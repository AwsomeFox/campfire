import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { BackupService } from '../../src/modules/backup/backup.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { BACKUP_CADENCE_KEY, type BackupCadenceState } from '../../src/modules/backup/backup-cadence';
import { settings } from '../../src/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Integration coverage for the scheduled-backup cadence fix (issue #732):
 * the scheduler now PERSISTS lastBackupAt and, on boot, runs a catch-up backup
 * if a scheduled run was missed while the server was down — closing the
 * "frequent restarts never back up" regression.
 *
 * Pure storage-layer harness (no Nest bootstrap), same shape as
 * db-shutdown-checkpoint.spec: a real DbHolder + temp DATA_DIR, with
 * BackupService wired to the real SettingsService (so the persisted cadence
 * row genuinely round-trips through the `settings` table) and a real
 * AuditService. The private runScheduledBackup is driven end-to-end via the
 * public onApplicationBootstrap() with BACKUP_SCHEDULE_ENABLED=1.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Read the persisted cadence row straight out of the settings table. */
function readCadenceRow(db: DrizzleDb): BackupCadenceState | null {
  const rows = db.select().from(settings).where(eq(settings.key, BACKUP_CADENCE_KEY)).limit(1).all();
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0].value) as BackupCadenceState;
  } catch {
    return null;
  }
}

/** Write a cadence row directly (simulating the state left by a prior run). */
function writeCadenceRow(db: DrizzleDb, state: BackupCadenceState): void {
  const json = JSON.stringify(state);
  const existing = db.select().from(settings).where(eq(settings.key, BACKUP_CADENCE_KEY)).limit(1).all();
  if (existing.length > 0) {
    db.update(settings).set({ value: json }).where(eq(settings.key, BACKUP_CADENCE_KEY)).run();
  } else {
    db.insert(settings).values({ key: BACKUP_CADENCE_KEY, value: json }).run();
  }
}

