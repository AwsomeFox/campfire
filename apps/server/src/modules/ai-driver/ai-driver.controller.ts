import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Sse,
  UseInterceptors,
  type MessageEvent,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse, ApiProduces } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  AI_DM_TRANSCRIPT_CLIENT_REF_MAX,
  AI_DM_TRANSCRIPT_LIST_MAX_LIMIT,
  NarrationLanguage,
} from '@campfire/schema';
import { interval, merge, map, type Observable } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WriteModeExempt } from '../../common/decorators/proposable.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { AiDriverService, toPublicAiDmSessionState, toPublicAiDmSessionStateForRole, toPublicAiDmToolConfirmation, type AiDmTurnRunResult } from './ai-driver.service';
import { AiDmStreamService } from './ai-driver-stream.service';
import { ProactiveService } from './proactive.service';
import { DriverGroundingService } from './driver-grounding.service';
import { AiDmTranscriptService } from './ai-driver-transcript.service';
import { GroundingProjectionInterceptor, markHttpProjected, type HttpProjected } from './grounding-projection.interceptor';
import { projectAiDmStreamEventForRole } from './ai-driver-stream-projection';

/**
 * `AiDmTurnRunResult` carries `grounding?: GroundingVerdict` (#1639). This controller's
 * `@UseInterceptors(GroundingProjectionInterceptor)` redacts it for every response, but
 * that is a runtime property of the class, invisible to the type checker. Every handler
 * below that returns a turn result declares this return type instead of the plain one,
 * so returning the driver's raw result directly (skipping `markHttpProjected`) is a
 * compile error — see `grounding-projection.interceptor.ts` for exactly what that does
 * and does not prove, and `test/unit/grounding-http-brand.spec.ts` for the compile-level
 * proof.
 */
type AiDmTurnRunResultHttp = HttpProjected<AiDmTurnRunResult>;

/** Player action submitted to the AI DM seat (POST /ai-dm/message). */
const AiDmMessageRequest = z
  .object({
    input: z.string().min(1).max(20_000).describe('What the player says / does — the situation the AI DM responds to.'),
    characterId: z.number().int().positive().optional().describe('The character speaking. When provided, the server resolves speaker identity and enriches the prompt.'),
    scene: z.string().max(500).optional().describe('Optional scene/encounter label to set on the session.'),
    maxSteps: z.number().int().min(1).max(12).optional().describe('Cap on tool-loop iterations this turn.'),
    maxTokens: z.number().int().min(1).max(4096).optional().describe('Cap on each provider call’s output tokens (clamped to remaining budget).'),
    narrationLanguage: NarrationLanguage.optional().describe('Per-run override of the campaign narration language (#635).'),
    clientRef: z
      .string()
      .min(1)
      .max(AI_DM_TRANSCRIPT_CLIENT_REF_MAX)
      .optional()
      .describe(
        'Optimistic-echo correlation token minted by the sending client (#572). Echoed back verbatim on the ' +
          'persisted `player.action` transcript event so the sender replaces its local optimistic entry instead of ' +
          'rendering the action twice. A token, not content equality — two players typing the same words must still ' +
          'produce two transcript lines.',
      ),
    characterName: z
      .string()
      .max(200)
      .optional()
      .describe('Speaker attribution recorded on the transcript line (display only; the server fences the input).'),
    displayText: z
      .string()
      .max(20_000)
      .optional()
      .describe(
        'What the player actually typed, for the shared transcript (#572). `input` is what the MODEL receives and ' +
          'carries a speaker prefix (#317); this is the clean line the table reads. Defaults to `input`.',
      ),
  })
  .strict();
class AiDmMessageDto extends createZodDto(AiDmMessageRequest) {}

/** Query params for the transcript list (GET /ai-dm/transcript, #572). */
const AiDmTranscriptListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(AI_DM_TRANSCRIPT_LIST_MAX_LIMIT).optional(),
    cursor: z.string().max(512).optional(),
    after: z.coerce
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Reconnect watermark: return every event with seq greater than this, oldest-first.'),
  })
  .strict();
class AiDmTranscriptListDto extends createZodDto(AiDmTranscriptListQuery) {}

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

