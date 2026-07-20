import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'List quests in a campaign (with objectives)', description: 'Requires campaign membership. dmSecret is stripped for non-dm.' })
  @ApiQuery({ name: 'status', required: false, enum: ['available', 'active', 'completed', 'failed'], description: 'Filter to a single quest status.' })
  @ApiResponse({ status: 200, description: 'Quests, each with its objectives.' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('status') status: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    return this.quests.listForCampaignByStatusWithObjectives(campaignId, status, role);
  }

  @Post()
  @ApiOperation({ summary: 'Create a quest', description: 'dm role required, unless `?proposed=true` — then any member may submit it as a pending proposal.' })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending proposal instead of writing directly.' })
  @ApiResponse({ status: 201, description: 'Created quest (direct write).' })
  @ApiResponse({ status: 202, description: 'Pending proposal created (proposed=true).' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: QuestCreateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (isProposed(proposed)) {
      const role = await this.access.requireMember(user, campaignId, { write: true });
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
  @ApiOperation({ summary: 'Get a quest (with objectives)', description: 'Requires campaign membership. dmSecret is stripped for non-dm.' })
  @ApiResponse({ status: 200, description: 'Quest with objectives.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.quests.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.quests.getWithObjectivesOrThrow(id, role);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a quest', description: 'dm role required, unless `?proposed=true` — then any member may submit it as a pending proposal.' })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending proposal instead of writing directly.' })
  @ApiResponse({ status: 200, description: 'Updated quest (direct write).' })
  @ApiResponse({ status: 202, description: 'Pending proposal created (proposed=true).' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: QuestUpdateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.quests.getRowOrThrow(id);
    if (isProposed(proposed)) {
      const role = await this.access.requireMember(user, row.campaignId, { write: true });
      const validated = QuestUpdate.parse(body);
      const proposal = await this.proposals.create(row.campaignId, 'quest', id, 'update', validated, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.quests.update(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a quest',
    description: 'dm role required, unless `?proposed=true` — then any member may submit a deletion as a pending proposal.',
  })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending delete proposal instead of deleting directly.' })
  @ApiResponse({ status: 200, description: 'Deleted (direct write).' })
  @ApiResponse({ status: 202, description: 'Pending delete proposal created (proposed=true).' })
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.quests.getRowOrThrow(id);
    if (isProposed(proposed)) {
      const role = await this.access.requireMember(user, row.campaignId, { write: true });
      const proposal = await this.proposals.create(row.campaignId, 'quest', id, 'delete', {}, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.quests.remove(id, user, role);
  }

  @Post(':id/status')
  @ApiOperation({ summary: 'Set a quest\'s status', description: 'dm role required.' })
  @ApiResponse({ status: 201, description: 'Updated quest.' })
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
  @ApiOperation({ summary: 'Add an objective to a quest', description: 'dm role required.' })
  @ApiResponse({ status: 201, description: 'Created objective.' })
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
  @ApiOperation({ summary: 'Update an objective', description: "player role required to toggle `done`; changing `text`/`sortOrder` requires dm." })
  @ApiResponse({ status: 200, description: 'Updated objective.' })
  @ApiResponse({ status: 403, description: 'Player attempting to change text/sortOrder (only `done` is player-writable).' })
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
  @ApiOperation({ summary: 'Remove an objective', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
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
