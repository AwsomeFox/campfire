import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { TimelineService } from './timeline.service';
import { TimelineEventCreateDto, TimelineEventUpdateDto, TimelineCalendarUpdateDto } from './timeline.dto';

@ApiTags('timeline')
@Controller('campaigns/:campaignId/timeline')
export class CampaignTimelineController {
  constructor(
    private readonly timeline: TimelineService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List in-world timeline events for a campaign',
    description: 'Requires campaign membership. Ordered by DM-controlled sortIndex (then id). dmSecret is stripped and hidden events are excluded for non-DM.',
  })
  @ApiResponse({ status: 200, description: 'Timeline events in narrative order.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.timeline.listEvents(campaignId, role);
  }

  @Post()
  @ApiOperation({ summary: 'Create a timeline event', description: 'dm role required.' })
  @ApiResponse({ status: 201, description: 'Created timeline event.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: TimelineEventCreateDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    res.status(201);
    return this.timeline.createEvent(campaignId, body, user, role);
  }

  @Get('calendar')
  @ApiOperation({
    summary: "Get the campaign's current in-world date",
    description: 'Requires campaign membership. Returns an empty default if none has been set yet (never 404s).',
  })
  @ApiResponse({ status: 200, description: 'The campaign calendar (current in-world date + note).' })
  async getCalendar(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.timeline.getCalendar(campaignId);
  }

  @Put('calendar')
  @ApiOperation({ summary: "Set the campaign's current in-world date", description: 'dm role required. Upserts the single per-campaign calendar row.' })
  @ApiResponse({ status: 200, description: 'The updated campaign calendar.' })
  async setCalendar(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: TimelineCalendarUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.timeline.setCalendar(campaignId, body, user, role);
  }
}

@ApiTags('timeline')
@Controller('timeline')
export class TimelineController {
  constructor(
    private readonly timeline: TimelineService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a timeline event', description: 'Requires campaign membership. dmSecret stripped for non-DM; a hidden event 404s for non-DM.' })
  @ApiResponse({ status: 200, description: 'The timeline event.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.timeline.getEventRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.timeline.getEventOrThrow(id, role);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a timeline event', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'The updated timeline event.' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: TimelineEventUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.timeline.getEventRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.timeline.updateEvent(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a timeline event', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.timeline.getEventRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.timeline.removeEvent(id, user, role);
  }
}
