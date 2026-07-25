/**
 * User time-of-day rendering preference (issue #634).
 *
 * `system` defers to the active locale's default (en-US → 12h, de-DE → 24h).
 * `12h` / `24h` pin hour-cycle regardless of locale. Date-only values and
 * options that omit a time component are never altered.
 */

import { z } from 'zod';

export const TimeFormat = z.enum(['system', '12h', '24h']);
export type TimeFormat = z.infer<typeof TimeFormat>;

export const DEFAULT_TIME_FORMAT: TimeFormat = 'system';

/** Map a stored preference to an explicit `hour12` override, or `undefined` for system. */
export function resolveHour12(timeFormat: TimeFormat): boolean | undefined {
  switch (timeFormat) {
    case '12h':
      return true;
    case '24h':
      return false;
    default:
      return undefined;
  }
}

/** True when Intl options will render a clock time (not date-only). */
export function appliesTime(options: Intl.DateTimeFormatOptions): boolean {
  if (options.timeStyle !== undefined) return true;
  if (options.hour !== undefined) return true;
  if (options.minute !== undefined) return true;
  if (options.second !== undefined) return true;
  return false;
}

/** Merge an hour-cycle override into datetime options when a time component is present. */
export function withTimeFormat(
  options: Intl.DateTimeFormatOptions,
  timeFormat: TimeFormat,
): Intl.DateTimeFormatOptions {
  if (!appliesTime(options)) return options;
  const hour12 = resolveHour12(timeFormat);
  if (hour12 === undefined) return options;
  return { ...options, hour12 };
}
