import { Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { SessionShare, SessionShareCreated, SharedRecap } from '@campfire/schema';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { THROTTLE_SHARE, SHARE_THROTTLE_LIMIT, SHARE_THROTTLE_TTL_MS } from '../../common/throttle.constants';
import { SessionsService } from './sessions.service';
import { SessionSharesService } from './session-shares.service';

/**
 * Unauthenticated endpoint + unguessable capability token: same throttling
 * pattern as the @Public auth routes (see auth.controller.ts / throttle.constants.ts)
 * — a strict per-IP cap applied to THIS route only via the named 'share' throttler.
 */
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
  @ApiOperation({ summary: 'List share links for a session recap', description: 'dm role required. Returns display metadata only (tokenPrefix) — raw tokens are never retrievable after creation.' })
  @ApiResponse({ status: 200, description: 'Share links for this session.' })
  async list(@Param('sessionId', ParseIntPipe) sessionId: number, @CurrentUser() user: RequestUser): Promise<SessionShare[]> {
    const row = await this.sessions.getRowOrThrow(sessionId);
    await this.access.requireRole(user, row.campaignId, 'dm');
    return this.shares.listForSession(sessionId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a read-only share link for a session recap', description: 'dm role required. The raw `token` is returned ONCE — the public URL is /share/<token>, resolved via GET /shared/recaps/<token>.' })
  @ApiResponse({ status: 201, description: 'Share link created; `token` is shown once — copy the URL now.' })
  async create(@Param('sessionId', ParseIntPipe) sessionId: number, @CurrentUser() user: RequestUser): Promise<SessionShareCreated> {
    const row = await this.sessions.getRowOrThrow(sessionId);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.shares.create(row, user, role);
  }

  @Delete(':shareId')
  @ApiOperation({ summary: 'Revoke a share link', description: 'dm role required. The link stops resolving immediately.' })
  @ApiResponse({ status: 200, description: 'Revoked.' })
  @ApiResponse({ status: 404, description: 'Share link not found (or belongs to a different session).' })
  async revoke(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('shareId', ParseIntPipe) shareId: number,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    const row = await this.sessions.getRowOrThrow(sessionId);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.shares.revoke(shareId, row, user, role);
  }
}

@ApiTags('sessions')
@Controller('shared')
export class SharedRecapController {
  constructor(private readonly shares: SessionSharesService) {}

  @Public()
  @SHARE_THROTTLE
  @Get('recaps/:token')
  @ApiOperation({ summary: 'Read a shared session recap (no auth)', description: 'Public, rate-limited per IP. Resolves an unguessable share token to a read-only recap payload. Uniform 404 for unknown, malformed, or revoked tokens.' })
  @ApiResponse({ status: 200, description: 'Campaign name + session recap.' })
  @ApiResponse({ status: 404, description: 'Share link not found or revoked.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async read(@Param('token') token: string): Promise<SharedRecap> {
    return this.shares.resolveSharedRecap(token);
  }
}
