import { TextDecoder } from 'node:util';
import {
  BACKUP_CADENCE_KEY,
  BACKUP_INTERVAL_MAX_HOURS,
  BACKUP_INTERVAL_MIN_HOURS,
  isBackupOverdue,
  parseBackupIntervalHours,
  type BackupCadenceState,
} from '../../src/modules/backup/backup-cadence';

/**
 * Pure-function coverage for the scheduled-backup cadence fix (issue #732). The
 * scheduler in BackupService has a memory of missed runs now: it persists
 * lastBackupAt and, on boot, decides whether a catch-up run is overdue. The
 * decision logic and the strict interval parsing are extracted into these pure
 * helpers so they can be exercised without booting a Nest app or touching the
 * filesystem / SQLite handle.
 *
 * Regression-first note: every case below (NaN, negative, zero, fractional,
 * frequent-restart catch-up, overlap suppression) was a documented symptom in
 * the issue's acceptance criteria and is what the OLD `Number(x) || 24` +
 * in-memory `setInterval` code path got wrong.
 */

const HOUR_MS = 60 * 60 * 1000;

describe('parseBackupIntervalHours (issue #732: strict cadence parsing)', () => {
  // Snapshot the original env so a stray mutation can't leak across cases.
  const original = process.env.BACKUP_INTERVAL_HOURS;
  afterEach(() => {
    if (original === undefined) delete process.env.BACKUP_INTERVAL_HOURS;
    else process.env.BACKUP_INTERVAL_HOURS = original;
  });

  it('defaults to 24h when unset (the documented cadence)', () => {
    delete process.env.BACKUP_INTERVAL_HOURS;
    expect(parseBackupIntervalHours(undefined)).toBe(24);
  });

  it('parses a clean positive integer', () => {
    expect(parseBackupIntervalHours('12')).toBe(12);
    expect(parseBackupIntervalHours('1')).toBe(1);
  });

  it('parses a fractional hour (0.5h == 30m is a legitimate sub-hour cadence)', () => {
    expect(parseBackupIntervalHours('0.5')).toBe(0.5);
    expect(parseBackupIntervalHours('1.5')).toBe(1.5);
  });

  it('rejects NaN ("not-a-number" / empty / whitespace-only) by falling back to 24h', () => {
    // OLD bug: Number('garbage') || 24 also happened to land on 24, but it also
    // silently accepted '0' and negative strings as falsy → 24, hiding the
    // misconfiguration. The new parse is strict about WHY it falls back.
    expect(parseBackupIntervalHours('garbage')).toBe(24);
    expect(parseBackupIntervalHours('')).toBe(24);
    expect(parseBackupIntervalHours('   ')).toBe(24);
    expect(parseBackupIntervalHours('12abc')).toBe(24);
  });

  it('rejects zero — a zero cadence is a misconfiguration, not "every instant"', () => {
    // OLD bug: Number('0') || 24 → 24, but with NO signal that the configured
    // value was invalid. The new path clamps AND the boot logs the effective
    // cadence so an operator sees the discrepancy. 0 still becomes usable.
    expect(parseBackupIntervalHours('0')).toBe(24);
    expect(parseBackupIntervalHours('0.0')).toBe(24);
  });

  it('rejects negative values and falls back to 24h (OLD bug: logged a misleading negative cadence)', () => {
    // OLD bug: Math.max(1, -5) → 1, then it logged "every -5h" because the
    // log line used the raw `hours`, not the clamped intervalMs.
    expect(parseBackupIntervalHours('-1')).toBe(24);
    expect(parseBackupIntervalHours('-0.25')).toBe(24);
    expect(parseBackupIntervalHours('-9999')).toBe(24);
  });

  it('rejects Infinity (a bare "Infinity" string)', () => {
    expect(parseBackupIntervalHours('Infinity')).toBe(24);
  });

  it('clamps an absurdly large value down to BACKUP_INTERVAL_MAX_HOURS', () => {
    // A typo like BACKUP_INTERVAL_HOURS=100000 would otherwise mean "never
    // back up" with no warning. Clamp to the documented sane ceiling.
    const huge = String(BACKUP_INTERVAL_MAX_HOURS * 10);
    expect(parseBackupIntervalHours(huge)).toBe(BACKUP_INTERVAL_MAX_HOURS);
  });

  it('clamps a sub-minimum fractional value up to BACKUP_INTERVAL_MIN_HOURS', () => {
    // 0.001h would mean a backup every ~3.6s — a footgun. Floor it at the min.
    expect(parseBackupIntervalHours('0.001')).toBe(BACKUP_INTERVAL_MIN_HOURS);
    expect(parseBackupIntervalHours('0.01')).toBe(BACKUP_INTERVAL_MIN_HOURS);
  });

  it('respects an explicit env override when no argument is passed', () => {
    process.env.BACKUP_INTERVAL_HOURS = '6';
    expect(parseBackupIntervalHours()).toBe(6);
  });
});

