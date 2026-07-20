import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { RollsService, DEFAULT_ROLL_LIST_LIMIT, MAX_ROLLS_PER_CAMPAIGN } from './rolls.service';

@ApiTags('encounters')
@Controller('campaigns/:campaignId/rolls')
export class CampaignRollsController {
  constructor(
    private readonly rolls: RollsService,
    private readonly access: CampaignAccessService,
  ) {}

  /** The shared table feed — any member sees everyone's rolls (POST lives at /campaigns/:id/roll). */
  @Get()
  @ApiOperation({
    summary: 'List recent dice rolls in a campaign',
    description: `Requires campaign membership. The shared table roll feed, most-recent-first — every member's rolls, capped at ${MAX_ROLLS_PER_CAMPAIGN} retained per campaign.`,
  })
  @ApiQuery({ name: 'limit', required: false, description: `Max rolls to return (1-${MAX_ROLLS_PER_CAMPAIGN}, default ${DEFAULT_ROLL_LIST_LIMIT}).` })
  @ApiResponse({ status: 200, description: 'Recent rolls, newest first, with roller identity.' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('limit') limitRaw: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireMember(user, campaignId);
    // Lenient limit parsing (clamped, NaN -> default) mirrors the audit list's fixed
    // cap philosophy — a bad limit is a harmless request, not a 400.
    const parsed = Number(limitRaw);
    const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_ROLLS_PER_CAMPAIGN, Math.trunc(parsed))) : DEFAULT_ROLL_LIST_LIMIT;
    return this.rolls.listForCampaign(campaignId, limit);
  }
}
