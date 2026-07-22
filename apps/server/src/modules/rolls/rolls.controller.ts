import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import {
  RollsService,
  DEFAULT_ROLL_LIST_LIMIT,
  DEFAULT_DICE_ROLLS_RETENTION,
  resolveDiceRollsRetention,
  retentionIsUnbounded,
} from './rolls.service';

@ApiTags('encounters')
@Controller('campaigns/:campaignId/rolls')
export class CampaignRollsController {
  constructor(
    private readonly rolls: RollsService,
    private readonly access: CampaignAccessService,
  ) {}

  /**
   * The shared table feed — any member sees everyone's rolls (POST lives at
   * /campaigns/:id/roll). Returns the newest-first page bounded by `limit`
   * (the live-feed window). The *durable* ceiling on how many rolls a campaign
   * stores is disclosed via the `X-Dice-Rolls-Retention` response header
   * (issue #614) so the UI can show "the latest N rolls are kept"; a value of
   * `unlimited` (header `X-Dice-Rolls-Unbounded: 1`) means history is never
   * pruned.
   */
  @Get()
  @ApiOperation({
    summary: 'List recent dice rolls in a campaign',
    description: `Requires campaign membership. The shared table roll feed, most-recent-first — every member's rolls. Durable retention defaults to ${DEFAULT_DICE_ROLLS_RETENTION} rolls per campaign (configurable via DICE_ROLLS_RETENTION; 0/negative keeps all). The page size is independent and bounded by \`limit\`. Retention is disclosed in the X-Dice-Rolls-Retention / X-Dice-Rolls-Unbounded response headers.`,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Max rolls to return in this page (default ${DEFAULT_ROLL_LIST_LIMIT}). Independent of the durable retention ceiling.`,
  })
  @ApiResponse({ status: 200, description: 'Recent rolls, newest first, with roller identity.' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('limit') limitRaw: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.access.requireMember(user, campaignId);
    // Lenient limit parsing (clamped, NaN -> default) mirrors the audit list's
    // fixed-cap philosophy — a bad limit is a harmless request, not a 400. The
    // clamp is on the *page* size, not the durable retention: a caller can
    // always page through the full retained history, they just can't pull it
    // all in one unbounded request.
    const parsed = Number(limitRaw);
    const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(DEFAULT_DICE_ROLLS_RETENTION, Math.trunc(parsed))) : DEFAULT_ROLL_LIST_LIMIT;

    // Disclose the retention policy (#614) so the dice-log UI can render
    // "Showing the latest N rolls" / "all rolls kept" honestly.
    if (retentionIsUnbounded()) {
      res.setHeader('X-Dice-Rolls-Retention', 'unlimited');
      res.setHeader('X-Dice-Rolls-Unbounded', '1');
    } else {
      res.setHeader('X-Dice-Rolls-Retention', String(resolveDiceRollsRetention()));
    }

    return this.rolls.listForCampaign(campaignId, limit);
  }
}
