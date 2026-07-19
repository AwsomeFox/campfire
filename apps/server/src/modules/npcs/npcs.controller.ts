import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { NpcCreate, NpcUpdate } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { isProposed } from '../../common/proposed.util';
import { NpcsService } from './npcs.service';
import { NpcCreateDto, NpcUpdateDto } from './npcs.dto';

@ApiTags('npcs')
@Controller('campaigns/:campaignId/npcs')
export class CampaignNpcsController {
  constructor(
    private readonly npcs: NpcsService,
    private readonly access: CampaignAccessService,
    private readonly proposals: ProposalRecordsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List NPCs in a campaign', description: 'Requires campaign membership. dmSecret is stripped for non-dm.' })
  @ApiResponse({ status: 200, description: 'NPCs in the campaign.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.npcs.listForCampaign(campaignId, role);
  }

  @Post()
  @ApiOperation({ summary: 'Create an NPC', description: 'dm role required, unless `?proposed=true` — then any member may submit it as a pending proposal.' })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending proposal instead of writing directly.' })
  @ApiResponse({ status: 201, description: 'Created NPC (direct write).' })
  @ApiResponse({ status: 202, description: 'Pending proposal created (proposed=true).' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: NpcCreateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (isProposed(proposed)) {
      const role = await this.access.requireMember(user, campaignId);
      const validated = NpcCreate.parse(body);
      const proposal = await this.proposals.create(campaignId, 'npc', null, 'create', validated, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, campaignId, 'dm');
    res.status(201);
    return this.npcs.create(campaignId, body, user, role);
  }
}

@ApiTags('npcs')
@Controller('npcs')
export class NpcsController {
  constructor(
    private readonly npcs: NpcsService,
    private readonly access: CampaignAccessService,
    private readonly proposals: ProposalRecordsService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get an NPC', description: 'Requires campaign membership. dmSecret is stripped for non-dm.' })
  @ApiResponse({ status: 200, description: 'NPC.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.npcs.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.npcs.getOrThrow(id, role);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an NPC', description: 'dm role required, unless `?proposed=true` — then any member may submit it as a pending proposal.' })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending proposal instead of writing directly.' })
  @ApiResponse({ status: 200, description: 'Updated NPC (direct write).' })
  @ApiResponse({ status: 202, description: 'Pending proposal created (proposed=true).' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: NpcUpdateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.npcs.getRowOrThrow(id);
    if (isProposed(proposed)) {
      const role = await this.access.requireMember(user, row.campaignId);
      const validated = NpcUpdate.parse(body);
      const proposal = await this.proposals.create(row.campaignId, 'npc', id, 'update', validated, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.npcs.update(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an NPC', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.npcs.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.npcs.remove(id, user, role);
  }
}
