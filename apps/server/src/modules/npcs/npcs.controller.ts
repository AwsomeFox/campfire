import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { NpcsService } from './npcs.service';
import { NpcCreateDto, NpcUpdateDto } from './npcs.dto';

@ApiTags('npcs')
@Controller('campaigns/:campaignId/npcs')
export class CampaignNpcsController {
  constructor(
    private readonly npcs: NpcsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.npcs.listForCampaign(campaignId, role);
  }

  @Post()
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: NpcCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.npcs.create(campaignId, body, user, role);
  }
}

@ApiTags('npcs')
@Controller('npcs')
export class NpcsController {
  constructor(
    private readonly npcs: NpcsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.npcs.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.npcs.getOrThrow(id, role);
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: NpcUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.npcs.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.npcs.update(id, body, user, role);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.npcs.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.npcs.remove(id, user, role);
  }
}
