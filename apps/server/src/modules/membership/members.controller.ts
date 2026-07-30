import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from './campaign-access.service';
import { MembersService } from './members.service';
import { GuestDmGrantCreateDto, MemberAiConsentUpdateDto, MemberCreateDto, MemberUpdateDto } from './members.dto';

@ApiTags('members')
@Controller('campaigns/:campaignId/members')
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List campaign members', description: 'Requires campaign membership.' })
  @ApiResponse({
    status: 200,
    description:
      'Members with denormalized username/displayName. `aiExternalUseConsent` is null for other members unless the caller is the dm (#501).',
  })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    const members = await this.members.listForCampaign(campaignId);
    return this.members.redactOthersAiConsent(members, role, user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Add a member to a campaign', description: 'dm role required.' })
  @ApiResponse({ status: 201, description: 'Created membership.' })
  @ApiResponse({ status: 400, description: 'Target user is disabled or character link is invalid.' })
  @ApiResponse({ status: 404, description: 'Target user does not exist.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: MemberCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireCampaignPermission(user, campaignId, 'membership_admin');
    return this.members.create(campaignId, body, user);
  }

  @Get('grants')
  @ApiOperation({ summary: 'List temporary guest DM grants', description: 'Membership-admin campaign permission required.' })
  @ApiResponse({ status: 200, description: 'Guest DM grants, including expired/revoked handoff records.' })
  async listGuestDmGrants(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireCampaignPermission(user, campaignId, 'membership_admin', { allowArchived: true });
    return this.members.listGuestDmGrants(campaignId);
  }

  @Post('grants')
  @ApiOperation({
    summary: 'Grant temporary guest/co-DM authority',
    description:
      'Membership-admin campaign permission required. Default scope grants time-bounded DM play authority but excludes membership administration and destructive campaign lifecycle actions.',
  })
  @ApiResponse({ status: 201, description: 'Created grant.' })
  async createGuestDmGrant(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: GuestDmGrantCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireCampaignPermission(user, campaignId, 'membership_admin');
    return this.members.createGuestDmGrant(campaignId, body, user);
  }

  @Post('grants/:grantId/revoke')
  @ApiOperation({ summary: 'Revoke a guest DM grant', description: 'Membership-admin campaign permission required.' })
  @ApiResponse({ status: 201, description: 'Revoked grant.' })
  async revokeGuestDmGrant(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('grantId', ParseIntPipe) grantId: number,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireCampaignPermission(user, campaignId, 'membership_admin');
    return this.members.revokeGuestDmGrant(campaignId, grantId, user);
  }

  @Post('grants/:grantId/handback')
  @ApiOperation({ summary: 'Hand back a guest DM grant', description: 'The grantee may end their own temporary authority early.' })
  @ApiResponse({ status: 201, description: 'Handed-back grant.' })
  async handBackGuestDmGrant(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('grantId', ParseIntPipe) grantId: number,
    @CurrentUser() user: RequestUser,
  ) {
    // DELIBERATE archive exemption (issue #1480): handing back a guest/co-DM
    // grant is the grantee surrendering their own temporary authority — a
    // governance unwind, not campaign content. It must work on an archived
    // campaign so a temporary seat can always be released, so this stays the
    // plain membership gate (requireMember, no writable assertion).
    await this.access.requireMember(user, campaignId);
    return this.members.handBackGuestDmGrant(campaignId, grantId, user);
  }

  @Patch('me/ai-consent')
  @ApiOperation({
    summary: 'Update your external AI content consent',
    description:
      'Campaign membership required. Controls whether this member\'s authored source material may be included in prompts sent to external AI providers when the campaign policy allows it.',
  })
  @ApiResponse({ status: 200, description: 'Updated membership.' })
  async updateOwnAiConsent(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: MemberAiConsentUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireMember(user, campaignId);
    return this.members.updateOwnAiConsent(campaignId, body, user);
  }

  @Patch(':memberId')
  @ApiOperation({ summary: "Update a member's role/character link", description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Updated membership.' })
  @ApiResponse({ status: 400, description: 'Cannot promote a disabled account to DM, or character link is invalid.' })
  @ApiResponse({ status: 409, description: 'Would demote the last enabled DM.' })
  async update(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('memberId', ParseIntPipe) memberId: number,
    @Body() body: MemberUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireCampaignPermission(user, campaignId, 'membership_admin');
    return this.members.update(campaignId, memberId, body, user);
  }

  @Delete(':memberId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a member from a campaign (or leave it yourself)',
    description:
      'A dm may remove any member. A member may ALSO remove their OWN seat — self-leave (issue #128 player data rights) — ' +
      'which needs only membership, not the dm role, and works even on an archived (read-only) campaign so leaving is never blocked. ' +
      'Either way the last dm cannot be removed/leave without first handing dm off (409). ' +
      'The departing member keeps no edit rights: their owned character sheets stay in the campaign but are un-owned; their notes/proposals are preserved and attributed.',
  })
  @ApiResponse({ status: 204, description: 'Removed / left.' })
  @ApiResponse({ status: 403, description: 'Not the dm and not removing your own membership.' })
  @ApiResponse({ status: 409, description: 'Would remove/leave as the last dm of the campaign.' })
  async remove(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('memberId', ParseIntPipe) memberId: number,
    @CurrentUser() user: RequestUser,
  ) {
    // Resolve the target seat first so we can tell self-leave from a dm removing
    // someone else. A member leaving needs only membership and is a DELIBERATE
    // archive exemption (issue #1480): leaving is the member exercising their
    // own data rights, not campaign content, so it must work on an archived
    // campaign — requireMember (no writable assertion) is intentional here. A dm
    // removing ANOTHER member keeps the dm gate exactly as before.
    const target = await this.members.getRowOrThrow(campaignId, memberId);
    const selfLeave = String(target.userId) === user.id;
    if (selfLeave) {
      await this.access.requireMember(user, campaignId);
    } else {
      await this.access.requireCampaignPermission(user, campaignId, 'membership_admin');
    }
    await this.members.remove(campaignId, memberId, user, { selfLeave });
  }
}
