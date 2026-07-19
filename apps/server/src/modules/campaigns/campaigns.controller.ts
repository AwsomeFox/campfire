import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignsService } from './campaigns.service';
import { CampaignCreateDto, CampaignUpdateDto } from './campaigns.dto';

@ApiTags('campaigns')
@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.campaigns.listForUser(user);
  }

  @Post()
  create(@Body() body: CampaignCreateDto, @CurrentUser() user: RequestUser) {
    return this.campaigns.create(body, user);
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, id);
    return this.campaigns.getOrThrow(id);
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: CampaignUpdateDto, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.campaigns.update(id, body, user);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.campaigns.remove(id, user);
  }

  @Get(':id/summary')
  async summary(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, id);
    return this.campaigns.summary(id, role);
  }
}