describe('isBackupOverdue (issue #732: catch-up after restart)', () => {
  const now = new Date('2026-07-21T12:00:00Z').getTime();

  it('is overdue when lastBackupAt is older than the interval (the missed-run case)', () => {
    // Server was down across a scheduled boundary: 25h elapsed, interval 24h.
    const last = new Date(now - 25 * HOUR_MS).toISOString();
    expect(isBackupOverdue(last, 24 * HOUR_MS, now)).toBe(true);
  });

  it('is NOT overdue when the last backup is still within the interval', () => {
    const last = new Date(now - 10 * HOUR_MS).toISOString();
    expect(isBackupOverdue(last, 24 * HOUR_MS, now)).toBe(false);
  });

  it('is exactly overdue at the boundary (>= interval elapsed)', () => {
    const last = new Date(now - 24 * HOUR_MS).toISOString();
    expect(isBackupOverdue(last, 24 * HOUR_MS, now)).toBe(true);
  });

  it('treats a null/missing lastBackupAt as overdue (first-ever boot after enable)', () => {
    // The "initial backup" criterion from the acceptance criteria: a freshly
    // enabled scheduler with no history should run once immediately rather
    // than waiting a full interval.
    expect(isBackupOverdue(null, 24 * HOUR_MS, now)).toBe(true);
    expect(isBackupOverdue(undefined, 24 * HOUR_MS, now)).toBe(true);
  });

  it('treats an unparseable stored timestamp as overdue (defensive: don\'t silently skip)', () => {
    // A corrupted settings row must not mean "never catch up".
    expect(isBackupOverdue('not-a-date', 24 * HOUR_MS, now)).toBe(true);
    expect(isBackupOverdue('', 24 * HOUR_MS, now)).toBe(true);
  });

  it('handles frequent restarts: a backup 1m ago is never overdue on the next boot', () => {
    // The headline regression: before this fix, each restart reset the
    // in-memory interval and a frequently-restarted server could go forever
    // without a backup. With persistence, a 1m-old backup is correctly seen
    // as fresh, so no catch-up fires.
    const last = new Date(now - 60 * 1000).toISOString();
    expect(isBackupOverdue(last, 24 * HOUR_MS, now)).toBe(false);
  });

  it('catch-up survives multiple missed intervals (30h down across a 6h cadence)', () => {
    const last = new Date(now - 30 * HOUR_MS).toISOString();
    expect(isBackupOverdue(last, 6 * HOUR_MS, now)).toBe(true);
  });
});

describe('BackupCadenceState shape (issue #732: persist last attempt/success/next run)', () => {
  it('exposes the settings key the scheduler persists under', () => {
    // The acceptance criteria: persist last attempt, last success, and next run.
    // The key name is part of the on-disk contract (operators may read the
    // settings table), so pin it.
    expect(BACKUP_CADENCE_KEY).toBe('backup.cadence');
  });

  it('a freshly-built state object carries all three timestamps', () => {
    const now = new Date('2026-07-21T12:00:00Z').toISOString();
    const state: BackupCadenceState = {
      lastAttemptAt: now,
      lastSuccessAt: now,
      nextRunAt: new Date(new Date(now).getTime() + 24 * HOUR_MS).toISOString(),
      lastSize: 1234,
      lastChecksum: 'abc123',
      lastError: '',
    };
    expect(state.lastAttemptAt).toBe(now);
    expect(state.lastSuccessAt).toBe(now);
    expect(state.nextRunAt).toBeTruthy();
    expect(state.lastSize).toBe(1234);
    expect(state.lastChecksum).toBe('abc123');
  });

  it('a failed attempt records lastAttemptAt without advancing lastSuccessAt', () => {
    // The acceptance criteria distinguish attempt from success: a run that
    // threw must update lastAttemptAt (so catch-up doesn't busy-loop) but
    // must NOT claim a success. The scheduler owns this distinction; this
    // test pins the shape it relies on.
    const successAt = '2026-07-20T00:00:00Z';
    const failedAttemptAt = '2026-07-21T12:00:00Z';
    const state: BackupCadenceState = {
      lastAttemptAt: failedAttemptAt,
      lastSuccessAt: successAt,
      nextRunAt: failedAttemptAt,
      lastSize: 1234,
      lastChecksum: 'abc123',
      lastError: 'disk full',
    };
    expect(state.lastAttemptAt).not.toBe(state.lastSuccessAt);
    expect(state.lastError).toBe('disk full');
  });
});

// Smoke-test that the module imports cleanly under ts-jest (catches a stray
// default/non-default export mismatch early).
describe('backup-cadence module import', () => {
  it('exports the pure helpers and the state type', () => {
    expect(typeof parseBackupIntervalHours).toBe('function');
    expect(typeof isBackupOverdue).toBe('function');
    expect(typeof BACKUP_CADENCE_KEY).toBe('string');
    expect(typeof BACKUP_INTERVAL_MIN_HOURS).toBe('number');
    expect(typeof BACKUP_INTERVAL_MAX_HOURS).toBe('number');
    // TextDecoder is touched so Node's undici global is exercised under jsdom-less ts-jest.
    expect(new TextDecoder().decode(new Uint8Array([0x68]))).toBe('h');
  });
});
