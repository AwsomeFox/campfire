import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { DB_HOLDER, DbHolder, dbFilePath, resolveDataDir } from '../../db/db.module';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor, type RequestUser } from '../../common/user.types';
import { SettingsService } from '../settings/settings.service';
import {
  BACKUP_CADENCE_KEY,
  isBackupOverdue,
  parseBackupIntervalHours,
  type BackupCadenceState,
} from './backup-cadence';
import {
  BACKUP_APP,
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  BACKUP_VERSION,
  CURRENT_SCHEMA_REVISION,
  manifestToInspectView,
  parseBackupManifest,
  serverAppVersion,
  type BackupInspectResult,
  type BackupManifest,
} from './backup-manifest';

export { BACKUP_APP, BACKUP_KIND, BACKUP_VERSION, BACKUP_FORMAT_VERSION };
export type { BackupManifest, BackupInspectResult };

/** Zip entry names inside a backup archive. */
export const MANIFEST_ENTRY = 'manifest.json';
export const DB_ENTRY = 'db/campfire.db';
const UPLOADS_PREFIX = 'uploads/';

/**
 * Restore is destructive (it overwrites the entire database + uploads). The
 * caller must pass this exact confirmation token in the request body so a
 * restore can never happen by accident (e.g. an errant click or a replayed
 * request). Server-admin gating is enforced separately by @ServerRoles('admin').
 */
export const RESTORE_CONFIRM_TOKEN = 'RESTORE';

/**
 * The 16-byte magic every SQLite 3 database file begins with: the ASCII string
 * "SQLite format 3" followed by a single NUL byte (0x00). Built from an
 * explicit escape rather than a string literal so the source file stays plain
 * text (a literal NUL in the .ts is what made some editors/tools treat the
 * file as binary).
 */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

export interface RestoreResult {
  ok: true;
  restoredAt: string;
  dbBytes: number;
  uploadCount: number;
}

function uploadsRoot(dataDir: string): string {
  return path.join(dataDir, 'uploads');
}

/** All file paths (relative to `root`) under `root`, recursively. Returns [] if root is absent. */
function listFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  walk(root, '');
  return out;
}

function looksLikeSqlite(buf: Buffer): boolean {
  return buf.length >= SQLITE_MAGIC.length && buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC);
}

