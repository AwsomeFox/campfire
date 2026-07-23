import { expect, test } from '@playwright/test';
import {
  endSessionDurationMinutes,
  extendSessionDurationMinutes,
  partitionSchedules,
  scheduleEndsAtMs,
  schedulePhase,
} from '@campfire/schema';

/**
 * UI-facing schedule window helpers (issue #818). Pure classification used by
 * SchedulePanel + SessionLog — no browser, no server.
 */
test.describe('schedule window UI helpers (#818)', () => {
  test.describe.configure({ mode: 'serial' });

  test('start/end boundaries match the in-progress window', () => {
    const start = '2026-07-23T18:00:00.000Z';
    const duration = 240;
    const startMs = Date.parse(start);
    const endMs = scheduleEndsAtMs(start, duration);

    expect(schedulePhase(start, duration, startMs - 1)).toBe('upcoming');
    expect(schedulePhase(start, duration, startMs)).toBe('in_progress');
    expect(schedulePhase(start, duration, endMs - 1)).toBe('in_progress');
    expect(schedulePhase(start, duration, endMs)).toBe('past');
  });

  test('DST transition does not change the UTC duration window', () => {
    const original = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // Fall-back night: local clocks repeat an hour; stored duration stays absolute.
      const start = '2026-11-01T05:30:00.000Z';
      expect(scheduleEndsAtMs(start, 180) - Date.parse(start)).toBe(180 * 60_000);
      expect(schedulePhase(start, 180, Date.parse(start) + 179 * 60_000)).toBe('in_progress');
      expect(schedulePhase(start, 180, Date.parse(start) + 180 * 60_000)).toBe('past');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  test('partition keeps overlapping in-progress rows and a separate Next', () => {
    const now = Date.parse('2026-07-23T19:30:00.000Z');
    const { inProgress, upcoming, past } = partitionSchedules(
      [
        { id: 'a', scheduledAt: '2026-07-23T10:00:00.000Z', durationMinutes: 60 },
        { id: 'b', scheduledAt: '2026-07-23T18:00:00.000Z', durationMinutes: 240 },
        { id: 'c', scheduledAt: '2026-07-23T19:00:00.000Z', durationMinutes: 90 },
        { id: 'd', scheduledAt: '2026-07-23T22:00:00.000Z', durationMinutes: 120 },
      ],
      now,
    );
    expect(inProgress.map((s) => s.id)).toEqual(['b', 'c']);
    expect(upcoming.map((s) => s.id)).toEqual(['d']);
    expect(past.map((s) => s.id)).toEqual(['a']);
  });

  test('end/extend helpers stay within durationMinutes validation bounds', () => {
    const start = '2026-07-23T18:00:00.000Z';
    // End-now uses floor elapsed (0 allowed on update) so live cards clear immediately.
    expect(endSessionDurationMinutes(start, Date.parse(start) + 3 * 60_000)).toBe(3);
    expect(endSessionDurationMinutes(start, Date.parse(start) + 45_000)).toBe(0);
    expect(extendSessionDurationMinutes(240, 30)).toBe(270);
    expect(extendSessionDurationMinutes(1440, 30)).toBe(1440);
  });
});
