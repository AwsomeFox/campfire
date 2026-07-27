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
 * (issue #588): they hold a room or venue, belong to a series, or carry an event key.
 *
 * This predicate is the privacy boundary for every cross-campaign read. A private
 * home game that never touches venues/series is invisible to the coordinator
 * calendar and to conflict detection — not merely redacted, but absent — so
 * shipping this feature cannot make an existing campaign's mere *existence* at
 * 7pm on Tuesday observable to a stranger. The cost is that a collision with a
 * purely private night goes unreported; that is the right trade, because nobody
 * outside that campaign is competing for its (nonexistent) shared resource.
 */
export function scheduleOrganizedPlaySql(): SQL {
  return sql`(
    ${scheduledSessions.roomId} IS NOT NULL
    OR ${scheduledSessions.venueId} IS NOT NULL
    OR ${scheduledSessions.seriesId} IS NOT NULL
    OR ${scheduledSessions.eventId} != ''
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

/** True once scheduledAt + durationMinutes has passed. */
export function scheduleEndedSql(nowIso: string): SQL {
  return sql`${scheduleEndJulianSql()} <= julianday(${nowIso})`;
}

/** In progress: started (scheduledAt <= now) but not ended. */
export function scheduleInProgressSql(nowIso: string): SQL {
  return sql`julianday(${scheduledSessions.scheduledAt}) <= julianday(${nowIso}) AND ${scheduleNotEndedSql(nowIso)}`;
}

/** Upcoming only: scheduledAt strictly after now. */
export function scheduleUpcomingOnlySql(nowIso: string): SQL {
  return sql`julianday(${scheduledSessions.scheduledAt}) > julianday(${nowIso})`;
}
