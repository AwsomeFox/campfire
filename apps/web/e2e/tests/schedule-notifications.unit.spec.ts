/**
 * Client schedule-notification copy + cancelled-detail routing (issue #820).
 */
import { expect, test } from '@playwright/test';
import type { ScheduleNotificationData } from '@campfire/schema';
import {
  cancelledScheduleDetailCopy,
  cancelledScheduleDetailHref,
  clearCancelledScheduleDetail,
  readCancelledScheduleDetail,
  rememberCancelledScheduleDetail,
  scheduleNotificationDisplayTitle,
} from '../../src/lib/scheduleNotificationCopy';

const snapshot: ScheduleNotificationData = {
  kind: 'schedule',
  scheduleId: 42,
  scheduledAt: '2026-07-22T00:00:00.000Z',
  durationMinutes: 240,
  changeType: 'cancelled',
  changedFields: [],
  label: 'Underdark heist',
};

test.describe('schedule notification client helpers (issue #820)', () => {
  test('localizes titles with an explicit timezone (Eastern evening ≠ next UTC day)', () => {
    const title = scheduleNotificationDisplayTitle(
      { ...snapshot, changeType: 'created' },
      'en-US',
      'America/New_York',
    );
    expect(title).toMatch(/Underdark heist scheduled for/);
    expect(title).toMatch(/Jul\s*21,\s*2026/);
    expect(title).not.toMatch(/Jul\s*22/);
  });

  test('cancelled detail href is stable and sessionStorage round-trips the snapshot', () => {
    expect(cancelledScheduleDetailHref(7, 42)).toBe(
      '/c/7/sessions?tab=schedule&cancelled=42#cancelled-schedule-42',
    );
    rememberCancelledScheduleDetail(snapshot);
    expect(readCancelledScheduleDetail(42)).toEqual(snapshot);
    const copy = cancelledScheduleDetailCopy(snapshot, 'en-US', 'America/New_York');
    expect(copy.heading).toBe('Underdark heist was cancelled');
    expect(copy.when).toMatch(/Jul\s*21,\s*2026/);
    clearCancelledScheduleDetail(42);
    expect(readCancelledScheduleDetail(42)).toBeNull();
  });

  test('missing snapshot still yields a generic cancelled detail', () => {
    const copy = cancelledScheduleDetailCopy(null);
    expect(copy.heading).toBe('Game night cancelled');
    expect(copy.body).toMatch(/removed from the calendar/i);
  });
});
