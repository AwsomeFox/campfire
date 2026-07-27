import { and, eq, inArray, ne } from 'drizzle-orm';
import type { ScheduleConflict } from '@campfire/schema';
import { scheduledSessions, sessionRsvps } from '../../db/schema';
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

/** End of a booking window. Half-open: `[startsAt, endsAt)`. */
export function endInstant(startIso: string, durationMinutes: number): string {
  const start = Date.parse(startIso);
  const minutes = Number.isFinite(durationMinutes) ? Math.max(0, durationMinutes) : 0;
  return new Date(start + minutes * 60_000).toISOString();
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
