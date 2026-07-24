import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { AiDmService } from './ai-dm.service';
import { AiDmSeatUpdateDto, AiDmTurnRequestDto } from './ai-dm.dto';

/**
 * Experimental server-side AI Dungeon Master (issue #28), scoped under a campaign.
 *
 * The whole feature is gated twice: the server-wide ServerSettings.experimentalAiDm
 * flag (admin opt-in) AND the per-campaign seat's `enabled`. Reads (GET) are ungated
 * beyond campaign membership; configure/turn/reset require the dm role AND the
 * experimental flag (enforced in AiDmService). The server never calls an LLM vendor —
 * narration is produced by an injected, swappable provider whose default is a no-op.
 */
@ApiTags('ai-dm')
@Controller('campaigns/:id/ai-dm')
export class AiDmController {
  constructor(
    private readonly aiDm: AiDmService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get the AI Dungeon Master seat for a campaign',
    description:
      'Requires campaign membership. Returns the seat config + metering (defaults when never configured). ' +
      "The DM-authored `instructions` (steering prompt / plot secrets) are omitted for non-DM callers (issue #261).",
  })
  @ApiResponse({ status: 200, description: 'The AI DM seat (instructions omitted unless the caller is the DM).' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, id);
    return this.aiDm.getSeatForRole(id, role);
  }

  @Put()
  @ApiOperation({
    summary: 'Configure the AI Dungeon Master seat',
    description:
      'dm role required, and the server-wide experimental flag (ServerSettings.experimentalAiDm) must be on (else 403). ' +
      'Sets enabled / model / instructions / tokenBudget; omitted fields are left unchanged.',
  })
  @ApiResponse({ status: 200, description: 'The updated seat.' })
  @ApiResponse({ status: 403, description: 'Not a dm, or the experimental feature is disabled server-wide.' })
  async configure(@Param('id', ParseIntPipe) id: number, @Body() body: AiDmSeatUpdateDto, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.aiDm.configure(id, body, user);
  }

  @Post('turn')
  @Throttle({ ai: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'AI Dungeon Master takes a turn',
    description:
      'dm role required (the AI holds the DM seat), the experimental flag must be on, the seat must be enabled, and the ' +
      "per-campaign token budget must not be exhausted. Narration comes from the server's injected AI_DM_PROVIDER — the " +
      'shipped default is a no-op scaffold that makes no vendor calls. Audited as ai-dm.',
  })
  @ApiResponse({ status: 201, description: 'The turn result (narration + metering).' })
  @ApiResponse({ status: 403, description: 'Not a dm, feature disabled, seat not enabled, or token budget exhausted.' })
  async turn(@Param('id', ParseIntPipe) id: number, @Body() body: AiDmTurnRequestDto, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.aiDm.takeTurn(id, body, user);
  }

  @Post('reset')
  @ApiOperation({
    summary: 'Reset the AI Dungeon Master usage counters',
    description: 'dm role required, experimental flag must be on. Clears tokensUsed/turnCount/lastTurnAt; config is untouched.',
  })
  @ApiResponse({ status: 201, description: 'The seat after resetting metering.' })
  async reset(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.aiDm.resetUsage(id, user);
  }

  @Get('usage-history')
  @ApiOperation({
    summary: 'Per-turn AI DM usage history (issue #1060)',
    description:
      'dm role required. Returns per-turn token usage records (newest-first), used by the DM settings usage sparkline ' +
      'and the audit view. Each row records one metered spend: driver step, co-DM draft, or scribe run. ' +
      'Response contains items + summary (totalTokens, count). Bounded by ?limit= (default 100, max 500); optional ' +
      '?since=ISO date to scope to a time window.',
  })
  @ApiResponse({ status: 200, description: 'The usage-history entries + summary.' })
  async usageHistory(
    @Param('id', ParseIntPipe) id: number,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('since') since: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, id, 'dm');
    const sinceTrimmed = typeof since === 'string' ? since.trim() : '';
    return this.aiDm.listUsageHistory(id, {
      limit,
      ...(sinceTrimmed.length > 0 ? { sinceIso: sinceTrimmed } : {}),
    });
  }
}
