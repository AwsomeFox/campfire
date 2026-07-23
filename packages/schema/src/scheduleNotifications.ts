/**
 * Schedule notification metadata + locale-aware copy (issue #820).
 *
 * Servers store structured fields (schedule id, UTC instant, duration, change
 * type, changed field names) instead of baking a UTC calendar date into the
 * title. Clients (and tests) render the instant in the viewer's locale with an
 * explicit short timezone so Eastern 8 PM game nights are not announced as the
 * next UTC day.
 */

import { z } from 'zod';

export const ScheduleNotificationChangeType = z.enum([
  'created',
  'rescheduled',
  'updated',
  'cancelled',
]);
export type ScheduleNotificationChangeType = z.infer<typeof ScheduleNotificationChangeType>;

/** Party-visible schedule facets that may trigger a follow-up ping. */
export const ScheduleNotificationChangedField = z.enum([
  'time',
  'duration',
  'venue',
  'notes',
]);
export type ScheduleNotificationChangedField = z.infer<typeof ScheduleNotificationChangedField>;

export const ScheduleNotificationData = z.object({
  kind: z.literal('schedule'),
  scheduleId: z.number().int().positive(),
  /** Canonical ISO UTC start instant. */
  scheduledAt: z.string().min(1).max(40),
  durationMinutes: z.number().int().min(0).max(24 * 60),
  changeType: ScheduleNotificationChangeType,
  /** Field names only — never venue URLs or note bodies (invite links stay private). */
  changedFields: z.array(ScheduleNotificationChangedField).default([]),
  /** Display label (trimmed title), empty when the night was untitled. */
  label: z.string().max(200).default(''),
});
export type ScheduleNotificationData = z.infer<typeof ScheduleNotificationData>;

export type ScheduleComparable = {
  scheduledAt: string;
  durationMinutes: number;
  location: string;
  notes: string;
};

/** Diff party-visible schedule facets. Title-only edits are intentionally ignored. */
export function diffScheduleNotificationFields(
  before: ScheduleComparable,
  after: ScheduleComparable,
): ScheduleNotificationChangedField[] {
  const changed: ScheduleNotificationChangedField[] = [];
  if (before.scheduledAt !== after.scheduledAt) changed.push('time');
  if (before.durationMinutes !== after.durationMinutes) changed.push('duration');
  if (before.location !== after.location) changed.push('venue');
  if (before.notes !== after.notes) changed.push('notes');
  return changed;
}

/** True when an update should ping the party (lifecycle-meaningful, not title-only). */
export function shouldNotifyScheduleUpdate(changedFields: readonly ScheduleNotificationChangedField[]): boolean {
  return changedFields.length > 0;
}

export function scheduleNotificationChangeType(
  changedFields: readonly ScheduleNotificationChangedField[],
): Exclude<ScheduleNotificationChangeType, 'created' | 'cancelled'> {
  return changedFields.includes('time') ? 'rescheduled' : 'updated';
}

/** Fallback English label when the scheduled night has no title. */
export function scheduleNotificationLabel(title: string | null | undefined): string {
  const trimmed = (title ?? '').trim();
  return trimmed || 'the next session';
}

/**
 * Locale-aware start instant with an explicit short timezone name.
 * Pass `timeZone` (IANA) to pin a viewer zone in tests / cross-timezone tables.
 */
export function formatScheduleNotificationInstant(
  scheduledAt: string,
  locale?: string,
  timeZone?: string,
): string {
  const d = new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) return 'an unknown time';
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  if (timeZone) options.timeZone = timeZone;
  try {
    return d.toLocaleString(locale, options);
  } catch {
    // Invalid locale/timeZone — fall back to environment defaults.
    return d.toLocaleString(undefined, { ...options, timeZone: undefined });
  }
}

const FIELD_SUMMARY: Record<ScheduleNotificationChangedField, string> = {
  time: 'time',
  duration: 'duration',
  venue: 'venue',
  notes: 'notes',
};

/** Oxford-ish join of changed field names for body copy (no private values). */
export function summarizeScheduleChangedFields(
  fields: readonly ScheduleNotificationChangedField[],
): string {
  const labels = fields.map((f) => FIELD_SUMMARY[f]);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** Clamp to Notification.title max (200) without mid-word care — ellipsis if needed. */
function clampNotificationTitle(title: string): string {
  return title.length <= 200 ? title : `${title.slice(0, 199)}…`;
}

/** Server-stored fallback title — no UTC date slice; clients re-render from `data`. */
export function scheduleNotificationFallbackTitle(data: ScheduleNotificationData): string {
  const label = scheduleNotificationLabel(data.label);
  let title: string;
  switch (data.changeType) {
    case 'created':
      title = `${label} was scheduled`;
      break;
    case 'rescheduled':
      title = `${label} was rescheduled`;
      break;
    case 'updated':
      title = `${label} was updated`;
      break;
    case 'cancelled':
      title = `${label} was cancelled`;
      break;
    default:
      title = `${label} schedule update`;
      break;
  }
  return clampNotificationTitle(title);
}

/** Server-stored fallback body — field names / when placeholder, never note/venue values. */
export function scheduleNotificationFallbackBody(data: ScheduleNotificationData): string {
  const when = formatScheduleNotificationInstant(data.scheduledAt, 'en-US', 'UTC');
  switch (data.changeType) {
    case 'created':
      return `Starts ${when}.`;
    case 'cancelled':
      return `Was planned for ${when}.`;
    case 'rescheduled':
    case 'updated': {
      const summary = summarizeScheduleChangedFields(data.changedFields);
      return summary ? `Updated: ${summary}. Starts ${when}.` : `Starts ${when}.`;
    }
    default:
      return `Starts ${when}.`;
  }
}

/**
 * Viewer-local title for the notifications bell. Prefer this over the stored
 * title whenever structured `data` is present.
 */
export function formatScheduleNotificationTitle(
  data: ScheduleNotificationData,
  locale?: string,
  timeZone?: string,
): string {
  const label = scheduleNotificationLabel(data.label);
  const when = formatScheduleNotificationInstant(data.scheduledAt, locale, timeZone);
  switch (data.changeType) {
    case 'created':
      return `${label} scheduled for ${when}`;
    case 'rescheduled':
      return `${label} rescheduled for ${when}`;
    case 'updated':
      return `${label} updated · ${when}`;
    case 'cancelled':
      return `${label} cancelled · was ${when}`;
    default:
      return `${label} · ${when}`;
  }
}

/** Viewer-local supporting line (changed fields only — no private venue/notes text). */
export function formatScheduleNotificationBody(
  data: ScheduleNotificationData,
  _locale?: string,
  _timeZone?: string,
): string {
  if (data.changeType === 'cancelled') return 'This game night was removed from the calendar.';
  if (data.changeType === 'created') return '';
  const summary = summarizeScheduleChangedFields(data.changedFields);
  if (!summary) return '';
  if (data.changeType === 'rescheduled' && data.changedFields.length === 1) return '';
  return `Changed: ${summary}.`;
}

/** Parse notification.data JSON into schedule metadata, or null when absent/malformed. */
export function parseScheduleNotificationData(raw: unknown): ScheduleNotificationData | null {
  if (raw == null || raw === '') return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = ScheduleNotificationData.safeParse(value);
  return parsed.success ? parsed.data : null;
}
