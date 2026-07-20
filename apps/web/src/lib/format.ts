/**
 * Locale-aware date/number formatting (issue #94).
 *
 * Before this seam, surfaces disagreed: SessionsPage/SharedRecapPage/SchedulePanel
 * hardcoded `'en-US'` while SessionLog/CommentsThread/etc. passed `undefined` (browser
 * locale). Everything now routes through these helpers so formatting is consistent and
 * follows the user's locale.
 *
 * Locale resolution: an explicit user override (`cf.lang` in localStorage, set from the
 * Preferences language switcher) wins; otherwise `undefined` lets `Intl` use the
 * runtime/browser default — never a hardcoded region.
 */
import { LANG_STORAGE_KEY } from '../i18n';

/**
 * The locale to hand to `Intl`. Returns the user's explicit override if set, else
 * `undefined` so the browser's own locale (and its date/number conventions) is used.
 */
export function activeLocale(): string | undefined {
  try {
    const override = localStorage.getItem(LANG_STORAGE_KEY);
    return override && override.length > 0 ? override : undefined;
  } catch {
    return undefined;
  }
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Format a date (day granularity). Options default to the browser's locale-native short date. */
export function formatDate(
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  return toDate(value).toLocaleDateString(activeLocale(), options);
}

/** Format a date + time. */
export function formatDateTime(
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  return toDate(value).toLocaleString(activeLocale(), options);
}

/** Format a time-of-day. */
export function formatTime(
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  return toDate(value).toLocaleTimeString(activeLocale(), options);
}

/** Format a number with locale grouping/decimal separators. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(activeLocale(), options);
}
