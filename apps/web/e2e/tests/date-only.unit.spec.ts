import { expect, test } from '@playwright/test';
import { localDateInputValue, millisecondsUntilNextLocalDate } from '../../src/lib/dateOnly';

const originalTimezone = process.env.TZ;

test.afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

test.describe('local date-only helpers', () => {
  test.describe.configure({ mode: 'serial' });

  test('uses local calendar components at UTC-12 and UTC+14 without adding a timezone', () => {
    const instant = '2026-07-22T10:30:00.000Z';

    process.env.TZ = 'Etc/GMT+12';
    expect(localDateInputValue(new Date(instant))).toBe('2026-07-21');

    process.env.TZ = 'Pacific/Kiritimati';
    expect(localDateInputValue(new Date(instant))).toBe('2026-07-23');
    expect(localDateInputValue(new Date(instant))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('computes the next local day across both daylight-saving transitions', () => {
    process.env.TZ = 'America/New_York';

    // 00:30 before the spring-forward gap: only 22.5 real hours remain in the day.
    expect(millisecondsUntilNextLocalDate(new Date('2026-03-08T05:30:00.000Z'))).toBe(22.5 * 60 * 60 * 1_000);
    // 00:30 before the fall-back repeat: 24.5 real hours remain in the day.
    expect(millisecondsUntilNextLocalDate(new Date('2026-11-01T04:30:00.000Z'))).toBe(24.5 * 60 * 60 * 1_000);
  });
});
