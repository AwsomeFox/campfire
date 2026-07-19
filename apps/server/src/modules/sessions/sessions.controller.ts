import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { SessionCreate, SessionUpdate } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { isProposed } from '../../common/proposed.util';
import { SessionsService } from './sessions.service';
import { SessionCreateDto, SessionUpdateDto } from './sessions.dto';

@ApiTags('sessions')
@Controller('campaigns/:campaignId/sessions')
export class CampaignSessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly access: CampaignAccessService,
    private readonly proposals: ProposalRecordsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List sessions (play logs) in a campaign', description: 'Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Sessions in the campaign.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.sessions.listForCampaign(campaignId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a session log', description: 'dm role required, unless `?proposed=true` — then any member may submit it as a pending proposal.' })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending proposal instead of writing directly.' })
  @ApiResponse({ status: 201, description: 'Created session (direct write).' })
  @ApiResponse({ status: 202, description: 'Pending proposal created (proposed=true).' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SessionCreateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (isProposed(proposed)) {
      const role = await this.access.requireMember(user, campaignId);
      const validated = SessionCreate.parse(body);
      const proposal = await this.proposals.create(campaignId, 'session', null, 'create', validated, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, campaignId, 'dm');
    res.status(201);
    return this.sessions.create(campaignId, body, user, role);
  }
}

@ApiTags('sessions')
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly access: CampaignAccessService,
    private readonly proposals: ProposalRecordsService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a session log', description: 'Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Session.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.sessions.getRowOrThrow(id);
    await this.access.requireMember(user, row.campaignId);
    return this.sessions.getOrThrow(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a session log', description: 'dm role required, unless `?proposed=true` — then any member may submit it as a pending proposal.' })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending proposal instead of writing directly.' })
  @ApiResponse({ status: 200, description: 'Updated session (direct write).' })
  @ApiResponse({ status: 202, description: 'Pending proposal created (proposed=true).' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: SessionUpdateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.sessions.getRowOrThrow(id);
    if (isProposed(proposed)) {
      const role = await this.access.requireMember(user, row.campaignId);
      const validated = SessionUpdate.parse(body);
      const proposal = await this.proposals.create(row.campaignId, 'session', id, 'update', validated, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.sessions.update(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a session log', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.sessions.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.sessions.remove(id, user, role);
  }
}
