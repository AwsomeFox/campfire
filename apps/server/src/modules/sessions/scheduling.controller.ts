import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { CalendarFeed, ScheduledSessionListPage, ScheduledSessionRestored, ScheduledSessionWithRsvps } from '@campfire/schema';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { THROTTLE_AUTH, ICS_THROTTLE_LIMIT, ICS_THROTTLE_TTL_MS } from '../../common/throttle.constants';
import { parsePageParams } from '../../common/pagination';
import { SCHEDULE_PAST_MAX_LIMIT } from '@campfire/schema';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { SchedulingService } from './scheduling.service';
// #588: restore re-acquires a released room/DM, so it can 409 like the
// organized-play booking endpoints and shares their redaction of the conflict list.
import { OrganizedPlayService } from './organized-play.service';
import {
  ScheduledSessionCancelDto,
  ScheduledSessionCreateDto,
  ScheduledSessionDuplicateDto,
  ScheduledSessionRestoreDto,
  ScheduledSessionUpdateDto,
  RsvpSetDto,
} from './sessions.dto';

/**
 * Session scheduling (issue #13): the "next session" concept. Planned game
 * nights (GET/POST under a campaign; PATCH/DELETE/RSVP by schedule id) plus
 * the per-campaign ICS calendar feed (member-readable settings, DM-managed
 * token, and a token-authorized public .ics endpoint at the bottom).
 */
