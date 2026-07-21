import { Body, Controller, Get, Param, ParseIntPipe, Post, Sse, type MessageEvent } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiProduces } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { interval, merge, map, type Observable } from 'rxjs';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WriteModeExempt } from '../../common/decorators/proposable.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
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
  ) {}

  @Post('message')
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

  @Sse('stream')
  @ApiOperation({
    summary: 'Subscribe to AI DM narration (SSE)',
    description:
      'Requires campaign membership. Server-sent stream of AiDmStreamEvent JSON in `data`: turn.start, narration.delta ' +
      '(token-by-token), narration.message, tool (id-only signals — refetch through REST), and turn.end. Periodic ' +
      '`{"type":"ping"}` keepalives should be ignored.',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({ status: 200, description: 'text/event-stream of AiDmStreamEvent JSON.' })
  @ApiResponse({ status: 403, description: 'Not a member of this campaign.' })
  async streamNarration(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
  ): Promise<Observable<MessageEvent>> {
    await this.access.requireMember(user, id);
    return merge(
      this.stream.streamFor(id).pipe(map((event): MessageEvent => ({ data: event }))),
      interval(HEARTBEAT_MS).pipe(map((): MessageEvent => ({ data: { type: 'ping' } }))),
    );
  }
}