/** Manually trigger a proactive DM turn (POST /ai-dm/trigger). */
const AiDmTriggerRequest = z
  .object({
    type: z.enum(['encounterEnded', 'hpCritical', 'objectiveCompleted']).describe('The proactive trigger type.'),
    prompt: z.string().max(2_000).optional().describe('Optional custom prompt override.'),
  })
  .strict();
class AiDmTriggerDto extends createZodDto(AiDmTriggerRequest) {}

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

/** Turn collaborative handoff on/off (POST /ai-dm/collaborative, #1051). */
const AiDmCollaborativeRequest = z
  .object({
    enabled: z.boolean().describe('true = the AI narrates but a DM confirms every mechanical commit.'),
  })
  .strict();
class AiDmCollaborativeDto extends createZodDto(AiDmCollaborativeRequest) {}

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

/** Approve or reject a queued confirm-policy tool call (POST /ai-dm/tool-confirmation, #474). */
const AiDmToolConfirmationRequest = z
  .object({
    action: z.enum(['approve', 'reject']).describe('Execute the queued tool, or discard it.'),
    confirmationId: z.string().min(1).max(120).describe('The pending confirmation id returned to the model.'),
  })
  .strict();
class AiDmToolConfirmationDto extends createZodDto(AiDmToolConfirmationRequest) {}

/** Correct one of the AI's factual claims (POST /ai-dm/grounding/correct, #577). */
const AiDmGroundingCorrectionRequest = z
  .object({
    claimId: z.number().int().positive().describe('The grounding claim id from GET /ai-dm/grounding.'),
    correction: z
      .string()
      .min(1)
      .max(2_000)
      .describe('What is actually true — replayed into later turns as table-authoritative.'),
  })
  .strict();
class AiDmGroundingCorrectionDto extends createZodDto(AiDmGroundingCorrectionRequest) {}

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
// #1043: DM-only grounding is redacted for the reading role HERE, for the whole controller,
// rather than in each handler that happens to remember. See the interceptor for why: the
// per-handler version held only for handlers whose author knew the rule, and start-session did
// not. A handler in this controller cannot return an unprojected verdict.
@UseInterceptors(GroundingProjectionInterceptor)
@Controller('campaigns/:id/ai-dm')
export class AiDriverController {
  constructor(
    private readonly driver: AiDriverService,
    private readonly stream: AiDmStreamService,
    private readonly access: CampaignAccessService,
    private readonly events: CampaignEventsService,
    private readonly proactive: ProactiveService,
    private readonly transcript: AiDmTranscriptService,
    private readonly groundingStore: DriverGroundingService,
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
  ): Promise<AiDmTurnRunResultHttp> {
    const role = await this.access.requireRole(user, id, 'player');
    const turn = await this.driver.runTurn(id, user, body.input, {
      scene: body.scene,
      maxSteps: body.maxSteps,
      maxTokens: body.maxTokens,
      characterId: body.characterId,
      // #1499: the caller's SERVER-RESOLVED role, never the request body — governs whether
      // characterId/scene/maxSteps/maxTokens above are honored or overridden inside runTurn.
      callerRole: role,
      narrationLanguage: body.narrationLanguage,
      // #572: carried through to the persisted `player.action` transcript event.
      clientRef: body.clientRef,
      actorName: user.name,
      characterName: body.characterName,
      displayText: body.displayText,
    });
    // #577 — the turn result carries the grounding verdict, including the raw retrieval ledger,
    // and this endpoint is player-callable, so it is a second delivery path for DM-only ids.
    //
    // #1043: that projection is no longer applied here. GroundingProjectionInterceptor covers the
    // whole controller, and this was the ONLY handler that ever had the inline version — which is
    // precisely why start-session could ship without it and leak. Two mechanisms for one
    // guarantee is how the guarantee drifts, so there is deliberately only one left.
    //
    // #1639 — `markHttpProjected` does not itself redact; see grounding-projection.interceptor.ts.
    return markHttpProjected(turn);
  }

