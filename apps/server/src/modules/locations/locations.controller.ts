import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { LocationsService } from './locations.service';
import { LocationCreateDto, LocationUpdateDto, LocationDiscoverDto } from './locations.dto';

@ApiTags('locations')
@Controller('campaigns/:campaignId/locations')
export class CampaignLocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly access: CampaignAccessService,
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
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.locations.create(campaignId, body, user, role);
  }
}

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.locations.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.locations.getOrThrow(id, role);
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: LocationUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.locations.getRowOrThrow(id);
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
