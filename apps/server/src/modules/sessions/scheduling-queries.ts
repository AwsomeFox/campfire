import { sql, type SQL } from 'drizzle-orm';
import { scheduledSessions, sessions } from '../../db/schema';

/** Julian-day end instant for a scheduled row (UTC). */
export function scheduleEndJulianSql(): SQL {
  return sql`julianday(${scheduledSessions.scheduledAt}) + (${scheduledSessions.durationMinutes} / 1440.0)`;
}

/** True while scheduledAt + durationMinutes is still in the future (upcoming or in progress). */
export function scheduleNotEndedSql(nowIso: string): SQL {
  return sql`${scheduleEndJulianSql()} > julianday(${nowIso})`;
}

/**
 * True when a stored `completed` is only an artefact of a recap that is now trashed or
 * gone — the SQL twin of SchedulingService.projectLink()'s read-time reconciliation.
 *
 * Deliberately requires a non-null session_id: a `completed` row with no link at all
 * (e.g. imported from another install) is genuine played history, and projectLink leaves
 * it alone, so this must too. Keep the two in lockstep.
 */
function completedByMissingRecapSql(): SQL {
  return sql`(
    ${scheduledSessions.status} = 'completed'
    AND ${scheduledSessions.sessionId} IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM ${sessions}
      WHERE ${sessions.id} = ${scheduledSessions.sessionId}
        AND ${sessions.deletedAt} IS NULL
    )
  )`;
}

/**
 * True for rows that should remain visible in live/upcoming projections — i.e. rows that
 * are EFFECTIVELY 'scheduled' once the schedule↔recap link is reconciled.
 *
 * This must agree with projectLink(), not just with the raw column. Filtering on the raw
 * status made a future-dated `completed` night whose recap was trashed vanish from
 * Upcoming/Next while every point read insisted it was scheduled again — the DM lost a
 * real game night from the view they plan from. The single definition of "live" lives
 * here; schedulePastSql() below is its literal complement, so no row can land in both
 * projections or in neither.
 *
 * NOT the predicate for "does this row still hold its room/DM" (issue #1555) — a
 * genuinely completed night (live recap, not the missing-recap artefact case above)
 * is deliberately EXCLUDED here, but must NOT be treated as having released its
 * resource. See scheduleResourceHeldSql() below for that question and why the two
 * must stay separate.
 */
export function scheduleLiveSql(): SQL {
  return sql`(${scheduledSessions.status} = 'scheduled' OR ${completedByMissingRecapSql()})`;
}

/**
 * Past = everything that is not a live, not-yet-ended night: already ended, or cancelled,
 * or genuinely completed. Derived from scheduleLiveSql() rather than restating the status
 * rules, so the two projections stay exact complements by construction.
 */
export function schedulePastSql(nowIso: string): SQL {
  return sql`(${scheduleEndedSql(nowIso)} OR NOT ${scheduleLiveSql()})`;
}

/**
 * True for rows that still HOLD their shared room/DM for booking-conflict purposes
 * (issue #1555). This is a DIFFERENT question from scheduleLiveSql() and must not be
 * confused with it:
 *
 *   - scheduleLiveSql() answers "does this night still need the DM's attention as an
 *     upcoming/no-recap game?" — genuinely completed (a live, non-trashed recap
 *     exists) is deliberately EXCLUDED, because scribe draftability
 *     (findNextEndedScheduledSession / resolveRunScope), the reminder sweep and the
 *     Upcoming/Next projections all need "already has its recap" to mean "nothing left
 *     to do here".
 *   - scheduleResourceHeldSql() answers "did this row's booking ever release its room
 *     or its assigned DM?" — and the answer is DECIDED HERE: only `cancelled` releases
 *     a resource. A genuinely completed night still occupies the historical window it
 *     was played in — cancelling is an explicit "this is not happening", completing is
 *     not — so a completed row keeps colliding with anything that would overlap its
 *     window, forever, the same as a merely-completed-on-paper (missing-recap) one.
 *
 * This is why `findConflictRows()` must use THIS predicate, not scheduleLiveSql():
 * before this fix, a genuinely completed occurrence fell out of scheduleLiveSql() and
 * therefore out of conflict detection entirely, so (a) another campaign could book
 * straight over a completed night's own window while it was still current, and (b)
 * `unlinkSessionInTx` / trashing the linked recap could flip the row back to
 * `scheduled` (directly, or via projectLink()'s read-time reconciliation) with no
 * re-probe, silently completing a double-booking. Defining "release" as "only
 * cancellation releases" closes both: nothing ever stops holding its resource on the
 * way to `completed`, so there is no re-acquisition for a revival path to skip.
 *
 * `scheduleOverlapsSql()` still does the real work of deciding whether any of this
 * matters for a given probe — a completed row's window is normally in the past, so it
 * naturally stops colliding with new bookings once nothing can overlap it, without this
 * predicate needing to reason about time at all.
 */
export function scheduleResourceHeldSql(): SQL {
  return sql`${scheduledSessions.status} != 'cancelled'`;
}

