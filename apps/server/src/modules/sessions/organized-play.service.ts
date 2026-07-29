import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  MAX_SERIES_OCCURRENCES,
  ScheduleTemplateSlot,
  expandRecurrence,
  isValidIanaTimeZone,
  materializeWallClock,
  scheduleNotificationChangeType,
  scheduleNotificationFallbackBody,
  scheduleNotificationFallbackTitle,
  shouldNotifyScheduleUpdate,
  utcToLocalDateTime,
  wallClockToUtc,
  windowsOverlap,
  diffScheduleNotificationFields,
  type ScheduleNotificationChangeType,
  type ScheduleNotificationChangedField,
  type ScheduleNotificationData,
  type CoordinatorCalendar,
  type CoordinatorCalendarEntry,
  type OccurrenceAttendance,
  type OccurrenceReassign,
  type OccurrenceWriteResult,
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
  type SeriesException,
  type SessionSeries,
  type SessionSeriesCreate,
  type SessionSeriesUpdate,
  type SessionSeriesWithOccurrences,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  campaignMembers,
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
import { NotificationsService } from '../notifications/notifications.service';
import { RoleResolver } from '../membership/role-resolver.service';
import { seriesIcsUid } from './ics.util';
import { recurrenceLocalDateFor, reconcileScheduledSessions, seriesTimezoneInTx, type SyncDb } from './scheduling.service';
import {
  scheduleEffectiveStatusSql,
  scheduleOrganizedPlaySql,
  scheduleOverlapsSql,
  scheduleResourceHeldSql,
} from './scheduling-queries';
// The booking probe lives in its own leaf module so SchedulingService can run the
// identical check when a restore re-acquires a released room/DM (see #588).
import {
  SeriesConflictSignal,
  canSee,
  endInstant,
  findConflictRows,
  lookupConflictNames,
  redactConflicts,
  type AccessScope,
  type ConflictNames,
  type RawConflict,
} from './schedule-conflicts';

const MAX_CALENDAR_WINDOW_DAYS = 366;

/**
 * Exception kinds that constitute a per-occurrence METADATA override, i.e. the
 * ones a series-level fan-out must leave alone. `cancel`/`restore` are lifecycle
 * events and are deliberately absent — see updateSeries.
 */
const METADATA_OVERRIDE_KINDS = ['reschedule', 'reassign'] as const;

type SeriesRow = typeof sessionSeries.$inferSelect;
type ScheduleRow = typeof scheduledSessions.$inferSelect;

/**
 * Does this write actually change the row?
 *
 * THE single answer both per-occurrence endpoints use before appending to the
 * append-only exception ledger, deliberately generic over "the columns this
 * write touches" so the two cannot drift. `reassignOccurrence` grew its own
 * version of this check first; `rescheduleOccurrence` did not get one, and the
 * result was the identical defect one function away — which is exactly the
 * two-expressions-of-one-rule failure this branch keeps paying for.
 *
 * It matters because the ledger is APPEND-ONLY and `updateSeries` reads every
 * `reschedule`/`reassign` entry as a permanent per-occurrence override. An entry
 * written for a request that changed nothing — a client retry resending the
 * current instant, a double-clicked button — can never be withdrawn, and freezes
 * that night out of every later series title, notes, room, DM, capacity and
 * event-key change, forever.
 */
function changesOccurrence(existing: ScheduleRow, next: Partial<ScheduleRow>): boolean {
  return (Object.keys(next) as Array<keyof ScheduleRow>).some((key) => existing[key] !== next[key]);
}

/** Occurrence columns a calendar client renders, and therefore what "moved" means. */
const OCCURRENCE_TIME_FIELDS = ['scheduledAt', 'durationMinutes', 'timezone', 'localStart'] as const;
/** Occurrence columns that describe WHO/WHERE rather than WHEN. */
const OCCURRENCE_ASSIGNMENT_FIELDS = ['roomId', 'venueId', 'assignedDmUserId', 'capacity'] as const;

function pickFields<K extends keyof ScheduleRow>(next: Partial<ScheduleRow>, keys: readonly K[]): Partial<ScheduleRow> {
  const out: Partial<ScheduleRow> = {};
  for (const key of keys) if (key in next) out[key] = next[key];
  return out;
}

/**
 * Which kind of deviation this write actually is — or `null` when it is none.
 *
 * Derived from the SAME comparison `changesOccurrence` performs, deliberately,
 * rather than from which endpoint was called. `rescheduleOccurrence` accepts a
 * `roomId`, so a request that changes only the room and moves no time was being
 * filed as `kind: 'reschedule'` — a ledger entry that mislabels what happened,
 * on a ledger whose whole purpose is explaining what happened. Reading the kind
 * off the actual diff means the entry describes the change rather than the route
 * the caller happened to take.
 *
 * A time move outranks a re-seat when both happen: the instants are the more
 * significant fact, and the assignment delta is recorded on the entry regardless,
 * so nothing is lost by the precedence.
 */
function occurrenceExceptionKind(existing: ScheduleRow, next: Partial<ScheduleRow>): 'reschedule' | 'reassign' | null {
  if (changesOccurrence(existing, pickFields(next, OCCURRENCE_TIME_FIELDS))) return 'reschedule';
  if (changesOccurrence(existing, pickFields(next, OCCURRENCE_ASSIGNMENT_FIELDS))) return 'reassign';
  return null;
}

/**
 * better-sqlite3 throws a synchronous Error with `.code` set to one of the
 * SQLITE_CONSTRAINT_* codes on a constraint violation (issue #1638). `createRoom` and
 * `updateRoom` each run a sibling-name clash check before writing, but that check is
 * a plain SELECT outside any transaction — it narrows the race, it does not close it.
 * This is the backstop: catch a lost race on play_rooms' UNIQUE(venue_id, name) index
 * and translate it into the same clean 400 the up-front check produces, instead of a
 * raw constraint-violation 500. Same helper other services already use for this exact
 * shape (rules.service.ts, encounters.service.ts, members.service.ts,
 * campaign-modules.service.ts) — no shared util exists for it, so this follows the
 * established per-service local-helper convention rather than introducing one now.
 */