describe('scheduled backup catch-up (issue #732, real SQLite + settings row)', () => {
  let dataDir: string;
  let backupDir: string;
  let holder: DbHolder;
  let prevDataDir: string | undefined;
  let prevBackupDir: string | undefined;
  let prevEnabled: string | undefined;
  let prevInterval: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.DATA_DIR;
    prevBackupDir = process.env.BACKUP_DIR;
    prevEnabled = process.env.BACKUP_SCHEDULE_ENABLED;
    prevInterval = process.env.BACKUP_INTERVAL_HOURS;

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-catchup-'));
    backupDir = path.join(dataDir, 'backups');
    process.env.DATA_DIR = dataDir;
    process.env.BACKUP_DIR = backupDir;
    process.env.BACKUP_SCHEDULE_ENABLED = '1';
    // A short cadence keeps the test fast; the catch-up decision is independent
    // of the magnitude (see backup-cadence.spec for the boundary math).
    process.env.BACKUP_INTERVAL_HOURS = '1';
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    if (prevBackupDir === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = prevBackupDir;
    if (prevEnabled === undefined) delete process.env.BACKUP_SCHEDULE_ENABLED;
    else process.env.BACKUP_SCHEDULE_ENABLED = prevEnabled;
    if (prevInterval === undefined) delete process.env.BACKUP_INTERVAL_HOURS;
    else process.env.BACKUP_INTERVAL_HOURS = prevInterval;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Build a BackupService against the live holder + real settings/audit services. */
  function makeService(): BackupService {
    // holder.proxy is the stable drizzle forwarder every @Inject(DB) consumer
    // receives (see db.module DbHolder). AuditService/SettingsService only use
    // it for inserts/reads, so handing them the proxy directly mirrors runtime.
    const db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    return new BackupService(holder, audit, new SettingsService(db), new AttachmentsService(db, audit, new FsDeletionService(db, audit)));
  }

  it('runs an initial catch-up backup on the first boot after enabling (no prior cadence row)', async () => {
    holder = new DbHolder();
    const service = makeService();

    // No backup dir + no cadence row yet → first boot.
    expect(fs.existsSync(backupDir)).toBe(false);

    await service.onApplicationBootstrap();

    // An archive was written...
    const files = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^campfire-backup-.*\.zip$/);

    // ...and the cadence row now records a real success.
    const cadence = readCadenceRow(holder.proxy);
    expect(cadence).not.toBeNull();
    expect(cadence!.lastSuccessAt).toBe(cadence!.lastAttemptAt);
    expect(cadence!.lastError).toBe('');
    expect(cadence!.lastSize).toBeGreaterThan(0);
    expect(cadence!.lastChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(cadence!.nextRunAt).toBeTruthy();
  });

  it('does NOT run a catch-up when the last backup is still within the cadence (frequent restart)', async () => {
    // The headline regression: a server that bounces every few minutes used to
    // reset its in-memory interval and could go forever without a backup. With
    // persistence, a 1-minute-old backup is correctly seen as fresh, so boot
    // does NOT re-run. (This also proves the overlap guard isn't the thing
    // suppressing the second run — there IS no second run to suppress.)
    holder = new DbHolder();
    const service = makeService();

    // Seed a fresh cadence row as if a backup completed 1 minute ago.
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    writeCadenceRow(holder.proxy, {
      lastAttemptAt: recent,
      lastSuccessAt: recent,
      nextRunAt: new Date(Date.now() + 1 * HOUR_MS).toISOString(),
      lastSize: 1234,
      lastChecksum: 'a'.repeat(64),
      lastError: '',
    });

    await service.onApplicationBootstrap();

    // No archive was written (catch-up correctly skipped).
    const files = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    expect(files.length).toBe(0);

    // The cadence row is untouched — boot did not stamp a new attempt.
    const cadence = readCadenceRow(holder.proxy);
    expect(cadence!.lastAttemptAt).toBe(recent);
    expect(cadence!.lastSize).toBe(1234);
  });

  it('runs a catch-up when the last backup is older than the cadence (missed run)', async () => {
    holder = new DbHolder();
    const service = makeService();

    // Seed a STALE cadence row: last attempt 2h ago, cadence 1h → overdue.
    const stale = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    writeCadenceRow(holder.proxy, {
      lastAttemptAt: stale,
      lastSuccessAt: stale,
      nextRunAt: stale,
      lastSize: 100,
      lastChecksum: 'b'.repeat(64),
      lastError: '',
    });

    await service.onApplicationBootstrap();

    // A fresh archive was written...
    const files = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    expect(files.length).toBe(1);

    // ...and the cadence row advanced past the stale timestamp.
    const cadence = readCadenceRow(holder.proxy);
    expect(Date.parse(cadence!.lastAttemptAt)).toBeGreaterThan(Date.parse(stale));
    expect(cadence!.lastError).toBe('');
    expect(cadence!.lastSize).toBeGreaterThan(100);
  });

  it('treats a corrupted (unparseable) cadence timestamp as overdue and catches up', async () => {
    // Defensive: a garbled settings row must never mean "never back up again".
    holder = new DbHolder();
    const service = makeService();

    writeCadenceRow(holder.proxy, {
      lastAttemptAt: 'not-a-date',
      lastSuccessAt: null,
      nextRunAt: 'not-a-date',
      lastSize: null,
      lastChecksum: null,
      lastError: '',
    });

    await service.onApplicationBootstrap();

    const files = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    expect(files.length).toBe(1);
    const cadence = readCadenceRow(holder.proxy);
    expect(cadence!.lastSuccessAt).not.toBeNull();
  });

  it('does not arm the scheduler when BACKUP_DIR is not writable', async () => {
    // Validate-config acceptance criterion: a bad path fails loudly and does
    // NOT run a catch-up (so we don't write into an unintended location).
    holder = new DbHolder();
    const service = makeService();

    // Point BACKUP_DIR at a path that already exists as a FILE → not writable
    // as a directory. mkdirSync(recursive) is a no-op on an existing file, and
    // fs.accessSync(W_OK) on a file still passes, so to force the not-writable
    // branch we make the parent unwritable instead.
    const blockingParent = path.join(dataDir, 'blocked');
    fs.mkdirSync(blockingParent, { recursive: true });
    fs.chmodSync(blockingParent, 0o555); // r-x: cannot create children
    process.env.BACKUP_DIR = path.join(blockingParent, 'backups');

    // Only treat a genuinely unwritable path as a failure when not root (root
    // ignores POSIX perms). Skip the assertion body in that case.
    const isRoot = process.getuid && process.getuid() === 0;
    if (!isRoot) {
      await service.onApplicationBootstrap();
      // No archive written, and the stale catch-up path was never taken.
      expect(fs.readdirSync(blockingParent).length).toBe(0);
    }
  });
});
