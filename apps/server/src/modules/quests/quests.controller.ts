import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { QuestCreate, QuestUpdate } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { isProposed } from '../../common/proposed.util';
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
    private readonly proposals: ProposalRecordsService,
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
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (isProposed(proposed)) {
      const role = await this.access.requireMember(user, campaignId);
      const validated = QuestCreate.parse(body);
      const proposal = await this.proposals.create(campaignId, 'quest', null, 'create', validated, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, campaignId, 'dm');
    res.status(201);
    return this.quests.create(campaignId, body, user, role);
  }
}

@ApiTags('quests')
@Controller('quests')
export class QuestsController {
  constructor(
    private readonly quests: QuestsService,
    private readonly access: CampaignAccessService,
    private readonly proposals: ProposalRecordsService,
  ) {}

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.quests.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.quests.getWithObjectivesOrThrow(id, role);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: QuestUpdateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.quests.getRowOrThrow(id);
    if (isProposed(proposed)) {
      const role = await this.access.requireMember(user, row.campaignId);
      const validated = QuestUpdate.parse(body);
      const proposal = await this.proposals.create(row.campaignId, 'quest', id, 'update', validated, user, role);
      res.status(202);
      return { proposal };
    }
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
