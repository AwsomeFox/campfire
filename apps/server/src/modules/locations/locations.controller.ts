import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { RequestUser } from '../../common/user.types';
import { LocationsService } from './locations.service';
import { LocationCreateDto, LocationUpdateDto, LocationDiscoverDto } from './locations.dto';

@ApiTags('locations')
@Controller('campaigns/:campaignId/locations')
export class CampaignLocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    return this.locations.listForCampaign(campaignId, user.role);
  }

  @Post()
  @Roles('dm')
  create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: LocationCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.locations.create(campaignId, body, user);
  }
}

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.locations.getOrThrow(id, user.role);
  }

  @Patch(':id')
  @Roles('dm')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: LocationUpdateDto, @CurrentUser() user: RequestUser) {
    return this.locations.update(id, body, user);
  }

  @Delete(':id')
  @Roles('dm')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.locations.remove(id, user);
  }

  @Post(':id/discover')
  @Roles('dm')
  discover(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: LocationDiscoverDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.locations.discover(id, body.status, user);
  }
}
