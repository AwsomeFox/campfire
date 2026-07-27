/**
 * IANA wall-clock arithmetic + recurrence expansion for organized-play
 * scheduling (issue #588).
 *
 * WHY THIS EXISTS
 * ---------------
 * `scheduled_sessions.scheduled_at` is a UTC instant, and that is the right
 * storage for a single night: it is unambiguous and every comparison in
 * scheduling-queries.ts is an instant comparison. It is NOT enough for a
 * *series*. "Every Tuesday at 19:00 in America/New_York" is a statement about a
 * wall clock, not about an instant: the UTC offset changes twice a year, so a
 * series stored as "first instant + 7*24h" silently drifts to 18:00 or 20:00
 * local the moment a DST transition crosses the series. Organized play cares
 * about the wall clock (the store opens at 7pm, not at 23:00Z), so the SERIES
 * stores the IANA zone plus the local start date/time, and each occurrence is
 * materialized from that pair.
 *
 * All functions here are pure and dependency-free (the package ships with zod
 * only), so they are unit-testable without a DB or a Nest context.
 */

/** `YYYY-MM-DD` in some IANA zone — a calendar date, not an instant. */
export type LocalDate = string;
/** `HH:MM` 24-hour wall clock in some IANA zone. */
export type LocalTime = string;
/** `YYYY-MM-DDTHH:MM` wall clock in some IANA zone. */
export type LocalDateTime = string;

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):([0-5]\d)$/;

/** Hard ceiling on how many occurrences one series may materialize. */
export const MAX_SERIES_OCCURRENCES = 104;

/** Recurrence frequencies this feature supports. */
export const RECURRENCE_FREQS = ['daily', 'weekly', 'monthly'] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];

export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function isLocalTime(value: string): boolean {
  return LOCAL_TIME_RE.test(value);
}

export function isLocalDateTime(value: string): boolean {
  if (!LOCAL_DATE_TIME_RE.test(value)) return false;
  return isLocalDate(value.slice(0, 10));
}

/** Cached formatters — expansion asks for many offsets in a row. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = zoneFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // h23 (not `hour12: false`) so midnight formats as 00, never 24 — some ICU
      // builds render hour 24 under hour12:false and that breaks Date.UTC round-trips.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** True when `timeZone` is a zone this runtime's ICU data recognizes. */
export function isValidIanaTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    zoneFormatter(timeZone).format(0);
    return true;
  } catch {
    return false;
  }
}

type WallParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function wallPartsAt(timeZone: string, utcMs: number): WallParts {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(utcMs));
  const pick = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
  };
}

/**
 * The zone's UTC offset in milliseconds at instant `utcMs` (east of UTC is positive).
 * Derived by formatting the instant into the zone and reading the difference back —
 * the only offset source available without shipping a tz database.
 */
