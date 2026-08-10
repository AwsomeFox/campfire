/**
 * Locale-aware date/number formatting (issue #94).
 *
 * Before this seam, surfaces disagreed: SessionsPage/SharedRecapPage/SchedulePanel
 * hardcoded `'en-US'` while SessionLog/CommentsThread/etc. passed `undefined` (browser
 * locale). Everything now routes through these helpers so formatting is consistent and
 * follows the user's locale.
 *
 * Locale resolution is centralized in `i18n/locale`: an explicit language uses that
 * locale, while System preserves the browser's full locale (not the rendered catalog).
 *
 * Issue #634: clock rendering follows the signed-in user's `timeFormat` preference
 * (system / 12h / 24h). Date-only values keep their calendar-day semantics.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_TIME_FORMAT,
  appliesTime,
  resolveHour12,
  withTimeFormat,
  type TimeFormat,
} from '@campfire/schema';
import { localeController } from '../i18n/locale';

const subscribeToLocale = (onStoreChange: () => void) => localeController.subscribe(onStoreChange);
const formattingLocaleSnapshot = () => localeController.resolved.formatLocale;

const timeFormatListeners = new Set<() => void>();
let activeTimeFormatPreference: TimeFormat = DEFAULT_TIME_FORMAT;

function subscribeToTimeFormat(onStoreChange: () => void): () => void {
  timeFormatListeners.add(onStoreChange);
  return () => timeFormatListeners.delete(onStoreChange);
}

const timeFormatSnapshot = () => activeTimeFormatPreference;

/** Called by AuthProvider when the signed-in user's preference is known or cleared. */
export function setTimeFormatPreference(preference: TimeFormat): void {
  if (activeTimeFormatPreference === preference) return;
  activeTimeFormatPreference = preference;
  for (const listener of timeFormatListeners) listener();
}

/** The persisted clock-rendering preference for the current session. */
export function activeTimeFormat(): TimeFormat {
  return activeTimeFormatPreference;
}

/** Subscribe a formatting surface so a preference change re-renders it. */
export function useTimeFormat(): TimeFormat {
  return useSyncExternalStore(subscribeToTimeFormat, timeFormatSnapshot, timeFormatSnapshot);
}

/** Subscribe a formatting surface so a runtime browser-language change re-renders it. */
export function useFormattingLocale(): string | undefined {
  return useSyncExternalStore(subscribeToLocale, formattingLocaleSnapshot, formattingLocaleSnapshot);
}

/**
 * The locale to hand to `Intl`: an explicit language or System's full browser locale.
 * `undefined` is used only when the runtime does not expose a browser locale.
 */
export function activeLocale(): string | undefined {
  return localeController.resolved.formatLocale;
}

/** Matches a bare calendar date with no time/zone component, e.g. `2026-07-21`. */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Coerce a value to a `Date` for formatting.
 *
 * Date-only strings (`YYYY-MM-DD`, e.g. a session's `playedAt`) carry no time or
 * timezone, so `new Date('2026-07-21')` would parse them as UTC midnight — which,
 * rendered in a negative-offset local zone, slips back to the previous calendar day
 * (issue #267). We instead build a *local* midnight from the Y/M/D parts so the date
 * shown always matches the date stored, regardless of the viewer's timezone. Values
 * that carry a time component (ISO timestamps, epoch millis, `Date`) are untouched.
 */
function toDate(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const m = DATE_ONLY_RE.exec(value);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]) - 1;
      const d = Number(m[3]);
      const local = new Date(y, mo, d);
      // The regex only checks shape, so a calendar-invalid date (e.g. 2026-02-31)
      // would silently roll over (→ Mar 3). Only accept the local date when it
      // round-trips exactly; otherwise fall through so it parses to Invalid Date,
      // matching the pre-fix behavior rather than showing a wrong-but-plausible day.
      if (local.getFullYear() === y && local.getMonth() === mo && local.getDate() === d) {
        return local;
      }
    }
  }
  return new Date(value);
}

/** When Intl options are omitted, locale defaults still render a clock — pin hour cycle only. */
function hourCycleOnlyOptions(
  timeFormat: TimeFormat,
): Intl.DateTimeFormatOptions | undefined {
  const hour12 = resolveHour12(timeFormat);
  return hour12 === undefined ? undefined : { hour12 };
}

