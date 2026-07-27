import {
  MAX_SERIES_OCCURRENCES,
  addDaysLocal,
  addMonthsLocal,
  expandRecurrence,
  isLocalDate,
  isLocalDateTime,
  isLocalTime,
  isValidIanaTimeZone,
  utcToLocalDateTime,
  wallClockToUtc,
  windowsOverlap,
  zoneOffsetMsAt,
} from '@campfire/schema';

/**
 * Issue #588 — wall-clock and recurrence math.
 *
 * The whole reason a series stores an IANA zone plus a LOCAL start time (instead
 * of one instant plus a fixed stride) is DST, so that is what this spec is
 * mostly about: a weekly 19:00 table must still start at 19:00 local on the
 * other side of every transition, in both hemispheres, including a zone whose
 * DST step is not a whole hour.
 *
 * Pure functions only — no DB, no Nest.
 */
describe('IANA wall-clock resolution (#588)', () => {
  it('validates local date/time shapes', () => {
    expect(isLocalDate('2026-03-08')).toBe(true);
    expect(isLocalDate('2026-02-30')).toBe(false); // real calendar, not just a regex
    expect(isLocalDate('2026-3-8')).toBe(false);
    expect(isLocalTime('19:00')).toBe(true);
    expect(isLocalTime('24:00')).toBe(false);
    expect(isLocalTime('7pm')).toBe(false);
    expect(isLocalDateTime('2026-03-08T19:00')).toBe(true);
    expect(isLocalDateTime('2026-03-08 19:00')).toBe(false);
  });

  it('recognizes real zones and rejects invented ones', () => {
    expect(isValidIanaTimeZone('America/New_York')).toBe(true);
    expect(isValidIanaTimeZone('UTC')).toBe(true);
    expect(isValidIanaTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidIanaTimeZone('   ')).toBe(false);
  });

  it('reports the zone offset at an instant, including sub-hour zones', () => {
    // Kathmandu is UTC+05:45 year-round — a whole-hour assumption fails here.
    expect(zoneOffsetMsAt('Asia/Kathmandu', Date.parse('2026-01-01T00:00:00Z'))).toBe(5 * 3_600_000 + 45 * 60_000);
    expect(zoneOffsetMsAt('America/New_York', Date.parse('2026-01-15T12:00:00Z'))).toBe(-5 * 3_600_000);
    expect(zoneOffsetMsAt('America/New_York', Date.parse('2026-07-15T12:00:00Z'))).toBe(-4 * 3_600_000);
  });

  it('round-trips an unambiguous wall clock', () => {
    const resolved = wallClockToUtc('2026-06-02T19:00', 'America/New_York');
    expect(resolved.resolution).toBe('exact');
    expect(resolved.utcIso).toBe('2026-06-02T23:00:00.000Z');
    expect(utcToLocalDateTime(resolved.utcIso, 'America/New_York')).toBe('2026-06-02T19:00');
  });

  it('shifts a wall clock that falls in a spring-forward GAP to just past the transition', () => {
    // 2026-03-08, US: 02:00 EST jumps straight to 03:00 EDT, so 02:30 never happens.
    const resolved = wallClockToUtc('2026-03-08T02:30', 'America/New_York');
    expect(resolved.resolution).toBe('gap');
    // 07:30Z is 03:30 EDT — the same offset from the start of the day as requested.
    expect(resolved.utcIso).toBe('2026-03-08T07:30:00.000Z');
    expect(utcToLocalDateTime(resolved.utcIso, 'America/New_York')).toBe('2026-03-08T03:30');
  });

  it('resolves an AMBIGUOUS fall-back wall clock to the earlier (still-DST) instant', () => {
    // 2026-11-01, US: 01:30 happens twice. The night starts at the FIRST one.
    const resolved = wallClockToUtc('2026-11-01T01:30', 'America/New_York');
    expect(resolved.resolution).toBe('ambiguous');
    expect(resolved.utcIso).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT, not 06:30Z/EST
    expect(utcToLocalDateTime(resolved.utcIso, 'America/New_York')).toBe('2026-11-01T01:30');
  });

  /**
   * UTC has no transitions at all, so every wall clock must resolve 'exact' and
   * be its own instant. Worth pinning explicitly: 'UTC' is the DEFAULT zone on
   * play_venues/session_series, so it is the code path most installs take, and a
   * bracket that mis-detected ambiguity here would mis-schedule everyone.
   */
  it('treats UTC itself as transition-free', () => {
    for (const local of ['2026-03-08T02:30', '2026-11-01T01:30', '1970-01-01T00:00']) {
      const resolved = wallClockToUtc(local, 'UTC');
      expect({ local, ...resolved }).toEqual({ local, utcMs: Date.parse(`${local}:00.000Z`), utcIso: `${local}:00.000Z`, resolution: 'exact' });
    }
  });

  /**
   * The offset is read from the runtime's tz database at the TARGET instant, not
   * from today's rules, so a zone that changed its rules historically resolves by
   * the rules in force then. Europe/Moscow ran DST until 2011 and abolished it
   * that year; a naive "does this zone observe DST?" test gets both of these wrong.
   */
  it('honours the rules in force at the target instant, not today\'s rules', () => {
    // 2011-03-27: the last spring-forward Moscow ever had (+3 -> +4).
    const gap = wallClockToUtc('2011-03-27T02:30', 'Europe/Moscow');
    expect(gap.resolution).toBe('gap');
    expect(utcToLocalDateTime(gap.utcIso, 'Europe/Moscow')).toBe('2011-03-27T03:30');

    // 2014-10-26: the one-off step back to +3 when permanent DST was repealed.
    const ambiguous = wallClockToUtc('2014-10-26T01:30', 'Europe/Moscow');
    expect(ambiguous.resolution).toBe('ambiguous');
    expect(utcToLocalDateTime(ambiguous.utcIso, 'Europe/Moscow')).toBe('2014-10-26T01:30');

    // 2016: no DST any more, so a summer wall clock is plain +3 and unambiguous.
    const flat = wallClockToUtc('2016-07-15T19:00', 'Europe/Moscow');
    expect(flat.resolution).toBe('exact');
    expect(flat.utcIso).toBe('2016-07-15T16:00:00.000Z');
  });

  /**
   * Chatham runs +12:45/+13:45 — a non-hour offset whose transitions land on :45
   * rather than on the hour. Any arithmetic that rounded offsets to whole hours,
   * or assumed a transition happens at :00, resolves these two wrong.
   */
  it('handles a zone with a :45 offset and :45 transitions (Pacific/Chatham)', () => {
    const flat = wallClockToUtc('2026-06-15T19:00', 'Pacific/Chatham');
    expect(flat.resolution).toBe('exact');
    expect(flat.utcIso).toBe('2026-06-15T06:15:00.000Z'); // 19:00 - 12:45

    // Spring forward 2026-09-27: 02:45 -> 03:45 local.
    const gap = wallClockToUtc('2026-09-27T03:00', 'Pacific/Chatham');
    expect(gap.resolution).toBe('gap');
    expect(utcToLocalDateTime(gap.utcIso, 'Pacific/Chatham')).toBe('2026-09-27T04:00');

    // Fall back 2026-04-05: 03:45 -> 02:45 local, so 03:00 happens twice.
    const ambiguous = wallClockToUtc('2026-04-05T03:00', 'Pacific/Chatham');
    expect(ambiguous.resolution).toBe('ambiguous');
    expect(utcToLocalDateTime(ambiguous.utcIso, 'Pacific/Chatham')).toBe('2026-04-05T03:00');
    // "Earlier of the two" means the still-DST (+13:45) reading, not the +12:45 one.
    expect(ambiguous.utcIso).toBe('2026-04-04T13:15:00.000Z');
  });
});