function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  const message = err instanceof Error ? err.message : '';
  return /UNIQUE constraint failed/i.test(message);
}

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
    fromRoomId: row.fromRoomId,
    toRoomId: row.toRoomId,
    fromAssignedDmUserId: row.fromAssignedDmUserId,
    toAssignedDmUserId: row.toAssignedDmUserId,
    fromCapacity: row.fromCapacity,
    toCapacity: row.toCapacity,
    reason: row.reason,
    actorUserId: row.actorUserId,
    createdAt: row.createdAt,
  };
}

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
    private readonly notifications: NotificationsService,
    private readonly roles: RoleResolver,
  ) {}

  /**
   * Tell the party about a schedule change made through an organized-play route.
   *
   * `this.events.emit` is an EPHEMERAL SSE ping: it reaches whoever has the app
   * open at that instant and nobody else. Every equivalent write on the one-off
   * path also calls `SchedulingService.notifyScheduleLifecycle`, which persists a
   * notification row and feeds immediate delivery, digests and offline catch-up.
   * Without this, cancelling a series or moving an occurrence told nobody who was
   * not already looking at the page — and `PATCH /schedule/:id` now REJECTS a
   * series occurrence's move and points callers here, so the one path that used
   * to notify was replaced by one that did not. Members would keep turning up to
   * a game that had been cancelled or moved.
   *
   * ONE notification per request, anchored on the SOONEST affected occurrence,
   * rather than one per row. A series-level action is a single decision by the
   * coordinator; fanning it out per occurrence would put up to
   * MAX_SERIES_OCCURRENCES bells in every member's tray for one click, and the
   * soonest night is the one they would otherwise have travelled to. The
   * per-occurrence routes pass their single row and so behave exactly like the
   * one-off path.
   *
   * EVERY WRITE PATH IN THIS SERVICE, AND ITS DECISION. This table is the point:
   * the first version of this fan-out covered five of the six paths that
   * materialize or cancel occurrences, and `applyTemplate` — the one that can
   * create the MOST rows — was silent purely by omission and looked no different
   * in the code from the paths that are silent on purpose. That is the same
   * "enforced at some call sites but not their siblings" shape this branch keeps
   * finding, reproduced one level up inside the fix for it. So each site below
   * carries an explicit `NOTIFIES` or `NO NOTIFICATION` marker: a path with
   * neither is a bug, and that is now visible by reading rather than by
   * remembering.
   *
   *   createSeries          NOTIFIES  'created'
   *   applyTemplate         NOTIFIES  'created'
   *   extendSeries          NOTIFIES  'created'
   *   updateSeries          NOTIFIES  'updated' (only when location/notes moved)
   *   cancelSeries          NOTIFIES  'cancelled'
   *   rescheduleOccurrence  NOTIFIES  diffed, like SchedulingService.update
   *   reassignOccurrence    NO NOTIFICATION — room/DM/capacity are not
   *                         `ScheduleNotificationChangedField`s and never reach
   *                         the party's copy of the night, so a re-seat is the
   *                         organized-play analogue of the title-only edit
   *                         `shouldNotifyScheduleUpdate` already declines.
   *   deleteRoom/deleteVenue  NO NOTIFICATION — these clear `room_id`/`venue_id`
   *                         on bookings but move no night and cancel no night.
   *                         The game still happens, at the same time; only an
   *                         admin's resource record went away. (`venue` in the
   *                         changed-field enum is the free-text `location`/VTT
   *                         link, not `venue_id`.)
   *
   * Single-occurrence cancel and restore are NOT in this table because they live
   * on `SchedulingService` (`DELETE`/`POST /schedule/:id/restore`) and already
   * notify there.
   */
  private async notifyOccurrenceChange(
    campaignId: number,
    user: RequestUser,
    rows: Array<{ id: number; scheduledAt: string; durationMinutes: number; title: string }>,
    changeType: ScheduleNotificationChangeType,
    changedFields: ScheduleNotificationChangedField[] = [],
  ): Promise<void> {
    if (rows.length === 0) return;
    const anchor = rows.reduce((soonest, row) => (row.scheduledAt < soonest.scheduledAt ? row : soonest));
    const data: ScheduleNotificationData = {
      kind: 'schedule',
      scheduleId: anchor.id,
      scheduledAt: anchor.scheduledAt,
      durationMinutes: anchor.durationMinutes,
      changeType,
      changedFields,
      label: anchor.title.trim(),
    };
    await this.notifications.notifyCampaign(campaignId, user, {
      type: 'session_scheduled',
      title: scheduleNotificationFallbackTitle(data),
      body: scheduleNotificationFallbackBody(data),
      // entityId alone (no EntityType for scheduled_session), matching
      // SchedulingService: the bell routes session_scheduled to the Schedule tab
      // and focuses this card (#446).
      entityId: data.scheduleId,
      actorName: user.name,
      data,
    });
  }

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
  // NO NOTIFICATION (this method and deleteRoom below) — see the path table on
  // notifyOccurrenceChange. Clearing `room_id`/`venue_id` moves no night and
  // cancels no night: the game still happens, at the same time, and only an
  // admin's resource record went away.
  async deleteVenue(id: number, user: RequestUser): Promise<{ deleted: true }> {
    const existing = await this.getVenueOrThrow(id);
    const ts = nowIso();
    this.db.transaction((tx) => {
      const roomIds = tx.select({ id: playRooms.id }).from(playRooms).where(eq(playRooms.venueId, existing.id)).all().map((r) => r.id);
      if (roomIds.length > 0) {
        tx.update(scheduledSessions).set({ roomId: null }).where(inArray(scheduledSessions.roomId, roomIds)).run();
        tx.update(sessionSeries).set({ roomId: null }).where(inArray(sessionSeries.roomId, roomIds)).run();
        // These rooms are about to cascade away, so their ids have to leave
        // slots_json too. Clearing scheduleTemplates.venueId below does NOT cover
        // it: createTemplate validates only that a slot's room EXISTS, never that
        // it belongs to the template's venue, so a template pointed at venue A can
        // legitimately hold slots booking rooms in venue B. Deleting B would then
        // strand those ids and 404 every later apply — the same permanent breakage
        // deleteRoom guards against, reached by a different route.
        this.clearTemplateSlotRooms(tx, roomIds, ts);
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

  /**
   * The sibling-name clash message, shared verbatim by createRoom's up-front check,
   * updateRoom's up-front check, AND both methods' constraint-violation backstop
   * (issue #1638) — one string, one place, so the three call sites cannot drift to
   * three different wordings for what is the exact same rule.
   */
  private roomNameClashMessage(name: string): string {
    return `Venue already has a room named "${name}"`;
  }

  /**
   * Up-front sibling-name check (issue #1638). This is a plain SELECT outside any
   * transaction — it gives a fast, correct 400 in the common (non-racing) case, but it
   * CANNOT by itself close the window between the check and the write: two concurrent
   * callers can both pass it before either writes. `runRoomWrite` below is the actual
   * safety net; this check exists only so the ordinary single-caller case doesn't have
   * to round-trip through a failed write to get the same error.
   */
  private async assertRoomNameAvailable(venueId: number, name: string, excludeRoomId: number | null): Promise<void> {
    const conditions = excludeRoomId === null
      ? and(eq(playRooms.venueId, venueId), eq(playRooms.name, name))
      : and(eq(playRooms.venueId, venueId), eq(playRooms.name, name), ne(playRooms.id, excludeRoomId));
    const [clash] = await this.db.select({ id: playRooms.id }).from(playRooms).where(conditions).limit(1);
    if (clash) throw new BadRequestException(this.roomNameClashMessage(name));
  }

  /**
   * Runs a room INSERT/UPDATE, translating a lost race on the UNIQUE(venue_id, name)
   * index into the same clean 400 `assertRoomNameAvailable` produces (issue #1638),
   * instead of letting the raw SQLITE_CONSTRAINT error surface as a 500. Both
   * createRoom and updateRoom route their write through this so they cannot diverge
   * on how the race is handled — that divergence (create validated, update didn't) is
   * exactly the bug updateRoom's clash check was originally added to fix, and the
   * point of this issue is that the race reintroduces it in a narrower window.
   */
  private async runRoomWrite<T>(name: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new BadRequestException(this.roomNameClashMessage(name));
      throw err;
    }
  }

  async createRoom(venueId: number, input: PlayRoomCreate, user: RequestUser): Promise<PlayRoom> {
    await this.getVenueOrThrow(venueId);
    const ts = nowIso();
    const name = input.name.trim();
    await this.assertRoomNameAvailable(venueId, name, null);
    const [row] = await this.runRoomWrite(name, () =>
      this.db
        .insert(playRooms)
        .values({
          venueId,
          name,
          capacity: input.capacity ?? 0,
          notes: input.notes ?? '',
          createdAt: ts,
          updatedAt: ts,
        })
        .returning(),
    );
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
    // The same sibling-name check createRoom runs, excluding this row. Without it
    // a rename onto a sibling's name reached the raw UNIQUE(venue_id, name) index
    // and surfaced as a 500 — the create path validated and the update path did
    // not, so identical bad input produced a clean 400 or an opaque server error
    // depending on which endpoint you used. See runRoomWrite (issue #1638) for how
    // that same inconsistency is closed for the narrower check-then-write race.
    const trimmedName = input.name !== undefined ? input.name.trim() : undefined;
    if (trimmedName !== undefined) {
      await this.assertRoomNameAvailable(existing.venueId, trimmedName, existing.id);
    }
    const [row] = await this.runRoomWrite(trimmedName ?? existing.name, () =>
      this.db
        .update(playRooms)
        .set({
          ...(trimmedName !== undefined ? { name: trimmedName } : {}),
          ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          updatedAt: nowIso(),
        })
        .where(eq(playRooms.id, existing.id))
        .returning(),
    );
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
      this.clearTemplateSlotRooms(tx, [existing.id], ts);
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

  /**
   * Remove `roomIds` from every schedule template's `slots_json`.
   *
   * A template keeps its slots as JSON, so the relational `UPDATE`s that clear
   * `room_id` on bookings and series cannot reach the ids embedded there. Left
   * behind, a stale id makes every later applyTemplate 404 on getRoomOrThrow —
   * PERMANENTLY, because there is no template-update endpoint to repair it and
   * the only remedy would be deleting and recreating the template. Clearing the
   * reference leaves the slot bookable with no room, which is the same state a
   * room deletion already leaves bookings and series in.
   *
   * Shared by deleteRoom and deleteVenue (which cascade-deletes its rooms) so the
   * two cannot drift: a second copy of this is how the next path that removes
   * rooms ends up silently missing it.
   *
   * Sync, and takes the caller's `tx`: the scrub has to commit or roll back with
   * the delete that makes it necessary.
   */
  private clearTemplateSlotRooms(tx: SyncDb, roomIds: number[], ts: string): void {
    if (roomIds.length === 0) return;
    const doomed = new Set(roomIds);
    for (const row of tx.select().from(scheduleTemplates).all()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.slotsJson);
      } catch {
        // Unparseable JSON holds no reachable reference to these rooms, and
        // templateToDomain already degrades it to zero slots. Leave it alone
        // rather than overwriting a row we cannot read.
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      let changed = false;
      const slots = parsed.map((slot) => {
        const roomId = slot !== null && typeof slot === 'object' ? (slot as { roomId?: unknown }).roomId : undefined;
        if (typeof roomId === 'number' && doomed.has(roomId)) {
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
   * Thin delegate to the shared probe in ./schedule-conflicts.
   *
   * Kept as an instance method rather than calling the free function at each
   * site: every booking path in this file goes through one seam, which is what
   * the atomicity test spies on to assert the probe really does run inside the
   * write transaction rather than merely near it.
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
    return findConflictRows(db, q);
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
   * A sorted sweep rather than all-pairs, so a 20-slot x 104-occurrence template
   * does not cost ~2M comparisons. NOTE: the sweep must carry the maximum end
   * seen so far. An earlier version compared only ADJACENT pairs on the claim
   * that "if A overlaps C it also overlaps everything between them" — that claim
   * is false, and the counter-example is in the loop below.
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
        // Sweep carrying the MAXIMUM end seen so far, not the previous element's
        // end. Comparing only consecutive pairs is wrong: one long interval can
        // swallow a gap between two short ones, and the pair that actually
        // collides is then never compared. A=[10:00,14:00], B=[11:00,12:00],
        // C=[12:30,13:00] sorts to A,B,C — A-B overlaps, B-C does not, and the
        // adjacent scan stops there while A-C genuinely double-books the room.
        // Tracking the max end (and which entry set it) is still one pass and
        // O(n log n) overall, and it is correct for existence detection: an entry
        // overlaps SOMETHING earlier exactly when it starts before the furthest
        // end reached so far.
        let maxEnd = Number.NEGATIVE_INFINITY;
        let maxEntry: Entry | null = null;
        for (const cur of sorted) {
          const curStart = Date.parse(cur.startsAt);
          const curEnd = Date.parse(cur.endsAt);
          // Reuses the shared predicate rather than open-coding `start < maxEnd`,
          // so half-open semantics stay defined in exactly one place.
          const overlapsEarlier =
            maxEntry !== null && windowsOverlap(Date.parse(maxEntry.startsAt), maxEnd, curStart, curEnd);
          if (curEnd > maxEnd) {
            maxEnd = curEnd;
            maxEntry = cur;
          }
          if (!overlapsEarlier) continue;
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
  /**
   * Thin delegates to the shared redaction in ./schedule-conflicts, for the same
   * reason findConflictRows is one: SchedulingService.restore must produce an
   * identically-redacted list, and a second copy is how two views of one privacy
   * rule start disagreeing.
   */
  private redactConflicts(raws: RawConflict[], scope: AccessScope, names: ConflictNames): ScheduleConflict[] {
    return redactConflicts(raws, scope, names);
  }

  private async lookupNames(campaignIds: number[], roomIds: number[]): Promise<ConflictNames> {
    return lookupConflictNames(this.db, campaignIds, roomIds);
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

  /**
   * Honour a caller-supplied `excludeScheduleId` only if the caller could have
   * seen that schedule anyway. Returns `undefined` — "no exclusion" — for an id
   * that is unreadable OR that does not exist.
   *
   * WHY THIS EXISTS. `redactConflicts` withholds `scheduleId` from a caller who
   * cannot read the conflicting campaign, and the privacy spec states the reason
   * out loud: it must not hand back "an id he could use to probe further". But
   * the exclusion was applied INSIDE the SQL, before redaction ever ran, so the
   * filter answered the question the projection refused to. A stranger who can
   * see an opaque busy block enumerates ids in `excludeScheduleId` until the
   * block disappears, and the id that makes it vanish IS the withheld id. The
   * redaction stayed intact and was bypassed anyway — a guarantee enforced at one
   * point and sidestepped at its sibling, the exact shape this branch keeps
   * finding.
   *
   * The two rejected outcomes are DELIBERATELY identical. An unreadable id and a
   * nonexistent id both yield "no exclusion", so the response is byte-for-byte
   * what the caller would have got by sending no exclusion at all: same
   * conflicts, same order, same array length. There is nothing to difference.
   *
   * Nor does a timing channel replace the content one: this runs exactly one
   * indexed primary-key lookup on EVERY path, including both rejecting paths, so
   * no branch does conditional extra work whose duration could discriminate.
   *
   * The legitimate use is untouched. `excludeScheduleId` exists for "I am editing
   * this occurrence, do not report it colliding with itself" — and someone
   * editing an occurrence can necessarily read its campaign, so their exclusion
   * always survives this check.
   *
   * WHY NOT ONLY THIS FIELD. This docblock used to argue that `excludeScheduleId`
   * was the endpoint's ONLY oracle, because every other filter merely names a
   * resource the caller already holds. That reasoning was wrong about PEOPLE, and
   * {@link honourableSubjects} is the correction — a room is a shared facility
   * whose occupancy is public to the coordinator pool by design, but a person is
   * not a facility, and "is this account busy at 19:00 on the 14th" is a question
   * about them, not about a resource the caller controls. A future filter of
   * EITHER shape — the identity of a hidden row, or the identity of a person —
   * needs one of these two treatments.
   */
  private async honourableExclusion(excludeScheduleId: number | undefined, scope: AccessScope): Promise<number | undefined> {
    if (excludeScheduleId == null) return undefined;
    const [row] = await this.db
      .select({ campaignId: scheduledSessions.campaignId })
      .from(scheduledSessions)
      .where(eq(scheduledSessions.id, excludeScheduleId))
      .limit(1);
    if (!row) return undefined;
    return canSee(scope, row.campaignId) ? excludeScheduleId : undefined;
  }

  /**
   * Which of the person ids in a probe this caller may actually ask about.
   *
   * `POST /organized-play/conflicts` is open to ANY authenticated user, writes
   * nothing, and is therefore repeatable at no cost. A person-specific probe
   * returns the exact window of the subject's booking even when the booking's
   * campaign is redacted — `visible: false` drops the campaign, title and
   * schedule id, but the whole POINT of a conflict is the window, so the window
   * stays. Numeric account ids are obtainable, so an unrestricted probe let
   * anyone sweep day-sized windows against an id they do not otherwise share a
   * table with and reconstruct when and where that person runs games.
   *
   * That is precisely the existence this module withholds elsewhere: the
   * coordinator calendar blanks `assignedDmUserId` on a booking the caller cannot
   * read, on the stated principle that a private game must be ABSENT rather than
   * redacted, because redaction alone leaks that it happened. Leaving the probe
   * unrestricted made that blanking decorative — the same fact was one POST away.
   *
   * The rule: a person may be probed when the caller shares a campaign with them
   * (`scope`), or when they ARE the caller. That is the population a coordinator
   * has any business scheduling around, and it is exactly what the booking flows
   * need — the DM and members you are seating at your own table are members of
   * your own campaign, so every legitimate probe survives unchanged.
   *
   * Unauthorized ids are DROPPED, not rejected, following honourableExclusion:
   * a 403 would itself answer "does this account exist and is it a stranger",
   * whereas a dropped id yields byte-for-byte the response the caller would have
   * got by not sending it.
   *
   * NOT applied to the booking WRITE paths, deliberately. Those already require
   * DM/coordinator role on a specific campaign, they commit or reject a real row
   * rather than answering a question, and their probe is the conflict check that
   * makes the write safe. The hazard here is the free, silent, unlimited repeat.
   */
  private async honourableSubjects(requested: string[], scope: AccessScope, user: RequestUser): Promise<Set<string>> {
    const wanted = [...new Set(requested.filter((id) => id.trim() !== ''))];
    if (wanted.length === 0) return new Set();
    if (scope === 'all') return new Set(wanted);
    // The caller may always ask about themselves — they need no campaign in
    // common with themselves, and a user with no campaigns at all can still
    // check their own availability.
    const allowed = new Set(wanted.filter((id) => id === user.id));
    const others = wanted.filter((id) => id !== user.id);
    if (others.length === 0 || scope.length === 0) return allowed;
    const numeric = others.map((id) => Number(id)).filter((n) => Number.isInteger(n));
    if (numeric.length === 0) return allowed;
    const rows = await this.db
      .select({ userId: campaignMembers.userId })
      .from(campaignMembers)
      .where(and(inArray(campaignMembers.campaignId, scope), inArray(campaignMembers.userId, numeric)));
    for (const row of rows) allowed.add(String(row.userId));
    return allowed;
  }

  /** Read-only "would this collide?" probe. Writes nothing. */
  async checkConflicts(input: ScheduleConflictQuery, user: RequestUser): Promise<ScheduleConflictReport> {
    const { startsAt, endsAt } = this.resolveWindow(input);
    // Scope is resolved BEFORE the query, because the exclusion filter and the
    // person filters are themselves access-controlled — see honourableExclusion
    // and honourableSubjects.
    const scope = await this.roles.accessibleCampaignIds(user);
    const subjects = await this.honourableSubjects([input.assignedDmUserId, ...input.memberUserIds], scope, user);
    const raws = this.findConflictRows(this.db, {
      startsAt,
      endsAt,
      roomId: input.roomId,
      assignedDmUserId: subjects.has(input.assignedDmUserId) ? input.assignedDmUserId : '',
      memberUserIds: input.memberUserIds.filter((id) => subjects.has(id)),
      excludeScheduleId: await this.honourableExclusion(input.excludeScheduleId, scope),
    });
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
      // Reconcile the schedule↔recap link (issue #1601): a completed occurrence
      // whose recap is trashed must read as `scheduled` here too, exactly as the
      // coordinator calendar (scheduleEffectiveStatusSql) and the Schedule tab
      // (projectLink) already show it. Mapping the raw `status` column left series
      // detail as the one surface that disagreed.
      occurrences: await reconcileScheduledSessions(this.db, occurrences),
      exceptions: exceptions.map(exceptionToDomain),
      // Reads never force anything; only a forced write populates this.
      conflicts: [],
    };
  }

  /**
   * Fetch a series that MUST belong to `campaignId`.
   *
   * The single choke point for every campaign-scoped series route. Being a DM of
   * the campaign in the URL and the series existing are two separately-correct
   * facts that do not compose into authorization: without this, `PATCH
   * /campaigns/A/series/<id-from-B>` passed both checks and then wrote to B. That
   * is the classic IDOR shape — the route parameter never validated against the
   * object's owner — and it punches through the boundary this module's privacy
   * rule rests on, which is that another campaign's game is ABSENT from a scope
   * that may not read it, not merely redacted.
   *
   * 404, not 403: a series in a campaign the caller did not name must not be
   * distinguishable from one that does not exist, or the error code itself
   * becomes a cross-campaign existence probe.
   *
   * Deliberately a method here rather than four inline comparisons in the
   * controller, so the next campaign-scoped series handler inherits it.
   */
  /**
   * Attach the redacted conflict list a FORCED write overrode.
   *
   * `force` is only defensible if the caller can see what they overrode, so every
   * forcible series write returns this rather than a bare 200 (see the
   * `conflicts` field on SessionSeriesWithOccurrences). Redaction is the same
   * rule as the 409 path: a coordinator learns the room and window they took, not
   * whose game was in it.
   */
  private async withForcedConflicts(
    series: SessionSeriesWithOccurrences,
    raw: RawConflict[],
    batch: ScheduleConflict[],
    user: RequestUser,
  ): Promise<SessionSeriesWithOccurrences> {
    if (raw.length === 0 && batch.length === 0) return series;
    const scope = await this.roles.accessibleCampaignIds(user);
    const names = await this.lookupNames(
      raw.map((r) => r.campaignId),
      raw.flatMap((r) => (r.roomId != null ? [r.roomId] : [])),
    );
    return { ...series, conflicts: [...this.redactConflicts(raw, scope, names), ...batch] };
  }

  async getSeriesRowInCampaignOrThrow(campaignId: number, id: number): Promise<SeriesRow> {
    const row = await this.getSeriesRowOrThrow(id);
    if (row.campaignId !== campaignId) throw new NotFoundException(`Session series ${id} not found`);
    return row;
  }

  async getSeriesRowOrThrow(id: number): Promise<SeriesRow> {
    const [row] = await this.db.select().from(sessionSeries).where(eq(sessionSeries.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Session series ${id} not found`);
    return row;
  }

  /**
   * The occurrence row read INSIDE the caller's transaction.
   *
   * Both per-occurrence write paths re-read through this rather than trusting the
   * snapshot they validated against. better-sqlite3 is synchronous, so once the
   * transaction callback is running nothing can interleave — but each `await`
   * before it is a yield, and these endpoints necessarily await (the room lookup
   * that resolves a venue is async and cannot run inside a sync transaction).
   * Re-reading here is what makes "validate, then write" atomic despite that.
   */
  private getOccurrenceRowInTxOrThrow(tx: SyncDb, id: number): ScheduleRow {
    const [row] = tx.select().from(scheduledSessions).where(eq(scheduledSessions.id, id)).limit(1).all();
    if (!row) throw new NotFoundException(`Scheduled session ${id} not found`);
    return row;
  }

  async getOccurrenceRowOrThrow(id: number): Promise<ScheduleRow> {
    const [row] = await this.db.select().from(scheduledSessions).where(eq(scheduledSessions.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Scheduled session ${id} not found`);
    return row;
  }

  /**
   * The SERIES row read inside the caller's transaction — the series-level
   * counterpart to {@link getOccurrenceRowInTxOrThrow}, and it exists for exactly
   * the same reason.
   *
   * Every series write path awaits before it can open its transaction (the room
   * lookup that resolves a venue is async and cannot run inside a synchronous
   * one), so the row it validated against is a SNAPSHOT — and any value DERIVED
   * from that snapshot and then written is derived from a state that may already
   * be gone. `updateSeries` derived four such values: the venue to keep when the
   * room is cleared, and the three "did this actually change?" predicates that
   * decide whether the booking probe runs at all.
   */
  private getSeriesRowInTxOrThrow(tx: SyncDb, id: number): SeriesRow {
    const [row] = tx.select().from(sessionSeries).where(eq(sessionSeries.id, id)).limit(1).all();
    if (!row) throw new NotFoundException(`Session series ${id} not found`);
    return row;
  }

  /** A room's venue, read inside the caller's transaction. Same rule as resolveVenueId. */
  private getRoomVenueInTxOrThrow(tx: SyncDb, roomId: number): number {
    const [row] = tx.select({ venueId: playRooms.venueId }).from(playRooms).where(eq(playRooms.id, roomId)).limit(1).all();
    if (!row) throw new NotFoundException(`Play room ${roomId} not found`);
    return row.venueId;
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

    let forced: RawConflict[] = [];
    let createdRows: ScheduleRow[] = [];
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
      forced = conflicts;

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

      createdRows = occurrences.map((occ) => this.insertOccurrence(tx, series, occ, ts));
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
    // NOTIFIES ('created'). One ping for the request, anchored on the first night.
    await this.notifyOccurrenceChange(campaignId, user, createdRows, 'created');
    return this.withForcedConflicts(await this.getSeries(created.id), forced, batchConflicts, user);
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

  /*
   * CLEARING THE ROOM DOES NOT CLEAR THE VENUE — the rule all three write paths
   * apply, each against the row it re-read inside its own transaction.
   *
   * A room supplies its own venue, so naming a room resolves it; naming NO room
   * says "no particular table", which is not the same statement as "not at this
   * venue any more". Keeping the venue is also the only non-destructive reading,
   * and destructiveness is the whole point here: `SessionSeriesUpdate` and
   * `OccurrenceReassign` expose no `venueId` field at all, so a cleared venue
   * CANNOT BE PUT BACK through the API. There is no recovery path, only
   * recreating the series.
   *
   * The series PATCH reached that state from a request that changed nothing. It
   * keyed on `input.roomId === undefined`, so a venue-only series (venue set,
   * room already null) PATCHed with an explicit `roomId: null` — a client
   * resending its current state — resolved `(null, null)` to `null` and silently
   * dropped the venue from the series and every future occurrence, removing them
   * from every venue-filtered calendar.
   *
   * This was a shared async helper until the venue derivation moved inside
   * `updateSeries`'s transaction, which left it with no callers: the two
   * per-occurrence paths never called it — they express the same rule inline
   * against their in-tx row (`roomId === existing.roomId || roomId == null ?
   * existing.venueId : roomVenue`), which is why the docblock's claim that "all
   * three go through here" had already stopped being true. The rule is recorded
   * here, next to `resolveVenueId`, because the three sites must keep agreeing on
   * it even though none of them can share code: each needs its OWN transaction's
   * row, and a helper that took a snapshot is precisely what went stale.
   *
   * What CAN safely be resolved before a transaction is the other direction,
   * room -> venue (`resolveVenueId`): `PlayRoomCreate` omits `venueId` and
   * `PlayRoomUpdate` is its `.partial()`, so a room's venue is immutable after
   * creation and no concurrent write can move it. `createSeries` and
   * `applyTemplate` rely on that, correctly. The mutable direction is a SERIES'
   * own `venueId`, which this very endpoint rewrites — so that one, and only that
   * one, has to be read inside the transaction that rewrites it.
   */

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
    // Existence and permission checks only. Everything this method WRITES is
    // derived inside the transaction below, from a row re-read there — see
    // getSeriesRowInTxOrThrow. This await is the yield that makes that necessary.
    const existing = await this.getSeriesRowOrThrow(id);
    if (input.roomId !== undefined && input.roomId !== null) await this.getRoomOrThrow(input.roomId);
    const ts = nowIso();
    const nowStr = new Date(nowMs).toISOString();

    let forced: RawConflict[] = [];
    let forcedBatch: ScheduleConflict[] = [];
    let notifyRows: ScheduleRow[] = [];
    // The series state this edit is a delta AGAINST, re-read inside the
    // transaction. Used after it for the notification diff, which must compare
    // against the values that were actually in force when the write happened.
    let before: SeriesRow = existing;
    this.db.transaction((tx) => {
      // EVERY derived value below comes from this row, not from the snapshot
      // awaited above. A concurrent series PATCH committing in that gap would
      // otherwise make this request write conclusions about a state that no
      // longer exists — most visibly on an explicit `roomId: null`, where
      // "clearing the room keeps the venue" would re-assert the OLD venue and
      // silently relocate a booking the other request had just moved.
      before = this.getSeriesRowInTxOrThrow(tx, id);
      // CLEARING THE ROOM DOES NOT CLEAR THE VENUE — the rule stated in full on
      // venueAfterRoomChange, applied here against the fresh row. A named room
      // supplies its own venue; naming no room says "no particular table", which
      // is not the same statement as "not at this venue any more".
      const venueId = input.roomId == null ? before.venueId : this.getRoomVenueInTxOrThrow(tx, input.roomId);

      // Which shared resources this edit actually moves. Everything else in the
      // body (title, notes, capacity, event/season keys) holds no booking, so it
      // cannot collide with anything and needs no probe.
      const nextRoomId = input.roomId === undefined ? before.roomId : input.roomId;
      const nextDm = input.assignedDmUserId === undefined ? before.assignedDmUserId : input.assignedDmUserId;
      const roomChanged = nextRoomId !== before.roomId;
      const dmChanged = nextDm !== before.assignedDmUserId;
      // Only the resources actually CHANGING are probed. Re-confirming a resource
      // the occurrence already holds would report its own neighbours as if this
      // edit had caused them — and, in the intra-batch scan, would flag the series
      // against ITSELF over a room the edit never touched, pushing the coordinator
      // into forcing an edit that introduced no new clash.
      //
      // Built ONCE and shared by both checks below. The two answer the same
      // question about the same inputs, so they must not each construct their own
      // view of what changed: that is precisely how they drifted apart before.
      // Deriving them from `before` rather than the outer snapshot is what stops
      // a concurrent room change making this request skip the probe entirely.
      const probeRoomId = roomChanged ? nextRoomId : null;
      const probeDm = dmChanged ? nextDm : '';

      // "Overridden" means the coordinator made a per-occurrence decision ABOUT
      // METADATA that this fan-out must not silently undo — a move or a re-seat.
      // Filtering by kind is load-bearing, not tidiness: the ledger also records
      // `cancel` and `restore`, and a cancel-then-restore is a lifecycle event, not
      // a metadata decision. Counting those as overrides froze the occurrence out
      // of every later series edit permanently, leaving it with a stale title,
      // room, DM and event keys forever — the opposite of the documented contract,
      // and invisible until someone compared two occurrences by hand.
      // Read INSIDE the transaction, like every other read this fan-out's
      // correctness depends on. better-sqlite3 is synchronous, so nothing can
      // interleave once this callback runs — but an `await`ed read before it is a
      // yield, and a `reassignOccurrence`/`rescheduleOccurrence` committing in
      // that gap would not appear in the set. Its occurrence would then be
      // treated as un-overridden and have the customization the coordinator just
      // saved silently rewritten to the series default: precisely the outcome
      // this set exists to prevent. Same fix, same reason, as the count and
      // occurrence indexes in extendSeries.
      const overriddenIds = new Set(
        tx
          .select({ occurrenceId: seriesExceptions.occurrenceId })
          .from(seriesExceptions)
          .where(and(eq(seriesExceptions.seriesId, id), inArray(seriesExceptions.kind, [...METADATA_OVERRIDE_KINDS])))
          .all()
          .map((r) => r.occurrenceId)
          .filter((v): v is number => v != null),
      );
      const future = tx
        .select()
        .from(scheduledSessions)
        .where(and(eq(scheduledSessions.seriesId, id), sql`${scheduledSessions.scheduledAt} > ${nowStr}`))
        .all();
      const affected = future.filter((occ) => !overriddenIds.has(occ.id));
      // A CANCELLED occurrence is a metadata target but NOT a booking
      // participant. Cancelling releases the room and DM — `scheduleResourceHeldSql()`
      // (issue #1555/#1671) drops the row from conflict detection, so another
      // campaign may legitimately have taken that window — and `restore()` is what
      // re-acquires them, with its own probe. Counting a cancelled row here would
      // therefore demand `force` for a collision that does not exist, on behalf of
      // a night that is not happening. Same rule as the SEQUENCE decision below:
      // cancelled rows keep receiving metadata, and take no part in booking.
      // (A `completed` row is correctly still a booking participant here — this is
      // the plain `.filter(occ.status !== 'cancelled')` below, already equivalent
      // to `scheduleResourceHeldSql()` without a second SQL predicate.)
      const booking = affected.filter((occ) => occ.status !== 'cancelled');
      // A cancelled night is not one the party can be told to turn up to, so it
      // is not a notification subject either — the same line `booking` draws.
      //
      // These rows are SNAPSHOTS read before the fan-out wrote, so the title they
      // carry is the OLD one. `notifyOccurrenceChange` renders `title` into the
      // notification's `label` — the only row field it reads that this method can
      // change — so handing them over verbatim announced the rename under the
      // pre-rename name, for a night that already had the new one. Overlaying the
      // new title here rather than re-reading keeps the notification payload
      // derived from the same values the writes below use.
      //
      // Only `title` needs it. `location` and `notes` never reach the payload as
      // row fields: they are carried as `changedFields`, computed from `input`
      // directly at the call site, so they cannot go stale the same way. And
      // `scheduledAt`/`durationMinutes` — the payload's other two row fields —
      // are not editable through a series metadata PATCH at all.
      notifyRows = input.title === undefined ? booking : booking.map((occ) => ({ ...occ, title: input.title as string }));

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
        // The batch against ITSELF, for the same reason createSeries, extendSeries
        // and applyTemplate all do it: a stored-row probe cannot see this change.
        // Each occurrence's probe excludes its own id, and its siblings still hold
        // the OLD resource in the database while the probe runs — so if two future
        // occurrences of this series overlap (duration longer than the recurrence
        // step), moving them all onto one room double-books it with no row
        // anywhere that could report it.
        const batchConflicts = this.intraBatchConflicts(
          booking.map((occ) => ({
            startsAt: occ.scheduledAt,
            endsAt: endInstant(occ.scheduledAt, occ.durationMinutes),
            roomId: probeRoomId,
            dm: probeDm,
            campaignId: occ.campaignId,
            title: occ.title,
          })),
        );
        const conflicts: RawConflict[] = [];
        for (const occ of booking) {
          conflicts.push(
            ...this.findConflictRows(tx, {
              startsAt: occ.scheduledAt,
              endsAt: endInstant(occ.scheduledAt, occ.durationMinutes),
              roomId: probeRoomId,
              assignedDmUserId: probeDm,
              memberUserIds: [],
              excludeScheduleId: occ.id,
            }),
          );
        }
        // Rolls the whole transaction back: a rejected fan-out writes nothing,
        // not even the series-level metadata.
        if ((conflicts.length > 0 || batchConflicts.length > 0) && !input.force) {
          throw new SeriesConflictSignal(conflicts, batchConflicts);
        }
        forced = conflicts;
        forcedBatch = batchConflicts;
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
        //
        // A CANCELLED occurrence still receives the metadata but never a SEQUENCE
        // bump. Both halves are deliberate. It keeps the metadata so a night that
        // is later restored comes back current instead of carrying whatever the
        // series said on the day it was cancelled — the same stale-forever trap as
        // treating lifecycle entries as overrides. It skips the bump because the
        // feed publishes this row as STATUS:CANCELLED, so a fresh SEQUENCE would
        // push subscribers a revision of an event that is not happening and whose
        // visible content did not change. Restore bumps SEQUENCE itself, which is
        // when the accumulated metadata legitimately reaches subscribers. Raw
        // status, not effective: it is the raw column the ICS emitter branches on.
        //
        // `roomId` is NOT here, and its absence is the same rule stated from the
        // other side: the emitter renders LOCATION from the free-text `location`
        // column, never from the room, so a room-only fan-out produces a
        // byte-identical VEVENT and a fresh SEQUENCE would announce a revision
        // that changed nothing a subscriber can see. reassignOccurrence declines
        // the bump for exactly this reason; the two must not disagree about what
        // "renders" means.
        const renders =
          occ.status !== 'cancelled'
          && ((input.title !== undefined && input.title !== occ.title)
            || (input.location !== undefined && input.location !== occ.location)
            || (input.notes !== undefined && input.notes !== occ.notes));
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
      campaignId: before.campaignId,
    });
    this.events.emit({ type: 'schedule.updated', campaignId: before.campaignId, scheduleId: id });
    // Only the facets a member's copy of the night actually carries. Title-only
    // stays silent here for the same reason `shouldNotifyScheduleUpdate` keeps it
    // silent on the one-off path, and room/DM/capacity are not party-visible
    // fields at all — see notifyOccurrenceChange.
    // NOTIFIES ('updated'), and only for the facets a member's copy of the night
    // actually carries.
    //
    // Diffed against `before` — the row read INSIDE the transaction — not the
    // snapshot awaited at the top. The question this answers is "did this write
    // change anything the party can see", and only the value that was actually in
    // force when the write committed can answer it: against a stale snapshot a
    // concurrent edit could make an unchanged field look changed, notifying the
    // whole party about nothing, or a changed one look unchanged and tell them
    // nothing at all.
    const changedFields = diffScheduleNotificationFields(
      { scheduledAt: '', durationMinutes: 0, location: before.location, notes: before.notes },
      { scheduledAt: '', durationMinutes: 0, location: input.location ?? before.location, notes: input.notes ?? before.notes },
    );
    if (shouldNotifyScheduleUpdate(changedFields)) {
      await this.notifyOccurrenceChange(before.campaignId, user, notifyRows, 'updated', changedFields);
    }
    return this.withForcedConflicts(await this.getSeries(id), forced, forcedBatch, user);
  }

  /**
   * Materialize more occurrences past the end of an existing series, continuing
   * the ORIGINAL wall-clock rule rather than striding from the last instant —
   * which is what keeps an extension that crosses a DST boundary at 19:00 local.
   */
  async extendSeries(id: number, addCount: number, user: RequestUser, role: Role, force = false): Promise<SessionSeriesWithOccurrences> {
    const existing = await this.getSeriesRowOrThrow(id);
    if (existing.status !== 'active') throw new BadRequestException('Cancelled series cannot be extended');

    const ts = nowIso();
    let forced: RawConflict[] = [];
    let batchConflicts: ScheduleConflict[] = [];
    let addedRows: ScheduleRow[] = [];
    this.db.transaction((tx) => {
      // Count, occurrence indexes and expansion are ALL re-derived here, inside
      // the transaction, and not from the row read above.
      //
      // better-sqlite3 is synchronous, so nothing can interleave once this
      // callback is running — but every `await` before it is a yield. Two
      // extensions of the same series (a double-submitted button) both awaited
      // the same `count` and the same index set, both computed the same "fresh"
      // indexes, and both inserted them: `idx_scheduled_sessions_series` is a
      // plain index, not unique, and a resource-less series gives the booking
      // probe nothing to collide on, so the duplicates were reported to neither
      // caller. Two rows then shared an occurrence_index AND an ICS UID, which
      // is a subscriber-visible corruption the feed cannot recover from.
      // Re-reading inside the sync transaction is the same structural guarantee
      // the conflict probe already rests on: read and claim in one atomic step.
      const current = tx.select().from(sessionSeries).where(eq(sessionSeries.id, id)).limit(1).all()[0];
      if (!current) throw new NotFoundException(`Series ${id} not found`);
      // Re-checked here as well as above for the same reason the count is: a
      // cancel that landed while this request was awaiting must not have its tail
      // silently re-materialized.
      if (current.status !== 'active') throw new BadRequestException('Cancelled series cannot be extended');
      const nextCount = current.count + addCount;
      if (nextCount > MAX_SERIES_OCCURRENCES) {
        throw new BadRequestException(`A series may hold at most ${MAX_SERIES_OCCURRENCES} occurrences`);
      }
      const all = this.expandOrThrow({
        timezone: current.timezone,
        startDate: current.startDate,
        startTime: current.startTime,
        durationMinutes: current.durationMinutes,
        freq: current.freq as RecurrenceFreq,
        interval: current.interval,
        count: nextCount,
        untilDate: current.untilDate,
      });
      const existingIndexes = new Set(
        tx
          .select({ occurrenceIndex: scheduledSessions.occurrenceIndex })
          .from(scheduledSessions)
          .where(eq(scheduledSessions.seriesId, id))
          .all()
          .map((r) => r.occurrenceIndex),
      );
      const fresh = all.filter((o) => !existingIndexes.has(o.index));
      if (fresh.length === 0) throw new BadRequestException('Recurrence produced no new occurrences (untilDate reached?)');

      // The same self-collision hazard createSeries and applyTemplate guard
      // against, and for the identical reason: NOTHING in `fresh` is stored yet,
      // so the per-row probe below cannot see the batch against itself. An
      // extension whose duration exceeds its recurrence step (a daily 25-hour
      // marathon), or one that straddles a spring-forward transition, would
      // otherwise double-book its own room and its own DM and pass every
      // database probe on the way through.
      batchConflicts = this.intraBatchConflicts(
        fresh.map((occ) => ({
          startsAt: occ.scheduledAt,
          endsAt: endInstant(occ.scheduledAt, occ.durationMinutes),
          roomId: current.roomId,
          dm: current.assignedDmUserId,
          campaignId: current.campaignId,
          title: current.title,
        })),
      );

      const conflicts: RawConflict[] = [];
      for (const occ of fresh) {
        conflicts.push(
          ...this.findConflictRows(tx, {
            startsAt: occ.scheduledAt,
            endsAt: endInstant(occ.scheduledAt, occ.durationMinutes),
            roomId: current.roomId,
            assignedDmUserId: current.assignedDmUserId,
            memberUserIds: [],
          }),
        );
      }
      if ((conflicts.length > 0 || batchConflicts.length > 0) && !force) {
        throw new SeriesConflictSignal(conflicts, batchConflicts);
      }
      forced = conflicts;
      tx.update(sessionSeries).set({ count: nextCount, updatedAt: ts }).where(eq(sessionSeries.id, id)).run();
      addedRows = fresh.map((occ) => this.insertOccurrence(tx, { ...current, count: nextCount }, occ, ts));
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'organized_play.series_extend',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
      detail: `added=${addedRows.length}`,
    });
    this.events.emit({ type: 'schedule.updated', campaignId: existing.campaignId, scheduleId: id });
    // NOTIFIES ('created'): an extension puts new nights on the party's calendar.
    await this.notifyOccurrenceChange(existing.campaignId, user, addedRows, 'created');
    return this.withForcedConflicts(await this.getSeries(id), forced, batchConflicts, user);
  }

  /**
   * Cancel a whole series: mark it cancelled and cancel every FUTURE occurrence,
   * non-destructively. Rows, RSVPs and lineage all survive — the same choice
   * issue #504 made for a single night, for the same reason (the ICS feed must
   * keep publishing STATUS:CANCELLED under each UID, and a cancelled night that
   * vanished would take the party's RSVP history with it). Past occurrences are
   * left exactly as they are: they already happened.
   *
   * The "which future occurrences does this actually touch" filter is
   * `scheduleResourceHeldSql()` (`status != 'cancelled'`), NOT `scheduleLiveSql()`
   * (issue #1671). #1555 established that only cancellation releases a room/DM — a
   * genuinely completed occurrence still holds its resource. `scheduleLiveSql()`
   * excludes exactly that case (it answers "does this still need the DM's
   * attention", not "does this still hold a resource"), so a future-dated
   * occurrence completed early or out of order — reachable via
   * `POST /schedule/:id/link/:sessionId` before its nominal window arrives — used
   * to fall straight through this filter untouched: still `completed`, still
   * counted by `findConflictRows()`, forever, for a series that no longer exists.
   * `scheduleResourceHeldSql()` is the same predicate `findConflictRows()` itself
   * probes against, so "everything this cancel releases" and "everything a future
   * booking can collide with" cannot drift apart again. Idempotent by construction:
   * an already-cancelled row is excluded, so a second cancel of the same series
   * cannot re-append a `cancel` ledger entry or re-bump SEQUENCE for it.
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
        .where(and(eq(scheduledSessions.seriesId, id), sql`${scheduledSessions.scheduledAt} > ${nowStr}`, scheduleResourceHeldSql()))
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
            recurrenceLocalDate: recurrenceLocalDateFor(occ, existing.timezone),
            kind: 'cancel',
            fromScheduledAt: occ.scheduledAt,
            toScheduledAt: null,
            toLocalStart: '',
            // Lifecycle entry: from == to, stating the seating at cancel time.
            fromRoomId: occ.roomId,
            toRoomId: occ.roomId,
            fromAssignedDmUserId: occ.assignedDmUserId,
            toAssignedDmUserId: occ.assignedDmUserId,
            fromCapacity: occ.capacity,
            toCapacity: occ.capacity,
            reason,
            actorUserId: user.id,
            createdAt: ts,
          })
          .run();
      }
      return future;
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'organized_play.series_cancel',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
      detail: `cancelled=${cancelled.length}`,
    });
    this.events.emit({ type: 'schedule.updated', campaignId: existing.campaignId, scheduleId: id });
    // NOTIFIES ('cancelled'). The whole reason this exists: a member who is not
    // watching the page must not turn up to a night cancelled with the series.
    await this.notifyOccurrenceChange(existing.campaignId, user, cancelled, 'cancelled');
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
  ): Promise<OccurrenceWriteResult> {
    // ---- ASYNC PHASE. Only work that cannot depend on the stored row, because
    // everything read here can be stale by the time the transaction opens.
    //
    // Splitting the method this way is forced: resolving a room's venue is an
    // async lookup and cannot run inside a synchronous better-sqlite3
    // transaction callback. Doing the whole thing from one pre-transaction
    // snapshot was the bug — a concurrent write landing in the gap was
    // overwritten from stale values, filed a ledger entry whose
    // `fromScheduledAt` never existed, and REUSED `icsSequence`, which makes
    // subscribed calendars ignore the second move entirely.
    if (input.timezone) this.assertTimezone(input.timezone);
    if (!input.localStart && !input.scheduledAt) {
      throw new BadRequestException('scheduledAt or localStart is required');
    }
    // Validates the room exists (404s before any write) and resolves its venue.
    // Independent of the occurrence, so it is safe to compute out here.
    const roomVenue = input.roomId != null ? await this.resolveVenueId(null, input.roomId) : null;
    const scope = await this.roles.accessibleCampaignIds(user);
    const ts = nowIso();

    // ---- SYNC PHASE. Re-read, re-derive, validate, probe and write as one
    // atomic step against what is ACTUALLY stored.
    let rawConflicts: RawConflict[] = [];
    let existing!: ScheduleRow;
    let scheduledAt!: string;
    let durationMinutes!: number;
    let movedTime = false;
    let kind: 'reschedule' | 'reassign' | null = null;
    this.db.transaction((tx) => {
      existing = this.getOccurrenceRowInTxOrThrow(tx, id);
      // Re-validated in here too: an occurrence cancelled in the gap must not be
      // moved on the strength of a snapshot that said it was live.
      if (existing.status === 'cancelled') {
        throw new BadRequestException('Cancelled scheduled sessions cannot be rescheduled — restore it first');
      }
      const timezone = input.timezone ?? existing.timezone;
      let localStart = '';
      if (input.localStart) {
        if (!timezone) throw new BadRequestException('localStart requires a timezone on the occurrence or in the body');
        // `materializeWallClock`, NOT `wallClockToUtc` + echoing the request. When
        // the requested clock falls in a spring-forward gap the instant is shifted
        // past the transition (New York 02:30 -> 03:30), and storing the requested
        // 02:30 alongside the 03:30 instant makes the row describe two different
        // times. Same helper `expandRecurrence` materializes with, so the two paths
        // are one expression of the rule rather than two that can drift — which is
        // how this site was missed when the recurrence path was fixed. Pure, so it
        // runs happily inside the transaction.
        const resolved = materializeWallClock(input.localStart, timezone);
        scheduledAt = resolved.utcIso;
        localStart = resolved.localStart;
      } else {
        const ms = Date.parse(input.scheduledAt as string);
        if (!Number.isFinite(ms)) throw new BadRequestException('scheduledAt is not a valid date-time');
        scheduledAt = new Date(ms).toISOString();
        localStart = timezone ? utcToLocalDateTime(scheduledAt, timezone) : '';
      }
      // Every OMITTED field is re-derived from the freshly-read row, so a field
      // this request does not mention cannot be reverted to a stale value — that
      // is how a concurrent room reassignment used to be silently undone.
      durationMinutes = input.durationMinutes ?? existing.durationMinutes;
      const roomId = input.roomId === undefined ? existing.roomId : input.roomId;
      const venueId = roomId === existing.roomId || roomId == null ? existing.venueId : roomVenue;
      // Did this request MOVE anything? Compute it BEFORE the probe so a retry
      // that resends the current instant/duration/room/DM is not rejected over a
      // forced overlap it did not cause. The same predicate gates the SEQUENCE bump
      // and the ledger below, so all three decisions stay in lockstep.
      const next = { scheduledAt, durationMinutes, timezone, localStart, roomId, venueId };
      movedTime = changesOccurrence(existing, pickFields(next, OCCURRENCE_TIME_FIELDS));
      kind = occurrenceExceptionKind(existing, next);
      // Only probe resources when the request actually changes them. Re-confirming
      // an occurrence's existing time/room/DM would flag its own forced overlap
      // as if a new edit had caused it.
      if (kind !== null) {
        const conflicts = this.findConflictRows(tx, {
          startsAt: scheduledAt,
          endsAt: endInstant(scheduledAt, durationMinutes),
          roomId,
          assignedDmUserId: existing.assignedDmUserId,
          // No member check, deliberately, on this and every other WRITE path.
          // A room and a running DM are resources this server ALLOCATES, so
          // double-allocating them is a bug it must refuse. A player is not
          // allocated: they RSVP, and being wanted at two tables is a fact about
          // their evening, not a broken booking — the coordinator resolves it by
          // talking to them. `POST /conflicts` still reports it, because a probe
          // that answers "what would this cost?" should surface everything;
          // rejecting a legal room booking over it would let one player's RSVP veto
          // another campaign's table.
          memberUserIds: [],
          excludeScheduleId: id,
        });
        if (conflicts.length > 0 && !input.force) throw new SeriesConflictSignal(conflicts);
        rawConflicts = conflicts;
      }
      if (kind === null) {
        // Idempotent retry: skip conflict probe results, ledger, SEQUENCE bump,
        // and notifications. Still back-fill a missing lineage anchor on legacy
        // rows adopted into a series without one — that write does not change
        // the schedule the client sent and cannot create a new overlap.
        if (existing.originalScheduledAt == null) {
          tx.update(scheduledSessions)
            .set({
              originalScheduledAt: existing.scheduledAt,
              updatedAt: ts,
            })
            .where(eq(scheduledSessions.id, id))
            .run();
          existing = { ...existing, originalScheduledAt: existing.scheduledAt, updatedAt: ts };
        }
        return;
      }
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
          // Missing anchors on no-op retries are repaired on the early-return
          // path above without probing or filing a ledger entry.
          originalScheduledAt: existing.originalScheduledAt ?? existing.scheduledAt,
          ...(movedTime ? { icsSequence: existing.icsSequence + 1 } : {}),
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
            // different recurrence ids and the ledger cannot line them up. And
            // the SERIES' zone, not this row's: `timezone` below is being
            // rewritten from `input.timezone` on this very statement, so reading
            // the row's own zone would let the id drift across the date line on
            // the next entry. See recurrenceLocalDateFor.
            recurrenceLocalDate: recurrenceLocalDateFor(existing, seriesTimezoneInTx(tx, existing.seriesId)),
            kind,
            fromScheduledAt: existing.scheduledAt,
            toScheduledAt: scheduledAt,
            toLocalStart: localStart,
            fromRoomId: existing.roomId,
            toRoomId: roomId,
            fromAssignedDmUserId: existing.assignedDmUserId,
            toAssignedDmUserId: existing.assignedDmUserId,
            fromCapacity: existing.capacity,
            toCapacity: existing.capacity,
            reason: input.reason ?? '',
            actorUserId: user.id,
            createdAt: ts,
          })
          .run();
      }
    });

    if (kind !== null) {
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
      // NOTIFIES. The same diff `SchedulingService.update` runs, so a move made here and the
      // identical move made through PATCH /schedule/:id announce themselves the
      // same way. Location and notes cannot change on this route, so in practice
      // this yields 'rescheduled'. Diffed against the row as it was read INSIDE the
      // transaction, so a concurrent write cannot make this announce a move that
      // did not happen (or stay silent about one that did).
      const changedFields = diffScheduleNotificationFields(
        { scheduledAt: existing.scheduledAt, durationMinutes: existing.durationMinutes, location: existing.location, notes: existing.notes },
        { scheduledAt, durationMinutes, location: existing.location, notes: existing.notes },
      );
      if (shouldNotifyScheduleUpdate(changedFields)) {
        await this.notifyOccurrenceChange(
          existing.campaignId,
          user,
          [{ id, scheduledAt, durationMinutes, title: existing.title }],
          scheduleNotificationChangeType(changedFields),
          changedFields,
        );
      }
    }

    const names = await this.lookupNames(
      rawConflicts.map((r) => r.campaignId),
      rawConflicts.flatMap((r) => (r.roomId != null ? [r.roomId] : [])),
    );
    return {
      occurrence: (
        await reconcileScheduledSessions(this.db, [
          kind !== null ? await this.getOccurrenceRowOrThrow(id) : existing,
        ])
      )[0],
      conflicts: this.redactConflicts(rawConflicts, scope, names),
    };
  }

  /** Re-seat one occurrence: different room, running DM, or capacity. */
  async reassignOccurrence(
    id: number,
    input: OccurrenceReassign,
    user: RequestUser,
    role: Role,
  ): Promise<OccurrenceWriteResult> {
    // ---- ASYNC PHASE. See rescheduleOccurrence for why this split exists: the
    // room lookup is async and cannot run inside a synchronous better-sqlite3
    // transaction, so nothing that depends on the STORED row may be computed
    // out here.
    const roomVenue = input.roomId != null ? await this.resolveVenueId(null, input.roomId) : null;
    const scope = await this.roles.accessibleCampaignIds(user);
    const ts = nowIso();

    // ---- SYNC PHASE. Re-read, re-derive, validate, probe and write atomically.
    let rawConflicts: RawConflict[] = [];
    let existing!: ScheduleRow;
    let roomId: number | null = null;
    let assignedDmUserId = '';
    this.db.transaction((tx) => {
      existing = this.getOccurrenceRowInTxOrThrow(tx, id);
      if (existing.status === 'cancelled') {
        throw new BadRequestException('Cancelled scheduled sessions cannot be reassigned — restore it first');
      }
      // Omitted fields re-derived from the row as actually stored, so this cannot
      // revert a concurrent change it never saw.
      roomId = input.roomId === undefined ? existing.roomId : input.roomId;
      const venueId = roomId === existing.roomId || roomId == null ? existing.venueId : roomVenue;
      assignedDmUserId = input.assignedDmUserId ?? existing.assignedDmUserId;
      const capacity = input.capacity ?? existing.capacity;
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
      // NO NOTIFICATION, deliberately — see the path table on
      // notifyOccurrenceChange. Room, DM and capacity are not
      // `ScheduleNotificationChangedField`s and never reach the party's copy of
      // the night. Silent ON PURPOSE, which is exactly why it is written down: a
      // path silent by omission looks identical at the call site to one silent
      // by decision, and that is how applyTemplate went unnoticed.
      //
      // NOT a SEQUENCE bump either, for the neighbouring reason. Nothing this endpoint writes reaches
      // the ICS feed: the emitter renders SUMMARY from `title`, LOCATION from the
      // free-text `location` column and DESCRIPTION from `notes` (ics.util.ts),
      // and never the room, the DM or the capacity. A re-seat therefore produces
      // a byte-identical VEVENT, so advancing SEQUENCE would push every
      // subscriber a "revision" of an event whose visible content did not change
      // — the exact no-op-must-not-bump rule `calendarFieldChanged` states on the
      // one-off path, and the rule the series fan-out follows too. If a room ever
      // starts rendering into LOCATION, all three predicates change together.
      const kind = occurrenceExceptionKind(existing, { roomId, venueId, assignedDmUserId, capacity });
      tx.update(scheduledSessions)
        .set({
          roomId,
          venueId,
          assignedDmUserId,
          capacity,
          updatedAt: ts,
        })
        .where(eq(scheduledSessions.id, id))
        .run();
      // Only a REAL re-seat files an override. `updateSeries` reads every
      // `reassign` entry as "the coordinator made a per-occurrence decision here,
      // do not overwrite it", so an entry written for a request that changed
      // nothing — an empty body, a reason-only call, a retry repeating the values
      // already stored — froze that occurrence out of every later series edit
      // PERMANENTLY (the ledger is append-only; there is no way to withdraw one).
      // A night could be excluded from its own series' title, notes, room, DM and
      // event keys forever because of a double-click.
      if (existing.seriesId != null && kind != null) {
        tx.insert(seriesExceptions)
          .values({
            seriesId: existing.seriesId,
            occurrenceId: id,
            recurrenceLocalDate: recurrenceLocalDateFor(existing, seriesTimezoneInTx(tx, existing.seriesId)),
            kind,
            fromScheduledAt: existing.scheduledAt,
            toScheduledAt: existing.scheduledAt,
            toLocalStart: existing.localStart,
            // The delta this entry exists to record. Without it an A->B->C run of
            // room moves loses B forever, because the row holds only C.
            fromRoomId: existing.roomId,
            toRoomId: roomId,
            fromAssignedDmUserId: existing.assignedDmUserId,
            toAssignedDmUserId: assignedDmUserId,
            fromCapacity: existing.capacity,
            toCapacity: capacity,
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
      occurrence: (
        await reconcileScheduledSessions(this.db, [await this.getOccurrenceRowOrThrow(id)])
      )[0],
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
      //
      // Per-slot, not one try/catch around the whole array: a single malformed
      // slot used to reset `slots` to [] and discard every VALID slot beside it,
      // so one bad entry silently turned the template into one that creates
      // nothing. Dropping only the unreadable slot keeps the rest of the block
      // usable, which is the recoverable failure — and there is no
      // template-update endpoint with which to repair the other outcome.
      slots = Array.isArray(parsed)
        ? parsed.flatMap((raw) => {
            const one = ScheduleTemplateSlot.safeParse(raw);
            return one.success ? [one.data] : [];
          })
        : [];
    } catch {
      // Unparseable JSON: nothing is recoverable, so the template reads as empty
      // rather than throwing on a list endpoint.
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
    const createdRows: ScheduleRow[] = [];

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
          createdRows.push(this.insertOccurrence(tx, series, occ, ts));
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
    // NOTIFIES ('created'). Applying a template puts a whole block of game nights
    // on the party's calendar, which is the single largest thing this service can
    // do to a member's schedule — and it emitted only transient SSE. One
    // notification for the request, anchored on the earliest night created, for
    // the same reason createSeries takes one: a template application is ONE
    // coordinator decision, and this path can materialize more rows than any
    // other (slots x occurrences), so per-row would be worst here.
    await this.notifyOccurrenceChange(input.campaignId, user, createdRows, 'created');

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
