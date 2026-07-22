import { Body, Controller, Delete, Get, Header, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type {
  SessionShare,
  SessionShareCreated,
  SessionShareMutationResult,
  SharedRecap,
} from '@campfire/schema';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { THROTTLE_SHARE, SHARE_THROTTLE_LIMIT, SHARE_THROTTLE_TTL_MS } from '../../common/throttle.constants';
import {
  SessionShareCreateDto,
  SessionSharePolicyUpdateDto,
  SessionShareUpdateDto,
} from './sessions.dto';
import { SessionsService } from './sessions.service';
import { SessionSharesService } from './session-shares.service';

const SHARE_THROTTLE = Throttle({ [THROTTLE_SHARE]: { limit: SHARE_THROTTLE_LIMIT, ttl: SHARE_THROTTLE_TTL_MS } });

@ApiTags('sessions')
@Controller('sessions/:sessionId/shares')
export class SessionSharesController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly shares: SessionSharesService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List active public recap shares',
    description:
      'Any campaign member may inspect active share status, label, creator, expiry, access count, and access timestamps. Raw tokens and token hashes are never returned.',
  })
  @ApiResponse({ status: 200, description: 'Active share metadata for this session.' })
  async list(@Param('sessionId', ParseIntPipe) sessionId: number, @CurrentUser() user: RequestUser): Promise<SessionShare[]> {
    const row = await this.sessions.getRowOrThrow(sessionId);
    await this.access.requireMember(user, row.campaignId);
    return this.shares.listForSession(sessionId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a public recap share',
    description:
      'DM role required. expiresAt is mandatory; send an ISO timestamp for a bounded link or explicit null for a deliberately non-expiring link. The raw token is returned once.',
  })
  @ApiResponse({ status: 201, description: 'Share created; copy the one-time token now.' })
  async create(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() body: SessionShareCreateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<SessionShareCreated> {
    const row = await this.sessions.getRowOrThrow(sessionId);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.shares.create(row, body, user, role);
  }

  @Patch(':shareId')
  @ApiOperation({ summary: 'Update a public recap share', description: 'DM role required. Updates the label and/or expiry; extending expiry notifies affected campaign members.' })
  @ApiResponse({ status: 200, description: 'Updated active share metadata.' })
  async update(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('shareId', ParseIntPipe) shareId: number,
    @Body() body: SessionShareUpdateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<SessionShare> {
    const row = await this.sessions.getRowOrThrow(sessionId);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.shares.update(shareId, row, body, user, role);
  }

  @Delete(':shareId')
  @ApiOperation({ summary: 'Revoke a public recap share', description: 'DM role required. The capability stops resolving immediately.' })
  @ApiResponse({ status: 200, description: 'Revoked.' })
  @ApiResponse({ status: 404, description: 'Share not found or belongs to another session.' })
  async revoke(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('shareId', ParseIntPipe) shareId: number,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    const row = await this.sessions.getRowOrThrow(sessionId);
    const role = await this.access.requireRole(user, row.campaignId, 'dm', { allowArchived: true });
    return this.shares.revoke(shareId, row, user, role);
  }
}

@ApiTags('sessions')
@Controller('campaigns/:campaignId/session-shares')
export class CampaignSessionSharesController {
  constructor(
    private readonly shares: SessionSharesService,
    private readonly access: CampaignAccessService,
  ) {}

  @Delete()
  @ApiOperation({ summary: 'Revoke every public recap share in a campaign', description: 'DM role required. Deletes all capability hashes, including expired links.' })
  @ApiResponse({ status: 200, description: 'Number of shares revoked.' })
  async revokeAll(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
  ): Promise<SessionShareMutationResult> {
    await this.shares.getCampaignOrThrow(campaignId);
    const role = await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.shares.revokeAll(campaignId, user, role);
  }

  @Put('policy')
  @ApiOperation({
    summary: 'Set the campaign public recap sharing policy',
    description: 'DM role required. Disabling atomically revokes every existing recap capability; re-enabling never resurrects old URLs.',
  })
  @ApiResponse({ status: 200, description: 'Policy updated and number of links revoked.' })
  async setPolicy(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SessionSharePolicyUpdateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<SessionShareMutationResult> {
    const campaign = await this.shares.getCampaignOrThrow(campaignId);
    const role = await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.shares.setCampaignPolicy(campaign, body.enabled, user, role);
  }
}

@ApiTags('sessions')
@Controller('shared')
export class SharedRecapController {
  constructor(private readonly shares: SessionSharesService) {}

  @Public()
  @SHARE_THROTTLE
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Get('recaps/:token')
  @ApiOperation({
    summary: 'Read a shared session recap (no auth)',
    description: 'Public and rate-limited. Unknown, malformed, revoked, expired, disabled, archived, and deleted capabilities all return the same 404 response.',
  })
  @ApiResponse({ status: 200, description: 'Campaign name and current live recap.' })
  @ApiResponse({ status: 404, description: 'Share link not found or revoked.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async read(@Param('token') token: string): Promise<SharedRecap> {
    return this.shares.resolveSharedRecap(token);
  }
}
