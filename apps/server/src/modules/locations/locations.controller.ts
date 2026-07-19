import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { LocationCreate, LocationUpdate } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { isProposed } from '../../common/proposed.util';
import { LocationsService } from './locations.service';
import { LocationCreateDto, LocationUpdateDto, LocationDiscoverDto } from './locations.dto';

@ApiTags('locations')
@Controller('campaigns/:campaignId/locations')
export class CampaignLocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly access: CampaignAccessService,
    private readonly proposals: ProposalRecordsService,
  ) {}

  @Get()
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.locations.listForCampaign(campaignId, role);
  }

  @Post()
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: LocationCreateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (isProposed(proposed)) {
      const role = await this.access.requireMember(user, campaignId);
      const validated = LocationCreate.parse(body);
      const proposal = await this.proposals.create(campaignId, 'location', null, 'create', validated, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, campaignId, 'dm');
    res.status(201);
    return this.locations.create(campaignId, body, user, role);
  }
}

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly access: CampaignAccessService,
    private readonly proposals: ProposalRecordsService,
  ) {}

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.locations.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.locations.getOrThrow(id, role);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: LocationUpdateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.locations.getRowOrThrow(id);
    if (isProposed(proposed)) {
      const role = await this.access.requireMember(user, row.campaignId);
      const validated = LocationUpdate.parse(body);
      const proposal = await this.proposals.create(row.campaignId, 'location', id, 'update', validated, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.locations.update(id, body, user, role);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.locations.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.locations.remove(id, user, role);
  }

  @Post(':id/discover')
  async discover(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: LocationDiscoverDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.locations.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.locations.discover(id, body.status, user, role);
  }
}
