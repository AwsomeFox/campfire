/**
 * Pure helpers for the scheduled-backup cadence fix (issue #732).
 *
 * The scheduler in {@link BackupService} used to keep its cadence entirely in
 * memory: a single `setInterval` set on boot, with no record of when a backup
 * last ran. Frequent restarts (a container that bounces every few minutes)
 * could therefore go forever without ever crossing an interval boundary, and
 * invalid `BACKUP_INTERVAL_HOURS` values (`0`, negative, `NaN`, fractional
 * footguns) were silently coerced with no signal to the operator.
 *
 * This module extracts the two decisions that drive the fix into pure,
 * side-effect-free functions so they can be unit-tested without booting Nest,
 * opening SQLite, or touching the filesystem:
 *   - {@link parseBackupIntervalHours}: strict parsing + clamping of the
 *     configured cadence. Invalid input falls back to 24h (the documented
 *     default) instead of becoming 0/Infinity/negative.
 *   - {@link isBackupOverdue}: the catch-up decision. Given the persisted
 *     last-backup timestamp, the configured interval, and "now", returns
 *     whether a scheduled run was missed while the server was down (or whether
 *     this is the first-ever boot after enabling the scheduler).
 *
 * The persisted state shape ({@link BackupCadenceState}) and the settings key
 * it lives under ({@link BACKUP_CADENCE_KEY}) are exported here so both the
 * service and the tests agree on the on-disk contract.
 */

/** Settings key holding the serialized {@link BackupCadenceState}. */
export const BACKUP_CADENCE_KEY = 'backup.cadence';

/**
 * Default cadence when `BACKUP_INTERVAL_HOURS` is unset or invalid. Matches the
 * pre-fix behaviour and the README's documented default.
 */
export const DEFAULT_BACKUP_INTERVAL_HOURS = 24;

/**
 * Floor for the configured cadence. A sub-minute cadence is almost always a
 * misconfiguration (a stray `0.001`), and at the limit it would busy-loop the
 * backup writer. Anything below this is clamped up to it.
 */
export const BACKUP_INTERVAL_MIN_HOURS = 1 / 60; // one minute

/**
 * Ceiling for the configured cadence. An absurd value (e.g. a typo'd
 * `100000`) would otherwise mean "effectively never back up" with no warning.
 * Anything above this is clamped down to it. 30 days is well past any
 * reasonable disaster-recovery RPO while still being a legal configuration.
 */
export const BACKUP_INTERVAL_MAX_HOURS = 24 * 30; // 30 days

/**
 * Persisted cadence state (issue #732). Stored as JSON under
 * {@link BACKUP_CADENCE_KEY} in the `settings` table via
 * `SettingsService.getJson`/`setJson`.
 *
 * `lastAttemptAt` is stamped on every run, success OR failure, so a crashed
 * backup doesn't busy-loop catch-up on the next boot. `lastSuccessAt` is
 * stamped only on a completed archive write — it's the field an operator
 * reading the row actually cares about. `nextRunAt` is the projected next
 * boundary, recorded so the catch-up check has a stable reference even if the
 * configured interval later changes. `lastSize` / `lastChecksum` are the
 * size and sha256 of the most recent SUCCESSFUL archive, exposed for operator
 * diagnostics (the acceptance criteria ask for size + checksum + next run).
 */
export interface BackupCadenceState {
  /** ISO timestamp of the most recent backup attempt (success or failure). */
  lastAttemptAt: string;
  /** ISO timestamp of the most recent SUCCESSFUL archive write. */
  lastSuccessAt: string | null;
  /** ISO timestamp the next scheduled run is projected for. */
  nextRunAt: string;
  /** Size in bytes of the most recent successful archive (null until first success). */
  lastSize: number | null;
  /** sha256 hex of the most recent successful archive (null until first success). */
  lastChecksum: string | null;
  /** Non-empty when the most recent attempt FAILED; empty string on success. */
  lastError: string;
}

/**
 * Strictly parse `BACKUP_INTERVAL_HOURS` into a usable, bounded number of
 * hours.
 *
 * Accepts unset (→ default), and any positive finite number string (integers
 * and fractions alike — a 0.5h / 30m cadence is legitimate). Rejects NaN,
 * empty/whitespace, negative, zero, and Infinity by falling back to the
 * default, and clamps the result into `[BACKUP_INTERVAL_MIN_HOURS,
 * BACKUP_INTERVAL_MAX_HOURS]`.
 *
 * Reads `process.env.BACKUP_INTERVAL_HOURS` when `raw` is omitted, so callers
 * can pass an explicit override (tests) or rely on the env (the service).
 *
 * @returns the resolved cadence in hours (always finite, positive, bounded).
 */
export function parseBackupIntervalHours(
  raw: string | undefined = process.env.BACKUP_INTERVAL_HOURS,
): number {
  if (raw === undefined || raw === '') return DEFAULT_BACKUP_INTERVAL_HOURS;
  const trimmed = raw.trim();
  if (trimmed === '') return DEFAULT_BACKUP_INTERVAL_HOURS;
  const parsed = Number(trimmed);
  // Number('') === 0 and Number(' ') === 0, but we already handled empty
  // above; any remaining non-numeric string is NaN. Reject NaN, negative,
  // zero, and non-finite (Infinity) outright — they are misconfigurations,
  // not silent defaults to clamp.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BACKUP_INTERVAL_HOURS;
  }
  return clamp(parsed, BACKUP_INTERVAL_MIN_HOURS, BACKUP_INTERVAL_MAX_HOURS);
}

/**
 * Decide whether a catch-up backup is overdue, given the persisted
 * last-attempt timestamp, the configured interval (ms), and the current time.
 *
 * Overdue means: the interval has elapsed since the last attempt, OR there is
 * no usable last-attempt on record (first boot after enabling the scheduler,
 * or a corrupted/missing settings row). The latter is the "initial backup"
 * criterion from the issue: a freshly-enabled scheduler runs once immediately
 * rather than waiting a full interval.
 *
 * @param lastAttemptAt ISO timestamp of the last backup attempt, or null/empty
 *   if none has ever been recorded (treated as overdue).
 * @param intervalMs the configured cadence in milliseconds.
 * @param nowMs current epoch milliseconds (default: Date.now()). Passed
 *   explicitly in tests for determinism.
 */
export function isBackupOverdue(
  lastAttemptAt: string | null | undefined,
  intervalMs: number,
  nowMs: number = Date.now(),
): boolean {
  // No recorded attempt → this is a first-ever boot (or the row was wiped).
  // The acceptance criteria call for an initial catch-up backup in this case.
  if (!lastAttemptAt) return true;
  const lastMs = Date.parse(lastAttemptAt);
  // An unparseable timestamp is treated as overdue rather than silently
  // skipping catch-up (defensive: a corrupted settings row should never mean
  // "never back up again").
  if (Number.isNaN(lastMs)) return true;
  return nowMs - lastMs >= intervalMs;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
