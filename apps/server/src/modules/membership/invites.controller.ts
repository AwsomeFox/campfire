import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { CampaignInvite, InviteMutationResult, InvitePreview, Me } from '@campfire/schema';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { THROTTLE_AUTH, AUTH_THROTTLE_LIMIT, AUTH_THROTTLE_TTL_MS } from '../../common/throttle.constants';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';
import { sessionCookieOptions } from '../auth/session-cookie';
import { CampaignAccessService } from './campaign-access.service';
import { InvitesService } from './invites.service';
import {
  InviteCreateDto,
  InviteAcceptDto,
  InviteDeclineDto,
  InviteJoinDto,
  InvitePolicyUpdateDto,
} from './invites.dto';

/**
 * Same strict per-IP cap as the @Public auth routes (see auth.controller.ts):
 * GET /invites/:code is an unauthenticated code oracle (rate-limit brute-force
 * code guessing) and POST /invites/:code/accept additionally runs a full scrypt
 * password hash per request — the exact DoS shape the auth throttle exists for.
 * POST /invites/:code/decline is authenticated but still resolves codes through the
 * same oracle, so it gets the same cap.
 */
const INVITE_THROTTLE = Throttle({ [THROTTLE_AUTH]: { limit: AUTH_THROTTLE_LIMIT, ttl: AUTH_THROTTLE_TTL_MS } });

@ApiTags('invites')
@Controller('campaigns/:campaignId/invites')
export class CampaignInvitesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "List a campaign's live invite links",
    description:
      'dm role required. Expired/exhausted invites are retained but not listed. Allowed on archived campaigns so archive/Trash confirmations can show outstanding links (#857).',
  })
  @ApiResponse({ status: 200, description: 'Live invites, including their join codes.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser): Promise<CampaignInvite[]> {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.invites.listForCampaign(campaignId);
  }

  @Post()
  @ApiOperation({ summary: 'Create an invite link', description: 'dm role required. Role is capped to player/viewer; the code always expires (default 7 days) and may be use-capped. Refused while public invites are suspended (#857).' })
  @ApiResponse({ status: 201, description: 'Created invite, including its join code.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: InviteCreateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<CampaignInvite> {
    await this.access.requireRole(user, campaignId, 'dm');
    return this.invites.create(campaignId, body, user);
  }

  @Delete()
  @ApiOperation({
    summary: 'Revoke every invite link in a campaign',
    description: 'dm role required. Deletes all invite rows (including expired/exhausted retained history). Existing members are unaffected. Allowed on archived campaigns (#857).',
  })
  @ApiResponse({ status: 200, description: 'Number of invites revoked.' })
  async revokeAll(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
  ): Promise<InviteMutationResult> {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.invites.revokeAll(campaignId, user);
  }

  @Put('policy')
  @ApiOperation({
    summary: 'Set the campaign public-invite policy',
    description:
      'dm role required. Disabling suspends every outstanding code without deleting rows; re-enabling is deliberate and refused while the campaign is archived or trashed so restore cannot accidentally revive links (#857).',
  })
  @ApiResponse({ status: 200, description: 'Policy updated.' })
  async setPolicy(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: InvitePolicyUpdateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<InviteMutationResult> {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.invites.setPolicy(campaignId, body.enabled, user);
  }

  @Delete(':inviteId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke an invite link', description: 'dm role required. The code stops working immediately; existing members are unaffected. Allowed on archived campaigns (#857).' })
  @ApiResponse({ status: 204, description: 'Revoked.' })
  async revoke(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('inviteId', ParseIntPipe) inviteId: number,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    await this.invites.revoke(campaignId, inviteId, user);
  }
}

@ApiTags('invites')
@Controller('invites')
export class JoinController {
  constructor(private readonly invites: InvitesService) {}

  @Public()
  @INVITE_THROTTLE
  @Get(':code')
  @ApiOperation({
    summary: "Preview an invite, including the table's session-zero charter",
    description:
      'Unauthenticated. Resolves a join code to the campaign name, the role it grants, and (issue #600) the ' +
      "PUBLISHED session-zero charter, so a person can read the table's lines, veils, safety tools and AI policy " +
      'BEFORE committing rather than after. The charter is a narrow projection: a published version only (never ' +
      "the DM's working draft), never private boundary submissions, and never member names or counts. `charter` is " +
      'null and `consentRequired` false for a campaign that never published, whose join flow is unchanged. Unknown, ' +
      'expired, exhausted, revoked, suspended (archived/trashed/policy-off), and missing codes all still return the ' +
      'same 404.',
  })
  @ApiResponse({ status: 200, description: 'Valid invite.' })
  @ApiResponse({ status: 404, description: 'Invalid or no longer active.' })
  async preview(@Param('code') code: string): Promise<InvitePreview> {
    return this.invites.preview(code);
  }

  @Public()
  @INVITE_THROTTLE
  @Post(':code/accept')
  @ApiOperation({
    summary: 'Accept an invite as a new user',
    description:
      'Unauthenticated. Creates the account, adds it to the campaign at the invite\'s role, and starts a session — one call from link to seat at the table. ' +
      'Refused (403) while local login is disabled for non-admins, so invites never bypass that server policy.',
  })
  @ApiResponse({ status: 201, description: 'Account created and campaign joined; session cookie set.' })
  @ApiResponse({ status: 404, description: 'Invite invalid or no longer active.' })
  @ApiResponse({ status: 409, description: 'Username already taken.' })
  async accept(
    @Param('code') code: string,
    @Body() body: InviteAcceptDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Me & { campaignId: number }> {
    const { token, me, campaignId } = await this.invites.accept(code, body);
    res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
    return { ...me, campaignId };
  }

  @Post(':code/join')
  @ApiOperation({ summary: 'Accept an invite as the current user', description: 'Adds the authenticated user to the campaign at the invite\'s role.' })
  @ApiResponse({ status: 201, description: 'Joined; returns the refreshed Me.' })
  @ApiResponse({ status: 404, description: 'Invite invalid or no longer active.' })
  @ApiResponse({ status: 409, description: 'Already a member, or charter acknowledgment missing/stale.' })
  async join(
    @Param('code') code: string,
    @Body() body: InviteJoinDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Me & { campaignId: number }> {
    return this.invites.join(code, user, body.acknowledgeVersion);
  }

  @INVITE_THROTTLE
  @Post(':code/decline')
  @ApiOperation({
    summary: 'Decline an invite, on the record',
    description:
      'Issue #600. Records a refusal against the exact charter version the person was shown, WITHOUT creating a ' +
      'membership. A decline that merely closed the tab told the DM nothing and left somebody who bounced off a ' +
      'specific line indistinguishable from somebody who never opened the link. Returns `recorded: false` for a ' +
      'campaign with no published charter — there is nothing concrete to decline against.',
  })
  @ApiResponse({ status: 201, description: 'Refusal recorded (or no charter to record against).' })
  @ApiResponse({ status: 404, description: 'Invite invalid or no longer active.' })
  async decline(
    @Param('code') code: string,
    @Body() body: InviteDeclineDto,
    @CurrentUser() user: RequestUser,
  ): Promise<{ recorded: boolean }> {
    return this.invites.decline(code, user, body.note);
  }
}
