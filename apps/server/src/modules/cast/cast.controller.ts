import { Body, Controller, Delete, Get, Header, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CastService } from './cast.service';
import { CastSessionCreateDto, CastSessionExitDto } from './cast.dto';

@ApiTags('cast')
@Controller('campaigns/:campaignId/cast-sessions')
export class CampaignCastSessionsController {
  constructor(
    private readonly cast: CastService,
    private readonly access: CampaignAccessService,
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
  async encounters(@Param('token') token: string, @Query('status') status?: string): Promise<Encounter[]> {
    if (status !== undefined && status !== 'running') return [];
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

  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Post('exit')
  @ApiOperation({ summary: 'Verify the cast exit PIN', description: 'Public capability endpoint used by the kiosk exit affordance.' })
  @ApiResponse({ status: 201, description: 'PIN accepted.' })
  async exit(@Param('token') token: string, @Body() body: CastSessionExitDto): Promise<{ ok: true }> {
    return this.cast.verifyExitPin(token, body.pin);
  }
}
