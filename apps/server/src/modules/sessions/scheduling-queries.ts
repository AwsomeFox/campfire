import { sql, type SQL } from 'drizzle-orm';
import { scheduledSessions } from '../../db/schema';

/** Julian-day end instant for a scheduled row (UTC). */
export function scheduleEndJulianSql(): SQL {
  return sql`julianday(${scheduledSessions.scheduledAt}) + (${scheduledSessions.durationMinutes} / 1440.0)`;
}

/** True while scheduledAt + durationMinutes is still in the future (upcoming or in progress). */
export function scheduleNotEndedSql(nowIso: string): SQL {
  return sql`${scheduleEndJulianSql()} > julianday(${nowIso})`;
}

/** True for rows that should remain visible in live/upcoming projections. */
export function scheduleLiveSql(): SQL {
  return sql`${scheduledSessions.status} = 'scheduled'`;
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
