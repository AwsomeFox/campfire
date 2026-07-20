import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignsService } from './campaigns.service';
import { CampaignCloneDto, CampaignCreateDto, CampaignImportDto, CampaignUpdateDto } from './campaigns.dto';

@ApiTags('campaigns')
@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List campaigns accessible to the caller', description: 'Everyone — server admins included — sees only campaigns they are a member of (capped further by an active token\'s campaignId, if scoped). Dev-auth users see all campaigns.' })
  @ApiResponse({ status: 200, description: 'Accessible campaigns.' })
  list(@CurrentUser() user: RequestUser) {
    return this.campaigns.listForUser(user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a campaign', description: 'Any authenticated user may create a campaign; the creator becomes its dm.' })
  @ApiResponse({ status: 201, description: 'Created campaign.' })
  create(@Body() body: CampaignCreateDto, @CurrentUser() user: RequestUser) {
    return this.campaigns.create(body, user);
  }

  @Post('import')
  @ApiOperation({
    summary: 'Import a campaign from a Campfire export',
    description:
      "Any authenticated user may import; the caller becomes the new campaign's dm. Accepts a Campfire JSON export document (the shape GET /campaigns/:id/export?format=json produces) and recreates the campaign with fresh ids and every intra-campaign reference remapped (location nesting, npc→location, quest parent/giver, combatant→character, note entity links, currentLocationId). Imported PCs come in unowned; attachments (metadata-only in the JSON export) are not recreated (mapAttachmentId/portraitUrl reset); status starts 'active'; an unknown ruleSystem is cleared. Members, audit and proposals are not imported.",
  })
  @ApiResponse({ status: 201, description: 'The newly created campaign.' })
  @ApiResponse({ status: 400, description: 'Body is not a valid Campfire export document.' })
  importCampaign(@Body() body: CampaignImportDto, @CurrentUser() user: RequestUser) {
    return this.campaigns.importCampaign(body, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a campaign', description: 'Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Campaign.' })
  @ApiResponse({ status: 403, description: 'Not a member of this campaign.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, id);
    return this.campaigns.getOrThrow(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a campaign', description: 'dm role required. On a paused/completed (archived, read-only) campaign only `status` may be changed — everything else requires un-archiving first.' })
  @ApiResponse({ status: 200, description: 'Updated campaign.' })
  @ApiResponse({ status: 403, description: 'Campaign is archived and the patch touches more than `status`.' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: CampaignUpdateDto, @CurrentUser() user: RequestUser) {
    // allowArchived: this is the un-archive path (PATCH {status:'active'}) —
    // CampaignsService.update() restricts an archived campaign to status-only patches.
    await this.access.requireRole(user, id, 'dm', { allowArchived: true });
    return this.campaigns.update(id, body, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a campaign', description: 'dm role required. Allowed even when the campaign is archived (paused/completed).' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    // allowArchived: deleting an archived campaign must not require un-archiving it first.
    await this.access.requireRole(user, id, 'dm', { allowArchived: true });
    return this.campaigns.remove(id, user);
  }

  @Post(':id/clone')
  @ApiOperation({ summary: 'Clone a campaign (duplicate or start from template)', description: "dm role required on the source campaign; the caller becomes the clone's dm. mode='full' (default) duplicates quests, npcs, locations, characters, sessions, notes and encounters with all cross-references remapped; mode='template' copies prep only (quests reset to available, objectives unchecked, locations unexplored) and strips play state. Members, attachments, tokens, audit history and proposals are never copied." })
  @ApiResponse({ status: 201, description: 'The newly created campaign.' })
  @ApiResponse({ status: 403, description: 'Not a dm of the source campaign.' })
  async clone(@Param('id', ParseIntPipe) id: number, @Body() body: CampaignCloneDto, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.campaigns.clone(id, body, user);
  }

  @Get(':id/summary')
  @ApiOperation({ summary: 'Campaign dashboard/AI-primer summary', description: 'Aggregates campaign metadata, current location, quests (with objectives), npcs, locations, characters, and sessions in one call — intended for dashboards and as an LLM context primer. Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Aggregate campaign summary.' })
  async summary(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, id);
    return this.campaigns.summary(id, role);
  }
}
