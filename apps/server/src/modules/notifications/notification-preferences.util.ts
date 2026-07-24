import {
  isCriticalNotificationCategory,
  type NotificationCategory,
  type NotificationDeliveryMode,
  type QuietHours,
} from '@campfire/schema';

/**
 * Pure preference/quiet-hours resolution helpers for issue #789. Kept free of
 * any DB/Nest dependency so the fan-out gating logic can be unit-tested in
 * isolation (see test/unit/notification-preferences.spec.ts).
 */

/** How a single notification should be handled for one recipient. */
export type DeliveryDecision =
  | { action: 'immediate' }
  | { action: 'muted' }
  | { action: 'defer'; reason: 'digest' | 'quiet_hours' };

/** Cached formatters — fan-out may call minuteOfDayInTimezone many times per tick. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterForTimezone(timezone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    });
    formatterCache.set(timezone, fmt);
  }
  return fmt;
}

/**
 * The wall-clock minute-of-day (0..1439) at instant `nowMs` in IANA `timezone`.
 * Falls back to UTC when the timezone is unrecognized so a bad tz never throws
 * on the fan-out hot path.
 */
export function minuteOfDayInTimezone(nowMs: number, timezone: string): number {
  const resolveIn = (tz: string): number => {
    const parts = formatterForTimezone(tz).formatToParts(new Date(nowMs));
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return hour * 60 + minute;
  };
  try {
    return resolveIn(timezone);
  } catch {
    return resolveIn('UTC');
  }
}

/** True when `timezone` is a recognized IANA zone (for client-side validation). */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone.trim()) return false;
  try {
    formatterForTimezone(timezone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `nowMs` falls inside the recipient's quiet-hours window. The window
 * is [startMinute, endMinute) in local time and may wrap past midnight
 * (startMinute > endMinute). A disabled window, or start === end, is never active.
 */
export function isWithinQuietHours(quietHours: QuietHours, nowMs: number): boolean {
  if (!quietHours.enabled) return false;
  const { startMinute, endMinute, timezone } = quietHours;
  if (startMinute === endMinute) return false;
  const now = minuteOfDayInTimezone(nowMs, timezone);
  return startMinute < endMinute
    ? now >= startMinute && now < endMinute // same-day window
    : now >= startMinute || now < endMinute; // wraps midnight
}

/**
 * Decide how to deliver a notification of `category` to one recipient given their
 * stored `mode` (undefined => the default 'immediate') and quiet-hours setting.
 *
 * Critical categories (access/security) ALWAYS deliver immediately, ignoring both
 * the stored mode and quiet hours — a member can never silence them (issue #789).
 */
export function decideDelivery(
  category: NotificationCategory,
  mode: NotificationDeliveryMode | undefined,
  quietHours: QuietHours | null,
  nowMs: number,
): DeliveryDecision {
  if (isCriticalNotificationCategory(category)) return { action: 'immediate' };
  const effective = mode ?? 'immediate';
  if (effective === 'muted') return { action: 'muted' };
  if (effective === 'digest') return { action: 'defer', reason: 'digest' };
  // immediate: hold if we're inside quiet hours, otherwise deliver now.
  if (quietHours && isWithinQuietHours(quietHours, nowMs)) {
    return { action: 'defer', reason: 'quiet_hours' };
  }
  return { action: 'immediate' };
}
