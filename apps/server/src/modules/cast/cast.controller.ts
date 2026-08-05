import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Param, ParseIntPipe, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type {
  CastSession,
  CastSessionCreated,
  CastSessionMutationResult,
  CampaignSummary,
  Encounter,
  EncounterWithCombatants,
} from '@campfire/schema';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { contentDispositionHeader } from '../attachments/filename';
import {
  THROTTLE_AUTH,
  AUTH_THROTTLE_LIMIT,
  AUTH_THROTTLE_TTL_MS,
  THROTTLE_SHARE,
  SHARE_THROTTLE_TTL_MS,
} from '../../common/throttle.constants';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { CastService } from './cast.service';
import { CastSessionCreateDto, CastSessionExitDto } from './cast.dto';

/**
 * The exit-PIN check runs a full scrypt verify on an UNauthenticated route against
 * a 6-digit secret. Both halves of that (CPU-per-request DoS and PIN brute force)
 * are exactly what the strict auth bucket exists for — the loose 300/min default is
 * not enough. ThrottlerGuard keys counters per route+IP, so reusing the `auth`
 * throttler here never interferes with the login/setup counters.
 */
const CAST_EXIT_THROTTLE = Throttle({ [THROTTLE_AUTH]: { limit: AUTH_THROTTLE_LIMIT, ttl: AUTH_THROTTLE_TTL_MS } });

/**
 * Map bytes are the one cast response that can cost real CPU: a fog re-render runs
 * whenever the revealed set changes and misses `EncounterMapService`'s render cache.
 * The global `default` bucket already bounds this route at 300/min; this tightens it
 * to a rate a kiosk cannot legitimately exceed while still leaving a wide margin.
 *
 * Deliberately NOT the strict auth bucket (10/min): the cast `<img>` URL is keyed on
 * `encounter.updatedAt` and served `no-store`, so every HP change or turn advance during
 * a fight mints a new URL and forces a refetch. A busy combat round can legitimately
 * exceed ten map fetches a minute, and throttling those would blank the TV mid-fight —
 * turning a DoS guard into a self-inflicted outage on the exact surface this feature
 * exists to serve. 120/min is ~2/s sustained: far above any real display, far below
 * what a render loop would need to hurt the server.
 */
const CAST_MAP_THROTTLE_LIMIT = 120;
const CAST_MAP_THROTTLE = Throttle({ [THROTTLE_SHARE]: { limit: CAST_MAP_THROTTLE_LIMIT, ttl: SHARE_THROTTLE_TTL_MS } });

@ApiTags('cast')
@Controller('campaigns/:campaignId/cast-sessions')
export class CampaignCastSessionsController {
  constructor(
    private readonly cast: CastService,
    private readonly access: CampaignAccessService,
    private readonly events: CampaignEventsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List active Player Display cast sessions',
    description: 'DM role required. Returns metadata only; raw cast tokens and exit PINs are never retrievable after creation.',
  })
  @ApiResponse({ status: 200, description: 'Active cast session metadata.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser): Promise<CastSession[]> {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.cast.listForCampaign(campaignId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a Player Display cast session',
    description: 'DM role required. The expiring raw token and exit PIN are shown once; copy them before closing the dialog.',
  })
  @ApiResponse({ status: 201, description: 'Cast session created.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: CastSessionCreateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<CastSessionCreated> {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.cast.create(campaignId, body, user, role);
  }

  @Delete(':castSessionId')
  @ApiOperation({ summary: 'Revoke a Player Display cast session', description: 'DM role required. The cast URL stops resolving immediately.' })
  @ApiResponse({ status: 200, description: 'Revoked.' })
  async revoke(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('castSessionId', ParseIntPipe) castSessionId: number,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    const role = await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.cast.revoke(campaignId, castSessionId, user, role);
  }

  @Delete()
  @ApiOperation({ summary: 'Revoke every Player Display cast session in a campaign', description: 'DM role required.' })
  @ApiResponse({ status: 200, description: 'Number of cast sessions revoked.' })
  async revokeAll(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
  ): Promise<CastSessionMutationResult> {
    const role = await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.cast.revokeAll(campaignId, user, role);
  }

  @Post('scene')
  @HttpCode(200)
  @ApiOperation({ summary: 'Broadcast a new scene to all player displays', description: 'DM or co-DM role required.' })
  @ApiResponse({ status: 200, description: 'Broadcasted.' })
  async broadcastScene(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body('scene') scene: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.access.requireRole(user, campaignId, 'dm');
    this.events.emit({ type: 'player-display-scene', campaignId, scene });
  }
}