  @Get('session')
  @ApiOperation({
    summary: 'Get the AI DM session state',
    description:
      'Requires campaign membership. Returns the lightweight session state (status, scene, last turn), plus ' +
      '`historyLength` (#1038) — how many past table events the AI can draw conversation memory from on its next ' +
      'turn. Derived from the durable transcript on every read, so a DM purge or retention pruning shows up ' +
      'immediately, and it counts only the narrative events the model may actually be told about rather than every ' +
      'stored row.',
  })
  @ApiResponse({ status: 200, description: 'The session state.' })
  async session(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, id);
    // #1501: lastUndoableCommit is DM-only — its encounterId could name a hidden fight.
    return toPublicAiDmSessionStateForRole(this.driver.getSession(id), role);
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
    return toPublicAiDmSessionState(this.driver.setPaused(id, body.paused));
  }

  @Post('resume')
  @ApiOperation({
    summary: 'Resume the AI DM seat',
    description: 'DM only. Convenience for POST /pause {paused:false} — clears a deliberate pause.',
  })
  @ApiResponse({ status: 201, description: 'The session state after resuming.' })
  async resume(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return toPublicAiDmSessionState(this.driver.setPaused(id, false));
  }

  @Post('undo')
  @ApiOperation({
    summary: 'Undo the AI DM seat\'s last reversible action',
    description:
      'DM only. Reverses the seat\'s most recently committed undoable action (a resolve_action/apply_action) ' +
      'by driving the existing undo path against the chain the seat observed — no client-held undo token required. ' +
      '404 when there is nothing reversible to undo.',
  })
  @ApiResponse({ status: 201, description: 'The reversal completed.' })
  @ApiResponse({ status: 404, description: 'No reversible action to undo.' })
  async undo(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.driver.undoLastSeatAction(id, user);
  }

  // ---- Session lifecycle (#1043) ----------------------------------------------------

  @Post('start-session')
  @Throttle({ ai: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Open a session: the AI greets the table and recaps where it left off',
    description:
      'Player+ — sitting down to play is a table act, not a DM-only one. Runs ONE greeting turn ' +
      'through the same gates as any player action (seat enabled, token budget, pause, human ' +
      'control, turn lock), so a paused or frozen seat refuses it and the lifecycle phase is left ' +
      'untouched. The recap is the DM-approved `sessions.recap` written by the AI Scribe — the ' +
      'model is told to use it and to say so plainly when there is none, never to invent one. ' +
      'The phase moves greeting → active when the turn returns, whatever its stop reason.',
  })
  @ApiResponse({ status: 201, description: 'The greeting turn summary.' })
  @ApiResponse({ status: 409, description: 'A lifecycle turn is already in progress, or the AI is mid-turn.' })
  @ApiResponse({ status: 503, description: 'Seat paused, under human control, or no provider configured.' })
  async startSession(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<AiDmTurnRunResultHttp> {
    const role = await this.access.requireRole(user, id, 'player');
    return markHttpProjected(await this.driver.startSession(id, user, role));
  }

  @Post('wrap-up')
  @Throttle({ ai: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Close the session: the AI delivers a spoken closing summary',
    description:
      'DM only — closing a session is a decision, not an announcement. Runs ONE wrap-up turn and ' +
      'lands the phase in `ended`, after which player input is refused until someone starts a new ' +
      'session. This does NOT write a session recap: the AI Scribe owns that, through the DM ' +
      'proposal queue, and a second unreviewed summary on the campaign record would be a canon ' +
      'write nobody approved.',
  })
  @ApiResponse({ status: 201, description: 'The wrap-up turn summary.' })
  @ApiResponse({ status: 409, description: 'Already wrapped up, a lifecycle turn is in progress, or the AI is mid-turn.' })
  // Same 503 surface as `startSession`: a wrap-up is an ordinary `runTurn`, so a paused seat, a
  // human takeover, or a missing provider refuses it exactly as it refuses a player action.
  @ApiResponse({ status: 503, description: 'Seat paused, under human control, or no provider configured.' })
  async wrapUp(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<AiDmTurnRunResultHttp> {
    const role = await this.access.requireRole(user, id, 'dm');
    return markHttpProjected(await this.driver.wrapUpSession(id, user, role));
  }

  @Post('collaborative')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Turn collaborative handoff on or off (AI narrates, DM decides mechanics)',
    description:
      'DM only. A middle rung between full autonomy and a full human takeover: the AI keeps ' +
      'narrating and keeps calling tools, but every call that would COMMIT a mechanical outcome — ' +
      'applying an action, changing HP or conditions, advancing the turn, changing who is on the ' +
      'board — routes to the existing confirm-policy queue (#474) instead of executing, and a DM ' +
      'resolves it via POST /ai-dm/tool-confirmation. Dice rolls, reads and undo stay automatic. ' +
      'Idempotent. Survives pause, takeover, stuck states and restarts, so autonomy is never ' +
      'restored as a side effect of some unrelated control.',
  })
  @ApiResponse({ status: 200, description: 'The updated session state.' })
  @ApiResponse({ status: 403, description: 'Not a DM.' })
  async collaborative(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AiDmCollaborativeDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, id, 'dm');
    return toPublicAiDmSessionState(this.driver.setCollaborative(id, body.enabled));
  }

  @Post('trigger')
  @HttpCode(202)
  @ApiOperation({ summary: 'Manually trigger a proactive DM turn' })
  @ApiResponse({ status: 202, description: 'Proactive turn initiated.' })
  @Throttle({ ai: { limit: 5, ttl: 60000 } })
  async trigger(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
    @Body() body: AiDmTriggerDto,
  ): Promise<void> {
    await this.access.requireRole(user, id, 'dm');
    await this.proactive.manualTrigger(id, body.type, body.prompt);
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
  async nudge(@Param('id', ParseIntPipe) id: number, @Body() body: AiDmNudgeDto, @CurrentUser() user: RequestUser): Promise<AiDmTurnRunResultHttp> {
    const role = await this.access.requireRole(user, id, 'player');
    return markHttpProjected(await this.driver.nudge(id, user, body.hint, role));
  }

  @Post('flag')
  @Throttle({ ai: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Flag / dispute the AI DM’s last ruling',
    description: 'Player+. Injects the objection into context and re-runs the turn so the AI must re-decide. Audited + notified.',
  })
  @ApiResponse({ status: 201, description: 'The re-decided turn summary.' })
  async flag(@Param('id', ParseIntPipe) id: number, @Body() body: AiDmFlagDto, @CurrentUser() user: RequestUser): Promise<AiDmTurnRunResultHttp> {
    const role = await this.access.requireRole(user, id, 'player');
    return markHttpProjected(await this.driver.flag(id, user, body.objection, role));
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
    if (body.action === 'open') return toPublicAiDmSessionState(await this.driver.openVote(id, user, body.kind!, role));
    return toPublicAiDmSessionState(await this.driver.castVote(id, user, body.choice!, role));
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
    return toPublicAiDmSessionState(await this.driver.requestTakeover(id, user, role));
  }

  @Post('continue-without-ai')
  @ApiOperation({
    summary: 'Continue play without the AI after a provider failure',
    description:
      'Player+. Offered when the seat is stuck on provider_error: DMs grant themselves the acting-DM seat; players request a human takeover.',
  })
  @ApiResponse({ status: 201, description: 'The session state after continuing without the AI.' })
  async continueWithoutAi(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, id, 'player');
    return toPublicAiDmSessionState(await this.driver.continueWithoutAi(id, user, role));
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
    return toPublicAiDmSessionState(await this.driver.grantTakeover(id, user, body.memberId, body.note, role));
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
    return toPublicAiDmSessionState(await this.driver.handback(id, user, body.note, role));
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
    return toPublicAiDmSessionState(await this.driver.revokeSecretReadApproval(id, user, body.tool, body.entityId, role));
  }

  @Get('tool-confirmations')
  @ApiOperation({
    summary: 'List pending confirm-policy tool calls',
    description:
      'DM only. Returns queued live-play tool calls awaiting DM approval before execution (#474). ' +
      'Each entry includes durable actor/provenance (seat actor + triggering player).',
  })
  @ApiResponse({ status: 200, description: 'Pending tool confirmations.' })
  async listToolConfirmations(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    // #1495 — project through the shared public schema; the internal record carries bookkeeping
    // (retainedActionChain) that must never reach an HTTP client.
    return this.driver.listPendingToolConfirmations(id).map(toPublicAiDmToolConfirmation);
  }

  @Post('tool-confirmation')
  @ApiOperation({
    summary: 'Approve or reject a queued confirm-policy tool call',
    description:
      'DM only. `action:approve` executes the stored tool args under the seat principal; `action:reject` discards it. ' +
      'Irreversible live-play tools (end_encounter, remove_combatant, award_xp, level_up_character, …) are queued during live play.',
  })
  @ApiResponse({ status: 201, description: 'The resolved confirmation (and tool result when approved).' })
  async toolConfirmation(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AiDmToolConfirmationDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, id, 'dm');
    const outcome = await this.driver.resolveToolConfirmation(id, user, body.confirmationId, body.action, role);
    // #1495 — same projection as GET /tool-confirmations: `outcome.confirmation` is the internal
    // record (when non-null, on a successful approval) and must not leak its bookkeeping fields.
    return {
      confirmation: outcome.confirmation ? toPublicAiDmToolConfirmation(outcome.confirmation) : null,
      result: outcome.result,
    };
  }

  // ---- Authoritative table transcript (#572) --------------------------------------

  @Get('transcript')
  @ApiOperation({
    summary: 'Read the authoritative AI-DM table transcript',
    description:
      'Requires campaign membership. Returns ONE ordered transcript every player at the table shares — accepted ' +
      'player actions, narration steps, tool summaries, cancellations, votes and control changes — each with a stable ' +
      '`eventId` and a per-campaign `seq`. `seq` is the ordering key AND the cursor: pass `after=<seq>` after a ' +
      'reconnect to replay exactly the events you missed (oldest-first, and gap-free as long as your watermark is ' +
      'still inside the retained window — see the retention cap), or omit it for the newest page ' +
      'and follow `nextCursor` to scroll further back. Role redaction is applied HERE: DM-only events are withheld ' +
      'from players and viewers, and a hidden encounter id inside a tool payload is stripped for non-DMs.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 50, max 200).' })
  @ApiQuery({ name: 'cursor', required: false, description: "Opaque cursor from a previous page's nextCursor (scroll back)." })
  @ApiQuery({ name: 'after', required: false, description: 'Reconnect watermark — return events with seq greater than this.' })
  @ApiResponse({ status: 200, description: 'A page of transcript events (`items`, `total`, `hasMore`, `nextCursor`).' })
  @ApiResponse({ status: 403, description: 'Not a member of this campaign.' })
  async listTranscript(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: AiDmTranscriptListDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, id);
    return this.transcript.list(id, role, { limit: query.limit, cursor: query.cursor, after: query.after });
  }

  @Get('transcript/export')
  @ApiOperation({
    summary: 'Export the retained AI-DM table transcript',
    description:
      'Requires campaign membership. Returns every event the campaign still retains, role-projected exactly like the ' +
      'paged read — an export is a copy of what you may already see, never a redaction back door. Retention is ' +
      'bounded per campaign; `retentionMaxEvents` reports the cap so a DM knows what has aged out.',
  })
  @ApiResponse({ status: 200, description: 'The role-projected transcript export.' })
  async exportTranscript(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, id);
    return this.transcript.exportAll(id, role);
  }

  @Delete('transcript')
  @ApiOperation({
    summary: 'Erase the AI-DM table transcript',
    description:
      'DM only. Deletes every retained transcript event for the campaign and tells every open table to drop its local ' +
      'copy (a purge resets the per-campaign `seq`, so a stale watermark would otherwise strand a connected client). ' +
      'Transcript rows also cascade-delete with the campaign itself.',
  })
  @ApiResponse({ status: 200, description: 'How many events were deleted.' })
  @ApiResponse({ status: 403, description: 'Not a DM.' })
  async deleteTranscript(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return { deleted: await this.transcript.purge(id) };
  }

  // ---- Grounding claims + the human-correction loop (#577) -------------------------

  @Get('grounding')
  @ApiOperation({
    summary: 'List the AI DM’s recent factual claims and the server’s verdict on each',
    description:
      'Requires campaign membership (#577). One entry per rules ruling / existing-canon assertion the driver made, ' +
      'with the SERVER’s verdict (supported / unsupported / corrected), the reason code, the structured citations ' +
      'with evidence links, and the ruling’s provenance — the provider NAME and served model id only, never a key, ' +
      'base URL, or header. Deliberately member-readable: the table is the audience for an unverified ruling. ' +
      'Role redaction is applied HERE: a citation backed by a DM-only id (a hidden encounter, or an entity behind ' +
      'a #557 secret-read approval) keeps its verdict for every reader but has its id and evidence link withheld ' +
      'from players and viewers (#825).',
  })
  @ApiResponse({ status: 200, description: 'Recent grounding claims, newest first.' })
  async grounding(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, id);
    return this.groundingStore.listForCampaign(id, role);
  }

  @Get('withheld-turns')
  @ApiOperation({
    summary: 'List AI DM turns withheld by a provider content filter or refusal',
    description:
      'DM only (#598). One entry per turn the server refused to deliver because the provider reported a content ' +
      'filter or the model refused. Every field is a COUNT or provenance — how much was withheld, how much had ' +
      'already been broadcast when the refusal arrived, how many tool calls were suppressed, which provider/model, ' +
      'and whose action provoked it. The withheld text is never stored, and no digest of it is stored either: ' +
      'persisting prose the provider just declined to stand behind would give it a longer-lived, exportable home ' +
      'than the live stream it was kept off. DM-only because “how often is this table getting filtered, and on ' +
      'whose turns” is table management, not play.',
  })
  @ApiResponse({ status: 200, description: 'Recent withheld-turn incidents, newest first.' })
  @ApiResponse({ status: 403, description: 'Not a DM of this campaign.' })
  async withheldTurns(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.driver.listWithheldIncidents(id);
  }

  @Post('grounding/correct')
  @ApiOperation({
    summary: 'Correct one of the AI DM’s claims',
    description:
      'DM only (#577). Records the human’s ruling against a claim: the original claim text, verdict, and provenance ' +
      'are preserved (the table may need to argue about what the AI actually said) and the correction is layered on ' +
      'top. The correction is replayed into every subsequent turn’s system prompt as table-authoritative, so the ' +
      'model stops repeating the claim.',
  })
  @ApiResponse({ status: 201, description: 'The corrected claim record.' })
  @ApiResponse({ status: 404, description: 'No such claim in this campaign.' })
  async correctGrounding(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AiDmGroundingCorrectionDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, id, 'dm');
    return this.groundingStore.correct(id, body.claimId, user, role, body.correction);
  }

  @Sse('stream')
  @ApiOperation({
    summary: 'Subscribe to AI DM narration (SSE)',
    description:
      'Requires campaign membership. Server-sent stream of AiDmStreamEvent JSON in `data`: turn.start, narration.delta ' +
      '(token-by-token), narration.message, tool (thin signals with optional encounterId for encounter mutations — ' +
      'refetch through REST; hidden encounter ids are stripped for non-DMs, #825), narration.withheld (a provider ' +
      'content filter or refusal ended the turn — no narration.message will follow, and clients MUST discard the ' +
      'deltas they have buffered for the open bubble, #598), and turn.end. Periodic ' +
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
    const role = await this.access.requireMember(user, id);
    // Issue #527: terminate the narration stream when this user's membership is revoked.
    // The AI narration channel is a separate Subject from CampaignEventsService, so the
    // shared membership.revoked notifier (from the campaign event stream) is tapped here
    // via takeUntil — applied to the WHOLE merged stream so the heartbeat interval stops
    // too (otherwise merge keeps the connection alive on keepalive pings after the data
    // stream has ended). Same race-free reasoning as CampaignEventsController: the notifier
    // subscribes to the same Subject the revocation is emitted on, so it fires synchronously.
    // Issue #527 / #867: tear down on membership revocation OR campaign trash.
    const closed = this.events.streamFor(id).pipe(
      filter(
        (event) =>
          (event.type === 'membership.revoked' && event.userId === user.id)
          || event.type === 'campaign.trashed',
      ),
    );
    return merge(
      this.stream.streamFor(id).pipe(
        // Role redaction is enforced HERE, at the broadcast boundary (#572), for EVERY frame
        // type rather than the two that used to be named inline (#1552). A withheld frame is
        // DROPPED from this subscriber's stream entirely — a player is never handed a DM-only
        // event and merely trusted not to render it. `projectAiDmStreamEventForRole` fails
        // closed: an unclassified frame type does not compile, and does not reach the wire.
        map((event) => projectAiDmStreamEventForRole(event, role)),
        filter((event): event is NonNullable<typeof event> => event !== null),
        map((event): MessageEvent => ({ data: event })),
      ),
      interval(HEARTBEAT_MS).pipe(map((): MessageEvent => ({ data: { type: 'ping' } }))),
    ).pipe(takeUntil(closed));
  }
}
