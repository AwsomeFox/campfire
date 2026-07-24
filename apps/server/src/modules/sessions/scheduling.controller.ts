import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { CalendarFeed, ScheduledSessionWithRsvps } from '@campfire/schema';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { THROTTLE_AUTH, ICS_THROTTLE_LIMIT, ICS_THROTTLE_TTL_MS } from '../../common/throttle.constants';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { SchedulingService } from './scheduling.service';
import { ScheduledSessionCreateDto, ScheduledSessionUpdateDto, RsvpSetDto } from './sessions.dto';

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
    await this.access.requireMember(user, campaignId);
    return this.scheduling.listForCampaign(campaignId);
  }

  @Get('next')
  @ApiOperation({
    summary: 'Next session',
    description:
      'Requires campaign membership. The earliest in-progress scheduled session (still inside its duration window), else the soonest not-yet-started one (with RSVPs), or null when nothing is planned. Issue #818: a game night remains current from scheduledAt through scheduledAt+durationMinutes.',
  })
  @ApiResponse({ status: 200, description: 'Current or next scheduled session, or null.' })
  async next(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser): Promise<ScheduledSessionWithRsvps | null> {
    await this.access.requireMember(user, campaignId);
    return this.scheduling.nextForCampaign(campaignId);
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
  ) {}

  @Patch(':id')
  @ApiOperation({ summary: 'Update a scheduled session', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Updated scheduled session.' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ScheduledSessionUpdateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ScheduledSessionWithRsvps> {
    const row = await this.scheduling.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.scheduling.update(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a scheduled session', description: 'dm role required. Deletes the schedule entry and its RSVPs, and notifies the party (issue #820).' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<void> {
    const row = await this.scheduling.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.scheduling.remove(id, user, role);
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
    const role = await this.access.requireMember(user, row.campaignId);
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