@ApiTags('sessions')
@Controller('campaigns/:campaignId/schedule')
export class CampaignScheduleController {
  constructor(
    private readonly scheduling: SchedulingService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List scheduled (planned) sessions', description: 'Requires campaign membership. Ordered soonest-first; each item includes member RSVPs.' })
  @ApiResponse({ status: 200, description: 'Scheduled sessions with RSVPs.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser): Promise<ScheduledSessionWithRsvps[]> {
    const role = await this.access.requireMember(user, campaignId);
    return this.scheduling.listForCampaign(campaignId, role);
  }

  @Get('upcoming')
  @ApiOperation({
    summary: 'Upcoming and in-progress scheduled sessions',
    description:
      'Requires campaign membership. Returns not-yet-ended game nights (in progress + upcoming), soonest-first, with RSVPs. Issue #612: queried directly instead of loading full history.',
  })
  @ApiResponse({ status: 200, description: 'Live scheduled sessions with RSVPs.' })
  async upcoming(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
  ): Promise<ScheduledSessionWithRsvps[]> {
    const role = await this.access.requireMember(user, campaignId);
    return this.scheduling.listUpcomingForCampaign(campaignId, role);
  }

  @Get('past')
  @ApiOperation({
    summary: 'Past scheduled sessions (paginated)',
    description:
      'Requires campaign membership. Ended game nights, most-recent first. Supports `?limit`/`?offset` paging (default limit 20, max 100). Issue #612.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated past scheduled sessions.' })
  async past(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ScheduledSessionListPage> {
    const role = await this.access.requireMember(user, campaignId);
    return this.scheduling.listPastForCampaign(
      campaignId,
      role,
      parsePageParams({ limit, offset }, SCHEDULE_PAST_MAX_LIMIT),
    );
  }

  @Get('next')
  @ApiOperation({
    summary: 'Next session',
    description:
      'Requires campaign membership. The earliest in-progress scheduled session (still inside its duration window), else the soonest not-yet-started one (with RSVPs), or null when nothing is planned. Issue #818: a game night remains current from scheduledAt through scheduledAt+durationMinutes.',
  })
  @ApiResponse({ status: 200, description: 'Current or next scheduled session, or null.' })
  async next(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser): Promise<ScheduledSessionWithRsvps | null> {
    const role = await this.access.requireMember(user, campaignId);
    return this.scheduling.nextForCampaign(campaignId, role);
  }

  @Post()
  @ApiOperation({ summary: 'Schedule a session', description: 'dm role required.' })
  @ApiResponse({ status: 201, description: 'Created scheduled session.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: ScheduledSessionCreateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ScheduledSessionWithRsvps> {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.scheduling.create(campaignId, body, user, role);
  }
}

@ApiTags('sessions')
@Controller('schedule')
export class ScheduleController {
  constructor(
    private readonly scheduling: SchedulingService,
    private readonly access: CampaignAccessService,
    private readonly organizedPlay: OrganizedPlayService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a scheduled session', description: 'Requires campaign membership. Includes RSVPs.' })
  @ApiResponse({ status: 200, description: 'Scheduled session with RSVPs.' })
  async get(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
  ): Promise<ScheduledSessionWithRsvps> {
    const row = await this.scheduling.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.scheduling.getWithRsvps(id, role);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a scheduled session',
    description:
      'dm role required. A cancelled game night is not editable — restore it first, so the party is never pushed a '
      + '"rescheduled" notification for a game that is not happening.',
  })
  @ApiResponse({ status: 200, description: 'Updated scheduled session.' })
  @ApiResponse({ status: 400, description: 'The scheduled session is cancelled.' })
  @ApiResponse({ status: 409, description: 'STALE_WRITE with the current revision token.' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ScheduledSessionUpdateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ScheduledSessionWithRsvps> {
    const row = await this.scheduling.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    const { expectedUpdatedAt, ...fields } = body;
    return this.scheduling.update(id, fields, user, role, { expectedUpdatedAt });
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a scheduled session', description: 'dm role required. Marks the schedule cancelled, retains RSVPs/history, and notifies the party.' })
  @ApiResponse({ status: 200, description: 'Cancelled scheduled session with retained RSVPs.' })
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ScheduledSessionCancelDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ScheduledSessionWithRsvps> {
    const row = await this.scheduling.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.scheduling.remove(id, user, role, body ?? {});
  }

  @Post(':id/restore')
  @ApiOperation({
    summary: 'Restore a cancelled scheduled session',
    description:
      'dm role required. Clears cancellation metadata and returns the schedule to live/upcoming projections. A cancelled '
      + 'night has RELEASED any room and assigned DM it held, so restoring re-books them: if either was taken while the '
      + 'night was cancelled this rejects with 409 SCHEDULE_CONFLICT unless `force`.',
  })
  @ApiResponse({ status: 201, description: 'Restored scheduled session.' })
  @ApiResponse({ status: 409, description: 'SCHEDULE_CONFLICT with the (redacted) conflict list.' })
  async restore(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ScheduledSessionRestoreDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ScheduledSessionRestored> {
    const row = await this.scheduling.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    try {
      return await this.scheduling.restore(id, user, role, body?.force ?? false, (body?.reason ?? '').trim());
    } catch (err) {
      return await this.organizedPlay.toConflictResponse(err, user);
    }
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Duplicate or reschedule a scheduled session', description: 'dm role required. Copies a schedule into a new live row; optional fields override the copied time/details. RSVPs are not copied.' })
  @ApiResponse({ status: 201, description: 'Duplicated scheduled session.' })
  async duplicate(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ScheduledSessionDuplicateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ScheduledSessionWithRsvps> {
    const row = await this.scheduling.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.scheduling.duplicate(id, body ?? {}, user, role);
  }

  @Post(':id/link/:sessionId')
  @ApiOperation({ summary: 'Link a schedule to the played session recap', description: 'dm role required. Marks the schedule completed and stores the durable schedule/session relationship.' })
  @ApiResponse({ status: 201, description: 'Completed scheduled session.' })
  async linkSession(
    @Param('id', ParseIntPipe) id: number,
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @CurrentUser() user: RequestUser,
  ): Promise<ScheduledSessionWithRsvps> {
    const row = await this.scheduling.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.scheduling.linkSession(id, sessionId, user, role);
  }

  @Put(':id/rsvp')
  @ApiOperation({ summary: 'Set own availability (RSVP)', description: 'Any campaign member. Upserts the caller\'s RSVP (yes / no / maybe, optional note) for this scheduled session.' })
  @ApiResponse({ status: 200, description: 'The scheduled session with updated RSVPs.' })
  async rsvp(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: RsvpSetDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ScheduledSessionWithRsvps> {
    const row = await this.scheduling.getRowOrThrow(id);
    // Member-level write: the archive read-only gate applies (issue #1480) — a
    // paused/completed campaign refuses new RSVPs, like its other mutations.
    const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
    return this.scheduling.setRsvp(id, body, user, role);
  }
}

@ApiTags('sessions')
@Controller('campaigns/:campaignId/calendar-feed')
export class CampaignCalendarFeedController {
  constructor(
    private readonly scheduling: SchedulingService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Calendar feed settings', description: 'Requires campaign membership. Returns the ICS feed token/URL plus its expiry, or nulls when the feed is disabled. Members may read it — the feed only exposes schedule data members already see.' })
  @ApiResponse({ status: 200, description: 'Feed token + relative URL + expiry (nulls when disabled).' })
  async get(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser): Promise<CalendarFeed> {
    await this.access.requireMember(user, campaignId);
    return this.scheduling.getFeed(campaignId);
  }

  @Post()
  @ApiOperation({ summary: 'Enable or rotate the calendar feed', description: 'dm role required. Generates a fresh unguessable feed token with a new expiry; any previously shared feed URL stops working immediately (and an expired token stops working on its own once the window elapses).' })
  @ApiResponse({ status: 201, description: 'New feed token + URL + expiry.' })
  async rotate(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser): Promise<CalendarFeed> {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.scheduling.rotateFeed(campaignId, user, role);
  }

  @Delete()
  @ApiOperation({ summary: 'Disable the calendar feed', description: 'dm role required. Clears the token; the public feed URL 404s afterward.' })
  @ApiResponse({ status: 200, description: 'Feed disabled.' })
  async disable(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser): Promise<CalendarFeed> {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.scheduling.disableFeed(campaignId, user, role);
  }
}

/**
 * Public ICS feed. @Public on purpose: calendar apps (Google/Apple/Outlook)
 * subscribe by URL and cannot send cookies or Bearer tokens — the unguessable
 * `cf_ics_<48 hex>` token in the path IS the authorization (same entropy as a
 * PAT; see crypto.ts). Rate-limited per-IP (ICS_THROTTLE_*) following the
 * @Public auth-endpoint throttler pattern, so token guessing/scraping is
 * capped; unknown or disabled tokens 404 without revealing anything.
 */
@ApiTags('sessions')
@Controller('calendar')
export class CalendarFeedController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Public()
  @Throttle({ [THROTTLE_AUTH]: { limit: ICS_THROTTLE_LIMIT, ttl: ICS_THROTTLE_TTL_MS } })
  @Get(':token.ics')
  @ApiParam({ name: 'token', description: 'Feed capability token (cf_ics_…), from the campaign calendar-feed settings.' })
  @ApiOperation({ summary: 'ICS calendar feed (public)', description: 'Unauthenticated, token-authorized iCalendar feed of a campaign\'s scheduled sessions. Subscribe to this URL from any calendar app. Rate-limited per IP.' })
  @ApiResponse({ status: 200, description: 'text/calendar document.' })
  @ApiResponse({ status: 404, description: 'Unknown, rotated, disabled, or expired feed token.' })
  async feed(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const ics = await this.scheduling.buildFeedByToken(token);
    res
      .status(200)
      .set({
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="campfire.ics"',
        // Issue #730: capability-token ICS feeds must never be stored by caches.
        'Cache-Control': 'private, no-store',
      })
      .send(ics);
  }
}
