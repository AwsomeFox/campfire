import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type {
  CoordinatorCalendar,
  OccurrenceAttendance,
  PlayRoom,
  PlayVenue,
  ScheduleConflictReport,
  ScheduleTemplate,
  ScheduleTemplateApplyResult,
  OccurrenceWriteResult,
  SeriesException,
  SessionSeries,
  SessionSeriesWithOccurrences,
} from '@campfire/schema';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { OrganizedPlayService } from './organized-play.service';
import {
  OccurrenceReassignDto,
  OccurrenceRescheduleDto,
  PlayRoomCreateDto,
  PlayRoomUpdateDto,
  PlayVenueCreateDto,
  PlayVenueUpdateDto,
  ScheduleConflictQueryDto,
  ScheduleTemplateApplyDto,
  ScheduleTemplateCreateDto,
  SessionSeriesCancelDto,
  SessionSeriesCreateDto,
  SessionSeriesExtendDto,
  SessionSeriesUpdateDto,
} from './sessions.dto';

/**
 * Organized-play scheduling (issue #588): the shared venue/room resource pool,
 * the cross-campaign coordinator calendar, conflict detection, reusable schedule
 * templates, and the per-occurrence exception operations.
 *
 * AUTHORIZATION MODEL
 * -------------------
 *   - Venues, rooms and templates are INSTALL-level infrastructure shared by
 *     every campaign, so mutating them is @ServerRoles('admin'). Reading the
 *     venue list is open to any authenticated user: a DM has to be able to pick
 *     a room, and a room's name and capacity are not campaign data.
 *   - The coordinator calendar and the conflict probe are open to any
 *     authenticated user BECAUSE their results are redacted per-caller (see
 *     OrganizedPlayService): they answer "is this resource free?", never "whose
 *     game is in it?". Gating them to admins instead would have made the feature
 *     useless to the DMs who actually book tables, and would not have made the
 *     redaction unnecessary — an admin is not a member of every campaign either.
 *   - Everything that writes to a campaign's schedule goes through the ordinary
 *     campaign role check (`dm`), exactly like POST /campaigns/:id/schedule.
 */
/**
 * Parse an optional numeric query parameter, rejecting garbage instead of
 * coercing it. `Number('abc')` is NaN, and an unguarded NaN reached the service
 * as a filter that matches nothing — a silent empty calendar rather than an
 * error the caller can act on. Same shape as audit.controller's parseOptionalInt.
 */
function parseOptionalId(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestException(`\`${name}\` must be a positive integer`);
  return n;
}

@ApiTags('sessions')
@Controller('organized-play')
export class OrganizedPlayController {
  constructor(
    private readonly organizedPlay: OrganizedPlayService,
    private readonly access: CampaignAccessService,
  ) {}

  // ----- venues + rooms -----

  @Get('venues')
  @ApiOperation({
    summary: 'List play venues and their rooms',
    description: 'Any authenticated user. Venues are install-level shared resources, not campaign data.',
  })
  @ApiResponse({ status: 200, description: 'Venues, each with its rooms.' })
  async listVenues(): Promise<Array<PlayVenue & { rooms: PlayRoom[] }>> {
    return this.organizedPlay.listVenues();
  }

  @Post('venues')
  @ServerRoles('admin')
  @ApiOperation({ summary: 'Create a play venue', description: 'Server admin only — venues are shared install infrastructure.' })
  @ApiResponse({ status: 201, description: 'Created venue.' })
  @ApiResponse({ status: 400, description: 'Unknown IANA time zone.' })
  async createVenue(@Body() body: PlayVenueCreateDto, @CurrentUser() user: RequestUser): Promise<PlayVenue> {
    return this.organizedPlay.createVenue(body, user);
  }

