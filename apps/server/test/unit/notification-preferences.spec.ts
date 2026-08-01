import {
  CRITICAL_NOTIFICATION_CATEGORIES,
  defaultNotificationMode,
  isCriticalNotificationCategory,
  NOTIFICATION_CATEGORIES,
  notificationCategory,
  type NotificationType,
  type QuietHours,
} from '@campfire/schema';
import {
  decideDelivery,
  isWithinQuietHours,
  minuteOfDayInTimezone,
} from '../../src/modules/notifications/notification-preferences.util';

/**
 * Issue #789 — pure fan-out gating helpers: category mapping, quiet-hours math
 * (including DST/timezone + midnight wrap), and the per-recipient delivery
 * decision (immediate / digest / muted / quiet-hours defer), with the critical
 * always-on override.
 */
describe('notification category mapping (issue #789)', () => {
  it('maps every NotificationType to a known category', () => {
    const types: NotificationType[] = [
      'recap_posted', 'recap_share_enabled', 'recap_share_extended',
      'note_reply', 'note_shared', 'comment_reply',
      'added_to_campaign', 'character_reassigned',
      'session_scheduled', 'session_rsvp', 'session_reminder', 'rsvp_nudge',
      'quest_updated', 'proposal_submitted', 'proposal_resolved',
      'inbox_submitted', 'ai_dm_alert',
      'encounter_started', 'encounter_ended', 'encounter_turn', 'character_downed',
      // #599 — the table safety hold. Critical/always-on: a safety stop must not be mutable by
      // a notification preference or deferrable into a digest.
      'safety_hold',
    ];
    for (const type of types) {
      expect(NOTIFICATION_CATEGORIES).toContain(notificationCategory(type));
    }
  });

  it('groups access/security as the critical always-on categories', () => {
    expect(notificationCategory('added_to_campaign')).toBe('access');
    expect(notificationCategory('character_reassigned')).toBe('access');
    expect(notificationCategory('ai_dm_alert')).toBe('security');
    expect(notificationCategory('safety_hold')).toBe('security');
    expect(isCriticalNotificationCategory('access')).toBe(true);
    expect(isCriticalNotificationCategory('security')).toBe(true);
    expect(CRITICAL_NOTIFICATION_CATEGORIES).toEqual(['access', 'security']);
    expect(isCriticalNotificationCategory('schedule')).toBe(false);
  });

  it('places session reminders and RSVP nudges in the schedule category', () => {
    expect(notificationCategory('session_reminder')).toBe('schedule');
    expect(notificationCategory('rsvp_nudge')).toBe('schedule');
  });

  it('defaults every category to immediate', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(defaultNotificationMode(category)).toBe('immediate');
    }
  });
});

describe('quiet-hours math (issue #789)', () => {
  const qh = (over: Partial<QuietHours>): QuietHours => ({
    enabled: true,
    startMinute: 1320, // 22:00
    endMinute: 420, // 07:00
    timezone: 'UTC',
    ...over,
  });

  it('reads the wall-clock minute-of-day in the given timezone', () => {
    const midnightUtc = Date.parse('2026-01-15T00:30:00.000Z');
    expect(minuteOfDayInTimezone(midnightUtc, 'UTC')).toBe(30);
    // New York is UTC-5 in January -> 19:30 the previous day = 1170.
    expect(minuteOfDayInTimezone(midnightUtc, 'America/New_York')).toBe(19 * 60 + 30);
  });

  it('falls back to UTC for an unknown timezone instead of throwing', () => {
    const t = Date.parse('2026-01-15T08:00:00.000Z');
    expect(minuteOfDayInTimezone(t, 'Not/AZone')).toBe(minuteOfDayInTimezone(t, 'UTC'));
  });

  it('treats a disabled window as never active', () => {
    expect(isWithinQuietHours(qh({ enabled: false }), Date.parse('2026-01-15T23:00:00.000Z'))).toBe(false);
  });

  it('handles a window that wraps past midnight (22:00 -> 07:00 UTC)', () => {
    expect(isWithinQuietHours(qh({}), Date.parse('2026-01-15T23:00:00.000Z'))).toBe(true); // late night
    expect(isWithinQuietHours(qh({}), Date.parse('2026-01-15T05:00:00.000Z'))).toBe(true); // early morning
    expect(isWithinQuietHours(qh({}), Date.parse('2026-01-15T12:00:00.000Z'))).toBe(false); // midday
  });

  it('handles a same-day window (09:00 -> 17:00 UTC)', () => {
    const day = qh({ startMinute: 540, endMinute: 1020 });
    expect(isWithinQuietHours(day, Date.parse('2026-01-15T10:00:00.000Z'))).toBe(true);
    expect(isWithinQuietHours(day, Date.parse('2026-01-15T18:00:00.000Z'))).toBe(false);
    // end is exclusive
    expect(isWithinQuietHours(day, Date.parse('2026-01-15T17:00:00.000Z'))).toBe(false);
  });

  it('respects the timezone (23:00 local is quiet even when UTC is midday)', () => {
    // 22:00->07:00 in Tokyo (UTC+9). 13:00 UTC == 22:00 JST -> quiet.
    const tokyo = qh({ timezone: 'Asia/Tokyo' });
    expect(isWithinQuietHours(tokyo, Date.parse('2026-01-15T13:00:00.000Z'))).toBe(true);
    expect(isWithinQuietHours(tokyo, Date.parse('2026-01-15T03:00:00.000Z'))).toBe(false); // 12:00 JST
  });

  it('never activates when start === end', () => {
    expect(isWithinQuietHours(qh({ startMinute: 600, endMinute: 600 }), Date.parse('2026-01-15T10:00:00.000Z'))).toBe(false);
  });
});

describe('delivery decision (issue #789)', () => {
  const noon = Date.parse('2026-01-15T12:00:00.000Z');
  const night = Date.parse('2026-01-15T23:00:00.000Z');
  const quiet: QuietHours = { enabled: true, startMinute: 1320, endMinute: 420, timezone: 'UTC' };

  it('always delivers critical categories immediately, ignoring mode and quiet hours', () => {
    expect(decideDelivery('access', 'muted', quiet, night)).toEqual({ action: 'immediate' });
    expect(decideDelivery('security', 'digest', quiet, night)).toEqual({ action: 'immediate' });
  });

  it('mutes a muted category', () => {
    expect(decideDelivery('recaps', 'muted', null, noon)).toEqual({ action: 'muted' });
  });

  it('defers a digest category as a digest', () => {
    expect(decideDelivery('recaps', 'digest', null, noon)).toEqual({ action: 'defer', reason: 'digest' });
  });

  it('delivers immediate outside quiet hours, defers it inside', () => {
    expect(decideDelivery('schedule', 'immediate', quiet, noon)).toEqual({ action: 'immediate' });
    expect(decideDelivery('schedule', 'immediate', quiet, night)).toEqual({ action: 'defer', reason: 'quiet_hours' });
  });

  it('treats an undefined mode as the immediate default', () => {
    expect(decideDelivery('quests', undefined, null, noon)).toEqual({ action: 'immediate' });
  });
});
