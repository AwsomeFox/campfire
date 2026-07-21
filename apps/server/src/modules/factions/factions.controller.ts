import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { FactionCreate, FactionUpdate } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { FactionsService } from './factions.service';
import { FactionCreateDto, FactionUpdateDto, FactionReputationDto } from './factions.dto';

@ApiTags('factions')
@Controller('campaigns/:campaignId/factions')
export class CampaignFactionsController {
  constructor(
    private readonly factions: FactionsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List factions in a campaign', description: 'Requires campaign membership. dmSecret is stripped and hidden factions dropped for non-dm.' })
  @ApiResponse({ status: 200, description: 'Factions in the campaign.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.factions.listForCampaign(campaignId, role);
  }

  @Post()
  @ApiOperation({ summary: 'Create a faction', description: 'dm role required.' })
  @ApiResponse({ status: 201, description: 'Created faction.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: FactionCreateDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    const validated = FactionCreate.parse(body);
    res.status(201);
    return this.factions.create(campaignId, validated, user, role);
  }
}

@ApiTags('factions')
@Controller('factions')
export class FactionsController {
  constructor(
    private readonly factions: FactionsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a faction (with its member NPCs)', description: 'Requires campaign membership. dmSecret is stripped for non-dm; a hidden faction 404s for non-dm.' })
  @ApiResponse({ status: 200, description: 'Faction with members.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.factions.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.factions.getWithMembersOrThrow(id, role);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a faction', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Updated faction.' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: FactionUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.factions.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    // Split off the optimistic-concurrency guard (#157) from the entity fields.
    const { expectedUpdatedAt, ...fields } = body;
    const validated = FactionUpdate.parse(fields);
    return this.factions.update(id, validated, user, role, { expectedUpdatedAt });
  }

  @Patch(':id/reputation')
  @ApiOperation({
    summary: 'Adjust a faction party-reputation',
    description: 'dm role required. Pass `delta` to bump the score, `reputation` to set it outright, and/or `standing` to set the label.',
  })
  @ApiResponse({ status: 200, description: 'Updated faction.' })
  async setReputation(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: FactionReputationDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.factions.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.factions.adjustReputation(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a faction', description: 'dm role required. NPCs pinned to it are unlinked (factionId nulled).' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.factions.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.factions.remove(id, user, role);
  }
}