  @Patch('venues/:id')
  @ServerRoles('admin')
  @ApiOperation({ summary: 'Update a play venue', description: 'Server admin only.' })
  @ApiResponse({ status: 200, description: 'Updated venue.' })
  async updateVenue(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: PlayVenueUpdateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<PlayVenue> {
    return this.organizedPlay.updateVenue(id, body, user);
  }

  @Delete('venues/:id')
  @ServerRoles('admin')
  @ApiOperation({
    summary: 'Delete a play venue',
    description:
      'Server admin only. Bookings that referenced its rooms are KEPT with the room cleared — removing a venue must never delete a campaign\'s game night.',
  })
  @ApiResponse({ status: 200, description: 'Venue deleted; bookings retained.' })
  async deleteVenue(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<{ deleted: true }> {
    return this.organizedPlay.deleteVenue(id, user);
  }

  @Post('venues/:id/rooms')
  @ServerRoles('admin')
  @ApiOperation({ summary: 'Add a room/table to a venue', description: 'Server admin only. Room names are unique within a venue.' })
  @ApiResponse({ status: 201, description: 'Created room.' })
  async createRoom(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: PlayRoomCreateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<PlayRoom> {
    return this.organizedPlay.createRoom(id, body, user);
  }

  @Patch('rooms/:id')
  @ServerRoles('admin')
  @ApiOperation({ summary: 'Update a room/table', description: 'Server admin only.' })
  @ApiResponse({ status: 200, description: 'Updated room.' })
  async updateRoom(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: PlayRoomUpdateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<PlayRoom> {
    return this.organizedPlay.updateRoom(id, body, user);
  }

  @Delete('rooms/:id')
  @ServerRoles('admin')
  @ApiOperation({ summary: 'Delete a room/table', description: 'Server admin only. Bookings are kept with the room cleared.' })
  @ApiResponse({ status: 200, description: 'Room deleted; bookings retained.' })
  async deleteRoom(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<{ deleted: true }> {
    return this.organizedPlay.deleteRoom(id, user);
  }

  // ----- coordinator calendar + conflicts -----

  @Get('calendar')
  @ApiOperation({
    summary: 'Cross-campaign coordinator calendar',
    description:
      'Any authenticated user. Lists organized-play bookings (rows holding a room/venue, an assigned DM, or an event/season key) '
      + 'overlapping [from, to). Bookings in campaigns the caller cannot read are returned as opaque busy blocks — window, local '
      + 'wall clock, venue/room, capacity, seats taken and event/season key — with `visible: false` and no campaign, title, '
      + 'schedule id, series id or assigned DM. Campaigns that never opted into organized play are absent entirely; belonging to a '
      + 'recurring series is NOT by itself an opt-in.',
  })
  @ApiQuery({ name: 'from', required: true, description: 'ISO date-time, inclusive.' })
  @ApiQuery({ name: 'to', required: true, description: 'ISO date-time, exclusive. At most 366 days after `from`.' })
  @ApiQuery({ name: 'venueId', required: false, type: Number })
  @ApiQuery({ name: 'roomId', required: false, type: Number })
  @ApiQuery({ name: 'eventId', required: false })
  @ApiQuery({ name: 'seasonId', required: false })
  @ApiResponse({ status: 200, description: 'Calendar entries, soonest-first.' })
  @ApiResponse({ status: 400, description: 'Invalid or oversized window.' })
  async calendar(
    @CurrentUser() user: RequestUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('venueId') venueId?: string,
    @Query('roomId') roomId?: string,
    @Query('eventId') eventId?: string,
    @Query('seasonId') seasonId?: string,
  ): Promise<CoordinatorCalendar> {
    return this.organizedPlay.coordinatorCalendar(user, {
      from: from ?? '',
      to: to ?? '',
      venueId: parseOptionalId(venueId, 'venueId'),
      roomId: parseOptionalId(roomId, 'roomId'),
      eventId: eventId || undefined,
      seasonId: seasonId || undefined,
    });
  }

  @Post('conflicts')
  @ApiOperation({
    summary: 'Check a proposed booking for conflicts',
    description:
      'Any authenticated user. Reports room double-bookings, a DM assigned to two overlapping tables, and members seated at two '
      + 'overlapping tables. Writes nothing. Conflicts in campaigns the caller cannot read carry the window and resource but no '
      + 'campaign identity (`visible: false`).',
  })
  @ApiResponse({ status: 201, description: 'Conflict report (possibly empty).' })
  async conflicts(@Body() body: ScheduleConflictQueryDto, @CurrentUser() user: RequestUser): Promise<ScheduleConflictReport> {
    return this.organizedPlay.checkConflicts(body, user);
  }

  // ----- schedule templates -----

  @Get('templates')
  @ApiOperation({ summary: 'List schedule templates', description: 'Any authenticated user.' })
  @ApiResponse({ status: 200, description: 'Templates.' })
  async listTemplates(): Promise<ScheduleTemplate[]> {
    return this.organizedPlay.listTemplates();
  }

  @Post('templates')
  @ServerRoles('admin')
  @ApiOperation({ summary: 'Create a schedule template', description: 'Server admin only. Templates are install-level infrastructure.' })
  @ApiResponse({ status: 201, description: 'Created template.' })
  async createTemplate(@Body() body: ScheduleTemplateCreateDto, @CurrentUser() user: RequestUser): Promise<ScheduleTemplate> {
    return this.organizedPlay.createTemplate(body, user);
  }

  @Delete('templates/:id')
  @ServerRoles('admin')
  @ApiOperation({ summary: 'Delete a schedule template', description: 'Server admin only. Series already created from it are untouched.' })
  @ApiResponse({ status: 200, description: 'Template deleted.' })
  async deleteTemplate(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<{ deleted: true }> {
    return this.organizedPlay.deleteTemplate(id, user);
  }

  @Post('templates/:id/apply')
  @ApiOperation({
    summary: 'Bulk-create series from a template',
    description:
      'dm role required on the target campaign. Creates one series per template slot and materializes every occurrence in a single '
      + 'transaction. `dmRotation` cycles running DMs across slots. Rejects with 409 SCHEDULE_CONFLICT unless `force` is set.',
  })
  @ApiResponse({ status: 201, description: 'Created series + occurrence count.' })
  @ApiResponse({ status: 409, description: 'SCHEDULE_CONFLICT with the (redacted) conflict list.' })
  async applyTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ScheduleTemplateApplyDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ScheduleTemplateApplyResult> {
    const role = await this.access.requireRole(user, body.campaignId, 'dm');
    try {
      return await this.organizedPlay.applyTemplate(id, body, user, role);
    } catch (err) {
      return await this.organizedPlay.toConflictResponse(err, user);
    }
  }

  // ----- per-occurrence exceptions -----

  @Post('occurrences/:id/reschedule')
  @ApiOperation({
    summary: 'Reschedule one occurrence',
    description:
      'dm role required. Moves a single night without disturbing the rest of its series: same row, same ICS UID, RSVPs retained, '
      + 'SEQUENCE bumped so subscribed calendars update in place, and both instants recorded in the exception ledger.',
  })
  @ApiResponse({ status: 201, description: 'Rescheduled occurrence (plus any conflicts that were forced past).' })
  @ApiResponse({ status: 409, description: 'SCHEDULE_CONFLICT with the (redacted) conflict list.' })
  async reschedule(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: OccurrenceRescheduleDto,
    @CurrentUser() user: RequestUser,
  ): Promise<OccurrenceWriteResult> {
    const row = await this.organizedPlay.getOccurrenceRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    try {
      return await this.organizedPlay.rescheduleOccurrence(id, body, user, role);
    } catch (err) {
      return await this.organizedPlay.toConflictResponse(err, user);
    }
  }

  @Post('occurrences/:id/reassign')
  @ApiOperation({
    summary: 'Re-seat one occurrence (room / running DM / capacity)',
    description: 'dm role required. Records a `reassign` entry in the series exception ledger. Rejects with 409 unless `force`.',
  })
  @ApiResponse({ status: 201, description: 'Reassigned occurrence.' })
  @ApiResponse({ status: 409, description: 'SCHEDULE_CONFLICT with the (redacted) conflict list.' })
  async reassign(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: OccurrenceReassignDto,
    @CurrentUser() user: RequestUser,
  ): Promise<OccurrenceWriteResult> {
    const row = await this.organizedPlay.getOccurrenceRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    try {
      return await this.organizedPlay.reassignOccurrence(id, body, user, role);
    } catch (err) {
      return await this.organizedPlay.toConflictResponse(err, user);
    }
  }

  @Get('occurrences/:id/exceptions')
  @ApiOperation({ summary: 'Exception lineage for one occurrence', description: 'Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Ordered exception ledger.' })
  async exceptions(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<SeriesException[]> {
    const row = await this.organizedPlay.getOccurrenceRowOrThrow(id);
    await this.access.requireMember(user, row.campaignId);
    return this.organizedPlay.occurrenceExceptions(id);
  }

  @Get('occurrences/:id/attendance')
  @ApiOperation({
    summary: 'Seats and attendance for one occurrence',
    description:
      'Requires campaign membership. Read-only projection over the existing schedule↔recap link and the recap\'s attendance rows — '
      + 'nothing is copied or rewritten.',
  })
  @ApiResponse({ status: 200, description: 'Capacity, RSVP yes count, seats remaining, and recorded attendees.' })
  async attendance(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<OccurrenceAttendance> {
    const row = await this.organizedPlay.getOccurrenceRowOrThrow(id);
    await this.access.requireMember(user, row.campaignId);
    return this.organizedPlay.occurrenceAttendance(id);
  }
}

/**
 * Campaign-scoped recurring series. Separate controller so the routes sit under
 * the campaign they belong to and reuse the ordinary campaign role checks.
 */
@ApiTags('sessions')
@Controller('campaigns/:campaignId/series')
export class CampaignSeriesController {
  constructor(
    private readonly organizedPlay: OrganizedPlayService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List recurring series', description: 'Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Series for this campaign.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser): Promise<SessionSeries[]> {
    await this.access.requireMember(user, campaignId);
    return this.organizedPlay.listSeries(campaignId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a recurring series',
    description:
      'dm role required. Stores the IANA zone plus the LOCAL start date/time and materializes every occurrence as an ordinary '
      + 'scheduled session, so a weekly 19:00 table stays 19:00 local across a DST transition. The conflict check and the inserts '
      + 'run in one transaction; rejects with 409 SCHEDULE_CONFLICT unless `force`.',
  })
  @ApiResponse({ status: 201, description: 'Created series with its materialized occurrences.' })
  @ApiResponse({ status: 400, description: 'Unknown time zone or invalid recurrence.' })
  @ApiResponse({ status: 409, description: 'SCHEDULE_CONFLICT with the (redacted) conflict list.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SessionSeriesCreateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<SessionSeriesWithOccurrences> {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    try {
      return await this.organizedPlay.createSeries(campaignId, body, user, role);
    } catch (err) {
      return await this.organizedPlay.toConflictResponse(err, user);
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a series with its occurrences and exception ledger', description: 'Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Series, occurrences, exceptions.' })
  async get(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
  ): Promise<SessionSeriesWithOccurrences> {
    const role = await this.access.requireMember(user, campaignId);
    // The series must belong to the campaign in the PATH — see
    // getSeriesRowInCampaignOrThrow. Holding rights in some campaign is not
    // authorization to address a series in another one.
    await this.organizedPlay.getSeriesRowInCampaignOrThrow(campaignId, id);
    return this.organizedPlay.getSeries(id, role);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update series metadata',
    description:
      'dm role required. Fans out to FUTURE occurrences that carry no per-occurrence exception; a night the coordinator has already '
      + 'moved or re-seated keeps its override, and past occurrences are never rewritten. The recurrence rule itself is immutable. '
      + 'A body carrying `roomId` or `assignedDmUserId` re-books every affected occurrence onto that resource, so it runs the same '
      + 'conflict check as the per-occurrence endpoints and rejects with 409 SCHEDULE_CONFLICT unless `force`.',
  })
  @ApiResponse({ status: 200, description: 'Updated series.' })
  @ApiResponse({ status: 409, description: 'SCHEDULE_CONFLICT with the (redacted) conflict list.' })
  async update(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: SessionSeriesUpdateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<SessionSeriesWithOccurrences> {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    await this.organizedPlay.getSeriesRowInCampaignOrThrow(campaignId, id);
    try {
      return await this.organizedPlay.updateSeries(id, body, user, role);
    } catch (err) {
      return await this.organizedPlay.toConflictResponse(err, user);
    }
  }

  @Post(':id/extend')
  @ApiOperation({
    summary: 'Materialize more occurrences',
    description:
      'dm role required. Continues the original wall-clock rule rather than striding from the last instant, so an extension that '
      + 'crosses a DST boundary stays at the same local time.',
  })
  @ApiResponse({ status: 201, description: 'Series with the added occurrences.' })
  @ApiResponse({ status: 409, description: 'SCHEDULE_CONFLICT with the (redacted) conflict list.' })
  async extend(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: SessionSeriesExtendDto,
    @CurrentUser() user: RequestUser,
  ): Promise<SessionSeriesWithOccurrences> {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    await this.organizedPlay.getSeriesRowInCampaignOrThrow(campaignId, id);
    try {
      return await this.organizedPlay.extendSeries(id, body.addCount, user, role, body.force);
    } catch (err) {
      return await this.organizedPlay.toConflictResponse(err, user);
    }
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Cancel a series',
    description:
      'dm role required. Marks the series and every FUTURE occurrence cancelled without deleting anything: rows, RSVPs and the '
      + 'exception ledger survive, and the ICS feed keeps publishing STATUS:CANCELLED under each stable UID.',
  })
  @ApiResponse({ status: 200, description: 'Cancelled series.' })
  async cancel(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: SessionSeriesCancelDto,
    @CurrentUser() user: RequestUser,
  ): Promise<SessionSeriesWithOccurrences> {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    await this.organizedPlay.getSeriesRowInCampaignOrThrow(campaignId, id);
    return this.organizedPlay.cancelSeries(id, (body?.reason ?? '').trim(), user, role);
  }
}
