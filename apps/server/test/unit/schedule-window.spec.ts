import {
  endSessionDurationMinutes,
  extendSessionDurationMinutes,
  isScheduleInProgress,
  isScheduleNotEnded,
  partitionSchedules,
  scheduleEndsAtMs,
  schedulePhase,
} from '@campfire/schema';

describe('schedule window helpers (issue #818)', () => {
  const start = '2026-07-23T18:00:00.000Z';
  const duration = 240; // 4h → ends 22:00Z
  const endMs = Date.parse('2026-07-23T22:00:00.000Z');

  it('computes end as scheduledAt + durationMinutes in UTC millis', () => {
    expect(scheduleEndsAtMs(start, duration)).toBe(endMs);
  });

  it('classifies boundaries: upcoming before start, in_progress at start, past at end', () => {
    const startMs = Date.parse(start);
    expect(schedulePhase(start, duration, startMs - 1)).toBe('upcoming');
    expect(schedulePhase(start, duration, startMs)).toBe('in_progress');
    expect(schedulePhase(start, duration, endMs - 1)).toBe('in_progress');
    expect(schedulePhase(start, duration, endMs)).toBe('past');
    expect(isScheduleInProgress(start, duration, startMs)).toBe(true);
    expect(isScheduleNotEnded(start, duration, endMs - 1)).toBe(true);
    expect(isScheduleNotEnded(start, duration, endMs)).toBe(false);
  });

  it('keeps absolute duration across a US daylight-saving spring-forward', () => {
    // Local wall clocks spring forward, but the stored ISO UTC window is unchanged.
    const prevTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const dstStart = '2026-03-08T06:30:00.000Z'; // 01:30 EST → spans the 02:00 gap
      const ms = scheduleEndsAtMs(dstStart, 180);
      expect(ms - Date.parse(dstStart)).toBe(180 * 60_000);
      expect(schedulePhase(dstStart, 180, Date.parse(dstStart) + 90 * 60_000)).toBe('in_progress');
      expect(schedulePhase(dstStart, 180, Date.parse(dstStart) + 180 * 60_000)).toBe('past');
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });

  it('partitions same-day, overlapping, and past schedules', () => {
    const now = Date.parse('2026-07-23T19:00:00.000Z');
    const rows = [
      { id: 1, scheduledAt: '2026-07-23T14:00:00.000Z', durationMinutes: 60 }, // ended 15:00
      { id: 2, scheduledAt: '2026-07-23T18:00:00.000Z', durationMinutes: 240 }, // in progress
      { id: 3, scheduledAt: '2026-07-23T18:30:00.000Z', durationMinutes: 120 }, // overlapping in progress
      { id: 4, scheduledAt: '2026-07-23T23:00:00.000Z', durationMinutes: 120 }, // upcoming later tonight
      { id: 5, scheduledAt: '2026-07-24T18:00:00.000Z', durationMinutes: 240 }, // tomorrow
    ];
    const { inProgress, upcoming, past } = partitionSchedules(rows, now);
    expect(inProgress.map((r) => r.id)).toEqual([2, 3]);
    expect(upcoming.map((r) => r.id)).toEqual([4, 5]);
    expect(past.map((r) => r.id)).toEqual([1]); // most recent first
  });

  it('clamps end/extend duration helpers to schema bounds', () => {
    // Ending early must clear in-progress (floor, not create-time min of 15).
    expect(endSessionDurationMinutes(start, Date.parse(start) + 5 * 60_000)).toBe(5);
    expect(endSessionDurationMinutes(start, Date.parse(start) + 30_000)).toBe(0);
    expect(endSessionDurationMinutes(start, Date.parse(start) + 90 * 60_000)).toBe(90);
    expect(schedulePhase(start, endSessionDurationMinutes(start, Date.parse(start) + 5 * 60_000), Date.parse(start) + 5 * 60_000)).toBe('past');
    expect(extendSessionDurationMinutes(240, 30)).toBe(270);
    expect(extendSessionDurationMinutes(1430, 30)).toBe(1440);
  });
});
