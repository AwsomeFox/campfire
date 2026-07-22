import { Body, Controller, Get, Param, ParseIntPipe, Post, Sse, type MessageEvent } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiProduces } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { interval, merge, map, type Observable } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import type { CampaignEvent } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WriteModeExempt } from '../../common/decorators/proposable.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { AiDriverService } from './ai-driver.service';
import { AiDmStreamService } from './ai-driver-stream.service';

/** Player action submitted to the AI DM seat (POST /ai-dm/message). */
const AiDmMessageRequest = z
  .object({
    input: z.string().min(1).max(20_000).describe('What the player says / does — the situation the AI DM responds to.'),
    scene: z.string().max(500).optional().describe('Optional scene/encounter label to set on the session.'),
    maxSteps: z.number().int().min(1).max(12).optional().describe('Cap on tool-loop iterations this turn.'),
    maxTokens: z.number().int().min(1).max(4096).optional().describe('Cap on each provider call’s output tokens (clamped to remaining budget).'),
  })
  .strict();
class AiDmMessageDto extends createZodDto(AiDmMessageRequest) {}

/** Pause/resume the seat (POST /ai-dm/pause). */
const AiDmPauseRequest = z.object({ paused: z.boolean() }).strict();
class AiDmPauseDto extends createZodDto(AiDmPauseRequest) {}

/** Retry / nudge the stuck seat (POST /ai-dm/nudge) — replays the last turn, optionally with a hint. */
const AiDmNudgeRequest = z
  .object({ hint: z.string().max(2_000).optional().describe('Optional steer injected into the replayed turn.') })
  .strict();
class AiDmNudgeDto extends createZodDto(AiDmNudgeRequest) {}

/** Flag / dispute the AI's last ruling (POST /ai-dm/flag) — forces a re-decision with the objection in context. */
const AiDmFlagRequest = z
  .object({ objection: z.string().min(1).max(2_000).describe('Why the last ruling was wrong/unfair — the AI re-decides with this in view.') })
  .strict();
class AiDmFlagDto extends createZodDto(AiDmFlagRequest) {}

/** Open or cast a table vote (POST /ai-dm/vote) to override the last ruling or pause the seat. */
const AiDmVoteRequest = z
  .object({
    action: z.enum(['open', 'cast']).describe('open a new vote, or cast a ballot on the open one.'),
    kind: z.enum(['override', 'pause']).optional().describe('What the vote decides (required when action=open).'),
    choice: z.boolean().optional().describe('Your ballot (required when action=cast).'),
  })
  .strict()
  .refine((v) => (v.action === 'open' ? v.kind !== undefined : v.choice !== undefined), {
    message: 'open requires `kind`; cast requires `choice`.',
  });
class AiDmVoteDto extends createZodDto(AiDmVoteRequest) {}

/** Grant the acting-DM seat to a human (POST /ai-dm/grant-takeover). */
const AiDmGrantTakeoverRequest = z
  .object({
    memberId: z.string().max(120).optional().describe('Who takes the seat (defaults to the last requester or the granter).'),
    note: z.string().max(500).optional().describe('Optional note recorded with the grant.'),
  })
  .strict();
class AiDmGrantTakeoverDto extends createZodDto(AiDmGrantTakeoverRequest) {}

/** Hand the seat back to the AI (POST /ai-dm/handback). */
const AiDmHandbackRequest = z
  .object({ note: z.string().max(500).optional().describe('The call the human made while in control (audited).') })
  .strict();
class AiDmHandbackDto extends createZodDto(AiDmHandbackRequest) {}

/** Route a rules question to the compendium instead of the model (POST /ai-dm/rules-lookup). */
const AiDmRulesLookupRequest = z
  .object({ query: z.string().min(1).max(200).describe('The rules question to look up in the compendium.') })
  .strict();
class AiDmRulesLookupDto extends createZodDto(AiDmRulesLookupRequest) {}

