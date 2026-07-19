import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignsService } from './campaigns.service';
import { CampaignCreateDto, CampaignUpdateDto } from './campaigns.dto';

@ApiTags('campaigns')
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  list() {
    return this.campaigns.list();
  }

  @Post()
  @Roles('dm')
  create(@Body() body: CampaignCreateDto, @CurrentUser() user: RequestUser) {
    return this.campaigns.create(body, user);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.getOrThrow(id);
  }

  @Patch(':id')
  @Roles('dm')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: CampaignUpdateDto, @CurrentUser() user: RequestUser) {
    return this.campaigns.update(id, body, user);
  }

  @Delete(':id')
  @Roles('dm')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.campaigns.remove(id, user);
  }

  @Get(':id/summary')
  summary(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.campaigns.summary(id, user);
  }
}