/**
 * The effective lifecycle status as a SQL projection — the twin of
 * SchedulingService.projectLink() for set-based reads (issue #588).
 *
 * Derived from scheduleLiveSql() rather than restating the rules, so a
 * cross-campaign calendar can never disagree with the per-campaign Schedule tab
 * (or with the reminder sweep) about whether a night is live. Reintroducing a
 * raw `status = 'scheduled'` comparison anywhere is exactly what causes that drift.
 */
export function scheduleEffectiveStatusSql(): SQL<string> {
  return sql`(CASE WHEN ${scheduleLiveSql()} THEN 'scheduled' ELSE ${scheduledSessions.status} END)`;
}

/**
 * True for rows that have opted into the SHARED organized-play resource pool
 * (issue #588): they hold a room or venue, name an assigned DM, or carry an
 * event/season key.
 *
 * This predicate is the privacy boundary for every cross-campaign read. A private
 * home game that holds none of those is invisible to the coordinator calendar and
 * to conflict detection — not merely redacted, but absent — so shipping this
 * feature cannot make an existing campaign's mere *existence* at 7pm on Tuesday
 * observable to a stranger. The cost is that a collision with a purely private
 * night goes unreported; that is the right trade, because nobody outside that
 * campaign is competing for its (nonexistent) shared resource.
 *
 * SERIES MEMBERSHIP IS DELIBERATELY *NOT* AN OPT-IN SIGNAL. `series_id IS NOT NULL`
 * once appeared here and it silently published private campaigns: recurrence is a
 * general convenience ("we play every Thursday"), not a declaration that a table
 * is shared, so a DM who used it for an ordinary basement game was enrolled in the
 * install-wide pool without ever naming a venue, a room or an event. That leaked
 * the window, the local wall clock and even the RSVP count of a campaign holding
 * nothing anybody else could compete for — precisely the "something is here"
 * disclosure this predicate exists to prevent. A series that IS organized play
 * still qualifies, through the room/venue/DM/event it actually holds.
 *
 * Every column tested here is one that ONLY the organized-play write paths ever
 * set (SchedulingService.create leaves them all at their empty defaults), so
 * membership of the pool is always the result of an explicit act.
 */
export function scheduleOrganizedPlaySql(): SQL {
  return sql`(
    ${scheduledSessions.roomId} IS NOT NULL
    OR ${scheduledSessions.venueId} IS NOT NULL
    OR ${scheduledSessions.assignedDmUserId} != ''
    OR ${scheduledSessions.eventId} != ''
    OR ${scheduledSessions.seasonId} != ''
  )`;
}

/**
 * True when the row's [start, end) window overlaps [`startIso`, `endIso`).
 * Half-open on both sides: a night that ends exactly when another starts does NOT
 * conflict, which is what back-to-back organized-play slots depend on.
 */
export function scheduleOverlapsSql(startIso: string, endIso: string): SQL {
  return sql`(
    julianday(${scheduledSessions.scheduledAt}) < julianday(${endIso})
    AND ${scheduleEndJulianSql()} > julianday(${startIso})
  )`;
}

/**
 * True once scheduledAt + durationMinutes has passed.
 *
 * Defence in depth (issue #1521): if `scheduledAt` is a value SQLite's
 * `julianday()` cannot parse, `scheduleEndJulianSql()` is NULL, so the raw
 * `<=` comparison is NULL — neither true nor false. Such a row (which can only
 * reach the DB by bypassing the import boundary now — a direct edit or a
 * hand-corrupted row) would then satisfy NEITHER `scheduleNotEndedSql()`
 * (Upcoming) NOR this predicate, and because `schedulePastSql()` is
 * `(scheduleEndedSql() OR NOT scheduleLiveSql())`, a live one would fall out of
 * Past too — vanishing from every list. Treating an unclassifiable end instant
 * as ended makes the projections TOTAL: the row lands in Past, where an
 * operator can see and fix it, instead of nowhere. For parseable input
 * `scheduleEndJulianSql()` is never NULL, so the `IS NULL` arm is dead and the
 * strict `>`/`<=` complement with `scheduleNotEndedSql()` — and therefore the
 * live/past complement property — is preserved exactly.
 */
export function scheduleEndedSql(nowIso: string): SQL {
  return sql`(${scheduleEndJulianSql()} IS NULL OR ${scheduleEndJulianSql()} <= julianday(${nowIso}))`;
}

/** In progress: started (scheduledAt <= now) but not ended. */
export function scheduleInProgressSql(nowIso: string): SQL {
  return sql`julianday(${scheduledSessions.scheduledAt}) <= julianday(${nowIso}) AND ${scheduleNotEndedSql(nowIso)}`;
}

/** Upcoming only: scheduledAt strictly after now. */
export function scheduleUpcomingOnlySql(nowIso: string): SQL {
  return sql`julianday(${scheduledSessions.scheduledAt}) > julianday(${nowIso})`;
}
