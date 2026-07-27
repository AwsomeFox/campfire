import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { SafetyService } from './safety.service';
import { SafetyBlockCreateDto, SafetyControlDto, SafetyMuteCreateDto } from './safety.dto';

/**
 * Personal safety controls (issue #597).
 *
 * Every route here is SELF-scoped: the caller acts only on their own controls, and no
 * route exposes another member's. That includes DMs — a DM has moderation powers over
 * the table (see the /moderation surface), but a member's block list is not table
 * business, and making it DM-readable would put the one fact that must stay private
 * (who blocked whom) in front of the person most likely to be asked about it.
 *
 * Every route allows an ARCHIVED campaign (`allowArchived: true`), matching the
 * moderation surface's reasoning: protecting yourself must not depend on campaign
 * status. A paused campaign is exactly when a whisper thread keeps going.
 */
@ApiTags('safety')
@Controller('campaigns/:campaignId/safety')
export class SafetyController {
  constructor(
    private readonly safety: SafetyService,
    private readonly access: CampaignAccessService,
  ) {}

  @Post('blocks')
  @ApiOperation({
    summary: 'Block another member',
    description:
      'Any campaign member, on another member of the same campaign. The block is ACCOUNT-WIDE: it also applies in ' +
      'every other campaign you share with them, and it survives them leaving and rejoining, being re-invited, ' +
      'changing role, or acting through a personal access token — it is keyed on the account, not the membership. ' +
      'A block stops the blocked member reaching you: nothing they send notifies you, and their notes and whispers ' +
      'are hidden from your reads and your search results. ' +
      'It is NOT disclosed to them — their sends still succeed normally, because an error or a refusal would tell a ' +
      'harasser exactly when they were blocked and by whom. Their content remains visible to DMs and to the ' +
      'moderation evidence path, so a later report still has something to look at. Idempotent.',
  })
  @ApiResponse({ status: 201, description: 'The block (or the existing one, if already blocked).', type: SafetyControlDto })
  @ApiResponse({ status: 400, description: 'Target is not a member of this campaign, or is the caller.' })
  async createBlock(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SafetyBlockCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId, { allowArchived: true });
    return this.safety.createBlock(campaignId, body, user, role);
  }

  @Post('mutes')
  @ApiOperation({
    summary: 'Mute a sender or a thread',
    description:
      'Any campaign member. Supply either `targetUserId` (stop being notified about one person) or ' +
      '`entityType` + `entityId` (stop being notified about one anchored discussion) — not both. ' +
      'A mute is noise control, not protection: the muted content stays fully visible and readable, only the ' +
      'notifications stop, and existing bell items are left alone. Use a block for the safety case. ' +
      'Scoped to this campaign. A thread mute must name an entity you can already see (issue #230).',
  })
  @ApiResponse({ status: 201, description: 'The mute (or the existing one).', type: SafetyControlDto })
  @ApiResponse({ status: 400, description: 'Neither or both of the person / thread targets supplied.' })
  async createMute(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SafetyMuteCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId, { allowArchived: true });
    return this.safety.createMute(campaignId, body, user, role);
  }

  @Get('controls')
  @ApiOperation({
    summary: "List your own blocks and mutes",
    description:
      'Your own live controls only, newest first — never anyone else\'s, and never visible to a DM. ' +
      'Account-wide blocks are listed here whichever campaign you ask through, so the list is manageable from ' +
      'anywhere you are a member.',
  })
  @ApiResponse({ status: 200, description: "The caller's live safety controls.", type: [SafetyControlDto] })
  async listOwn(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId, { allowArchived: true });
    return this.safety.listOwn(user);
  }

  @Delete('controls/:controlId')
  @ApiOperation({
    summary: 'Lift one of your own blocks or mutes',
    description:
      "Owner only. A control belonging to another member 404s rather than 403 — a 403 would confirm that somebody " +
      'else holds a control with that id, which for a block is precisely the fact that must stay private.',
  })
  @ApiResponse({ status: 200, description: 'Lifted.' })
  @ApiResponse({ status: 404, description: 'No live control with that id belongs to the caller.' })
  async lift(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('controlId', ParseIntPipe) controlId: number,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId, { allowArchived: true });
    await this.safety.lift(controlId, user, role, campaignId);
    return { ok: true };
  }
}