/**
 * Grant or revoke a narrowly-scoped secret-read approval (POST /ai-dm/secret-approval, #557).
 * Lets a DM let the autonomous seat read ONE secret entity under the DM principal during
 * narration (e.g. a hidden NPC the DM wants named). Single-use; bulk DM-only aggregate reads
 * (export/audit/arcs/…) are not approvable here.
 */
const AiDmSecretApprovalRequest = z
  .object({
    action: z.enum(['grant', 'revoke']).describe('grant a new approval, or revoke an unconsumed one.'),
    tool: z
      .string()
      .min(1)
      .max(60)
      .describe('The per-entity read tool the approval covers (e.g. get_npc, get_quest, get_location).'),
    entityId: z.number().int().positive().describe('The single entity id the approval is scoped to.'),
    note: z.string().max(500).optional().describe('Optional DM note recorded with the grant (audited).'),
  })
  .strict();
class AiDmSecretApprovalDto extends createZodDto(AiDmSecretApprovalRequest) {}

const HEARTBEAT_MS = 25_000;

/**
 * Driver AI-DM runtime endpoints (#312), alongside the existing seat config/turn
 * controller (ai-dm.controller.ts) under the same base path. Kept in its own
 * controller so the runtime (session loop, SSE narration, player input) lands as new
 * files rather than sprawling edits to the hot shared seat controller.
 *
 * - POST /message : a player submits an action; the AI DM runs a streamed turn.
 * - GET  /stream  : SSE narration — every member watches the AI narrate token-by-token.
 * - GET  /session : the lightweight session state (running/paused, scene, last turn).
 * - POST /pause   : DM pauses/resumes the seat (an explicit stop condition).
 *
 * The whole feature stays behind the server-wide `experimentalAiDm` flag + the seat's
 * `enabled` flag (enforced in AiDmService.assertRunnable), plus the per-campaign token
 * budget. @WriteModeExempt() because the AI's writes are gated INSIDE the tool layer
 * (write-mode/proposals per tool), not by the blunt HTTP WriteModeGuard.
 */
@ApiTags('ai-dm')
@WriteModeExempt()
@Controller('campaigns/:id/ai-dm')
export class AiDriverController {
  constructor(
    private readonly driver: AiDriverService,
    private readonly stream: AiDmStreamService,
    private readonly access: CampaignAccessService,
    private readonly events: CampaignEventsService,
  ) {}

