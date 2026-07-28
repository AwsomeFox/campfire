import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DB_HOLDER, dbFilePath, MIGRATION_NAMES, readInstallSentinel, resolveDataDir, sentinelFilePath, type DbHolder } from '../../db/db.module';

export type DiagnosticStatus = 'ok' | 'degraded' | 'failed' | 'unknown';
export interface DiagnosticCheck { status: DiagnosticStatus; code: string; message: string; checkedAt: string | null }
export interface StorageDiagnostics {
  status: DiagnosticStatus;
  ready: boolean;
  checks: Record<string, DiagnosticCheck>;
  storage: {
    dbFileBytes: number | null; walBytes: number | null; shmBytes: number | null;
    uploadsBytes: number | null; backupsBytes: number | null; tempBytes: number | null;
    freeBytes: number | null; totalBytes: number | null; availableBytes: number | null;
  };
  integrity: { quickCheck: DiagnosticCheck; integrityCheck: DiagnosticCheck };
}
/** Narrow host boundary used by diagnostics and deterministic fault-injection tests. */
export interface StorageDiagnosticsProbe {
  dataDir(): string;
  statfs(dir: string): ReturnType<typeof fs.statfsSync>;
  exists(file: string): boolean;
  stat(file: string): fs.Stats;
  readSentinel(file: string): ReturnType<typeof readInstallSentinel>;
  /** Kept injectable so tests can model ENOSPC/EROFS/locks without mutating a host DB. */
  writeProbe?(db: DbHolder['raw']): void;
}
export const STORAGE_DIAGNOSTICS_PROBE = Symbol('STORAGE_DIAGNOSTICS_PROBE');
const hostProbe: StorageDiagnosticsProbe = {
  dataDir: () => resolveDataDir(),
  statfs: (dir) => fs.statfsSync(dir),
  exists: (file) => fs.existsSync(file),
  stat: (file) => fs.statSync(file),
  readSentinel: (file) => readInstallSentinel(file),
};