@Injectable()
export class BackupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupService.name);
  /**
   * In-process overlap guard for scheduled backups (issue #732). A large DB
   * plus many uploads can take longer than a tight cadence; without this flag
   * a slow run would stack a second concurrent VACUUM INTO / zip pass on top
   * of the first. The flag is set for the duration of {@link runScheduledBackup}
   * and re-checked under it, so only one scheduled run is ever in flight.
   */
  private scheduledRunning = false;

  constructor(
    @Inject(DB_HOLDER) private readonly holder: DbHolder,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Optional scheduled backups — OFF unless BACKUP_SCHEDULE_ENABLED=1. Mirrors
   * the setInterval().unref() precedent in AuthService.onApplicationBootstrap
   * (this project has no cron/scheduler dependency, so we don't add one). When
   * enabled, writes a fresh archive to BACKUP_DIR (default DATA_DIR/backups)
   * every BACKUP_INTERVAL_HOURS (default 24). Documented in README.
   *
   * Issue #732 — the scheduler now remembers cadence across restarts:
   *   1. Strictly parse + clamp BACKUP_INTERVAL_HOURS (NaN/negative/zero/absurd
   *      values fall back to the documented default instead of silently becoming
   *      0/Infinity/negative) and log the EFFECTIVE cadence so an operator sees
   *      any discrepancy with what they configured.
   *   2. Validate BACKUP_DIR exists and is writable before arming the timer,
   *      so a misconfigured path fails loudly at boot rather than silently
   *      swallowing every scheduled write.
   *   3. Persist lastAttemptAt / lastSuccessAt / nextRunAt under the
   *      `backup.cadence` settings key, and on boot check whether a scheduled
   *      run was missed while the server was down — if so, run a catch-up
   *      backup immediately. This closes the "frequent restarts never back up"
   *      regression: a bounced container no longer resets the cadence clock.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.BACKUP_SCHEDULE_ENABLED !== '1') return;

    const hours = parseBackupIntervalHours();
    const intervalMs = hours * 60 * 60 * 1000;
    const dir = this.backupDir();

    // Validate the destination up front. mkdirSync(recursive) covers the common
    // "first run, dir doesn't exist yet" case; the W_OK probe then catches a
    // path that exists but isn't writable (e.g. a read-only mount). A failure
    // here disables scheduling for this boot — better to fail loudly than to
    // arm a timer whose every tick throws into the void.
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
      this.logger.error(
        `Scheduled backups disabled: BACKUP_DIR "${dir}" is not writable ` +
          `(${err instanceof Error ? err.message : String(err)}). Fix the path and restart.`,
      );
      return;
    }

    this.logger.log(`Scheduled backups enabled — effective cadence every ${hours}h to ${dir}`);

    // Catch-up: if the persisted last-attempt is older than the cadence (or this
    // is the first boot after enabling, so there's no record yet), run one
    // immediately rather than waiting a full interval. Awaited so the boot log
    // reflects reality and so test app.init() doesn't race a fire-and-forget.
    try {
      const cadence = await this.readCadence();
      if (isBackupOverdue(cadence?.lastAttemptAt ?? null, intervalMs)) {
        this.logger.log('Scheduled backup is overdue — running a catch-up backup now');
        await this.runScheduledBackup(intervalMs);
      }
    } catch (err) {
      // A catch-up failure must not prevent the recurring timer from arming —
      // the next tick is another chance. Log and continue.
      this.logger.error(
        `Catch-up backup failed at boot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const timer = setInterval(() => {
      void this.runScheduledBackup(intervalMs).catch((err) => {
        this.logger.error(`Scheduled backup failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);
    timer.unref();
  }

  private backupDir(): string {
    return process.env.BACKUP_DIR || path.join(resolveDataDir(), 'backups');
  }

  /**
   * Run one scheduled backup, guarding against overlap (issue #732). The cadence
   * state is always stamped through this single code path. Records the attempt
   * whether it succeeds or fails, so a crashed run doesn't busy-loop catch-up
   * on the next boot; advances lastSuccessAt only on a completed archive write.
   */
  private async runScheduledBackup(intervalMs: number): Promise<void> {
    if (this.scheduledRunning) {
      this.logger.warn('Scheduled backup skipped: a previous run is still in flight');
      return;
    }
    this.scheduledRunning = true;
    const attemptAt = nowIso();
    const previous = await this.readCadence();
    try {
      const dir = this.backupDir();
      fs.mkdirSync(dir, { recursive: true });
      const buffer = await this.buildBackup();
      const stamp = attemptAt.replace(/[:.]/g, '-');
      const filePath = path.join(dir, `campfire-backup-${stamp}.zip`);
      fs.writeFileSync(filePath, buffer);
      const size = buffer.length;
      const checksum = createHash('sha256').update(buffer).digest('hex');
      // Persist cadence BEFORE the success log so a crash between the write and
      // the log still leaves a correct "last success" on disk.
      const nextRunAt = new Date(Date.now() + intervalMs).toISOString();
      await this.writeCadence({
        lastAttemptAt: attemptAt,
        lastSuccessAt: attemptAt,
        nextRunAt,
        lastSize: size,
        lastChecksum: checksum,
        lastError: '',
      });
      this.logger.log(
        `Scheduled backup written: ${filePath} (${size} bytes, sha256 ${checksum.slice(0, 16)}…); next run ${nextRunAt}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Stamp the attempt even on failure so the overdue check on the next boot
      // doesn't immediately re-fire (and potentially busy-loop). lastSuccessAt
      // / lastSize / lastChecksum are deliberately NOT advanced — an operator
      // reading the row sees the real last-good time + size, not a misleading
      // recent timestamp. lastError records the failure for diagnostics.
      try {
        await this.writeCadence({
          lastAttemptAt: attemptAt,
          lastSuccessAt: previous?.lastSuccessAt ?? null,
          nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
          lastSize: previous?.lastSize ?? null,
          lastChecksum: previous?.lastChecksum ?? null,
          lastError: message,
        });
      } catch {
        // best-effort — the original error is the one that matters
      }
      throw err;
    } finally {
      this.scheduledRunning = false;
    }
  }

  /** Read the persisted cadence state, or null if never recorded. */
  private async readCadence(): Promise<BackupCadenceState | null> {
    return this.settings.getJson<BackupCadenceState>(BACKUP_CADENCE_KEY);
  }

  /** Upsert the persisted cadence state under the shared settings key. */
  private async writeCadence(state: BackupCadenceState): Promise<void> {
    await this.settings.setJson(BACKUP_CADENCE_KEY, state);
  }

  /** Suggested download filename, e.g. campfire-backup-2026-07-20.zip. */
  backupFilename(): string {
    const date = nowIso().slice(0, 10);
    return `campfire-backup-${date}.zip`;
  }

  /**
   * Build a downloadable backup archive: a WAL-safe hot snapshot of the SQLite
   * DB (via `VACUUM INTO`, which checkpoints the WAL into a single clean file
   * without blocking writers or requiring the app to be quiesced) plus every
   * file under DATA_DIR/uploads, wrapped with a manifest.
   */
  async buildBackup(): Promise<Buffer> {
    const dataDir = resolveDataDir();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-backup-'));
    const snapshotPath = path.join(tmpDir, 'campfire.db');
    try {
      // VACUUM INTO requires the target file NOT to exist (tmpDir is empty). Escape the
      // path for the SQL string literal.
      this.holder.raw.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
      const dbBytes = fs.readFileSync(snapshotPath);

      const zip = new JSZip();
      zip.file(DB_ENTRY, dbBytes);

      const uploads = uploadsRoot(dataDir);
      const uploadFiles = listFilesRecursive(uploads);
      for (const rel of uploadFiles) {
        zip.file(`${UPLOADS_PREFIX}${rel}`, fs.readFileSync(path.join(uploads, rel)));
      }

      const manifest: BackupManifest = {
        app: BACKUP_APP,
        kind: BACKUP_KIND,
        version: BACKUP_FORMAT_VERSION,
        appVersion: serverAppVersion(),
        schemaVersion: CURRENT_SCHEMA_REVISION,
        createdAt: nowIso(),
        db: DB_ENTRY,
        dbBytes: dbBytes.length,
        uploadCount: uploadFiles.length,
      };
      zip.file(MANIFEST_ENTRY, JSON.stringify(manifest, null, 2));

      return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Validate and apply a backup archive over the whole server: replaces the
   * SQLite DB and the uploads tree, then re-opens the DB in place. Destructive
   * — every current row and file is discarded. The archive is fully validated
   * BEFORE the live DB is touched, so a malformed upload leaves the server
   * untouched (it 400s and the running DB is never closed).
   */
  /**
   * Read manifest metadata and upload entry names from an archive without
   * restoring or touching the live server (issue #514).
   */
  async inspect(buffer: Buffer): Promise<BackupInspectResult> {
    const zip = await this.loadBackupZip(buffer);
    const manifest = await this.readManifestFromZip(zip);
    const uploads: string[] = [];
    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (entry.dir || !name.startsWith(UPLOADS_PREFIX)) continue;
      const rel = name.slice(UPLOADS_PREFIX.length);
      if (rel === '' || rel.includes('..') || path.isAbsolute(rel)) continue;
      uploads.push(rel);
    }
    uploads.sort();
    return manifestToInspectView(manifest, uploads);
  }

  async restore(buffer: Buffer, confirm: string | undefined, user: RequestUser): Promise<RestoreResult> {
    if (confirm !== RESTORE_CONFIRM_TOKEN) {
      throw new BadRequestException(
        `Restore is destructive — resend with the confirmation token "${RESTORE_CONFIRM_TOKEN}" in the "confirm" field`,
      );
    }

    const zip = await this.loadBackupZip(buffer);
    const manifest = await this.readManifestFromZip(zip);

    // --- Validate DB payload ---
    const dbFile = zip.file(manifest.db);
    if (!dbFile) throw new BadRequestException('Invalid backup archive — database is missing');
    const dbBytes = await dbFile.async('nodebuffer');
    if (!looksLikeSqlite(dbBytes)) {
      throw new BadRequestException('Invalid backup archive — database is not a SQLite file');
    }

    // Open the incoming DB read-only in a throwaway location to confirm it's a
    // real, non-corrupt Campfire database (right magic bytes alone aren't enough).
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-restore-'));
    const stagedDbPath = path.join(stageDir, 'campfire.db');
    try {
      fs.writeFileSync(stagedDbPath, dbBytes);
      try {
        const probe = new Database(stagedDbPath, { readonly: true, fileMustExist: true });
        try {
          const integrity = probe.pragma('integrity_check', { simple: true });
          const hasUsers = probe
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
            .get();
          if (integrity !== 'ok' || !hasUsers) {
            throw new BadRequestException('Invalid backup archive — database failed validation');
          }
        } finally {
          probe.close();
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException('Invalid backup archive — database could not be opened');
      }

      // --- Collect + path-check uploads before touching anything ---
      const uploadEntries: Array<{ rel: string; data: Buffer }> = [];
      for (const name of Object.keys(zip.files)) {
        const entry = zip.files[name];
        if (entry.dir || !name.startsWith(UPLOADS_PREFIX)) continue;
        const rel = name.slice(UPLOADS_PREFIX.length);
        // Zip-slip guard: reject any entry that would escape the uploads root.
        if (rel === '' || rel.includes('..') || path.isAbsolute(rel)) {
          throw new BadRequestException('Invalid backup archive — unsafe upload path');
        }
        uploadEntries.push({ rel, data: await entry.async('nodebuffer') });
      }

      // --- Apply (destructive) — DB is validated, so this is the point of no return ---
      this.holder.withDatabaseClosed((dataDir) => {
        const dbPath = dbFilePath(dataDir);
        for (const suffix of ['', '-wal', '-shm']) {
          fs.rmSync(dbPath + suffix, { force: true });
        }
        fs.copyFileSync(stagedDbPath, dbPath);

        const uploads = uploadsRoot(dataDir);
        fs.rmSync(uploads, { recursive: true, force: true });
        for (const { rel, data } of uploadEntries) {
          const dest = path.join(uploads, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, data);
        }
      });

      const result: RestoreResult = {
        ok: true,
        restoredAt: nowIso(),
        dbBytes: dbBytes.length,
        uploadCount: uploadEntries.length,
      };

      // Audit against the freshly-restored DB — records that a restore happened
      // (the actor comes from the still-valid request session/token).
      await this.audit.log({
        actor: auditActor(user),
        actorRole: 'dm', // no campaign role for a server-wide action; 'dm' is the highest Role.
        action: 'server.restore',
        entityType: 'server',
        entityId: 0,
        detail: `db ${result.dbBytes}B, ${result.uploadCount} uploads`,
      });

      return result;
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  }

  private async loadBackupZip(buffer: Buffer): Promise<JSZip> {
    try {
      return await JSZip.loadAsync(buffer);
    } catch {
      throw new BadRequestException('Invalid backup archive — not a readable zip file');
    }
  }

  private async readManifestFromZip(zip: JSZip): Promise<BackupManifest> {
    const manifestFile = zip.file(MANIFEST_ENTRY);
    if (!manifestFile) throw new BadRequestException('Invalid backup archive — manifest.json is missing');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await manifestFile.async('string'));
    } catch {
      throw new BadRequestException('Invalid backup archive — manifest.json is not valid JSON');
    }
    return parseBackupManifest(parsed);
  }
}