/** Format a date (day granularity). Options default to the browser's locale-native short date. */
export function createLocaleFormatters(
  getLocale: () => string | undefined,
  getTimeFormat: () => TimeFormat = activeTimeFormat,
) {
  return {
    formatDate(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
      return toDate(value).toLocaleDateString(getLocale(), options);
    },

    formatDateTime(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
      const resolved =
        options === undefined
          ? hourCycleOnlyOptions(getTimeFormat())
          : appliesTime(options)
            ? withTimeFormat(options, getTimeFormat())
            : options;
      return toDate(value).toLocaleString(getLocale(), resolved);
    },

    formatTime(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
      const resolved =
        options === undefined
          ? hourCycleOnlyOptions(getTimeFormat())
          : appliesTime(options)
            ? withTimeFormat(options, getTimeFormat())
            : options;
      return toDate(value).toLocaleTimeString(getLocale(), resolved);
    },

    formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
      return value.toLocaleString(getLocale(), options);
    },

    timeAgo(value: Date | string | number | null | undefined, now: number = Date.now()): string {
      if (value === null || value === undefined || value === '') return '';
      const date = toDate(value);
      const time = date.getTime();
      if (Number.isNaN(time)) return '';

      const ms = Math.max(0, now - time);
      const mins = Math.floor(ms / 60_000);
      if (mins < 1) return 'just now';

      const hours = Math.floor(mins / 60);
      const days = Math.floor(hours / 24);

      if (days >= 30) {
        return date.toLocaleDateString(getLocale());
      }

      if (typeof Intl !== 'undefined' && Intl.RelativeTimeFormat) {
        try {
          const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'always', style: 'narrow' });
          if (days >= 1) return rtf.format(-days, 'day');
          if (hours >= 1) return rtf.format(-hours, 'hour');
          return rtf.format(-mins, 'minute');
        } catch {
          // Fall through
        }
      }

      if (days >= 1) return `${days}d ago`;
      if (hours >= 1) return `${hours}h ago`;
      return `${mins}m ago`;
    },
  };
}

const formatters = createLocaleFormatters(activeLocale);

/** Format a date (day granularity). */
export const formatDate = formatters.formatDate;
/** Format a date + time. */
export const formatDateTime = formatters.formatDateTime;
/** Format a time-of-day. */
export const formatTime = formatters.formatTime;
/** Format a number with locale grouping/decimal separators. */
export const formatNumber = formatters.formatNumber;
/** Format a relative timestamp (e.g. "just now", "5m ago", "2h ago", "3d ago"). */
export const timeAgo = formatters.timeAgo;

/**
 * Render a number for an EDITABLE text field that will be re-parsed by
 * `parseLocalizedNumber` (apps/web/src/lib/i18nNumbers.ts) in the same locale — as
 * opposed to {@link formatNumber} above, which is for read-only display and may add
 * grouping separators a parser would then have to strip back out.
 *
 * Issue #2179 review: a draft field seeded or reset with plain `String(value)` is a
 * real data-integrity bug, not a formatting nit. `String()` always emits an ASCII
 * `.` decimal, but `parseLocalizedNumber` reads the decimal/grouping separators for
 * the ACTIVE locale — in a comma-decimal locale (de, fr, …) `.` is a member of the
 * *grouping* set, so its separator-stripping step silently deletes it before parsing.
 * `String(7.25)` round-trips through such a locale as the digit run `"725"`, parsed
 * as the integer 725 — no validation error, no visible sign anything went wrong,
 * just a value 100x too large silently written on blur.
 *
 * `useGrouping: false` keeps the output free of grouping separators (so a later
 * edit does not have to fight stray commas/periods/spaces the user never typed),
 * and `maximumFractionDigits` is generous enough to round-trip typical decimal
 * inputs without visibly truncating precision, while `toLocaleString` still emits
 * the correct decimal separator for `locale` — the same one `parseLocalizedNumber`
 * will look for when this string is edited and re-parsed. Takes an explicit
 * `locale` parameter (defaulting to {@link activeLocale}) rather than going through
 * `formatNumber`'s closure-bound one, matching `parseLocalizedNumber`'s own explicit-
 * locale convention and keeping both ends of a round-trip trivially testable against
 * the same, deliberately chosen locale.
 */
export function formatNumberForEditing(value: number, locale: string | undefined = activeLocale()): string {
  return value.toLocaleString(locale, { useGrouping: false, maximumFractionDigits: 6 });
}

/** Hook that triggers a re-render every `intervalMs` (default 60s) so relative timestamps update. */
export function useTimeTick(intervalMs: number = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Hook that returns an auto-updating formatted "time ago" string. */
export function useTimeAgo(
  value: Date | string | number | null | undefined,
  intervalMs: number = 60_000,
): string {
  const now = useTimeTick(intervalMs);
  useFormattingLocale();
  return formatters.timeAgo(value, now);
}