export function zoneOffsetMsAt(timeZone: string, utcMs: number): number {
  const p = wallPartsAt(timeZone, utcMs);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Floor to whole seconds: formatToParts has no sub-second field, so the
  // remainder would otherwise show up as a phantom offset.
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Render an instant as the `YYYY-MM-DDTHH:MM` wall clock observed in `timeZone`. */
export function utcToLocalDateTime(utcIso: string, timeZone: string): LocalDateTime {
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) throw new RangeError(`invalid instant: ${utcIso}`);
  const p = wallPartsAt(timeZone, ms);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** How a wall clock that is not a single unambiguous instant was resolved. */
export type WallClockResolution = 'exact' | 'gap' | 'ambiguous';

export type ResolvedWallClock = {
  /** UTC epoch millis. */
  utcMs: number;
  /** Canonical ISO-8601 UTC instant. */
  utcIso: string;
  resolution: WallClockResolution;
};

/**
 * Resolve a wall clock in an IANA zone to a UTC instant.
 *
 * Two wall clocks a year are not a single instant:
 *   - GAP (spring forward): 02:30 simply does not exist on the DST-start day.
 *     Resolved by shifting forward past the gap — the RFC 5545 / Temporal
 *     `compatible` convention — so a 02:30 series still fires once that day
 *     rather than silently skipping it.
 *   - AMBIGUOUS (fall back): 01:30 happens twice. Resolved to the EARLIER
 *     instant (the still-DST one), again matching `compatible`, so the night
 *     starts when the first 01:30 arrives instead of an hour "late".
 *
 * The `resolution` field is returned rather than swallowed so callers can
 * surface a warning; nothing in this feature refuses to schedule over a DST
 * transition, because a real venue does run that night.
 */
export function wallClockToUtc(local: LocalDateTime, timeZone: string): ResolvedWallClock {
  if (!isLocalDateTime(local)) throw new RangeError(`invalid local date-time: ${local}`);
  if (!isValidIanaTimeZone(timeZone)) throw new RangeError(`unknown IANA time zone: ${timeZone}`);

  const naiveUtcMs = Date.parse(`${local}:00.000Z`);
  const roundTrips = (candidate: number): boolean =>
    utcToLocalDateTime(new Date(candidate).toISOString(), timeZone) === local;

  // Bracket the wall clock with the offsets a day either side. Any transition
  // near it therefore shows up as two DIFFERENT offsets, which is what makes an
  // ambiguous time detectable at all: probing only at the naive instant returns
  // one offset for both repetitions of a fall-back hour and silently reports
  // 'exact'. (This is Temporal's getPossibleInstantsFor bracket, minus Temporal.)
  const DAY = 86_400_000;
  const offsetBefore = zoneOffsetMsAt(timeZone, naiveUtcMs - DAY);
  const offsetAfter = zoneOffsetMsAt(timeZone, naiveUtcMs + DAY);
  const candidates = [...new Set([naiveUtcMs - offsetBefore, naiveUtcMs - offsetAfter])];
  const valid = candidates.filter(roundTrips);

  if (valid.length === 1) {
    return { utcMs: valid[0], utcIso: new Date(valid[0]).toISOString(), resolution: 'exact' };
  }
  if (valid.length === 0) {
    // Gap: no candidate reproduces the requested wall clock because it does not
    // exist. The later instant is the one just past the transition.
    const shifted = Math.max(...candidates);
    return { utcMs: shifted, utcIso: new Date(shifted).toISOString(), resolution: 'gap' };
  }
  const earliest = Math.min(...valid);
  return { utcMs: earliest, utcIso: new Date(earliest).toISOString(), resolution: 'ambiguous' };
}

/** A requested wall clock, resolved to the instant AND the wall clock it really occupies. */
export type MaterializedWallClock = {
  /** Canonical ISO-8601 UTC instant the session actually starts at. */
  utcIso: string;
  /**
   * The wall clock that instant ACTUALLY reads in the zone — never the requested
   * one when the requested one does not exist.
   */
  localStart: LocalDateTime;
  resolution: WallClockResolution;
};

/**
 * THE one expression of "what gets persisted when someone asks for this wall
 * clock". Every path that stores a `local_start` alongside a `scheduled_at` must
 * come through here, so that the pair cannot disagree.
 *
 * The invariant is `utcToLocalDateTime(scheduledAt, timezone) === localStart`,
 * and it held everywhere except the DST GAP: 02:30 does not exist on the
 * spring-forward day, `wallClockToUtc` shifts the instant past the transition to
 * 03:30, and a caller that then stored the REQUESTED 02:30 produced a row whose
 * instant and wall clock describe different times. Any UI trusting `local_start`
 * shows the table meeting an hour early.
 *
 * `localStart` is derived from the chosen instant UNCONDITIONALLY rather than
 * only in the gap branch. For `exact` and `ambiguous` the derivation is
 * provably identical to echoing the request — both round-trip, which is how
 * `wallClockToUtc` selects them in the first place — so the branch would be dead
 * weight whose only power is to be got wrong. There is no `if` here to drift.
 *
 * Note this deliberately does NOT return a local DATE. Callers materializing a
 * recurrence keep the date the RULE names as the occurrence's identity; only the
 * clock is corrected. See expandRecurrence.
 */
export function materializeWallClock(local: LocalDateTime, timeZone: string): MaterializedWallClock {
  const resolved = wallClockToUtc(local, timeZone);
  return {
    utcIso: resolved.utcIso,
    localStart: utcToLocalDateTime(resolved.utcIso, timeZone),
    resolution: resolved.resolution,
  };
}

/** Split a `YYYY-MM-DD` into numeric parts (assumes `isLocalDate`). */
function dateParts(date: LocalDate): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}

