import {
  estimateNextBackupBytes,
  parseBackupMinFreeBytes,
  parseBackupRetentionPolicy,
  planBackupRetention,
  type BackupRetentionCandidate,
  type BackupRetentionPolicy,
} from '../../src/modules/backup/backup-retention';

const DAY_MS = 24 * 60 * 60 * 1000;

function policy(overrides: Partial<BackupRetentionPolicy> = {}): BackupRetentionPolicy {
  return {
    keepCount: null,
    keepDays: null,
    maxTotalBytes: null,
    protectLastGood: true,
    ...overrides,
  };
}

function candidate(
  name: string,
  ageDays: number,
  overrides: Partial<BackupRetentionCandidate> = {},
): BackupRetentionCandidate {
  const now = Date.parse('2026-07-26T00:00:00Z');
  return {
    name,
    bytes: 100,
    mtimeMs: now - ageDays * DAY_MS,
    verified: true,
    ...overrides,
  };
}

describe('planBackupRetention (issue #505)', () => {
  const now = Date.parse('2026-07-26T00:00:00Z');

  it('never prunes unverified/partial archives, even when age and count policies would match', () => {
    const plan = planBackupRetention(
      [
        candidate('new.zip', 0),
        candidate('partial.zip', 90, { verified: false, bytes: 5_000 }),
        candidate('old.zip', 60),
      ],
      policy({ keepCount: 1, keepDays: 30, maxTotalBytes: 150 }),
      now,
    );

    expect(plan.prune.map((entry) => entry.name)).toEqual(['old.zip']);
    expect(plan.keep.find((entry) => entry.name === 'partial.zip')?.reasons).toContain('unverified');
  });

  it('protects the last-known-good archive from count, age, and size pruning', () => {
    const plan = planBackupRetention(
      [
        candidate('latest.zip', 0),
        candidate('lkg.zip', 90, { lastKnownGood: true, bytes: 1_000 }),
        candidate('older.zip', 80, { bytes: 1_000 }),
      ],
      policy({ keepCount: 1, keepDays: 30, maxTotalBytes: 500 }),
      now,
    );

    expect(plan.prune.map((entry) => entry.name)).toEqual(['older.zip']);
    expect(plan.keep.find((entry) => entry.name === 'lkg.zip')?.reasons).toContain('last-known-good');
  });

  it('honors pinned/offsite markers as stronger than the size cap', () => {
    const plan = planBackupRetention(
      [
        candidate('new.zip', 0, { bytes: 500 }),
        candidate('offsite.zip', 10, { bytes: 500, offsite: true }),
        candidate('pinned.zip', 20, { bytes: 500, pinned: true }),
        candidate('old.zip', 30, { bytes: 500 }),
      ],
      policy({ maxTotalBytes: 1_000 }),
      now,
    );

    expect(plan.prune.map((entry) => entry.name)).toEqual(['old.zip']);
    expect(plan.keep.find((entry) => entry.name === 'offsite.zip')?.reasons).toContain('offsite');
    expect(plan.keep.find((entry) => entry.name === 'pinned.zip')?.reasons).toContain('pinned');
  });

  it('applies a size cap by deleting oldest verified, unprotected archives first', () => {
    const plan = planBackupRetention(
      [
        candidate('newest.zip', 0, { bytes: 400 }),
        candidate('middle.zip', 5, { bytes: 400 }),
        candidate('oldest.zip', 10, { bytes: 400 }),
      ],
      policy({ maxTotalBytes: 800 }),
      now,
    );

    expect(plan.prune).toEqual([
      expect.objectContaining({ name: 'oldest.zip', reasons: ['size'] }),
    ]);
    expect(plan.prunableBytes).toBe(400);
  });
});

describe('backup retention env parsing and estimates', () => {
  it('parses configured count/age/size policy and treats 0 as disabled', () => {
    const parsed = parseBackupRetentionPolicy({
      BACKUP_KEEP_COUNT: '0',
      BACKUP_KEEP_DAYS: '7',
      BACKUP_MAX_TOTAL_BYTES: '1048576',
      BACKUP_PROTECT_LAST_GOOD: 'false',
    } as NodeJS.ProcessEnv);

    expect(parsed).toEqual({
      keepCount: null,
      keepDays: 7,
      maxTotalBytes: 1_048_576,
      protectLastGood: false,
    });
  });

  it('falls back on invalid numeric env values', () => {
    const parsed = parseBackupRetentionPolicy({
      BACKUP_KEEP_COUNT: '-1',
      BACKUP_KEEP_DAYS: 'NaN',
      BACKUP_MAX_TOTAL_BYTES: '1.5',
    } as NodeJS.ProcessEnv);

    expect(parsed.keepCount).toBe(14);
    expect(parsed.keepDays).toBe(30);
    expect(parsed.maxTotalBytes).toBeNull();
  });

  it('estimates the next archive from the last successful size with growth headroom', () => {
    expect(estimateNextBackupBytes(100 * 1024 * 1024)).toBe(115 * 1024 * 1024);
    expect(estimateNextBackupBytes(null, 10)).toBe(1024 * 1024 + 10);
    expect(parseBackupMinFreeBytes('0')).toBe(0);
  });
});
