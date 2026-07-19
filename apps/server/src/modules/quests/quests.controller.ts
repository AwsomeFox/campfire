import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { QuestsService } from './quests.service';
import {
  QuestCreateDto,
  QuestUpdateDto,
  QuestStatusPatchDto,
  ObjectiveCreateDto,
  ObjectivePatchDto,
} from './quests.dto';

@ApiTags('quests')
@Controller('campaigns/:campaignId/quests')
export class CampaignQuestsController {
  constructor(
    private readonly quests: QuestsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('status') status: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    return this.quests.listForCampaignByStatus(campaignId, status, role);
  }

  @Post()
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: QuestCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.quests.create(campaignId, body, user, role);
  }
}

@ApiTags('quests')
@Controller('quests')
export class QuestsController {
  constructor(
    private readonly quests: QuestsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.quests.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.quests.getWithObjectivesOrThrow(id, role);
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: QuestUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.quests.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.quests.update(id, body, user, role);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.quests.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.quests.remove(id, user, role);
  }

  @Post(':id/status')
  async setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: QuestStatusPatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.quests.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.quests.setStatus(id, body, user, role);
  }

  @Post(':id/objectives')
  async addObjective(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ObjectiveCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.quests.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.quests.addObjective(id, body, user, role);
  }

  @Patch(':id/objectives/:oid')
  async patchObjective(
    @Param('id', ParseIntPipe) id: number,
    @Param('oid', ParseIntPipe) oid: number,
    @Body() body: ObjectivePatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.quests.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.quests.patchObjective(id, oid, body, user, role);
  }

  @Delete(':id/objectives/:oid')
  async removeObjective(
    @Param('id', ParseIntPipe) id: number,
    @Param('oid', ParseIntPipe) oid: number,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.quests.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.quests.removeObjective(id, oid, user, role);
  }
}
