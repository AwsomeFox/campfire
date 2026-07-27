import { and, eq, inArray, ne } from 'drizzle-orm';
import type { ScheduleConflict } from '@campfire/schema';
import { campaigns, playRooms, playVenues, scheduledSessions, sessionRsvps } from '../../db/schema';
import type { DrizzleDb } from '../../db/db.module';
import type { SyncDb } from './scheduling.service';
import { scheduleLiveSql, scheduleOrganizedPlaySql, scheduleOverlapsSql } from './scheduling-queries';

/**
 * The booking-conflict primitive (issue #588), extracted so that EVERY write path
 * which claims a shared room or DM can run the identical probe.
 *
 * This lives in its own leaf module rather than on OrganizedPlayService because
 * SchedulingService needs it too — `POST /schedule/:id/restore` re-acquires the
 * room and DM a cancellation released — and OrganizedPlayService already imports
 * helpers from SchedulingService. Putting the probe on either service would make
 * the two import each other. Nothing here touches service state, so a leaf module
 * is also the honest shape: these are functions of (db, window, resources).
 */

/** Which campaigns the caller may see identifying detail for. */
export type AccessScope = number[] | 'all';

export function canSee(scope: AccessScope, campaignId: number): boolean {
  return scope === 'all' || scope.includes(campaignId);
}

export type ConflictNames = {
  campaigns: Map<number, string>;
  rooms: Map<number, { name: string; venueName: string }>;
};

/** Campaign + room display names for the ids referenced by these conflicts. */
export async function lookupConflictNames(db: DrizzleDb, campaignIds: number[], roomIds: number[]): Promise<ConflictNames> {
  const uniqueCampaigns = [...new Set(campaignIds)];
  const uniqueRooms = [...new Set(roomIds)];
  const [campaignRows, roomRows] = await Promise.all([
    uniqueCampaigns.length === 0
      ? Promise.resolve([])
      : db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(inArray(campaigns.id, uniqueCampaigns)),
    uniqueRooms.length === 0
      ? Promise.resolve([])
      : db
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

/**
 * Apply the privacy rule to raw conflicts.
 *
 * A coordinator must be told "that room is taken from 19:00 to 23:00" even when
 * the booking belongs to a campaign they cannot read — otherwise the shared room
 * calendar is useless. They must NOT be told whose game it is. So the window, the
 * resource and the colliding subject id (which the CALLER supplied in the first
 * place) survive; the campaign, its name, the schedule id and the title are
 * dropped, and `visible: false` says so explicitly rather than leaving the client
 * to guess whether a null means redacted or absent.
 *
 * Lives in this leaf module, beside the probe that produces `RawConflict`, for
 * the same reason the probe does: SchedulingService needs it too. `restore()`
 * takes `force` and must report what it overrode, and a RawConflict must never
 * reach a caller unredacted — so the one place that turns raw into caller-safe
 * has to be reachable from both services without them importing each other.
 */
export function redactConflicts(raws: RawConflict[], scope: AccessScope, names: ConflictNames): ScheduleConflict[] {
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

/** End of a booking window. Half-open: `[startsAt, endsAt)`. */
export function endInstant(startIso: string, durationMinutes: number): string {
  const start = Date.parse(startIso);
  const minutes = Number.isFinite(durationMinutes) ? Math.max(0, durationMinutes) : 0;
  return new Date(start + minutes * 60_000).toISOString();
}

/**
 * True when this row holds a shared, ALLOCATABLE resource — a room or a running
 * DM — and so cannot have its window moved without a booking probe.
 *
 * Lives here, beside `findConflictRows`, because it has to mean exactly what that
 * probe can match on. The probe collides on `roomId` and `assignedDmUserId` and
 * on nothing else, so those two fields are the entire hazard, and keeping the
 * predicate in the same module as the query is what stops the two drifting.
 *
 * Deliberately NOT `scheduleOrganizedPlaySql()`, even though that is the obvious
 * candidate to reuse. That predicate is BROADER — a venue id, an event key or a
 * season key also puts a row in the coordinator's pool — and it answers a
 * different question: "should this row be visible to organized play?", not "can
 * moving this row double-book somebody?". A row carrying only a season key
 * allocates nothing, and gating the move guard on the wider predicate would
 * refuse a `PATCH` that has no hazard at all.
 *
 * The guard this backs used to test `seriesId != null`, which is a PROXY: series
 * occurrences are the rows that usually hold rooms, but `reassignOccurrence`
 * will seat any occurrence, so a plain one-off could be given a room and then
 * slid through `PATCH /schedule/:id` with no probe and no ledger entry —
 * recreating precisely the cross-campaign double-booking this feature exists to
 * prevent. `restore()` was never exposed to it because it probes off
 * `existing.roomId` directly, which is the shape this restores to the move path.
 */
export function holdsBookableResource(row: { roomId: number | null; assignedDmUserId: string }): boolean {
  return row.roomId != null || row.assignedDmUserId !== '';
}

/** The raw (unredacted) shape a conflict query returns before privacy is applied. */
export type RawConflict = {
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
 * Every booking that collides with the proposed window, as RAW rows.
 *
 * SYNCHRONOUS on purpose, and takes the caller's `db`/`tx` handle: the whole
 * point of a booking check is that it holds between "is the room free?" and
 * "the room is now mine". Running it inside the same better-sqlite3
 * transaction as the write makes that a structural guarantee rather than a
 * hopeful ordering — see createSeries()/rescheduleOccurrence()/restore(), which
 * all check and write inside one `db.transaction(...)`.
 *
 * Only rows in the shared organized-play pool are considered
 * (scheduleOrganizedPlaySql): a private home game holds no shared resource, so
 * it can neither be collided with nor be revealed by this query. Cancelled rows
 * are excluded via scheduleLiveSql — a cancelled night has RELEASED its room,
 * which is exactly why restoring one has to probe before taking it back.
 */
export function findConflictRows(
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
  const push = (
    kind: ScheduleConflict['kind'],
    row: { id: number; campaignId: number; title: string; scheduledAt: string; durationMinutes: number; roomId: number | null },
    subjectUserId: string,
  ): void => {
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
 * Internal marker thrown inside a booking transaction so better-sqlite3 rolls
 * the whole attempt back before anything is written. Never leaves the module
 * boundary: the controller layer converts it to a redacted 409 via
 * OrganizedPlayService.toConflictResponse().
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
