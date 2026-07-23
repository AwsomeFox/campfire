/**
 * Client helpers for schedule lifecycle notifications (issue #820).
 *
 * Structured `notification.data` carries the UTC instant; the bell renders
 * viewer-local copy. Cancelled nights are hard-deleted, so clicking a cancel
 * ping stashes the snapshot and opens a stable cancelled-event detail on the
 * Schedule tab.
 */
import type { ScheduleNotificationData } from '@campfire/schema';
import {
  formatScheduleNotificationBody,
  formatScheduleNotificationTitle,
  parseScheduleNotificationData,
  scheduleNotificationLabel,
  formatScheduleNotificationInstant,
} from '@campfire/schema';
import { activeLocale } from './format';

const CANCELLED_STORAGE_PREFIX = 'campfire.cancelledSchedule.';

/** In-memory fallback when sessionStorage is unavailable (Node unit tests / blocked storage). */
const cancelledDetailMemory = new Map<string, string>();

function cancelledStorageKey(scheduleId: number): string {
  return `${CANCELLED_STORAGE_PREFIX}${scheduleId}`;
}

function writeCancelledStorage(key: string, value: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, value);
      return;
    }
  } catch {
    /* fall through to memory */
  }
  cancelledDetailMemory.set(key, value);
}

function readCancelledStorage(key: string): string | null {
  try {
    if (typeof sessionStorage !== 'undefined') {
      return sessionStorage.getItem(key);
    }
  } catch {
    /* fall through to memory */
  }
  return cancelledDetailMemory.get(key) ?? null;
}

function removeCancelledStorage(key: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
  cancelledDetailMemory.delete(key);
}

export function scheduleNotificationDisplayTitle(
  data: ScheduleNotificationData,
  locale: string | undefined = activeLocale(),
  timeZone?: string,
): string {
  return formatScheduleNotificationTitle(data, locale, timeZone);
}

export function scheduleNotificationDisplayBody(
  data: ScheduleNotificationData,
  locale: string | undefined = activeLocale(),
  timeZone?: string,
): string {
  return formatScheduleNotificationBody(data, locale, timeZone);
}

/** Persist a cancelled-night snapshot for the Schedule tab detail card. */
export function rememberCancelledScheduleDetail(data: ScheduleNotificationData): void {
  writeCancelledStorage(cancelledStorageKey(data.scheduleId), JSON.stringify(data));
}

/** Read a previously stashed cancelled-night snapshot (or null). */
export function readCancelledScheduleDetail(scheduleId: number): ScheduleNotificationData | null {
  return parseScheduleNotificationData(readCancelledStorage(cancelledStorageKey(scheduleId)));
}

export function clearCancelledScheduleDetail(scheduleId: number): void {
  removeCancelledStorage(cancelledStorageKey(scheduleId));
}

/** Stable Schedule-tab URL for a cancelled game night (issue #820). */
export function cancelledScheduleDetailHref(campaignId: number, scheduleId: number): string {
  return `/c/${campaignId}/sessions?tab=schedule&cancelled=${scheduleId}#cancelled-schedule-${scheduleId}`;
}

export function cancelledScheduleDetailCopy(
  data: ScheduleNotificationData | null,
  locale: string | undefined = activeLocale(),
  timeZone?: string,
): { heading: string; when: string; body: string } {
  if (!data) {
    return {
      heading: 'Game night cancelled',
      when: '',
      body: 'This game night was removed from the calendar.',
    };
  }
  const label = scheduleNotificationLabel(data.label);
  return {
    heading: `${label} was cancelled`,
    when: formatScheduleNotificationInstant(data.scheduledAt, locale, timeZone),
    body: 'This game night was removed from the calendar.',
  };
}
