/**
 * Time format preference utilities (issue #634).
 */
import { expect, test } from '@playwright/test';
import {
  appliesTime,
  formatScheduleNotificationInstant,
  withTimeFormat,
} from '@campfire/schema';
import { createLocaleFormatters, setTimeFormatPreference } from '../../src/lib/format';

const LOCALE = 'en-US';
const TZ = 'America/New_York';

test.describe('time format preference (issue #634)', () => {
  test('withTimeFormat pins hour cycle only when a time component is present', () => {
    expect(withTimeFormat({ dateStyle: 'short' }, '24h')).toEqual({ dateStyle: 'short' });
    expect(withTimeFormat({ hour: 'numeric', minute: '2-digit' }, '24h')).toEqual({
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    });
    expect(withTimeFormat({ timeStyle: 'short' }, '12h')).toEqual({ timeStyle: 'short', hour12: true });
    expect(appliesTime({ dateStyle: 'short' })).toBe(false);
    expect(appliesTime({ hour: 'numeric' })).toBe(true);
  });

  test('date-only strings keep calendar-day semantics regardless of time format', () => {
    setTimeFormatPreference('24h');
    const format = createLocaleFormatters(() => LOCALE);
    expect(format.formatDate('2026-07-21', { dateStyle: 'short' })).toBe(
      new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short' }).format(new Date(2026, 6, 21)),
    );
  });

  test('noon and midnight render in 12-hour mode with AM/PM', () => {
    setTimeFormatPreference('12h');
    const format = createLocaleFormatters(() => LOCALE);

    const noonUtc = new Date('2026-01-15T17:00:00.000Z'); // noon Eastern (EST)
    const midnightUtc = new Date('2026-01-16T05:00:00.000Z'); // midnight Eastern

    expect(
      format.formatDateTime(noonUtc, {
        timeZone: TZ,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }),
    ).toMatch(/12:00\s*PM/);

    expect(
      format.formatDateTime(midnightUtc, {
        timeZone: TZ,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }),
    ).toMatch(/12:00\s*AM/);
  });

  test('omitted options still honor the active time format preference', () => {
    const instant = new Date('2026-01-15T17:00:00.000Z'); // noon Eastern (EST)
    const format = createLocaleFormatters(() => LOCALE);

    setTimeFormatPreference('12h');
    expect(format.formatDateTime(instant)).toMatch(/12:00:00\s*PM/);
    expect(format.formatTime(instant)).toMatch(/12:00:00\s*PM/);

    setTimeFormatPreference('24h');
    expect(format.formatDateTime(instant)).toMatch(/12:00:00/);
    expect(format.formatDateTime(instant)).not.toMatch(/PM|AM/);
    expect(format.formatTime(instant)).toMatch(/12:00:00/);
    expect(format.formatTime(instant)).not.toMatch(/PM|AM/);
  });

  test('noon and midnight render in 24-hour mode without AM/PM', () => {
    setTimeFormatPreference('24h');
    const format = createLocaleFormatters(() => LOCALE);

    const noonUtc = new Date('2026-01-15T17:00:00.000Z');
    const midnightUtc = new Date('2026-01-16T05:00:00.000Z');

    const noon = format.formatDateTime(noonUtc, {
      timeZone: TZ,
      hour: 'numeric',
      minute: '2-digit',
    });
    const midnight = format.formatDateTime(midnightUtc, {
      timeZone: TZ,
      hour: 'numeric',
      minute: '2-digit',
    });

    expect(noon).toMatch(/12:00/);
    expect(noon).not.toMatch(/PM|AM/);
    expect(midnight).toMatch(/00:00/);
    expect(midnight).not.toMatch(/PM|AM/);
  });

  test('DST spring-forward evening stays on the local calendar day', () => {
    setTimeFormatPreference('24h');
    const format = createLocaleFormatters(() => LOCALE);
    // 2026-03-08 20:00 Eastern — evening after US DST begins
    const instant = '2026-03-09T00:00:00.000Z';
    const rendered = format.formatDateTime(instant, {
      timeZone: TZ,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    expect(rendered).toMatch(/Mar\s*8/);
    expect(rendered).toMatch(/20:00/);
  });

  test('schedule notification instant honors 24-hour preference', () => {
    const instant = '2026-07-22T00:00:00.000Z';
    const twelve = formatScheduleNotificationInstant(instant, LOCALE, TZ, '12h');
    const twentyFour = formatScheduleNotificationInstant(instant, LOCALE, TZ, '24h');

    expect(twelve).toMatch(/8:00\s*PM/);
    expect(twentyFour).toMatch(/20:00/);
    expect(twentyFour).not.toMatch(/PM|AM/);
  });
});