  @Post('message')
  @Throttle({ ai: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Submit player input to the AI DM seat and run a streamed turn',
    description:
      'Requires player role (or DM). The AI DM assembles context, streams narration to all members over GET /ai-dm/stream, ' +
      'and executes tool calls under the seat’s guardrails (live play direct; canon edits become proposals). Gated by the ' +
      'experimental flag + seat enabled + token budget. Returns the turn summary (narration, stop reason, tool calls, budget).',
  })
  @ApiResponse({ status: 201, description: 'The completed turn summary.' })
  @ApiResponse({ status: 403, description: 'Not a player/DM, feature disabled, or seat not enabled.' })
  @ApiResponse({ status: 503, description: 'Seat paused, or no AI provider configured.' })
  async message(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AiDmMessageDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, id, 'player');
    return this.driver.runTurn(id, user, body.input, {
      scene: body.scene,
      maxSteps: body.maxSteps,
      maxTokens: body.maxTokens,
    });
  }

  @Get('session')
  @ApiOperation({
    summary: 'Get the AI DM session state',
    description: 'Requires campaign membership. Returns the lightweight session state (status, scene, last turn).',
  })
  @ApiResponse({ status: 200, description: 'The session state.' })
  async session(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, id);
    return this.driver.getSession(id);
  }

  @Post('pause')
  @ApiOperation({
    summary: 'Pause or resume the AI DM seat',
    description: 'DM only. A paused seat rejects new player input until resumed.',
  })
  @ApiResponse({ status: 201, description: 'The session state after pausing/resuming.' })
  async pause(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AiDmPauseDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, id, 'dm');
    return this.driver.setPaused(id, body.paused);
  }

  @Post('resume')
  @ApiOperation({
    summary: 'Resume the AI DM seat',
    description: 'DM only. Convenience for POST /pause {paused:false} — clears a deliberate pause.',
  })
  @ApiResponse({ status: 201, description: 'The session state after resuming.' })
  async resume(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.driver.setPaused(id, false);
  }

  // ---- Stuck-ladder player levers (#314): available to any player at the table ----

  @Post('nudge')
  @Throttle({ ai: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Retry / nudge a stuck AI DM turn',
    description:
      'Player+. Replays the last player input through the driver (bounded, budget-aware), optionally injecting a hint. ' +
      'A successful replay clears the stuck state. 409 if there is no prior turn to retry; 403 if the budget is exhausted.',
  })
  @ApiResponse({ status: 201, description: 'The replayed turn summary.' })
  async nudge(@Param('id', ParseIntPipe) id: number, @Body() body: AiDmNudgeDto, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, id, 'player');
    return this.driver.nudge(id, user, body.hint, role);
  }

  @Post('flag')
  @Throttle({ ai: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Flag / dispute the AI DM’s last ruling',
    description: 'Player+. Injects the objection into context and re-runs the turn so the AI must re-decide. Audited + notified.',
  })
  @ApiResponse({ status: 201, description: 'The re-decided turn summary.' })
  async flag(@Param('id', ParseIntPipe) id: number, @Body() body: AiDmFlagDto, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, id, 'player');
    return this.driver.flag(id, user, body.objection, role);
  }

  @Post('vote')
  @ApiOperation({
    summary: 'Open or cast a table vote to override/pause the AI DM',
    description:
      'Player+. `action:open` starts a vote (`kind: override|pause`); `action:cast` casts a ballot (`choice`). A majority ' +
      'of members carries it: a passed override discards the disputed ruling, a passed pause freezes the seat. All audited.',
  })
  @ApiResponse({ status: 201, description: 'The session state after the vote action.' })
  @ApiResponse({ status: 409, description: 'A vote is already open, or none is open to cast on.' })
  async vote(@Param('id', ParseIntPipe) id: number, @Body() body: AiDmVoteDto, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, id, 'player');
    if (body.action === 'open') return this.driver.openVote(id, user, body.kind!, role);
    return this.driver.castVote(id, user, body.choice!, role);
  }

  @Post('rules-lookup')
  @ApiOperation({
    summary: 'Route a rules question to the compendium (retrieval, not the model)',
    description: 'Player+. Looks the question up in the installed rule packs (cheaper + authoritative) instead of the generative model.',
  })
  @ApiResponse({ status: 201, description: 'The compendium lookup result.' })
  async rulesLookup(@Param('id', ParseIntPipe) id: number, @Body() body: AiDmRulesLookupDto, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, id, 'player');
    return this.driver.rulesLookup(id, user, body.query, role);
  }

  @Post('request-takeover')
  @ApiOperation({
    summary: 'Request a human takeover of the DM seat',
    description: 'Player+. Advisory — flags the ask and notifies the table so a DM/owner can grant the acting-DM seat.',
  })
  @ApiResponse({ status: 201, description: 'The session state after the request.' })
  async requestTakeover(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, id, 'player');
    return this.driver.requestTakeover(id, user, role);
  }

  @Post('grant-takeover')
  @ApiOperation({
    summary: 'Grant the acting-DM seat to a human',
    description: 'DM only. Freezes the AI seat (state → human_control) and records a revocable, audited acting-DM grant.',
  })
  @ApiResponse({ status: 201, description: 'The session state after the grant.' })
  async grantTakeover(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AiDmGrantTakeoverDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, id, 'dm');
    return this.driver.grantTakeover(id, user, body.memberId, body.note, role);
  }

  @Post('handback')
  @ApiOperation({
    summary: 'Hand the DM seat back to the AI',
    description: 'Player+. Revokes the acting-DM grant, unfreezes the seat, and clears any stuck state. `note` records the human’s call.',
  })
  @ApiResponse({ status: 201, description: 'The session state after handback.' })
  async handback(@Param('id', ParseIntPipe) id: number, @Body() body: AiDmHandbackDto, @CurrentUser() user: RequestUser) {
    // Route allows player+ so the acting-DM grant holder (often a player) can hand the seat back;
    // the service then enforces that only the grant holder or a campaign DM may actually do it (#375).
    const role = await this.access.requireRole(user, id, 'player');
    return this.driver.handback(id, user, body.note, role);
  }

  @Get('secret-approvals')
  @ApiOperation({
    summary: 'List active narrowly-scoped secret-read approvals',
    description:
      'DM only. Returns the unconsumed approvals currently letting the AI DM seat read one secret entity under the DM ' +
      'principal during narration (#557). Each is single-use and is consumed the first time the matching read runs.',
  })
  @ApiResponse({ status: 200, description: 'The active secret-read approvals.' })
  async listSecretApprovals(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.driver.listSecretReadApprovals(id);
  }

  @Post('secret-approval')
  @ApiOperation({
    summary: 'Grant or revoke a narrowly-scoped secret-read approval',
    description:
      'DM only. `action:grant` lets the autonomous AI DM seat read ONE secret entity (tool + entityId) under the DM principal ' +
      'during narration, so the model can reason about e.g. a hidden villain the DM wants named. Single-use: consumed the ' +
      'first time the matching read runs. `action:revoke` withdraws an unconsumed approval. Bulk DM-only reads ' +
      '(export_campaign, read_audit_log, list_arcs, …) are NOT approvable here.',
  })
  @ApiResponse({ status: 201, description: 'The grant (or the session state after a revoke).' })
  @ApiResponse({ status: 400, description: 'The tool is not a per-entity read the DM can approve.' })
  @ApiResponse({ status: 403, description: 'Not a DM.' })
  async secretApproval(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AiDmSecretApprovalDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, id, 'dm');
    if (body.action === 'grant') {
      return this.driver.grantSecretReadApproval(id, user, body.tool, body.entityId, body.note, role);
    }
    return this.driver.revokeSecretReadApproval(id, user, body.tool, body.entityId, role);
  }

  @Sse('stream')
  @ApiOperation({
    summary: 'Subscribe to AI DM narration (SSE)',
    description:
      'Requires campaign membership. Server-sent stream of AiDmStreamEvent JSON in `data`: turn.start, narration.delta ' +
      '(token-by-token), narration.message, tool (id-only signals — refetch through REST), and turn.end. Periodic ' +
      '`{"type":"ping"}` keepalives should be ignored. The stream closes automatically when the subscriber is removed ' +
      'from the campaign (issue #527); a reconnect then receives 403.',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({ status: 200, description: 'text/event-stream of AiDmStreamEvent JSON.' })
  @ApiResponse({ status: 403, description: 'Not a member of this campaign.' })
  async streamNarration(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
  ): Promise<Observable<MessageEvent>> {
    await this.access.requireMember(user, id);
    // Issue #527: terminate the narration stream when this user's membership is revoked.
    // The AI narration channel is a separate Subject from CampaignEventsService, so the
    // shared membership.revoked notifier (from the campaign event stream) is tapped here
    // via takeUntil — applied to the WHOLE merged stream so the heartbeat interval stops
    // too (otherwise merge keeps the connection alive on keepalive pings after the data
    // stream has ended). Same race-free reasoning as CampaignEventsController: the notifier
    // subscribes to the same Subject the revocation is emitted on, so it fires synchronously.
    const revoked = this.events.streamFor(id).pipe(
      filter(
        (event): event is Extract<CampaignEvent, { type: 'membership.revoked' }> =>
          event.type === 'membership.revoked' && event.userId === user.id,
      ),
    );
    return merge(
      this.stream.streamFor(id).pipe(map((event): MessageEvent => ({ data: event }))),
      interval(HEARTBEAT_MS).pipe(map((): MessageEvent => ({ data: { type: 'ping' } }))),
    ).pipe(takeUntil(revoked));
  }
}