const now = () => new Date().toISOString();
const check = (status: DiagnosticStatus, code: string, message: string, checkedAt: string | null = now()): DiagnosticCheck => ({ status, code, message, checkedAt });
const bytes = (file: string): number | null => { try { return fs.statSync(file).size; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };
const DEGRADED_FREE = Number(process.env.DIAGNOSTICS_DEGRADED_FREE_BYTES ?? 2 * 1024 ** 3);
const CRITICAL_FREE = Number(process.env.DIAGNOSTICS_CRITICAL_FREE_BYTES ?? 256 * 1024 ** 2);
const LARGE_WAL = Number(process.env.DIAGNOSTICS_LARGE_WAL_BYTES ?? 512 * 1024 ** 2);
/** Throttle BEGIN IMMEDIATE write probes on unauthenticated /readyz without masking later DB failures. */
const writeProbeCacheMs = () => Number(process.env.DIAGNOSTICS_WRITE_PROBE_CACHE_MS ?? 5_000);
/** Admin metrics polls reuse a scan, but must not freeze at boot forever. */
const snapshotCacheMs = () => Number(process.env.DIAGNOSTICS_SNAPSHOT_CACHE_MS ?? 60_000);

/** Bounded, safe diagnostics. Public readiness receives only its aggregate and stable codes. */
@Injectable()
export class StorageDiagnosticsService implements OnModuleInit {
  private readonly logger = new Logger(StorageDiagnosticsService.name);
  private quick = check('unknown', 'QUICK_CHECK_NOT_RUN', 'Quick integrity check has not run yet.', null);
  private integrity = check('unknown', 'INTEGRITY_CHECK_NOT_RUN', 'Full integrity check has not run yet.', null);
  private scanning = false;
  private cached: StorageDiagnostics | undefined;
  private cachedAt = 0;
  private writeProbeCache: { at: number; result: DiagnosticCheck } | undefined;

  constructor(
    @Inject(DB_HOLDER) private readonly holder: DbHolder,
    @Optional() @Inject(STORAGE_DIAGNOSTICS_PROBE) injectedProbe?: StorageDiagnosticsProbe,
  ) {
    this.probe = { ...hostProbe, ...injectedProbe };
    this.loadIntegrity();
  }
  private readonly probe: StorageDiagnosticsProbe;

  onModuleInit(): void { void this.runIntegrity('quick').finally(() => { this.snapshot(); }); }

  readiness(): { ready: boolean; status: DiagnosticStatus; checks: Record<string, DiagnosticCheck> } {
    const checks: Record<string, DiagnosticCheck> = {
      database: this.databaseCheck(), write: this.writeCheck(), schema: this.schemaCheck(), identity: this.identityCheck(), uploads: this.uploadsCheck(),
    };
    const disk = this.diskCheck();
    const wal = this.walCheck();
    checks.disk = disk; checks.wal = wal; checks.quickCheck = this.quick;
    const failed = Object.values(checks).some((item) => item.status === 'failed');
    const degraded = !failed && Object.values(checks).some((item) => item.status === 'degraded' || item.status === 'unknown');
    return { ready: !failed, status: failed ? 'failed' : degraded ? 'degraded' : 'ok', checks };
  }

  snapshot(): StorageDiagnostics {
    const ready = this.readiness();
    const dbFile = dbFilePath(this.probe.dataDir());
    // Disk capacity and directory walks are independent: a large uploads tree must
    // not discard a valid statfs-derived free-space result (scan-limit throws).
    const disk = this.diskCheck();
    let storage: StorageDiagnostics['storage'];
    try {
      const stat = this.probe.statfs(this.probe.dataDir());
      const freeBytes = Number(stat.bfree) * Number(stat.bsize);
      const availableBytes = Number(stat.bavail) * Number(stat.bsize);
      const totalBytes = Number(stat.blocks) * Number(stat.bsize);
      storage = {
        dbFileBytes: safeBytes(dbFile),
        walBytes: safeBytes(`${dbFile}-wal`),
        shmBytes: safeBytes(`${dbFile}-shm`),
        uploadsBytes: safeWalk(path.join(this.probe.dataDir(), 'uploads')),
        backupsBytes: safeWalk(process.env.BACKUP_DIR || path.join(this.probe.dataDir(), 'backups')),
        tempBytes: this.ownedTempBytes(),
        freeBytes,
        totalBytes,
        availableBytes,
      };
    } catch {
      storage = {
        dbFileBytes: safeBytes(dbFile),
        walBytes: safeBytes(`${dbFile}-wal`),
        shmBytes: safeBytes(`${dbFile}-shm`),
        uploadsBytes: safeWalk(path.join(this.probe.dataDir(), 'uploads')),
        backupsBytes: safeWalk(process.env.BACKUP_DIR || path.join(this.probe.dataDir(), 'backups')),
        tempBytes: null,
        freeBytes: null,
        totalBytes: null,
        availableBytes: null,
      };
    }
    const wal = this.walCheck(storage.walBytes);
    const checks = { ...ready.checks, disk, wal };
    const statuses = Object.values(checks).map((item) => item.status);
    const status: DiagnosticStatus = statuses.includes('failed') ? 'failed' : statuses.includes('degraded') ? 'degraded' : statuses.includes('unknown') ? 'unknown' : 'ok';
    const result = { status, ready: ready.ready, checks, storage, integrity: { quickCheck: this.quick, integrityCheck: this.integrity } };
    this.cached = result;
    this.cachedAt = Date.now();
    return result;
  }

  /**
   * Metrics polls consume the last scan rather than walking storage each interval.
   * Once a scan exists, refresh it after DIAGNOSTICS_SNAPSHOT_CACHE_MS so the admin
   * dashboard does not freeze at boot-time disk/upload figures forever.
   */
  cachedSnapshot(): StorageDiagnostics {
    if (this.cached && Date.now() - this.cachedAt >= snapshotCacheMs()) return this.snapshot();
    return this.cached ?? { status: 'unknown', ready: false, checks: { cache: check('unknown', 'DIAGNOSTICS_NOT_SCANNED', 'Diagnostics scan has not completed.') }, storage: { dbFileBytes: null, walBytes: null, shmBytes: null, uploadsBytes: null, backupsBytes: null, tempBytes: null, freeBytes: null, totalBytes: null, availableBytes: null }, integrity: { quickCheck: this.quick, integrityCheck: this.integrity } };
  }

  async runIntegrity(kind: 'quick' | 'full'): Promise<DiagnosticCheck> {
    if (this.scanning) return check('degraded', 'INTEGRITY_SCAN_BUSY', 'An integrity scan is already running.');
    this.scanning = true;
    try {
      const rows = this.holder.raw.pragma(kind === 'quick' ? 'quick_check' : 'integrity_check') as Array<Record<string, unknown>>;
      const values = rows.map((row) => String(Object.values(row)[0] ?? '')).filter(Boolean);
      // SQLite returns at least one row for a successful pragma. An empty result
      // means the driver/connection did not give us a trustworthy answer.
      const result = values.length > 0 && values.every((value) => value.toLowerCase() === 'ok')
        ? check('ok', kind === 'quick' ? 'QUICK_CHECK_OK' : 'INTEGRITY_CHECK_OK', 'SQLite integrity check completed successfully.')
        : check('failed', kind === 'quick' ? 'QUICK_CHECK_FAILED' : 'INTEGRITY_CHECK_FAILED', 'SQLite integrity check reported corruption.');
      if (kind === 'quick') this.quick = result; else this.integrity = result;
      this.persistIntegrity(kind, result);
      return result;
    } catch {
      const result = check('failed', kind === 'quick' ? 'QUICK_CHECK_ERROR' : 'INTEGRITY_CHECK_ERROR', 'SQLite integrity check could not complete.');
      if (kind === 'quick') this.quick = result; else this.integrity = result;
      return result;
    } finally { this.scanning = false; }
  }

  private databaseCheck(): DiagnosticCheck { try { this.holder.raw.prepare('SELECT 1').get(); return check('ok', 'DATABASE_OK', 'Database responds to a bounded query.'); } catch { return check('failed', 'DATABASE_UNAVAILABLE', 'Database is unavailable.'); } }
  private writeCheck(): DiagnosticCheck {
    if (this.writeProbeCache && Date.now() - this.writeProbeCache.at < writeProbeCacheMs()) return this.writeProbeCache.result;
    const db = this.holder.raw; let old = 0;
    let result: DiagnosticCheck;
    try {
      old = Number(db.prepare('PRAGMA busy_timeout').pluck().get() ?? 0);
      db.pragma('busy_timeout = 100');
      if (this.probe.writeProbe) this.probe.writeProbe(db);
      else db.exec("BEGIN IMMEDIATE; UPDATE health_write_probe SET touched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1; ROLLBACK;");
      result = check('ok', 'WRITE_OK', 'Rollback-only write probe succeeded.');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore nested rollback failures */ }
      const code = String((error as { code?: string }).code ?? '');
      result = check('failed', code.includes('FULL') ? 'WRITE_ENOSPC' : code.includes('READONLY') ? 'WRITE_EROFS' : code.includes('BUSY') || code.includes('LOCKED') ? 'WRITE_LOCKED' : 'WRITE_FAILED', 'Rollback-only database write probe failed.');
    } finally {
      try { db.pragma(`busy_timeout = ${old}`); } catch { /* ignore restore failures */ }
    }
    this.writeProbeCache = { at: Date.now(), result };
    return result;
  }
  private schemaCheck(): DiagnosticCheck { try { const db = this.holder.raw; for (const table of ['__migrations', '__db_meta', 'users', 'attachments']) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return check('failed', 'SCHEMA_MISMATCH', 'Required database schema is missing.'); const applied = new Set((db.prepare('SELECT name FROM __migrations').all() as Array<{ name: string }>).map((row) => row.name)); if (MIGRATION_NAMES.some((name) => !applied.has(name))) return check('failed', 'MIGRATION_MISSING', 'Required database migration is missing.'); const version = db.prepare("SELECT value FROM __db_meta WHERE key='app_version'").pluck().get(); if (typeof version !== 'string' || version.length === 0) return check('failed', 'MIGRATION_METADATA_MISSING', 'Database migration metadata is missing.'); return check('ok', 'SCHEMA_OK', 'Required schema and migration metadata are present.'); } catch { return check('failed', 'SCHEMA_UNAVAILABLE', 'Database schema could not be validated.'); } }
  /**
   * The install sentinel identifies the physical DATA_DIR. `server_meta` is a
   * separate logical DB/cache identity, generated lazily, so it must never be
   * compared to the mount sentinel here.
   */
  private identityCheck(): DiagnosticCheck { try { const dataDir = this.probe.dataDir(); const sentinel = this.probe.readSentinel(sentinelFilePath(dataDir)); if (!sentinel.present || !sentinel.sentinel || !this.probe.stat(dbFilePath(dataDir)).isFile()) return check('failed', 'STORAGE_IDENTITY_INVALID', 'Storage identity could not be validated.'); return check('ok', 'STORAGE_IDENTITY_OK', 'Storage identity is valid.'); } catch { return check('failed', 'STORAGE_IDENTITY_INVALID', 'Storage identity could not be validated.'); } }
  private uploadsCheck(): DiagnosticCheck {
    try {
      // Bounded existence probe — count(*) would scan a large attachments table on every /readyz.
      const committed = this.holder.raw.prepare("SELECT 1 FROM attachments WHERE state = 'committed' LIMIT 1").get();
      const root = path.join(this.probe.dataDir(), 'uploads');
      if (!this.probe.exists(root)) {
        return committed
          ? check('failed', 'UPLOADS_MISSING', 'Committed uploads are missing from storage.')
          : check('ok', 'UPLOADS_EMPTY', 'No committed uploads require an uploads directory.');
      }
      return check('ok', 'UPLOADS_OK', 'Uploads storage is available.');
    } catch {
      return check('unknown', 'UPLOADS_UNKNOWN', 'Uploads storage could not be validated.');
    }
  }
  private diskCheck(): DiagnosticCheck {
    try {
      const stat = this.probe.statfs(this.probe.dataDir());
      // Use bavail (space available to the process), matching readiness and snapshot.
      const available = Number(stat.bavail) * Number(stat.bsize);
      return available <= CRITICAL_FREE
        ? check('failed', 'DISK_SPACE_CRITICAL', 'Free disk capacity is critically low.')
        : available <= DEGRADED_FREE
          ? check('degraded', 'DISK_SPACE_LOW', 'Free disk capacity is below warning threshold.')
          : check('ok', 'DISK_SPACE_OK', 'Disk capacity is within configured thresholds.');
    } catch {
      return check('unknown', 'DISK_SPACE_UNKNOWN', 'Filesystem capacity is unavailable on this platform.');
    }
  }
  private walCheck(value = safeBytes(`${dbFilePath(this.probe.dataDir())}-wal`)): DiagnosticCheck { return value !== null && value > LARGE_WAL ? check('degraded', 'WAL_LARGE', 'Write-ahead log exceeds the configured threshold.') : check('ok', 'WAL_OK', 'Write-ahead log is within configured threshold.'); }
  private ownedTempBytes(): number | null { try { const prefixes = ['campfire-backup-', 'campfire-upload-', 'campfire-stage-']; return fs.readdirSync(os.tmpdir(), { withFileTypes: true }).filter((entry) => entry.isDirectory() && prefixes.some((prefix) => entry.name.startsWith(prefix))).reduce((total, entry) => total + (walk(path.join(os.tmpdir(), entry.name)) ?? 0), 0); } catch { return null; } }
  private loadIntegrity(): void { try { for (const row of this.holder.raw.prepare('SELECT kind, status, code, checked_at FROM health_integrity_results').all() as Array<{ kind: string; status: DiagnosticStatus; code: string; checked_at: string }>) { const value = { status: row.status, code: row.code, message: 'Cached integrity result.', checkedAt: row.checked_at }; if (row.kind === 'quick') this.quick = value; if (row.kind === 'full') this.integrity = value; } } catch { /* bootstrap may not exist on an externally damaged database */ } }
  private persistIntegrity(kind: string, result: DiagnosticCheck): void { try { this.holder.raw.prepare('INSERT INTO health_integrity_results (kind,status,code,checked_at) VALUES (?,?,?,?) ON CONFLICT(kind) DO UPDATE SET status=excluded.status, code=excluded.code, checked_at=excluded.checked_at').run(kind, result.status, result.code, result.checkedAt); } catch { this.logger.warn(`Could not persist ${kind} integrity result`); } }
}
function safeBytes(file: string): number | null { try { return bytes(file); } catch { return null; } }
function walk(root: string): number | null { if (!fs.existsSync(root)) return 0; let total = 0; let entries = 0; const visit = (dir: string, depth: number) => { if (depth > 12 || entries > 10_000) throw new Error('scan limit'); for (const item of fs.readdirSync(dir, { withFileTypes: true })) { entries++; const file = path.join(dir, item.name); if (item.isDirectory()) visit(file, depth + 1); else if (item.isFile()) total += fs.statSync(file).size; } }; visit(root, 0); return total; }
function safeWalk(dir: string): number | null { try { return walk(dir); } catch { return null; } }
