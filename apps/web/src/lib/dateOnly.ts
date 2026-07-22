/**
 * Format a Date as the browser's local, timezone-free calendar day for an
 * `<input type="date">`. Do not use `toISOString()` here: ISO conversion moves
 * the instant to UTC first and can therefore select yesterday or tomorrow for
 * users near the date line.
 */
export function localDateInputValue(date: Date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Milliseconds until the next local midnight.
 *
 * Constructing the boundary from local calendar components deliberately lets
 * the JavaScript runtime account for 23- and 25-hour daylight-saving days.
 */
export function millisecondsUntilNextLocalDate(date: Date = new Date()): number {
  const nextMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return Math.max(1, nextMidnight.getTime() - date.getTime());
}