describe('local calendar arithmetic (#588)', () => {
  it('adds days without instant arithmetic, so a 23-hour day does not shift the date', () => {
    expect(addDaysLocal('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDaysLocal('2026-03-01', 7)).toBe('2026-03-08');
    expect(addDaysLocal('2026-12-28', 7)).toBe('2027-01-04');
    expect(addDaysLocal('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });

  it('adds months keeping the day-of-month, and SKIPS months that have no such day', () => {
    expect(addMonthsLocal('2026-01-15', 1)).toBe('2026-02-15');
    expect(addMonthsLocal('2026-01-31', 1)).toBeNull(); // no 31 February — skip, never clamp
    expect(addMonthsLocal('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonthsLocal('2026-11-30', 2)).toBe('2027-01-30');
  });
});

describe('recurrence expansion (#588)', () => {
  const weekly = {
    timezone: 'America/New_York',
    startDate: '2026-02-24',
    startTime: '19:00',
    durationMinutes: 240,
    freq: 'weekly' as const,
    interval: 1,
    count: 4,
  };

  it('keeps a weekly 19:00 table at 19:00 LOCAL across a spring-forward boundary', () => {
    // 2026-03-08 is the US DST start; occurrences 0-1 are EST, 2-3 are EDT.
    const out = expandRecurrence(weekly);
    expect(out.map((o) => o.localStart)).toEqual([
      '2026-02-24T19:00',
      '2026-03-03T19:00',
      '2026-03-10T19:00',
      '2026-03-17T19:00',
    ]);
    // The UTC instant SHIFTS by an hour, which is exactly the point: a fixed
    // 7-day millisecond stride would have kept 00:00Z and moved the local time.
    expect(out.map((o) => o.scheduledAt)).toEqual([
      '2026-02-25T00:00:00.000Z',
      '2026-03-04T00:00:00.000Z',
      '2026-03-10T23:00:00.000Z',
      '2026-03-17T23:00:00.000Z',
    ]);
    for (const occ of out) {
      expect(utcToLocalDateTime(occ.scheduledAt, weekly.timezone)).toBe(occ.localStart);
    }
  });

  it('keeps a weekly table at the same local time across a fall-back boundary (Europe)', () => {
    const out = expandRecurrence({
      timezone: 'Europe/Berlin',
      startDate: '2026-10-20',
      startTime: '19:00',
      durationMinutes: 180,
      freq: 'weekly',
      interval: 1,
      count: 3,
    });
    // EU DST ends 2026-10-25.
    expect(out.map((o) => o.scheduledAt)).toEqual([
      '2026-10-20T17:00:00.000Z', // CEST (+02)
      '2026-10-27T18:00:00.000Z', // CET  (+01)
      '2026-11-03T18:00:00.000Z',
    ]);
    for (const occ of out) expect(occ.localStart.endsWith('T19:00')).toBe(true);
  });

  it('handles a southern-hemisphere zone, where DST runs the other way', () => {
    const out = expandRecurrence({
      timezone: 'Australia/Sydney',
      startDate: '2026-03-30',
      startTime: '19:00',
      durationMinutes: 240,
      freq: 'weekly',
      interval: 1,
      count: 2,
    });
    // Sydney leaves DST on 2026-04-05, so the offset drops +11 -> +10.
    expect(out.map((o) => o.scheduledAt)).toEqual(['2026-03-30T08:00:00.000Z', '2026-04-06T09:00:00.000Z']);
    for (const occ of out) expect(utcToLocalDateTime(occ.scheduledAt, 'Australia/Sydney')).toBe(occ.localStart);
  });

  it('handles a zone whose DST step is 30 minutes (Lord Howe Island)', () => {
    const out = expandRecurrence({
      timezone: 'Australia/Lord_Howe',
      startDate: '2026-03-30',
      startTime: '19:00',
      durationMinutes: 120,
      freq: 'weekly',
      interval: 1,
      count: 2,
    });
    // +11:00 -> +10:30 on 2026-04-05: the instants differ by 7 days AND 30 minutes.
    expect(out[1].scheduledAt).toBe(new Date(Date.parse(out[0].scheduledAt) + 7 * 86_400_000 + 30 * 60_000).toISOString());
    for (const occ of out) expect(utcToLocalDateTime(occ.scheduledAt, 'Australia/Lord_Howe')).toBe(occ.localStart);
  });

  it('flags an occurrence that lands in a DST gap instead of silently dropping it', () => {
    const out = expandRecurrence({
      timezone: 'America/New_York',
      startDate: '2026-03-01',
      startTime: '02:30',
      durationMinutes: 60,
      freq: 'weekly',
      interval: 1,
      count: 3,
    });
    expect(out.map((o) => o.resolution)).toEqual(['exact', 'gap', 'exact']);
    // The gap occurrence still exists — the table still meets that night.
    expect(out[1].localDate).toBe('2026-03-08');
    expect(out[1].scheduledAt).toBe('2026-03-08T07:30:00.000Z');
  });

  it('supports biweekly (interval 2) and daily frequencies', () => {
    expect(
      expandRecurrence({ ...weekly, interval: 2, count: 3 }).map((o) => o.localDate),
    ).toEqual(['2026-02-24', '2026-03-10', '2026-03-24']);
    expect(
      expandRecurrence({ ...weekly, freq: 'daily', interval: 1, count: 3 }).map((o) => o.localDate),
    ).toEqual(['2026-02-24', '2026-02-25', '2026-02-26']);
  });

  it('skips months with no matching day-of-month when expanding monthly', () => {
    const out = expandRecurrence({
      timezone: 'UTC',
      startDate: '2026-01-31',
      startTime: '19:00',
      durationMinutes: 240,
      freq: 'monthly',
      interval: 1,
      count: 3,
    });
    // February is skipped rather than clamped to the 28th.
    expect(out.map((o) => o.localDate)).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
  });

  it('truncates at untilDate', () => {
    const out = expandRecurrence({ ...weekly, count: 10, untilDate: '2026-03-10' });
    expect(out.map((o) => o.localDate)).toEqual(['2026-02-24', '2026-03-03', '2026-03-10']);
  });

  it('rejects invalid specs rather than producing nonsense occurrences', () => {
    expect(() => expandRecurrence({ ...weekly, startDate: '2026-02-30' })).toThrow(/startDate/);
    expect(() => expandRecurrence({ ...weekly, startTime: '25:00' })).toThrow(/startTime/);
    expect(() => expandRecurrence({ ...weekly, timezone: 'Nowhere/Fake' })).toThrow(/time zone/);
    expect(() => expandRecurrence({ ...weekly, interval: 0 })).toThrow(/interval/);
    expect(() => expandRecurrence({ ...weekly, count: 0 })).toThrow(/count/);
    expect(() => expandRecurrence({ ...weekly, count: MAX_SERIES_OCCURRENCES + 1 })).toThrow(/count/);
  });

  it('assigns stable 0-based indexes — the recurrence identity a UID hangs off', () => {
    expect(expandRecurrence(weekly).map((o) => o.index)).toEqual([0, 1, 2, 3]);
  });
});

describe('window overlap (#588)', () => {
  it('is half-open: back-to-back slots do not conflict', () => {
    expect(windowsOverlap(0, 100, 100, 200)).toBe(false);
    expect(windowsOverlap(100, 200, 0, 100)).toBe(false);
    expect(windowsOverlap(0, 101, 100, 200)).toBe(true);
    expect(windowsOverlap(50, 60, 0, 200)).toBe(true);
  });
});
