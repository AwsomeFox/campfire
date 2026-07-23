/**
 * Schedule temporal window helpers (issue #818).
 *
 * A planned game night is in progress from `scheduledAt` (inclusive) until
 * `scheduledAt + durationMinutes` (exclusive). Comparisons use UTC millis so
 * local DST transitions never stretch or shrink the stored duration.
 */

export type SchedulePhase = 'upcoming' | 'in_progress' | 'past';

export type ScheduleWindowFields = {
  scheduledAt: string;
  durationMinutes: number;
};

/** End instant as UTC epoch millis: start + durationMinutes. NaN when start is invalid. */
export function scheduleEndsAtMs(scheduledAt: string, durationMinutes: number): number {
  const start = Date.parse(scheduledAt);
  if (!Number.isFinite(start)) return Number.NaN;
  // Clamp to schema bounds so legacy/invalid durations cannot misclassify phases.
  const raw = Number.isFinite(durationMinutes) ? durationMinutes : 0;
  const minutes = Math.min(24 * 60, Math.max(0, raw));
  return start + minutes * 60_000;
}

/** Classify one schedule relative to `nowMs` (default: Date.now()). */
export function schedulePhase(
  scheduledAt: string,
  durationMinutes: number,
  nowMs: number = Date.now(),
): SchedulePhase {
  const start = Date.parse(scheduledAt);
  if (!Number.isFinite(start)) return 'past';
  const end = scheduleEndsAtMs(scheduledAt, durationMinutes);
  if (nowMs < start) return 'upcoming';
  if (nowMs < end) return 'in_progress';
  return 'past';
}

export function isScheduleInProgress(
  scheduledAt: string,
  durationMinutes: number,
  nowMs: number = Date.now(),
): boolean {
  return schedulePhase(scheduledAt, durationMinutes, nowMs) === 'in_progress';
}

/** True while the game night has not ended yet (upcoming or in progress). */
export function isScheduleNotEnded(
  scheduledAt: string,
  durationMinutes: number,
  nowMs: number = Date.now(),
): boolean {
  const end = scheduleEndsAtMs(scheduledAt, durationMinutes);
  return Number.isFinite(end) && end > nowMs;
}

/**
 * Split schedules into in-progress / upcoming / past.
 * In-progress and upcoming keep soonest-first order; past is most-recent first.
 * Invalid `scheduledAt` values sort last in ascending lists / first in past
 * (`Number.POSITIVE_INFINITY` sentinel), so comparators never return NaN.
 */
export function partitionSchedules<T extends ScheduleWindowFields>(
  schedules: readonly T[],
  nowMs: number = Date.now(),
): { inProgress: T[]; upcoming: T[]; past: T[] } {
  type Row = { row: T; startMs: number; phase: SchedulePhase };
  const classified: Row[] = schedules.map((row) => {
    const startMs = Date.parse(row.scheduledAt);
    const finiteStart = Number.isFinite(startMs);
    // Reuse parsed start for phase classification (avoid re-parsing in schedulePhase).
    let phase: SchedulePhase;
    if (!finiteStart) {
      phase = 'past';
    } else {
      const end = scheduleEndsAtMs(row.scheduledAt, row.durationMinutes);
      if (nowMs < startMs) phase = 'upcoming';
      else if (nowMs < end) phase = 'in_progress';
      else phase = 'past';
    }
    return {
      row,
      startMs: finiteStart ? startMs : Number.POSITIVE_INFINITY,
      phase,
    };
  });
  const inProgress = classified
    .filter((r) => r.phase === 'in_progress')
    .sort((a, b) => a.startMs - b.startMs)
    .map((r) => r.row);
  const upcoming = classified
    .filter((r) => r.phase === 'upcoming')
    .sort((a, b) => a.startMs - b.startMs)
    .map((r) => r.row);
  const past = classified
    .filter((r) => r.phase === 'past')
    .sort((a, b) => b.startMs - a.startMs)
    .map((r) => r.row);
  return { inProgress, upcoming, past };
}

/**
 * Duration minutes that ends the session at `nowMs` (clamped to schema bounds).
 * Editing duration mid-session redefines the end as scheduledAt + duration.
 * Uses floor so the exclusive end is never after `nowMs` — including the first
 * fifteen minutes, where clamping to the create-time minimum of 15 would leave
 * the night incorrectly classified as in progress.
 */
export function endSessionDurationMinutes(scheduledAt: string, nowMs: number = Date.now()): number {
  const start = Date.parse(scheduledAt);
  if (!Number.isFinite(start)) return 0;
  const elapsed = Math.floor((nowMs - start) / 60_000);
  return Math.min(24 * 60, Math.max(0, elapsed));
}

/** Extend a session's planned duration, clamped to the schema maximum (24h). */
export function extendSessionDurationMinutes(current: number, addMinutes: number): number {
  const base = Number.isFinite(current) ? current : 240;
  const add = Number.isFinite(addMinutes) ? addMinutes : 0;
  return Math.min(24 * 60, Math.max(15, base + add));
}
