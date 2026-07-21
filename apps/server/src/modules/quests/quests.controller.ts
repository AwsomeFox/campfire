import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { QuestCreate, QuestUpdate } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { requireWriteMode } from '../../common/proposed.util';
import { Proposable } from '../../common/decorators/proposable.decorator';
import { QuestsService } from './quests.service';
import {
  QuestCreateDto,
  QuestUpdateDto,
  QuestStatusPatchDto,
  ObjectiveCreateDto,
  ObjectivePatchDto,
  ObjectiveReorderDto,
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

  @Get('changes')
  @ApiOperation({
    summary: "What changed since last session",
    description:
      'Requires campaign membership. Returns `{ since, quests }` — the visible quests whose updatedAt is at/after `since`, in board order. `since` defaults to the campaign\'s latest session date; pass `?since=<ISO>` to diff against a different instant (e.g. the player\'s last visit). `since` is null (and quests empty) when the campaign has no sessions. Hidden quests are excluded and dmSecret stripped for non-dm.',
  })
  @ApiQuery({ name: 'since', required: false, type: String, description: 'ISO-8601 instant to diff against. Defaults to the latest session date.' })
  @ApiResponse({ status: 200, description: 'Changed quests plus the reference instant.' })
  async changes(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('since') since: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    return this.quests.changesSince(campaignId, since, role);
  }

  @Post()
  @ApiOperation({ summary: 'Create a quest', description: 'dm role required, unless `?proposed=true` — then any member may submit it as a pending proposal.' })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending proposal instead of writing directly.' })
  @ApiResponse({ status: 201, description: 'Created quest (direct write).' })
  @ApiResponse({ status: 202, description: 'Pending proposal created (proposed=true).' })
  @Proposable()
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: QuestCreateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (requireWriteMode(user, proposed)) {
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
  @Proposable()
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: QuestUpdateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.quests.getRowOrThrow(id);
    if (requireWriteMode(user, proposed)) {
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
  @Proposable()
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.quests.getRowOrThrow(id);
    if (requireWriteMode(user, proposed)) {
      const role = await this.access.requireMember(user, row.campaignId, { write: true });
      const proposal = await this.proposals.create(row.campaignId, 'quest', id, 'delete', {}, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.quests.remove(id, user, role);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore a trashed quest', description: 'dm role required. Undo a soft-delete (issue #116) — the quest returns exactly as it was.' })
  @ApiResponse({ status: 201, description: 'Restored quest.' })
  async restore(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.quests.getRowOrThrow(id, true);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.quests.restore(id, user, role);
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

  @Post(':id/objectives/reorder')
  @ApiOperation({ summary: 'Reorder a quest\'s objectives', description: 'dm role required. Body: { objectiveIds } — a permutation of the quest\'s objective ids; sortOrder is reassigned by position.' })
  @ApiResponse({ status: 201, description: 'Objectives in their new order.' })
  @ApiResponse({ status: 400, description: 'objectiveIds is not a permutation of this quest\'s objective ids.' })
  async reorderObjectives(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ObjectiveReorderDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.quests.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.quests.reorderObjectives(id, body, user, role);
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
