import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  MAX_SERIES_OCCURRENCES,
  ScheduleTemplateSlot,
  expandRecurrence,
  isValidIanaTimeZone,
  utcToLocalDateTime,
  wallClockToUtc,
  windowsOverlap,
  type CoordinatorCalendar,
  type CoordinatorCalendarEntry,
  type OccurrenceAttendance,
  type OccurrenceReassign,
  type OccurrenceReschedule,
  type PlayRoom,
  type PlayRoomCreate,
  type PlayRoomUpdate,
  type PlayVenue,
  type PlayVenueCreate,
  type PlayVenueUpdate,
  type RecurrenceFreq,
  type Role,
  type ScheduleConflict,
  type ScheduleConflictQuery,
  type ScheduleConflictReport,
  type ScheduleTemplate,
  type ScheduleTemplateApply,
  type ScheduleTemplateApplyResult,
  type ScheduleTemplateCreate,
  type ScheduledSession,
  type SeriesException,
  type SessionSeries,
  type SessionSeriesCreate,
  type SessionSeriesUpdate,
  type SessionSeriesWithOccurrences,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  campaigns,
  playRooms,
  playVenues,
  scheduleTemplates,
  scheduledSessions,
  seriesExceptions,
  sessionAttendees,
  sessionRsvps,
  sessionSeries,
  sessions,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { generateSeriesUid } from '../../common/crypto';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { RoleResolver } from '../membership/role-resolver.service';
import { seriesIcsUid } from './ics.util';
import { recurrenceLocalDateFor, scheduledSessionToDomain, type SyncDb } from './scheduling.service';
import {
  scheduleEffectiveStatusSql,
  scheduleLiveSql,
  scheduleOrganizedPlaySql,
  scheduleOverlapsSql,
} from './scheduling-queries';

/** Which campaigns the caller may see identifying detail for. */
type AccessScope = number[] | 'all';

function canSee(scope: AccessScope, campaignId: number): boolean {
  return scope === 'all' || scope.includes(campaignId);
}

const MAX_CALENDAR_WINDOW_DAYS = 366;

type SeriesRow = typeof sessionSeries.$inferSelect;
type ScheduleRow = typeof scheduledSessions.$inferSelect;

