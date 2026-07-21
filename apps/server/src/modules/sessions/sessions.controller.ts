import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import type { SessionAttendee } from '@campfire/schema';
import { SessionCreate, SessionUpdate } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { requireWriteMode } from '../../common/proposed.util';
import { Proposable } from '../../common/decorators/proposable.decorator';
import { parsePageParams } from '../../common/pagination';
import { SessionsService } from './sessions.service';
import { SessionCreateDto, SessionUpdateDto, SessionAttendanceSetDto } from './sessions.dto';

/** Upper bound for `?limit` on the sessions list (issue #71). */
const SESSIONS_LIST_MAX_LIMIT = 200;

@ApiTags('sessions')
@Controller('campaigns/:campaignId/sessions')
export class CampaignSessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly access: CampaignAccessService,
    private readonly proposals: ProposalRecordsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List sessions (play logs) in a campaign',
    description:
      'Requires campaign membership. dmSecret is stripped for non-dm. Newest-first. Each item carries a short ' +
      '`recapExcerpt` instead of the full recap body (fetch a single session for the full recap). Supports ' +
      'optional `?limit`/`?offset` paging (default: all sessions).',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max sessions to return (default: all, capped at 200).' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Sessions to skip, for paging (default 0).' })
  @ApiResponse({ status: 200, description: 'Sessions in the campaign (list-shape, with recapExcerpt).' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    return this.sessions.listForCampaign(campaignId, role, parsePageParams({ limit, offset }, SESSIONS_LIST_MAX_LIMIT));
  }

  @Post()
  @ApiOperation({ summary: 'Create a session log', description: 'dm role required, unless `?proposed=true` — then any member may submit it as a pending proposal.' })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending proposal instead of writing directly.' })
  @ApiResponse({ status: 201, description: 'Created session (direct write).' })
  @ApiResponse({ status: 202, description: 'Pending proposal created (proposed=true).' })
  @Proposable()
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SessionCreateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (requireWriteMode(user, proposed)) {
      const role = await this.access.requireMember(user, campaignId, { write: true });
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
  @ApiOperation({ summary: 'Get a session log', description: 'Requires campaign membership. dmSecret is stripped for non-dm.' })
  @ApiResponse({ status: 200, description: 'Session.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.sessions.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.sessions.getOrThrow(id, role);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a session log', description: 'dm role required, unless `?proposed=true` — then any member may submit it as a pending proposal.' })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending proposal instead of writing directly.' })
  @ApiResponse({ status: 200, description: 'Updated session (direct write).' })
  @ApiResponse({ status: 202, description: 'Pending proposal created (proposed=true).' })
  @Proposable()
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: SessionUpdateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.sessions.getRowOrThrow(id);
    if (requireWriteMode(user, proposed)) {
      const role = await this.access.requireMember(user, row.campaignId, { write: true });
      const validated = SessionUpdate.parse(body);
      const proposal = await this.proposals.create(row.campaignId, 'session', id, 'update', validated, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.sessions.update(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a session log',
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
    const row = await this.sessions.getRowOrThrow(id);
    if (requireWriteMode(user, proposed)) {
      const role = await this.access.requireMember(user, row.campaignId, { write: true });
      const proposal = await this.proposals.create(row.campaignId, 'session', id, 'delete', {}, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.sessions.remove(id, user, role);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore a trashed session', description: 'dm role required. Undo a soft-delete (issue #116) — the session (recap, attendance, share links) returns exactly as it was.' })
  @ApiResponse({ status: 201, description: 'Restored session.' })
  async restore(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.sessions.getRowOrThrow(id, true);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.sessions.restore(id, user, role);
  }

  @Get(':id/attendance')
  @ApiOperation({
    summary: 'Get session attendance',
    description:
      'Requires campaign membership. The characters that played this session (issue #121) — the West Marches ' +
      '"who was there" record. Empty when attendance was never set.',
  })
  @ApiResponse({ status: 200, description: 'Attendees (characters) for this session.' })
  async getAttendance(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<SessionAttendee[]> {
    const row = await this.sessions.getRowOrThrow(id);
    await this.access.requireMember(user, row.campaignId);
    return this.sessions.getAttendance(id);
  }

  @Put(':id/attendance')
  @ApiOperation({
    summary: 'Set session attendance',
    description:
      'dm role required. Replaces the session\'s attendance with exactly the given characterIds (empty array clears ' +
      'it). Every id must be a character in the session\'s own campaign — an id from another campaign 400s.',
  })
  @ApiResponse({ status: 200, description: 'The session\'s updated attendee list.' })
  async setAttendance(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: SessionAttendanceSetDto,
    @CurrentUser() user: RequestUser,
  ): Promise<SessionAttendee[]> {
    const row = await this.sessions.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.sessions.setAttendance(id, body.characterIds, user, role);
  }
}
