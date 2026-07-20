import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { StorylinesService } from './storylines.service';
import {
  StoryArcCreateDto,
  StoryArcUpdateDto,
  StoryArcStatusPatchDto,
  StoryBeatCreateDto,
  StoryBeatUpdateDto,
  StoryBeatStatusPatchDto,
  StoryBranchCreateDto,
} from './storylines.dto';

/**
 * Storylines (issue #27) — a DM-only branching arc/beat planner. EVERY route here
 * requires `dm` role, reads included: this is prep content the players must never
 * see. Reads pass `allowArchived` so an archived campaign's plan stays viewable;
 * writes use the default (writable) requireRole so a paused/completed campaign is
 * read-only, consistent with the rest of the app.
 */
@ApiTags('storylines')
@Controller('campaigns/:campaignId/arcs')
export class CampaignArcsController {
  constructor(
    private readonly storylines: StorylinesService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List story arcs (with beats and branches)', description: 'DM only.' })
  @ApiResponse({ status: 200, description: 'Arcs, each embedding its ordered beats (each beat embeds its branches).' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.storylines.listArcsWithBeats(campaignId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a story arc', description: 'DM only.' })
  @ApiResponse({ status: 201, description: 'Created arc.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: StoryArcCreateDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    res.status(201);
    return this.storylines.createArc(campaignId, body, user, role);
  }
}

@ApiTags('storylines')
@Controller('arcs')
export class ArcsController {
  constructor(
    private readonly storylines: StorylinesService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a story arc (with beats and branches)', description: 'DM only.' })
  @ApiResponse({ status: 200, description: 'Arc with its beats and branches.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.storylines.getArcRowOrThrow(id);
    await this.access.requireRole(user, row.campaignId, 'dm', { allowArchived: true });
    return this.storylines.getArcWithBeatsOrThrow(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a story arc', description: 'DM only.' })
  @ApiResponse({ status: 200, description: 'Updated arc.' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: StoryArcUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.storylines.getArcRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.storylines.updateArc(id, body, user, role);
  }

  @Post(':id/status')
  @ApiOperation({ summary: "Set a story arc's status", description: 'DM only. planned | active | resolved | abandoned.' })
  @ApiResponse({ status: 201, description: 'Updated arc.' })
  async setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: StoryArcStatusPatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.storylines.getArcRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.storylines.setArcStatus(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a story arc', description: 'DM only. Cascades to its beats and any branches touching them.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.storylines.getArcRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.storylines.removeArc(id, user, role);
  }

  @Post(':id/beats')
  @ApiOperation({ summary: 'Add a beat to an arc', description: 'DM only.' })
  @ApiResponse({ status: 201, description: 'Created beat.' })
  async addBeat(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: StoryBeatCreateDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.storylines.getArcRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    res.status(201);
    return this.storylines.addBeat(id, body, user, role);
  }
}

@ApiTags('storylines')
@Controller('beats')
export class BeatsController {
  constructor(
    private readonly storylines: StorylinesService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a beat (with branches)', description: 'DM only.' })
  @ApiResponse({ status: 200, description: 'Beat with its branches.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.storylines.getBeatRowOrThrow(id);
    await this.access.requireRole(user, row.campaignId, 'dm', { allowArchived: true });
    return this.storylines.getBeatWithBranchesOrThrow(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a beat', description: 'DM only.' })
  @ApiResponse({ status: 200, description: 'Updated beat.' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: StoryBeatUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.storylines.getBeatRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.storylines.updateBeat(id, body, user, role);
  }

  @Post(':id/status')
  @ApiOperation({ summary: "Set a beat's status", description: 'DM only. planned | active | done | skipped.' })
  @ApiResponse({ status: 201, description: 'Updated beat.' })
  async setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: StoryBeatStatusPatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.storylines.getBeatRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.storylines.setBeatStatus(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a beat', description: 'DM only. Also removes any branch pointing at or out of it.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.storylines.getBeatRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.storylines.removeBeat(id, user, role);
  }

  @Post(':id/branches')
  @ApiOperation({
    summary: 'Add a branch (next-option) to a beat',
    description: 'DM only. `label` is the trigger/condition; optional `toBeatId` targets a beat in the same campaign.',
  })
  @ApiResponse({ status: 201, description: 'Created branch.' })
  @ApiResponse({ status: 400, description: 'toBeatId does not exist in this campaign.' })
  async addBranch(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: StoryBranchCreateDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.storylines.getBeatRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    res.status(201);
    return this.storylines.addBranch(id, body, user, role);
  }

  @Delete(':id/branches/:branchId')
  @ApiOperation({ summary: 'Remove a branch from a beat', description: 'DM only.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async removeBranch(
    @Param('id', ParseIntPipe) id: number,
    @Param('branchId', ParseIntPipe) branchId: number,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.storylines.getBeatRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.storylines.removeBranch(id, branchId, user, role);
  }
}