function venueToDomain(row: typeof playVenues.$inferSelect): PlayVenue {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    address: row.address,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function roomToDomain(row: typeof playRooms.$inferSelect): PlayRoom {
  return {
    id: row.id,
    venueId: row.venueId,
    name: row.name,
    capacity: row.capacity,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function seriesToDomain(row: SeriesRow): SessionSeries {
  return {
    id: row.id,
    campaignId: row.campaignId,
    title: row.title,
    location: row.location,
    notes: row.notes,
    timezone: row.timezone,
    startDate: row.startDate,
    startTime: row.startTime,
    durationMinutes: row.durationMinutes,
    freq: row.freq as RecurrenceFreq,
    interval: row.interval,
    count: row.count,
    untilDate: row.untilDate,
    venueId: row.venueId,
    roomId: row.roomId,
    assignedDmUserId: row.assignedDmUserId,
    capacity: row.capacity,
    eventId: row.eventId,
    seasonId: row.seasonId,
    seriesUid: row.seriesUid,
    status: row.status as SessionSeries['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function exceptionToDomain(row: typeof seriesExceptions.$inferSelect): SeriesException {
  return {
    id: row.id,
    seriesId: row.seriesId,
    occurrenceId: row.occurrenceId,
    recurrenceLocalDate: row.recurrenceLocalDate,
    kind: row.kind as SeriesException['kind'],
    fromScheduledAt: row.fromScheduledAt,
    toScheduledAt: row.toScheduledAt,
    toLocalStart: row.toLocalStart,
    reason: row.reason,
    actorUserId: row.actorUserId,
    createdAt: row.createdAt,
  };
}

function endInstant(startIso: string, durationMinutes: number): string {
  const start = Date.parse(startIso);
  const minutes = Number.isFinite(durationMinutes) ? Math.max(0, durationMinutes) : 0;
  return new Date(start + minutes * 60_000).toISOString();
}

/** The raw (unredacted) shape a conflict query returns before privacy is applied. */
type RawConflict = {
  kind: ScheduleConflict['kind'];
  scheduleId: number;
  campaignId: number;
  title: string;
  startsAt: string;
  endsAt: string;
  roomId: number | null;
  subjectUserId: string;
};

/**
 * Organized-play scheduling (issue #588).
 *
 * WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT TOUCH
 * ------------------------------------------------------
 * Before this, a scheduled session was a per-campaign UTC instant with a
 * free-text location: no venue or table resource, no assigned DM, no recurrence,
 * no capacity, no way to see two campaigns' bookings side by side, and no way to
 * find out that two tables want the same room at the same time.
 *
 * This service adds all of that WITHOUT forking the schedule model. An occurrence
 * IS an ordinary `scheduled_sessions` row, decorated with organized-play columns
 * that all default to empty. That is what keeps RSVPs, the reminder sweep, the
 * ICS feed, campaign search, export/import and the schedule↔recap link working
 * with no change at all — and what makes the promise "a campaign that ignores
 * this feature sees zero behaviour change" mechanically true rather than aspirational.
 *
 * TIMEZONE MODEL
 * --------------
 * A SERIES stores an IANA zone plus a LOCAL start date and time; occurrences are
 * materialized from that pair, so a weekly 19:00 table is still 19:00 after a DST
 * transition rather than drifting to 18:00 or 20:00. A one-off night keeps the
 * instant as authoritative and merely records the zone (see SchedulingService.create).
 * The rule is kept after materialization so a series can be EXTENDED from the same
 * wall clock instead of from the last computed instant.
 *
 * MATERIALIZED, NOT EXPANDED
 * --------------------------
 * Occurrences are written as rows rather than expanded on read. Per-occurrence
 * exceptions, cancellations, reschedule lineage, RSVPs, capacity and room bookings
 * all need a durable identity to hang off, and cross-campaign conflict detection
 * needs to be an indexed overlap query rather than an expand-every-series scan.
 * See packages/schema/src/recurrence.ts for the long form of that argument.
 */
@Injectable()
export class OrganizedPlayService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly events: CampaignEventsService,
    private readonly roles: RoleResolver,
  ) {}

  // ----- venues + rooms -----

  async listVenues(): Promise<Array<PlayVenue & { rooms: PlayRoom[] }>> {
    const [venueRows, roomRows] = await Promise.all([
      this.db.select().from(playVenues).orderBy(asc(playVenues.name), asc(playVenues.id)),
      this.db.select().from(playRooms).orderBy(asc(playRooms.name), asc(playRooms.id)),
    ]);
    const byVenue = new Map<number, PlayRoom[]>();
    for (const row of roomRows) {
      const list = byVenue.get(row.venueId) ?? [];
      list.push(roomToDomain(row));
      byVenue.set(row.venueId, list);
    }
    return venueRows.map((v) => ({ ...venueToDomain(v), rooms: byVenue.get(v.id) ?? [] }));
  }

  async createVenue(input: PlayVenueCreate, user: RequestUser): Promise<PlayVenue> {
    this.assertTimezone(input.timezone);
    const ts = nowIso();
    const [row] = await this.db
      .insert(playVenues)
      .values({
        name: input.name.trim(),
        timezone: input.timezone,
        address: input.address ?? '',
        notes: input.notes ?? '',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'admin',
      action: 'organized_play.venue_create',
      entityType: 'venue',
      entityId: row.id,
      detail: row.name,
    });
    return venueToDomain(row);
  }

  async updateVenue(id: number, input: PlayVenueUpdate, user: RequestUser): Promise<PlayVenue> {
    const existing = await this.getVenueOrThrow(id);
    if (input.timezone !== undefined) this.assertTimezone(input.timezone);
    const [row] = await this.db
      .update(playVenues)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(playVenues.id, existing.id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'admin',
      action: 'organized_play.venue_update',
      entityType: 'venue',
      entityId: id,
    });
    return venueToDomain(row);
  }

  /**
   * Delete a venue. Its rooms cascade, and every booking that referenced them is
   * left in place with `room_id` cleared (ON DELETE SET NULL) rather than being
   * destroyed: removing a venue from the install must never delete somebody's
   * game night. On DBs created before FK enforcement the SET NULL is applied by
   * hand here for the same reason CampaignsService.purge() open-codes its cascade.
   */
  async deleteVenue(id: number, user: RequestUser): Promise<{ deleted: true }> {
    const existing = await this.getVenueOrThrow(id);
    this.db.transaction((tx) => {
      const roomIds = tx.select({ id: playRooms.id }).from(playRooms).where(eq(playRooms.venueId, existing.id)).all().map((r) => r.id);
      if (roomIds.length > 0) {
        tx.update(scheduledSessions).set({ roomId: null }).where(inArray(scheduledSessions.roomId, roomIds)).run();
        tx.update(sessionSeries).set({ roomId: null }).where(inArray(sessionSeries.roomId, roomIds)).run();
      }
      tx.update(scheduledSessions).set({ venueId: null }).where(eq(scheduledSessions.venueId, existing.id)).run();
      tx.update(sessionSeries).set({ venueId: null }).where(eq(sessionSeries.venueId, existing.id)).run();
      tx.update(scheduleTemplates).set({ venueId: null }).where(eq(scheduleTemplates.venueId, existing.id)).run();
      tx.delete(playRooms).where(eq(playRooms.venueId, existing.id)).run();
      tx.delete(playVenues).where(eq(playVenues.id, existing.id)).run();
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'admin',
      action: 'organized_play.venue_delete',
      entityType: 'venue',
      entityId: id,
      detail: existing.name,
    });
    return { deleted: true };
  }

  async createRoom(venueId: number, input: PlayRoomCreate, user: RequestUser): Promise<PlayRoom> {
    await this.getVenueOrThrow(venueId);
    const ts = nowIso();
    const name = input.name.trim();
    const [clash] = await this.db
      .select({ id: playRooms.id })
      .from(playRooms)
      .where(and(eq(playRooms.venueId, venueId), eq(playRooms.name, name)))
      .limit(1);
    if (clash) throw new BadRequestException(`Venue already has a room named "${name}"`);
    const [row] = await this.db
      .insert(playRooms)
      .values({
        venueId,
        name,
        capacity: input.capacity ?? 0,
        notes: input.notes ?? '',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'admin',
      action: 'organized_play.room_create',
      entityType: 'room',
      entityId: row.id,
      detail: `venue=${venueId}`,
    });
    return roomToDomain(row);
  }

  async updateRoom(id: number, input: PlayRoomUpdate, user: RequestUser): Promise<PlayRoom> {
    const existing = await this.getRoomOrThrow(id);
    const [row] = await this.db
      .update(playRooms)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(playRooms.id, existing.id))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'admin',
      action: 'organized_play.room_update',
      entityType: 'room',
      entityId: id,
    });
    return roomToDomain(row);
  }

  async deleteRoom(id: number, user: RequestUser): Promise<{ deleted: true }> {
    const existing = await this.getRoomOrThrow(id);
    const ts = nowIso();
    this.db.transaction((tx) => {
      tx.update(scheduledSessions).set({ roomId: null }).where(eq(scheduledSessions.roomId, existing.id)).run();
      tx.update(sessionSeries).set({ roomId: null }).where(eq(sessionSeries.roomId, existing.id)).run();
      // #588: a template keeps its slots as JSON, so the two relational updates
      // above cannot reach the room ids embedded in `slots_json`. Left behind, a
      // stale id makes every later applyTemplate 404 on getRoomOrThrow —
      // permanently, because there is no template-update endpoint to repair it,
      // and the only remedy would be deleting and recreating the template.
      // Clearing the reference leaves the slot bookable with no room, which is
      // the same state this deletion already leaves bookings and series in.
      for (const row of tx.select().from(scheduleTemplates).all()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.slotsJson);
        } catch {
          // Unparseable JSON holds no reachable reference to this room, and
          // templateToDomain already degrades it to zero slots. Leave it alone
          // rather than overwriting a row we cannot read.
          continue;
        }
        if (!Array.isArray(parsed)) continue;
        let changed = false;
        const slots = parsed.map((slot) => {
          if (slot !== null && typeof slot === 'object' && (slot as { roomId?: unknown }).roomId === existing.id) {
            changed = true;
            return { ...(slot as Record<string, unknown>), roomId: null };
          }
          return slot;
        });
        if (!changed) continue;
        tx.update(scheduleTemplates)
          .set({ slotsJson: JSON.stringify(slots), updatedAt: ts })
          .where(eq(scheduleTemplates.id, row.id))
          .run();
      }
      tx.delete(playRooms).where(eq(playRooms.id, existing.id)).run();
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'admin',
      action: 'organized_play.room_delete',
      entityType: 'room',
      entityId: id,
    });
    return { deleted: true };
  }

  private async getVenueOrThrow(id: number): Promise<typeof playVenues.$inferSelect> {
    const [row] = await this.db.select().from(playVenues).where(eq(playVenues.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Venue ${id} not found`);
    return row;
  }

  private async getRoomOrThrow(id: number): Promise<typeof playRooms.$inferSelect> {
    const [row] = await this.db.select().from(playRooms).where(eq(playRooms.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Room ${id} not found`);
    return row;
  }

  private assertTimezone(timezone: string): void {
    if (!isValidIanaTimeZone(timezone)) {
      throw new BadRequestException(`Unknown IANA time zone: ${timezone}`);
    }
  }

  // ----- conflict detection -----

  /**
   * Every booking that collides with the proposed window, as RAW rows.
   *
   * SYNCHRONOUS on purpose, and takes the caller's `db`/`tx` handle: the whole
   * point of a booking check is that it holds between "is the room free?" and
   * "the room is now mine". Running it inside the same better-sqlite3
   * transaction as the write makes that a structural guarantee rather than a
   * hopeful ordering — see createSeries()/rescheduleOccurrence(), which both
   * check and insert inside one `db.transaction(...)`.
   *
   * Only rows in the shared organized-play pool are considered
   * (scheduleOrganizedPlaySql): a private home game holds no shared resource, so
   * it can neither be collided with nor be revealed by this query.
   */
  private findConflictRows(
    db: SyncDb,
    q: {
      startsAt: string;
      endsAt: string;
      roomId: number | null;
      assignedDmUserId: string;
      memberUserIds: string[];
      excludeScheduleId?: number;
    },
  ): RawConflict[] {
    const base = [scheduleLiveSql(), scheduleOrganizedPlaySql(), scheduleOverlapsSql(q.startsAt, q.endsAt)];
    if (q.excludeScheduleId != null) base.push(ne(scheduledSessions.id, q.excludeScheduleId));

    const select = {
      id: scheduledSessions.id,
      campaignId: scheduledSessions.campaignId,
      title: scheduledSessions.title,
      scheduledAt: scheduledSessions.scheduledAt,
      durationMinutes: scheduledSessions.durationMinutes,
      roomId: scheduledSessions.roomId,
      assignedDmUserId: scheduledSessions.assignedDmUserId,
    };

    const out: RawConflict[] = [];
    const push = (kind: ScheduleConflict['kind'], row: { id: number; campaignId: number; title: string; scheduledAt: string; durationMinutes: number; roomId: number | null }, subjectUserId: string): void => {
      out.push({
        kind,
        scheduleId: row.id,
        campaignId: row.campaignId,
        title: row.title,
        startsAt: row.scheduledAt,
        endsAt: endInstant(row.scheduledAt, row.durationMinutes),
        roomId: row.roomId,
        subjectUserId,
      });
    };

    if (q.roomId != null) {
      const rows = db
        .select(select)
        .from(scheduledSessions)
        .where(and(...base, eq(scheduledSessions.roomId, q.roomId)))
        .all();
      for (const row of rows) push('room', row, '');
    }

    if (q.assignedDmUserId) {
      const rows = db
        .select(select)
        .from(scheduledSessions)
        .where(and(...base, eq(scheduledSessions.assignedDmUserId, q.assignedDmUserId)))
        .all();
      for (const row of rows) push('dm', row, q.assignedDmUserId);
    }

    const members = [...new Set(q.memberUserIds.filter((id) => id.trim() !== ''))];
    if (members.length > 0) {
      // A member is "seated" when they have said yes; a maybe/no is not a booking.
      const rows = db
        .select({ ...select, userId: sessionRsvps.userId })
        .from(scheduledSessions)
        .innerJoin(sessionRsvps, eq(sessionRsvps.scheduledSessionId, scheduledSessions.id))
        .where(and(...base, eq(sessionRsvps.status, 'yes'), inArray(sessionRsvps.userId, members)))
        .all();
      for (const row of rows) push('member', row, row.userId);
    }

    return out;
  }

  /**
   * Conflicts BETWEEN the occurrences a single request is about to create.
   *
   * findConflictRows only sees what is already in the database, and inside one
   * transaction nothing has been inserted yet — so a template that puts the same
   * DM at two simultaneous tables, or the same room in two slots, would sail
   * through every stored-row check and then be impossible to actually run. The
   * rotating-DM case is precisely why bulk creation exists, so the batch has to
   * be checked against itself.
   *
   * Already caller-visible: every occurrence here belongs to the request's own
   * target campaign, so there is nothing to redact.
   *
   * Sorted-adjacent scan rather than all-pairs: within a group sharing a room or
   * a DM, if A overlaps C then A also overlaps every entry between them, so one
   * adjacent overlap is enough to report the collision without going quadratic
   * on a 20-slot x 104-occurrence template.
   */
  private intraBatchConflicts(
    entries: Array<{ startsAt: string; endsAt: string; roomId: number | null; dm: string; campaignId: number; title: string }>,
  ): ScheduleConflict[] {
    const out: ScheduleConflict[] = [];
    type Entry = (typeof entries)[number];
    const scan = (kind: ScheduleConflict['kind'], keyOf: (e: Entry) => string | null): void => {
      const groups = new Map<string, Entry[]>();
      for (const entry of entries) {
        const key = keyOf(entry);
        if (key == null) continue;
        const list = groups.get(key);
        if (list) list.push(entry);
        else groups.set(key, [entry]);
      }
      for (const group of groups.values()) {
        const sorted = [...group].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        for (let i = 1; i < sorted.length; i += 1) {
          const prev = sorted[i - 1];
          const cur = sorted[i];
          if (
            !windowsOverlap(Date.parse(prev.startsAt), Date.parse(prev.endsAt), Date.parse(cur.startsAt), Date.parse(cur.endsAt))
          ) {
            continue;
          }
          out.push({
            kind,
            visible: true,
            startsAt: cur.startsAt,
            endsAt: cur.endsAt,
            roomId: cur.roomId,
            roomName: '',
            venueName: '',
            subjectUserId: kind === 'dm' ? cur.dm : '',
            campaignId: cur.campaignId,
            campaignName: null,
            // No schedule id: these rows do not exist yet, and never will —
            // the request that would have created them is being rejected.
            scheduleId: null,
            title: cur.title,
          });
        }
      }
    };
    scan('room', (e) => (e.roomId != null ? `room:${e.roomId}` : null));
    scan('dm', (e) => (e.dm ? `dm:${e.dm}` : null));
    return out;
  }

  /**
   * Apply the privacy rule to raw conflicts.
   *
   * A coordinator must be told "that room is taken from 19:00 to 23:00" even
   * when the booking belongs to a campaign they cannot read — otherwise the
   * shared room calendar is useless. They must NOT be told whose game it is.
   * So the window, the resource and the colliding subject id (which the CALLER
   * supplied in the first place) survive; the campaign, its name, the schedule
   * id and the title are dropped, and `visible: false` says so explicitly rather
   * than leaving the client to guess whether a null means redacted or absent.
   */
  private redactConflicts(
    raws: RawConflict[],
    scope: AccessScope,
    names: { campaigns: Map<number, string>; rooms: Map<number, { name: string; venueName: string }> },
  ): ScheduleConflict[] {
    return raws
      .map((raw): ScheduleConflict => {
        const visible = canSee(scope, raw.campaignId);
        const room = raw.roomId != null ? names.rooms.get(raw.roomId) : undefined;
        return {
          kind: raw.kind,
          visible,
          startsAt: raw.startsAt,
          endsAt: raw.endsAt,
          roomId: raw.roomId,
          roomName: room?.name ?? '',
          venueName: room?.venueName ?? '',
          subjectUserId: raw.subjectUserId,
          campaignId: visible ? raw.campaignId : null,
          campaignName: visible ? (names.campaigns.get(raw.campaignId) ?? null) : null,
          scheduleId: visible ? raw.scheduleId : null,
          title: visible ? raw.title : null,
        };
      })
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.kind.localeCompare(b.kind));
  }

  /** Campaign + room display names for the ids referenced by these conflicts. */
  private async lookupNames(campaignIds: number[], roomIds: number[]): Promise<{
    campaigns: Map<number, string>;
    rooms: Map<number, { name: string; venueName: string }>;
  }> {
    const uniqueCampaigns = [...new Set(campaignIds)];
    const uniqueRooms = [...new Set(roomIds)];
    const [campaignRows, roomRows] = await Promise.all([
      uniqueCampaigns.length === 0
        ? Promise.resolve([])
        : this.db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(inArray(campaigns.id, uniqueCampaigns)),
      uniqueRooms.length === 0
        ? Promise.resolve([])
        : this.db
            .select({ id: playRooms.id, name: playRooms.name, venueName: playVenues.name })
            .from(playRooms)
            .innerJoin(playVenues, eq(playVenues.id, playRooms.venueId))
            .where(inArray(playRooms.id, uniqueRooms)),
    ]);
    return {
      campaigns: new Map(campaignRows.map((r) => [r.id, r.name])),
      rooms: new Map(roomRows.map((r) => [r.id, { name: r.name, venueName: r.venueName }])),
    };
  }

  /** Resolve a conflict query's window, accepting either an instant or a wall clock. */
  private resolveWindow(input: { scheduledAt?: string; localStart?: string; timezone?: string; durationMinutes: number }): {
    startsAt: string;
    endsAt: string;
  } {
    let startsAt: string;
    if (input.localStart) {
      if (!input.timezone) throw new BadRequestException('localStart requires a timezone');
      this.assertTimezone(input.timezone);
      startsAt = wallClockToUtc(input.localStart, input.timezone).utcIso;
    } else if (input.scheduledAt) {
      const ms = Date.parse(input.scheduledAt);
      if (!Number.isFinite(ms)) throw new BadRequestException('scheduledAt is not a valid date-time');
      startsAt = new Date(ms).toISOString();
    } else {
      throw new BadRequestException('scheduledAt or localStart is required');
    }
    return { startsAt, endsAt: endInstant(startsAt, input.durationMinutes) };
  }

  /** Read-only "would this collide?" probe. Writes nothing. */
  async checkConflicts(input: ScheduleConflictQuery, user: RequestUser): Promise<ScheduleConflictReport> {
    const { startsAt, endsAt } = this.resolveWindow(input);
    const raws = this.findConflictRows(this.db, {
      startsAt,
      endsAt,
      roomId: input.roomId,
      assignedDmUserId: input.assignedDmUserId,
      memberUserIds: input.memberUserIds,
      excludeScheduleId: input.excludeScheduleId,
    });
    const scope = await this.roles.accessibleCampaignIds(user);
    const names = await this.lookupNames(
      raws.map((r) => r.campaignId),
      raws.flatMap((r) => (r.roomId != null ? [r.roomId] : [])),
    );
    return { scheduledAt: startsAt, endsAt, conflicts: this.redactConflicts(raws, scope, names) };
  }

  /**
   * Turn raw conflicts into the 409 a non-forced booking rejects with.
   *
   * The message deliberately names only the resource and the window; the
   * redacted conflict list travels in the error body, so the same redaction rule
   * applies to the failure path as to the read path. A coordinator who forces
   * past this still gets the (redacted) list back in the success payload.
   */
  private conflictException(conflicts: ScheduleConflict[]): ConflictException {
    const kinds = [...new Set(conflicts.map((c) => c.kind))].join(', ');
    return new ConflictException({
      code: 'SCHEDULE_CONFLICT',
      message: `Booking conflicts (${kinds}). Resolve them or retry with force.`,
      conflicts,
    });
  }

  // ----- series -----

  async listSeries(campaignId: number): Promise<SessionSeries[]> {
    const rows = await this.db
      .select()
      .from(sessionSeries)
      .where(eq(sessionSeries.campaignId, campaignId))
      .orderBy(asc(sessionSeries.startDate), asc(sessionSeries.id));
    return rows.map(seriesToDomain);
  }

  async getSeries(id: number): Promise<SessionSeriesWithOccurrences> {
    const row = await this.getSeriesRowOrThrow(id);
    const [occurrences, exceptions] = await Promise.all([
      this.db
        .select()
        .from(scheduledSessions)
        .where(eq(scheduledSessions.seriesId, id))
        .orderBy(asc(scheduledSessions.occurrenceIndex), asc(scheduledSessions.id)),
      this.db.select().from(seriesExceptions).where(eq(seriesExceptions.seriesId, id)).orderBy(asc(seriesExceptions.id)),
    ]);
    return {
      ...seriesToDomain(row),
      occurrences: occurrences.map(scheduledSessionToDomain),
      exceptions: exceptions.map(exceptionToDomain),
    };
  }

  async getSeriesRowOrThrow(id: number): Promise<SeriesRow> {
    const [row] = await this.db.select().from(sessionSeries).where(eq(sessionSeries.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Session series ${id} not found`);
    return row;
  }

  async getOccurrenceRowOrThrow(id: number): Promise<ScheduleRow> {
    const [row] = await this.db.select().from(scheduledSessions).where(eq(scheduledSessions.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Scheduled session ${id} not found`);
    return row;
  }

  /**
   * Create a series and materialize its occurrences.
   *
   * The conflict check and every occurrence insert happen inside ONE
   * better-sqlite3 transaction. better-sqlite3 is synchronous and single-process,
   * so no other statement of this process can interleave between them — the
   * "room was free when we looked" window is closed structurally rather than by
   * hoping the check runs close enough to the write.
   */
  async createSeries(
    campaignId: number,
    input: SessionSeriesCreate & { force?: boolean },
    user: RequestUser,
    role: Role,
  ): Promise<SessionSeriesWithOccurrences> {
    this.assertTimezone(input.timezone);
    const roomId = input.roomId ?? null;
    const venueId = await this.resolveVenueId(input.venueId ?? null, roomId);

    const occurrences = this.expandOrThrow({
      timezone: input.timezone,
      startDate: input.startDate,
      startTime: input.startTime,
      durationMinutes: input.durationMinutes ?? 240,
      freq: input.freq,
      interval: input.interval ?? 1,
      count: input.count ?? 1,
      untilDate: input.untilDate ?? null,
    });

    const assignedDmUserId = input.assignedDmUserId ?? '';
    const ts = nowIso();
    const seriesUid = generateSeriesUid();
    // A series can collide with ITSELF when the duration exceeds the recurrence
    // step (a daily 25-hour marathon), which no stored-row probe would catch.
    const batchConflicts = this.intraBatchConflicts(
      occurrences.map((occ) => ({
        startsAt: occ.scheduledAt,
        endsAt: endInstant(occ.scheduledAt, occ.durationMinutes),
        roomId,
        dm: assignedDmUserId,
        campaignId,
        title: input.title ?? '',
      })),
    );

    const created = this.db.transaction((tx) => {
      const conflicts: RawConflict[] = [];
      for (const occ of occurrences) {
        conflicts.push(
          ...this.findConflictRows(tx, {
            startsAt: occ.scheduledAt,
            endsAt: endInstant(occ.scheduledAt, occ.durationMinutes),
            roomId,
            assignedDmUserId,
            memberUserIds: [],
          }),
        );
      }
      if ((conflicts.length > 0 || batchConflicts.length > 0) && !input.force) {
        // Rolls the transaction back: nothing is written on a rejected booking.
        throw new SeriesConflictSignal(conflicts, batchConflicts);
      }

      const [series] = tx
        .insert(sessionSeries)
        .values({
          campaignId,
          title: input.title ?? '',
          location: input.location ?? '',
          notes: input.notes ?? '',
          timezone: input.timezone,
          startDate: input.startDate,
          startTime: input.startTime,
          durationMinutes: input.durationMinutes ?? 240,
          freq: input.freq,
          interval: input.interval ?? 1,
          count: input.count ?? 1,
          untilDate: input.untilDate ?? null,
          venueId,
          roomId,
          assignedDmUserId,
          capacity: input.capacity ?? 0,
          eventId: input.eventId ?? '',
          seasonId: input.seasonId ?? '',
          seriesUid,
          status: 'active',
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();

      for (const occ of occurrences) {
        this.insertOccurrence(tx, series, occ, ts);
      }
      return series;
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'organized_play.series_create',
      entityType: 'session',
      entityId: created.id,
      campaignId,
      detail: `occurrences=${occurrences.length} tz=${input.timezone}`,
    });
    this.events.emit({ type: 'schedule.updated', campaignId, scheduleId: created.id });
    return this.getSeries(created.id);
  }

  /** Insert one materialized occurrence row. Sync: called inside a transaction. */
  private insertOccurrence(
    tx: SyncDb,
    series: SeriesRow,
    occ: { index: number; localStart: string; scheduledAt: string; durationMinutes: number },
    ts: string,
  ): ScheduleRow {
    const [row] = tx
      .insert(scheduledSessions)
      .values({
        campaignId: series.campaignId,
        scheduledAt: occ.scheduledAt,
        durationMinutes: occ.durationMinutes,
        title: series.title,
        location: series.location,
        notes: series.notes,
        status: 'scheduled',
        seriesId: series.id,
        occurrenceIndex: occ.index,
        timezone: series.timezone,
        localStart: occ.localStart,
        venueId: series.venueId,
        roomId: series.roomId,
        assignedDmUserId: series.assignedDmUserId,
        capacity: series.capacity,
        eventId: series.eventId,
        seasonId: series.seasonId,
        icsUid: seriesIcsUid(series.seriesUid, occ.index),
        icsSequence: 0,
        originalScheduledAt: occ.scheduledAt,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    return row;
  }

  private expandOrThrow(spec: Parameters<typeof expandRecurrence>[0]): ReturnType<typeof expandRecurrence> {
    try {
      const out = expandRecurrence(spec);
      if (out.length === 0) throw new BadRequestException('Recurrence produced no occurrences');
      return out;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(err instanceof Error ? err.message : 'Invalid recurrence');
    }
  }

  private async resolveVenueId(venueId: number | null, roomId: number | null): Promise<number | null> {
    if (roomId == null) {
      if (venueId != null) await this.getVenueOrThrow(venueId);
      return venueId;
    }
    const room = await this.getRoomOrThrow(roomId);
    // The room is the source of truth for which venue a booking is in; an
    // explicit venueId that disagrees is a caller bug, not something to persist.
    if (venueId != null && venueId !== room.venueId) {
      throw new BadRequestException(`Room ${roomId} does not belong to venue ${venueId}`);
    }
    return room.venueId;
  }

  /**
   * Series-level metadata edit. Fans out to FUTURE occurrences only, and only to
   * those with no per-occurrence exception of their own: a table the coordinator
   * has already moved or re-seated must not be silently pulled back to the series
   * default. Past occurrences are history and are never rewritten.
   */
  async updateSeries(
    id: number,
    input: SessionSeriesUpdate & { force?: boolean },
    user: RequestUser,
    role: Role,
    nowMs: number = Date.now(),
  ): Promise<SessionSeriesWithOccurrences> {
    const existing = await this.getSeriesRowOrThrow(id);
    if (input.roomId !== undefined && input.roomId !== null) await this.getRoomOrThrow(input.roomId);
    const venueId = input.roomId === undefined ? existing.venueId : await this.resolveVenueId(null, input.roomId);
    const ts = nowIso();
    const nowStr = new Date(nowMs).toISOString();

    const overriddenIds = new Set(
      (await this.db.select({ occurrenceId: seriesExceptions.occurrenceId }).from(seriesExceptions).where(eq(seriesExceptions.seriesId, id)))
        .map((r) => r.occurrenceId)
        .filter((v): v is number => v != null),
    );

    // Which shared resources this edit actually moves. Everything else in the
    // body (title, notes, capacity, event/season keys) holds no booking, so it
    // cannot collide with anything and needs no probe.
    const nextRoomId = input.roomId === undefined ? existing.roomId : input.roomId;
    const nextDm = input.assignedDmUserId === undefined ? existing.assignedDmUserId : input.assignedDmUserId;
    const roomChanged = nextRoomId !== existing.roomId;
    const dmChanged = nextDm !== existing.assignedDmUserId;

    this.db.transaction((tx) => {
      const future = tx
        .select()
        .from(scheduledSessions)
        .where(and(eq(scheduledSessions.seriesId, id), sql`${scheduledSessions.scheduledAt} > ${nowStr}`))
        .all();
      const affected = future.filter((occ) => !overriddenIds.has(occ.id));

      // #588: a metadata PATCH that carries `roomId` or `assignedDmUserId` is a
      // BULK reassignment wearing a metadata edit's clothes — one request moves
      // every future unoverridden occurrence onto the new resource at once. It is
      // given the same probe, the same `force` override and the same 409 as its
      // per-occurrence siblings (reschedule/reassign) DELIBERATELY, and this
      // comment exists so the next reader does not have to re-derive why:
      // without it the cheapest endpoint in the module was also the only one that
      // could create cross-campaign double-bookings, it could create many of them
      // in a single call, and nothing in the 200 response told the caller it had
      // happened. A coordinator override is a legitimate thing to want here; an
      // override the caller cannot tell they took is not.
      //
      // In one transaction with the writes below, so the probe's answer still
      // holds when the rows are claimed — the same structural guarantee
      // createSeries and rescheduleOccurrence rest on.
      if (roomChanged || dmChanged) {
        const conflicts: RawConflict[] = [];
        for (const occ of affected) {
          conflicts.push(
            ...this.findConflictRows(tx, {
              startsAt: occ.scheduledAt,
              endsAt: endInstant(occ.scheduledAt, occ.durationMinutes),
              // Only the resources actually CHANGING are probed: re-confirming a
              // room the occurrence already holds would report its own
              // neighbours as if this edit had caused them (reassignOccurrence
              // makes the same distinction, for the same reason).
              roomId: roomChanged ? nextRoomId : null,
              assignedDmUserId: dmChanged ? nextDm : '',
              memberUserIds: [],
              excludeScheduleId: occ.id,
            }),
          );
        }
        // Rolls the whole transaction back: a rejected fan-out writes nothing,
        // not even the series-level metadata.
        if (conflicts.length > 0 && !input.force) throw new SeriesConflictSignal(conflicts);
      }

      tx.update(sessionSeries)
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.roomId !== undefined ? { roomId: input.roomId, venueId } : {}),
          ...(input.assignedDmUserId !== undefined ? { assignedDmUserId: input.assignedDmUserId } : {}),
          ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
          ...(input.seasonId !== undefined ? { seasonId: input.seasonId } : {}),
          updatedAt: ts,
        })
        .where(eq(sessionSeries.id, id))
        .run();

      for (const occ of affected) {
        // `notes` renders as DESCRIPTION in the feed and is written three lines
        // below, so it belongs in this predicate exactly as title and location do
        // (see calendarFieldChanged in SchedulingService.update for the same rule
        // on the one-off path).
        const renders =
          (input.title !== undefined && input.title !== occ.title)
          || (input.location !== undefined && input.location !== occ.location)
          || (input.notes !== undefined && input.notes !== occ.notes)
          || (input.roomId !== undefined && input.roomId !== occ.roomId);
        tx.update(scheduledSessions)
          .set({
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.location !== undefined ? { location: input.location } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            ...(input.roomId !== undefined ? { roomId: input.roomId, venueId } : {}),
            ...(input.assignedDmUserId !== undefined ? { assignedDmUserId: input.assignedDmUserId } : {}),
            ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
            ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
            ...(input.seasonId !== undefined ? { seasonId: input.seasonId } : {}),
            ...(renders ? { icsSequence: occ.icsSequence + 1 } : {}),
            updatedAt: ts,
          })
          .where(eq(scheduledSessions.id, occ.id))
          .run();
      }
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'organized_play.series_update',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
    });
    this.events.emit({ type: 'schedule.updated', campaignId: existing.campaignId, scheduleId: id });
    return this.getSeries(id);
  }

  /**
   * Materialize more occurrences past the end of an existing series, continuing
   * the ORIGINAL wall-clock rule rather than striding from the last instant —
   * which is what keeps an extension that crosses a DST boundary at 19:00 local.
   */
  async extendSeries(id: number, addCount: number, user: RequestUser, role: Role, force = false): Promise<SessionSeriesWithOccurrences> {
    const existing = await this.getSeriesRowOrThrow(id);
    if (existing.status !== 'active') throw new BadRequestException('Cancelled series cannot be extended');
    const nextCount = existing.count + addCount;
    if (nextCount > MAX_SERIES_OCCURRENCES) {
      throw new BadRequestException(`A series may hold at most ${MAX_SERIES_OCCURRENCES} occurrences`);
    }
    const all = this.expandOrThrow({
      timezone: existing.timezone,
      startDate: existing.startDate,
      startTime: existing.startTime,
      durationMinutes: existing.durationMinutes,
      freq: existing.freq as RecurrenceFreq,
      interval: existing.interval,
      count: nextCount,
      untilDate: existing.untilDate,
    });
    const existingIndexes = new Set(
      (await this.db.select({ occurrenceIndex: scheduledSessions.occurrenceIndex }).from(scheduledSessions).where(eq(scheduledSessions.seriesId, id))).map(
        (r) => r.occurrenceIndex,
      ),
    );
    const fresh = all.filter((o) => !existingIndexes.has(o.index));
    if (fresh.length === 0) throw new BadRequestException('Recurrence produced no new occurrences (untilDate reached?)');

    // The same self-collision hazard createSeries and applyTemplate guard against,
    // and for the identical reason: NOTHING in `fresh` is stored yet, so the
    // per-row probe inside the transaction below cannot see the batch against
    // itself. An extension whose duration exceeds its recurrence step (a daily
    // 25-hour marathon), or one that straddles a spring-forward transition,
    // would otherwise double-book its own room and its own DM and pass every
    // database probe on the way through.
    const batchConflicts = this.intraBatchConflicts(
      fresh.map((occ) => ({
        startsAt: occ.scheduledAt,
        endsAt: endInstant(occ.scheduledAt, occ.durationMinutes),
        roomId: existing.roomId,
        dm: existing.assignedDmUserId,
        campaignId: existing.campaignId,
        title: existing.title,
      })),
    );

    const ts = nowIso();
    this.db.transaction((tx) => {
      const conflicts: RawConflict[] = [];
      for (const occ of fresh) {
        conflicts.push(
          ...this.findConflictRows(tx, {
            startsAt: occ.scheduledAt,
            endsAt: endInstant(occ.scheduledAt, occ.durationMinutes),
            roomId: existing.roomId,
            assignedDmUserId: existing.assignedDmUserId,
            memberUserIds: [],
          }),
        );
      }
      if ((conflicts.length > 0 || batchConflicts.length > 0) && !force) {
        throw new SeriesConflictSignal(conflicts, batchConflicts);
      }
      tx.update(sessionSeries).set({ count: nextCount, updatedAt: ts }).where(eq(sessionSeries.id, id)).run();
      for (const occ of fresh) this.insertOccurrence(tx, { ...existing, count: nextCount }, occ, ts);
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'organized_play.series_extend',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
      detail: `added=${fresh.length}`,
    });
    this.events.emit({ type: 'schedule.updated', campaignId: existing.campaignId, scheduleId: id });
    return this.getSeries(id);
  }

  /**
   * Cancel a whole series: mark it cancelled and cancel every FUTURE occurrence,
   * non-destructively. Rows, RSVPs and lineage all survive — the same choice
   * issue #504 made for a single night, for the same reason (the ICS feed must
   * keep publishing STATUS:CANCELLED under each UID, and a cancelled night that
   * vanished would take the party's RSVP history with it). Past occurrences are
   * left exactly as they are: they already happened.
   */
  async cancelSeries(id: number, reason: string, user: RequestUser, role: Role, nowMs: number = Date.now()): Promise<SessionSeriesWithOccurrences> {
    const existing = await this.getSeriesRowOrThrow(id);
    const ts = nowIso();
    const nowStr = new Date(nowMs).toISOString();
    const cancelled = this.db.transaction((tx) => {
      tx.update(sessionSeries).set({ status: 'cancelled', updatedAt: ts }).where(eq(sessionSeries.id, id)).run();
      const future = tx
        .select()
        .from(scheduledSessions)
        .where(and(eq(scheduledSessions.seriesId, id), sql`${scheduledSessions.scheduledAt} > ${nowStr}`, scheduleLiveSql()))
        .all();
      for (const occ of future) {
        tx.update(scheduledSessions)
          .set({
            status: 'cancelled',
            cancelledAt: ts,
            cancelledBy: user.id,
            cancellationReason: reason,
            icsSequence: occ.icsSequence + 1,
            updatedAt: ts,
          })
          .where(eq(scheduledSessions.id, occ.id))
          .run();
        tx.insert(seriesExceptions)
          .values({
            seriesId: id,
            occurrenceId: occ.id,
            recurrenceLocalDate: recurrenceLocalDateFor(occ),
            kind: 'cancel',
            fromScheduledAt: occ.scheduledAt,
            toScheduledAt: null,
            toLocalStart: '',
            reason,
            actorUserId: user.id,
            createdAt: ts,
          })
          .run();
      }
      return future.length;
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'organized_play.series_cancel',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
      detail: `cancelled=${cancelled}`,
    });
    this.events.emit({ type: 'schedule.updated', campaignId: existing.campaignId, scheduleId: id });
    return this.getSeries(id);
  }

  // ----- per-occurrence exceptions -----

  /**
   * Move ONE occurrence. The row keeps its id, its UID, its RSVPs and its series
   * membership; only the instant moves, `original_scheduled_at` is preserved as
   * lineage, SEQUENCE advances so subscribers re-apply, and the ledger records
   * both instants. Creating a replacement row instead would orphan the RSVPs and
   * hand the subscriber a ghost on the old night.
   */
  async rescheduleOccurrence(
    id: number,
    input: OccurrenceReschedule,
    user: RequestUser,
    role: Role,
  ): Promise<{ occurrence: ScheduledSession; conflicts: ScheduleConflict[] }> {
    const existing = await this.getOccurrenceRowOrThrow(id);
    if (existing.status === 'cancelled') {
      throw new BadRequestException('Cancelled scheduled sessions cannot be rescheduled — restore it first');
    }
    const timezone = input.timezone ?? existing.timezone;
    if (input.timezone) this.assertTimezone(input.timezone);
    let scheduledAt: string;
    let localStart = '';
    if (input.localStart) {
      if (!timezone) throw new BadRequestException('localStart requires a timezone on the occurrence or in the body');
      scheduledAt = wallClockToUtc(input.localStart, timezone).utcIso;
      localStart = input.localStart;
    } else if (input.scheduledAt) {
      const ms = Date.parse(input.scheduledAt);
      if (!Number.isFinite(ms)) throw new BadRequestException('scheduledAt is not a valid date-time');
      scheduledAt = new Date(ms).toISOString();
      localStart = timezone ? utcToLocalDateTime(scheduledAt, timezone) : '';
    } else {
      throw new BadRequestException('scheduledAt or localStart is required');
    }
    const durationMinutes = input.durationMinutes ?? existing.durationMinutes;
    const roomId = input.roomId === undefined ? existing.roomId : input.roomId;
    const venueId = roomId === existing.roomId ? existing.venueId : await this.resolveVenueId(null, roomId);
    const scope = await this.roles.accessibleCampaignIds(user);
    const ts = nowIso();

    let rawConflicts: RawConflict[] = [];
    this.db.transaction((tx) => {
      const conflicts = this.findConflictRows(tx, {
        startsAt: scheduledAt,
        endsAt: endInstant(scheduledAt, durationMinutes),
        roomId,
        assignedDmUserId: existing.assignedDmUserId,
        memberUserIds: [],
        excludeScheduleId: id,
      });
      if (conflicts.length > 0 && !input.force) throw new SeriesConflictSignal(conflicts);
      rawConflicts = conflicts;
      tx.update(scheduledSessions)
        .set({
          scheduledAt,
          durationMinutes,
          timezone,
          localStart,
          roomId,
          venueId,
          // Set once, then preserved: the FIRST materialized instant is the
          // lineage anchor, so a twice-moved night still points at where it began.
          originalScheduledAt: existing.originalScheduledAt ?? existing.scheduledAt,
          icsSequence: existing.icsSequence + 1,
          updatedAt: ts,
        })
        .where(eq(scheduledSessions.id, id))
        .run();
      if (existing.seriesId != null) {
        tx.insert(seriesExceptions)
          .values({
            seriesId: existing.seriesId,
            occurrenceId: id,
            // The ORIGINAL local date, not the one this row currently sits on:
            // otherwise a twice-moved occurrence files its two entries under two
            // different recurrence ids and the ledger cannot line them up. See
            // recurrenceLocalDateFor.
            recurrenceLocalDate: recurrenceLocalDateFor(existing),
            kind: 'reschedule',
            fromScheduledAt: existing.scheduledAt,
            toScheduledAt: scheduledAt,
            toLocalStart: localStart,
            reason: input.reason ?? '',
            actorUserId: user.id,
            createdAt: ts,
          })
          .run();
      }
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'organized_play.occurrence_reschedule',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
      detail: `${existing.scheduledAt} -> ${scheduledAt}`,
    });
    this.events.emit({ type: 'schedule.updated', campaignId: existing.campaignId, scheduleId: id });

    const names = await this.lookupNames(
      rawConflicts.map((r) => r.campaignId),
      rawConflicts.flatMap((r) => (r.roomId != null ? [r.roomId] : [])),
    );
    return {
      occurrence: scheduledSessionToDomain(await this.getOccurrenceRowOrThrow(id)),
      conflicts: this.redactConflicts(rawConflicts, scope, names),
    };
  }

  /** Re-seat one occurrence: different room, running DM, or capacity. */
  async reassignOccurrence(
    id: number,
    input: OccurrenceReassign,
    user: RequestUser,
    role: Role,
  ): Promise<{ occurrence: ScheduledSession; conflicts: ScheduleConflict[] }> {
    const existing = await this.getOccurrenceRowOrThrow(id);
    if (existing.status === 'cancelled') {
      throw new BadRequestException('Cancelled scheduled sessions cannot be reassigned — restore it first');
    }
    const roomId = input.roomId === undefined ? existing.roomId : input.roomId;
    const venueId = roomId === existing.roomId ? existing.venueId : await this.resolveVenueId(null, roomId);
    const assignedDmUserId = input.assignedDmUserId ?? existing.assignedDmUserId;
    const capacity = input.capacity ?? existing.capacity;
    const scope = await this.roles.accessibleCampaignIds(user);
    const ts = nowIso();

    let rawConflicts: RawConflict[] = [];
    this.db.transaction((tx) => {
      const conflicts = this.findConflictRows(tx, {
        startsAt: existing.scheduledAt,
        endsAt: endInstant(existing.scheduledAt, existing.durationMinutes),
        // Only probe resources that are actually CHANGING: re-confirming the
        // room the occurrence already holds would report the occurrence's own
        // neighbours as if the move caused them.
        roomId: roomId !== existing.roomId ? roomId : null,
        assignedDmUserId: assignedDmUserId !== existing.assignedDmUserId ? assignedDmUserId : '',
        memberUserIds: [],
        excludeScheduleId: id,
      });
      if (conflicts.length > 0 && !input.force) throw new SeriesConflictSignal(conflicts);
      rawConflicts = conflicts;
      const renders = roomId !== existing.roomId;
      tx.update(scheduledSessions)
        .set({
          roomId,
          venueId,
          assignedDmUserId,
          capacity,
          ...(renders ? { icsSequence: existing.icsSequence + 1 } : {}),
          updatedAt: ts,
        })
        .where(eq(scheduledSessions.id, id))
        .run();
      if (existing.seriesId != null) {
        tx.insert(seriesExceptions)
          .values({
            seriesId: existing.seriesId,
            occurrenceId: id,
            recurrenceLocalDate: recurrenceLocalDateFor(existing),
            kind: 'reassign',
            fromScheduledAt: existing.scheduledAt,
            toScheduledAt: existing.scheduledAt,
            toLocalStart: existing.localStart,
            reason: input.reason ?? '',
            actorUserId: user.id,
            createdAt: ts,
          })
          .run();
      }
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'organized_play.occurrence_reassign',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
      detail: `room=${roomId ?? 'none'} dm=${assignedDmUserId || 'none'}`,
    });
    this.events.emit({ type: 'schedule.updated', campaignId: existing.campaignId, scheduleId: id });

    const names = await this.lookupNames(
      rawConflicts.map((r) => r.campaignId),
      rawConflicts.flatMap((r) => (r.roomId != null ? [r.roomId] : [])),
    );
    return {
      occurrence: scheduledSessionToDomain(await this.getOccurrenceRowOrThrow(id)),
      conflicts: this.redactConflicts(rawConflicts, scope, names),
    };
  }

  /** The exception ledger for one occurrence (its lineage). */
  async occurrenceExceptions(id: number): Promise<SeriesException[]> {
    const rows = await this.db
      .select()
      .from(seriesExceptions)
      .where(eq(seriesExceptions.occurrenceId, id))
      .orderBy(asc(seriesExceptions.id));
    return rows.map(exceptionToDomain);
  }

  // ----- coordinator calendar -----

  /**
   * The cross-campaign view a venue coordinator plans from.
   *
   * Two privacy layers, both required:
   *   1. Only rows in the shared organized-play pool are considered at all, so a
   *      private campaign is absent rather than redacted (scheduleOrganizedPlaySql).
   *   2. Of those, rows in campaigns the caller cannot read are reduced to an
   *      opaque busy block. What survives is the RESOURCE picture a coordinator
   *      plans from — window, local wall clock, venue/room, capacity, seats taken,
   *      event/season key, lifecycle status — and nothing that identifies the
   *      campaign (id, name, title, schedule id, series id) or any PERSON.
   *
   * `assignedDmUserId` is redacted with the campaign identity rather than kept
   * with the resource fields. This endpoint is open to any authenticated user over
   * a 366-day window with no campaign filter, so returning it would answer, in one
   * request, "where is this named person every night for the next year" for
   * campaigns the caller cannot read. The conflict probe still reports a `dm`
   * collision, but only for an id the CALLER already supplied — confirming a
   * guess is a far smaller disclosure than enumerating the mapping wholesale.
   */
  async coordinatorCalendar(
    user: RequestUser,
    params: { from: string; to: string; venueId?: number; roomId?: number; eventId?: string; seasonId?: string },
  ): Promise<CoordinatorCalendar> {
    const fromMs = Date.parse(params.from);
    const toMs = Date.parse(params.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new BadRequestException('from and to must be ISO date-times');
    }
    if (toMs <= fromMs) throw new BadRequestException('to must be after from');
    if (toMs - fromMs > MAX_CALENDAR_WINDOW_DAYS * 86_400_000) {
      throw new BadRequestException(`Calendar window may not exceed ${MAX_CALENDAR_WINDOW_DAYS} days`);
    }
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();

    const filters = [scheduleOrganizedPlaySql(), scheduleOverlapsSql(from, to)];
    if (params.venueId != null) filters.push(eq(scheduledSessions.venueId, params.venueId));
    if (params.roomId != null) filters.push(eq(scheduledSessions.roomId, params.roomId));
    if (params.eventId) filters.push(eq(scheduledSessions.eventId, params.eventId));
    if (params.seasonId) filters.push(eq(scheduledSessions.seasonId, params.seasonId));

    const rows = await this.db
      .select({
        id: scheduledSessions.id,
        campaignId: scheduledSessions.campaignId,
        title: scheduledSessions.title,
        scheduledAt: scheduledSessions.scheduledAt,
        durationMinutes: scheduledSessions.durationMinutes,
        effectiveStatus: scheduleEffectiveStatusSql(),
        timezone: scheduledSessions.timezone,
        localStart: scheduledSessions.localStart,
        venueId: scheduledSessions.venueId,
        roomId: scheduledSessions.roomId,
        capacity: scheduledSessions.capacity,
        eventId: scheduledSessions.eventId,
        seasonId: scheduledSessions.seasonId,
        assignedDmUserId: scheduledSessions.assignedDmUserId,
        seriesId: scheduledSessions.seriesId,
      })
      .from(scheduledSessions)
      .where(and(...filters))
      .orderBy(asc(scheduledSessions.scheduledAt), asc(scheduledSessions.id));

    const scope = await this.roles.accessibleCampaignIds(user);
    const [names, seats] = await Promise.all([
      this.lookupNames(
        rows.map((r) => r.campaignId),
        rows.flatMap((r) => (r.roomId != null ? [r.roomId] : [])),
      ),
      this.seatCounts(rows.map((r) => r.id)),
    ]);
    const venueNames = await this.venueNames(rows.flatMap((r) => (r.venueId != null ? [r.venueId] : [])));

    const entries: CoordinatorCalendarEntry[] = rows.map((row) => {
      const visible = canSee(scope, row.campaignId);
      const room = row.roomId != null ? names.rooms.get(row.roomId) : undefined;
      return {
        visible,
        startsAt: row.scheduledAt,
        endsAt: endInstant(row.scheduledAt, row.durationMinutes),
        status: row.effectiveStatus as CoordinatorCalendarEntry['status'],
        timezone: row.timezone,
        localStart: row.localStart,
        venueId: row.venueId,
        venueName: room?.venueName ?? (row.venueId != null ? (venueNames.get(row.venueId) ?? '') : ''),
        roomId: row.roomId,
        roomName: room?.name ?? '',
        capacity: row.capacity,
        seatsTaken: seats.get(row.id) ?? 0,
        eventId: row.eventId,
        seasonId: row.seasonId,
        // A person, not a resource — see the docblock. Redacted with identity.
        assignedDmUserId: visible ? row.assignedDmUserId : '',
        scheduleId: visible ? row.id : null,
        campaignId: visible ? row.campaignId : null,
        campaignName: visible ? (names.campaigns.get(row.campaignId) ?? null) : null,
        title: visible ? row.title : null,
        seriesId: visible ? row.seriesId : null,
      };
    });
    return { from, to, entries };
  }

  private async venueNames(ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.select({ id: playVenues.id, name: playVenues.name }).from(playVenues).where(inArray(playVenues.id, unique));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** How many members have said yes, per schedule id. */
  private async seatCounts(scheduleIds: number[]): Promise<Map<number, number>> {
    const unique = [...new Set(scheduleIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ scheduleId: sessionRsvps.scheduledSessionId, taken: sql<number>`count(*)` })
      .from(sessionRsvps)
      .where(and(inArray(sessionRsvps.scheduledSessionId, unique), eq(sessionRsvps.status, 'yes')))
      .groupBy(sessionRsvps.scheduledSessionId);
    return new Map(rows.map((r) => [r.scheduleId, Number(r.taken)]));
  }

  // ----- schedule templates + bulk creation -----

  async listTemplates(): Promise<ScheduleTemplate[]> {
    const rows = await this.db.select().from(scheduleTemplates).orderBy(asc(scheduleTemplates.name), asc(scheduleTemplates.id));
    return rows.map((r) => this.templateToDomain(r));
  }

  private templateToDomain(row: typeof scheduleTemplates.$inferSelect): ScheduleTemplate {
    let slots: z.infer<typeof ScheduleTemplateSlot>[] = [];
    try {
      const parsed: unknown = JSON.parse(row.slotsJson);
      // Re-parse through the Zod schema rather than trusting the stored JSON:
      // the column is text, and a hand-edited or partially-migrated row must not
      // become an ill-typed object flowing through the whole bulk-create path.
      slots = Array.isArray(parsed) ? parsed.map((s) => ScheduleTemplateSlot.parse(s)) : [];
    } catch {
      slots = [];
    }
    return {
      id: row.id,
      name: row.name,
      venueId: row.venueId,
      timezone: row.timezone,
      freq: row.freq as RecurrenceFreq,
      interval: row.interval,
      count: row.count,
      eventId: row.eventId,
      seasonId: row.seasonId,
      slots,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async createTemplate(input: ScheduleTemplateCreate, user: RequestUser): Promise<ScheduleTemplate> {
    this.assertTimezone(input.timezone);
    if (input.venueId != null) await this.getVenueOrThrow(input.venueId);
    for (const slot of input.slots) {
      if (slot.roomId != null) await this.getRoomOrThrow(slot.roomId);
    }
    const ts = nowIso();
    const [row] = await this.db
      .insert(scheduleTemplates)
      .values({
        name: input.name.trim(),
        venueId: input.venueId ?? null,
        timezone: input.timezone,
        freq: input.freq ?? 'weekly',
        interval: input.interval ?? 1,
        count: input.count ?? 8,
        eventId: input.eventId ?? '',
        seasonId: input.seasonId ?? '',
        slotsJson: JSON.stringify(input.slots),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'admin',
      action: 'organized_play.template_create',
      entityType: 'schedule_template',
      entityId: row.id,
      detail: `slots=${input.slots.length}`,
    });
    return this.templateToDomain(row);
  }

  async deleteTemplate(id: number, user: RequestUser): Promise<{ deleted: true }> {
    const [row] = await this.db.select().from(scheduleTemplates).where(eq(scheduleTemplates.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Schedule template ${id} not found`);
    await this.db.delete(scheduleTemplates).where(eq(scheduleTemplates.id, id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'admin',
      action: 'organized_play.template_delete',
      entityType: 'schedule_template',
      entityId: id,
    });
    return { deleted: true };
  }

  /**
   * Bulk-create every series a template describes, in one transaction.
   *
   * `dmRotation` is the organized-play rotating-DM pattern: slot 0 goes to the
   * first DM, slot 1 to the second, wrapping round. Rotating is what MAKES the
   * bookings legal — three simultaneous tables with one DM would be three DM
   * conflicts — so the rotation is applied before the conflict check, not after.
   */
  async applyTemplate(id: number, input: ScheduleTemplateApply, user: RequestUser, role: Role): Promise<ScheduleTemplateApplyResult> {
    const [templateRow] = await this.db.select().from(scheduleTemplates).where(eq(scheduleTemplates.id, id)).limit(1);
    if (!templateRow) throw new NotFoundException(`Schedule template ${id} not found`);
    const template = this.templateToDomain(templateRow);
    const count = input.count ?? template.count;

    // One plan per slot, anchored to the first date on/after `startDate` whose
    // weekday matches. Pure computation, so a bad template fails before any write.
    const plans = template.slots.map((slot, i) => {
      const startDate = firstOnOrAfterWeekday(input.startDate, slot.weekday);
      const assignedDmUserId =
        input.dmRotation.length > 0 ? input.dmRotation[i % input.dmRotation.length] : slot.assignedDmUserId;
      return {
        slot,
        startDate,
        assignedDmUserId,
        occurrences: this.expandOrThrow({
          timezone: template.timezone,
          startDate,
          startTime: slot.startTime,
          durationMinutes: slot.durationMinutes,
          freq: template.freq,
          interval: template.interval,
          count,
        }),
      };
    });

    const roomVenue = new Map<number, number>();
    for (const plan of plans) {
      if (plan.slot.roomId != null && !roomVenue.has(plan.slot.roomId)) {
        const room = await this.getRoomOrThrow(plan.slot.roomId);
        roomVenue.set(room.id, room.venueId);
      }
    }

    // Slots must be checked against EACH OTHER as well as against stored rows —
    // nothing in this batch exists yet, so a single DM booked onto two
    // simultaneous tables would otherwise pass every database probe.
    const batchConflicts = this.intraBatchConflicts(
      plans.flatMap((plan) =>
        plan.occurrences.map((occ) => ({
          startsAt: occ.scheduledAt,
          endsAt: endInstant(occ.scheduledAt, occ.durationMinutes),
          roomId: plan.slot.roomId,
          dm: plan.assignedDmUserId,
          campaignId: input.campaignId,
          title: plan.slot.title || template.name,
        })),
      ),
    );

    const scope = await this.roles.accessibleCampaignIds(user);
    const ts = nowIso();
    let rawConflicts: RawConflict[] = [];
    let occurrencesCreated = 0;

    const createdSeries = this.db.transaction((tx) => {
      const conflicts: RawConflict[] = [];
      const made: SeriesRow[] = [];
      for (const plan of plans) {
        const roomId = plan.slot.roomId;
        for (const occ of plan.occurrences) {
          conflicts.push(
            ...this.findConflictRows(tx, {
              startsAt: occ.scheduledAt,
              endsAt: endInstant(occ.scheduledAt, occ.durationMinutes),
              roomId,
              assignedDmUserId: plan.assignedDmUserId,
              memberUserIds: [],
            }),
          );
        }
      }
      if ((conflicts.length > 0 || batchConflicts.length > 0) && !input.force) {
        throw new SeriesConflictSignal(conflicts, batchConflicts);
      }
      rawConflicts = conflicts;

      for (const plan of plans) {
        const roomId = plan.slot.roomId;
        const [series] = tx
          .insert(sessionSeries)
          .values({
            campaignId: input.campaignId,
            title: plan.slot.title || template.name,
            location: '',
            notes: '',
            timezone: template.timezone,
            startDate: plan.startDate,
            startTime: plan.slot.startTime,
            durationMinutes: plan.slot.durationMinutes,
            freq: template.freq,
            interval: template.interval,
            count,
            untilDate: null,
            venueId: roomId != null ? (roomVenue.get(roomId) ?? template.venueId) : template.venueId,
            roomId,
            assignedDmUserId: plan.assignedDmUserId,
            capacity: plan.slot.capacity,
            eventId: input.eventId ?? template.eventId,
            seasonId: input.seasonId ?? template.seasonId,
            seriesUid: generateSeriesUid(),
            status: 'active',
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        for (const occ of plan.occurrences) {
          this.insertOccurrence(tx, series, occ, ts);
          occurrencesCreated += 1;
        }
        made.push(series);
      }
      return made;
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'organized_play.template_apply',
      entityType: 'schedule_template',
      entityId: id,
      campaignId: input.campaignId,
      detail: `series=${createdSeries.length} occurrences=${occurrencesCreated}`,
    });
    for (const series of createdSeries) {
      this.events.emit({ type: 'schedule.updated', campaignId: input.campaignId, scheduleId: series.id });
    }

    const names = await this.lookupNames(
      rawConflicts.map((r) => r.campaignId),
      rawConflicts.flatMap((r) => (r.roomId != null ? [r.roomId] : [])),
    );
    return {
      templateId: id,
      campaignId: input.campaignId,
      series: createdSeries.map(seriesToDomain),
      occurrencesCreated,
      conflicts: [...this.redactConflicts(rawConflicts, scope, names), ...batchConflicts],
    };
  }

  // ----- attendance (read-only join) -----

  /**
   * Read the occurrence -> played session -> attendance chain.
   *
   * Deliberately READ-ONLY and additive. The schedule↔recap link is the one
   * established in issue #504 and is not re-derived here; attendance rows belong
   * to the recap and are not copied, mirrored or rewritten. That is what "link
   * occurrences to played sessions and attendance non-destructively" has to mean:
   * a campaign that never touches organized play keeps identical rows, and this
   * view is a projection over what is already there.
   */
  async occurrenceAttendance(scheduleId: number): Promise<OccurrenceAttendance> {
    const row = await this.getOccurrenceRowOrThrow(scheduleId);
    const rsvpYesRows = await this.db
      .select({ id: sessionRsvps.id })
      .from(sessionRsvps)
      .where(and(eq(sessionRsvps.scheduledSessionId, scheduleId), eq(sessionRsvps.status, 'yes')));
    const rsvpYes = rsvpYesRows.length;
    const base: OccurrenceAttendance = {
      scheduleId,
      sessionId: null,
      sessionNumber: null,
      capacity: row.capacity,
      rsvpYes,
      seatsRemaining: row.capacity > 0 ? Math.max(0, row.capacity - rsvpYes) : null,
      attendees: [],
    };
    if (row.sessionId == null) return base;
    const [session] = await this.db
      .select({ id: sessions.id, number: sessions.number })
      .from(sessions)
      .where(and(eq(sessions.id, row.sessionId), notDeleted(sessions.deletedAt)))
      .limit(1);
    // A trashed recap is invisible to every other schedule read (#504); this view
    // agrees rather than surfacing a link the caller cannot open.
    if (!session) return base;
    const attendeeRows = await this.db
      .select({ characterId: sessionAttendees.characterId, characterName: sessionAttendees.characterName })
      .from(sessionAttendees)
      .where(eq(sessionAttendees.sessionId, session.id))
      .orderBy(asc(sessionAttendees.id));
    return {
      ...base,
      sessionId: session.id,
      sessionNumber: session.number,
      attendees: attendeeRows.map((a) => ({ characterId: a.characterId, characterName: a.characterName })),
    };
  }

  /** Series rows for a campaign, newest first — used by the campaign purge sweep. */
  async seriesIdsForCampaign(campaignId: number): Promise<number[]> {
    const rows = await this.db.select({ id: sessionSeries.id }).from(sessionSeries).where(eq(sessionSeries.campaignId, campaignId));
    return rows.map((r) => r.id);
  }

  /**
   * Translate the in-transaction conflict signal into the HTTP 409, with the
   * caller's redaction applied. Kept as a method so every write path shares one
   * failure shape.
   */
  async toConflictResponse(err: unknown, user: RequestUser): Promise<never> {
    if (!(err instanceof SeriesConflictSignal)) throw err;
    const scope = await this.roles.accessibleCampaignIds(user);
    const names = await this.lookupNames(
      err.conflicts.map((r) => r.campaignId),
      err.conflicts.flatMap((r) => (r.roomId != null ? [r.roomId] : [])),
    );
    throw this.conflictException([...this.redactConflicts(err.conflicts, scope, names), ...err.direct]);
  }
}

/**
 * Internal marker thrown inside a booking transaction so better-sqlite3 rolls
 * the whole attempt back before anything is written. Never leaves the module:
 * the controller layer converts it to a redacted 409 via toConflictResponse().
 */
export class SeriesConflictSignal extends Error {
  constructor(
    readonly conflicts: RawConflict[],
    /** Already-visible conflicts within the request's own batch (see intraBatchConflicts). */
    readonly direct: ScheduleConflict[] = [],
  ) {
    super('schedule conflict');
    this.name = 'SeriesConflictSignal';
  }
}

/** The first local date on or after `date` whose weekday is `weekday` (0=Sunday). */
export function firstOnOrAfterWeekday(date: string, weekday: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  const current = new Date(base).getUTCDay();
  const delta = (weekday - current + 7) % 7;
  const shifted = new Date(base + delta * 86_400_000);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}