@ApiTags('cast')
@Controller('cast/:token')
export class PublicCastController {
  constructor(private readonly cast: CastService) {}

  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Get('summary')
  @ApiOperation({
    summary: 'Read the server-redacted cast campaign summary',
    description: 'Public capability endpoint. Always returns a viewer-safe projection; invalid, revoked, expired, archived, and deleted sessions 404 uniformly.',
  })
  @ApiResponse({ status: 200, description: 'Viewer-safe campaign summary.' })
  async summary(@Param('token') token: string): Promise<CampaignSummary> {
    return this.cast.summary(token);
  }

  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Get('encounters')
  @ApiOperation({
    summary: 'List server-redacted cast encounters',
    description: 'Only `status=running` is supported for Player Display. Results are projected as viewer.',
  })
  @ApiResponse({ status: 200, description: 'Viewer-safe running encounter list.' })
  @ApiResponse({ status: 404, description: 'Cast session is invalid, revoked, or expired.' })
  async encounters(@Param('token') token: string, @Query('status') status?: string): Promise<Encounter[]> {
    // An unsupported status used to short-circuit `200 []` WITHOUT validating the token,
    // telling a stale shared-TV link its request had succeeded and contradicting the
    // uniform 404 this endpoint's docstring promises. Validate only on that branch:
    // `runningEncounters` already resolves the capability itself, and resolveActive()
    // bumps access_count and writes the access timestamps, so validating up front would
    // double-count every kiosk poll and issue two UPDATEs per refresh (Devin review on
    // #1438 — first for the missing 404, then for the double write my first fix caused).
    if (status !== undefined && status !== 'running') {
      this.cast.assertActive(token);
      return [];
    }
    return this.cast.runningEncounters(token);
  }

  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Get('encounters/:encounterId')
  @ApiOperation({ summary: 'Read a server-redacted cast encounter', description: 'Capability endpoint; returns viewer-safe combatants only.' })
  @ApiResponse({ status: 200, description: 'Viewer-safe encounter with combatants.' })
  async encounter(
    @Param('token') token: string,
    @Param('encounterId', ParseIntPipe) encounterId: number,
  ): Promise<EncounterWithCombatants> {
    return this.cast.encounter(token, encounterId);
  }

  /**
   * Battle-map pixels for the cast display (issue #547).
   *
   * An <img> cannot carry an Authorization header, so the cast page cannot reuse
   * GET /encounters/:id/map — that route authenticates from the session cookie,
   * which on a shared TV still holding the DM's cookie would return the *unfogged
   * source map*. Serving the bytes off the capability instead pins the viewer role
   * server-side, so the fog renderer always runs.
   */
  @Public()
  @CAST_MAP_THROTTLE
  @Get('encounters/:encounterId/map')
  @ApiOperation({
    summary: 'Get the fog-rendered battle-map image for a cast encounter',
    description:
      'Public capability endpoint. Always projected as `viewer`: when fog conceals pixels the response is an opaque ' +
      'server-rendered PNG of the revealed regions only, and the source attachment is never reachable. Responses are ' +
      'private/no-store and byte ranges are rejected so fog revisions cannot leak through caches.',
  })
  @ApiQuery({ name: 'size', required: false, enum: ['thumb'], description: 'Omit for full resolution; `thumb` caps the longest edge at 512px.' })
  @ApiQuery({ name: 'revision', required: false, type: String, description: 'Opaque client cache-buster; ignored by the server.' })
  @ApiResponse({ status: 200, description: 'Viewer-safe image bytes.' })
  @ApiResponse({ status: 404, description: 'Cast session, encounter, or map is absent — or the encounter is not running.' })
  @ApiResponse({ status: 416, description: 'Range requests are not supported on fog-specific map views.' })
  @ApiResponse({ status: 429, description: 'Too many map requests from this client.' })
  async map(
    @Param('token') token: string,
    @Param('encounterId', ParseIntPipe) encounterId: number,
    @Req() req: Request,
    @Res() res: Response,
    @Query('size') size?: string,
  ): Promise<void> {
    if (size !== undefined && size !== 'thumb') {
      throw new BadRequestException("Unsupported size — allowed: 'thumb' (or omit for the original)");
    }
    if (req.headers.range !== undefined) {
      res
        .status(416)
        .set({
          'Accept-Ranges': 'none',
          'Cache-Control': 'private, no-store',
          'Referrer-Policy': 'no-referrer',
          'Content-Range': 'bytes */0',
          Vary: 'Cookie, Authorization, x-dev-role, x-dev-user',
        })
        .end();
      return;
    }
    const view = await this.cast.encounterMap(token, encounterId, size === 'thumb' ? 'thumb' : 'original');
    res
      .status(200)
      .set({
        'Content-Type': view.mime,
        'Content-Length': String(view.bytes.length),
        'Content-Disposition': contentDispositionHeader(view.filename, 'inline'),
        ETag: view.etag,
        'Cache-Control': 'private, no-store, max-age=0',
        'Referrer-Policy': 'no-referrer',
        Pragma: 'no-cache',
        Expires: '0',
        'Accept-Ranges': 'none',
        Vary: 'Cookie, Authorization, x-dev-role, x-dev-user',
        'X-Campfire-Map-View': view.protected ? 'fog-protected' : 'fully-revealed',
      })
      .end(view.bytes);
  }

  @Public()
  @CAST_EXIT_THROTTLE
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Post('exit')
  @ApiOperation({
    summary: 'Verify the cast exit PIN',
    description: 'Public capability endpoint used by the kiosk exit affordance. Rate limited per IP like the auth routes.',
  })
  @ApiResponse({ status: 201, description: 'PIN accepted.' })
  @ApiResponse({ status: 429, description: 'Too many exit-PIN attempts from this IP.' })
  async exit(@Param('token') token: string, @Body() body: CastSessionExitDto): Promise<{ ok: true }> {
    return this.cast.verifyExitPin(token, body.pin);
  }
}
