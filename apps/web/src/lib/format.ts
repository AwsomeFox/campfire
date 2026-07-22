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
 */
import { useSyncExternalStore } from 'react';
import { localeController } from '../i18n/locale';

const subscribeToLocale = (onStoreChange: () => void) => localeController.subscribe(onStoreChange);
const formattingLocaleSnapshot = () => localeController.resolved.formatLocale;

/** Subscribe a formatting surface so a runtime browser-language change re-renders it. */
export function useFormattingLocale(): string | undefined {
  return useSyncExternalStore(subscribeToLocale, formattingLocaleSnapshot, () => undefined);
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

/** Format a date (day granularity). Options default to the browser's locale-native short date. */
export function createLocaleFormatters(getLocale: () => string | undefined) {
  return {
    formatDate(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
      return toDate(value).toLocaleDateString(getLocale(), options);
    },

    formatDateTime(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
      return toDate(value).toLocaleString(getLocale(), options);
    },

    formatTime(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
      return toDate(value).toLocaleTimeString(getLocale(), options);
    },

    formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
      return value.toLocaleString(getLocale(), options);
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