function toLocalDate(year: number, month: number, day: number): LocalDate {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/**
 * Calendar-only date arithmetic. Deliberately NOT instant arithmetic: adding 7
 * days to a local date must stay the same weekday and the same wall clock even
 * when a 23- or 25-hour day sits in between.
 */
export function addDaysLocal(date: LocalDate, days: number): LocalDate {
  const { year, month, day } = dateParts(date);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return toLocalDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/**
 * Add whole months, keeping the day-of-month. Returns null when the target
 * month has no such day (31 January + 1 month), matching RFC 5545 BYMONTHDAY:
 * the occurrence is SKIPPED, not clamped to the 28th. Clamping would silently
 * move a "third Saturday"-style booking onto a different weekday.
 */
export function addMonthsLocal(date: LocalDate, months: number): LocalDate | null {
  const { year, month, day } = dateParts(date);
  const zeroBased = month - 1 + months;
  const targetYear = year + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12;
  const probe = new Date(Date.UTC(targetYear, targetMonth, day));
  if (probe.getUTCMonth() !== targetMonth) return null;
  return toLocalDate(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate());
}

/** The recurrence half of a series definition. */
export type RecurrenceSpec = {
  timezone: string;
  /** Local date of the FIRST occurrence. */
  startDate: LocalDate;
  /** Local wall-clock start time, applied to every occurrence. */
  startTime: LocalTime;
  durationMinutes: number;
  freq: RecurrenceFreq;
  /** Every `interval` days/weeks/months. >= 1. */
  interval: number;
  /** How many occurrences to materialize. 1 = a one-off. */
  count: number;
  /** Optional inclusive last local date; occurrences past it are dropped. */
  untilDate?: LocalDate | null;
};

export type ExpandedOccurrence = {
  /** 0-based position in the series. Stable: it is the recurrence identity. */
  index: number;
  localDate: LocalDate;
  localStart: LocalDateTime;
  /** Materialized UTC instant for this occurrence's local start. */
  scheduledAt: string;
  durationMinutes: number;
  /** How the wall clock resolved — 'gap'/'ambiguous' flag a DST transition. */
  resolution: WallClockResolution;
};

export class RecurrenceError extends Error {}

/**
 * Materialize a recurrence into concrete occurrences.
 *
 * DESIGN NOTE — materialized rows, not on-the-fly expansion.
 * Expansion is cheap, so the tempting design is to keep only the rule and expand
 * at read time. It does not survive the rest of this feature's requirements:
 * per-occurrence exceptions, cancellations, reschedule lineage, RSVPs, seat
 * capacity and room bookings all need a DURABLE ROW IDENTITY to hang off, and a
 * cross-campaign conflict query needs to be an overlap query over rows rather
 * than an expand-every-series-in-the-install scan. So the rule lives on
 * `session_series` (which is what keeps DST correct) and each occurrence is
 * written as an ordinary `scheduled_sessions` row (which is what keeps RSVPs,
 * reminders, ICS and the schedule↔recap link working unchanged).
 *
 * The rule is retained anyway so a series can be EXTENDED later from the same
 * wall clock rather than from the last materialized instant.
 */
export function expandRecurrence(spec: RecurrenceSpec): ExpandedOccurrence[] {
  if (!isLocalDate(spec.startDate)) throw new RecurrenceError(`invalid startDate: ${spec.startDate}`);
  if (!isLocalTime(spec.startTime)) throw new RecurrenceError(`invalid startTime: ${spec.startTime}`);
  if (!isValidIanaTimeZone(spec.timezone)) throw new RecurrenceError(`unknown IANA time zone: ${spec.timezone}`);
  if (!RECURRENCE_FREQS.includes(spec.freq)) throw new RecurrenceError(`unknown freq: ${spec.freq}`);
  const interval = Math.floor(spec.interval);
  if (!Number.isFinite(interval) || interval < 1) throw new RecurrenceError('interval must be >= 1');
  const count = Math.floor(spec.count);
  if (!Number.isFinite(count) || count < 1) throw new RecurrenceError('count must be >= 1');
  if (count > MAX_SERIES_OCCURRENCES) {
    throw new RecurrenceError(`count must be <= ${MAX_SERIES_OCCURRENCES}`);
  }
  if (spec.untilDate != null && spec.untilDate !== '' && !isLocalDate(spec.untilDate)) {
    throw new RecurrenceError(`invalid untilDate: ${spec.untilDate}`);
  }

  const until = spec.untilDate != null && spec.untilDate !== '' ? spec.untilDate : null;
  const out: ExpandedOccurrence[] = [];
  // Monthly can SKIP a step (no 31st in February), so the loop is bounded by a
  // step budget rather than by `count` alone; without the budget a "31st monthly"
  // series would spin looking for months that mostly do not have one.
  const maxSteps = count * 12 + 24;

  for (let step = 0; step < maxSteps && out.length < count; step += 1) {
    const localDate =
      spec.freq === 'monthly'
        ? addMonthsLocal(spec.startDate, step * interval)
        : addDaysLocal(spec.startDate, step * interval * (spec.freq === 'weekly' ? 7 : 1));
    if (localDate == null) continue;
    if (until != null && localDate > until) break;
    const requested: LocalDateTime = `${localDate}T${spec.startTime}`;
    // Shared with rescheduleOccurrence, so the instant/wall-clock pair this row
    // stores cannot disagree with the pair that endpoint stores. `localDate` is
    // deliberately NOT re-derived from the result: it is the recurrence identity
    // — which day of the rule this is — and a DST gap moves the clock, not the
    // day the rule names.
    const resolved = materializeWallClock(requested, spec.timezone);
    out.push({
      index: out.length,
      localDate,
      localStart: resolved.localStart,
      scheduledAt: resolved.utcIso,
      durationMinutes: spec.durationMinutes,
      resolution: resolved.resolution,
    });
  }
  return out;
}

/** Half-open [start, end) overlap on epoch millis. Touching endpoints do NOT overlap. */
export function windowsOverlap(aStartMs: number, aEndMs: number, bStartMs: number, bEndMs: number): boolean {
  return aStartMs < bEndMs && bStartMs < aEndMs;
}
