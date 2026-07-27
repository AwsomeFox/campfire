import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DB_HOLDER, dbFilePath, readInstallSentinel, resolveDataDir, sentinelFilePath, type DbHolder } from '../../db/db.module';

export type DiagnosticStatus = 'ok' | 'degraded' | 'failed' | 'unknown';
export interface DiagnosticCheck { status: DiagnosticStatus; code: string; message: string; checkedAt: string }
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

const now = () => new Date().toISOString();
const check = (status: DiagnosticStatus, code: string, message: string): DiagnosticCheck => ({ status, code, message, checkedAt: now() });
const bytes = (file: string): number | null => { try { return fs.statSync(file).size; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };
const DEGRADED_FREE = Number(process.env.DIAGNOSTICS_DEGRADED_FREE_BYTES ?? 2 * 1024 ** 3);
const CRITICAL_FREE = Number(process.env.DIAGNOSTICS_CRITICAL_FREE_BYTES ?? 256 * 1024 ** 2);
const LARGE_WAL = Number(process.env.DIAGNOSTICS_LARGE_WAL_BYTES ?? 512 * 1024 ** 2);

/** Bounded, safe diagnostics. Public readiness receives only its aggregate and stable codes. */
@Injectable()
export class StorageDiagnosticsService implements OnModuleInit {
  private readonly logger = new Logger(StorageDiagnosticsService.name);
  private quick = check('unknown', 'QUICK_CHECK_NOT_RUN', 'Quick integrity check has not run yet.');
  private integrity = check('unknown', 'INTEGRITY_CHECK_NOT_RUN', 'Full integrity check has not run yet.');
  private scanning = false;
  private cached: StorageDiagnostics | undefined;

  constructor(@Inject(DB_HOLDER) private readonly holder: DbHolder) {}

  onModuleInit(): void { void this.runIntegrity('quick').finally(() => { this.cached = this.snapshot(); }); }

  readiness(): { ready: boolean; status: DiagnosticStatus; checks: Record<string, DiagnosticCheck> } {
    const checks: Record<string, DiagnosticCheck> = {
      database: this.databaseCheck(), write: this.writeCheck(), schema: this.schemaCheck(), identity: this.identityCheck(), uploads: this.uploadsCheck(),
    };
    const failed = Object.values(checks).some((item) => item.status === 'failed');
    return { ready: !failed, status: failed ? 'failed' : 'ok', checks };
  }

  snapshot(): StorageDiagnostics {
    const ready = this.readiness();
    const dbFile = dbFilePath(resolveDataDir());
    let storage: StorageDiagnostics['storage'];
    let disk: DiagnosticCheck;
    try {
      const stat = fs.statfsSync(resolveDataDir());
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      const totalBytes = Number(stat.blocks) * Number(stat.bsize);
      const status: DiagnosticStatus = freeBytes <= CRITICAL_FREE ? 'failed' : freeBytes <= DEGRADED_FREE ? 'degraded' : 'ok';
      disk = check(status, status === 'failed' ? 'DISK_SPACE_CRITICAL' : status === 'degraded' ? 'DISK_SPACE_LOW' : 'DISK_SPACE_OK', status === 'ok' ? 'Disk capacity is within configured thresholds.' : 'Free disk capacity is below a configured threshold.');
      storage = { dbFileBytes: bytes(dbFile), walBytes: bytes(`${dbFile}-wal`), shmBytes: bytes(`${dbFile}-shm`), uploadsBytes: this.walk(path.join(resolveDataDir(), 'uploads')), backupsBytes: this.walk(process.env.BACKUP_DIR || path.join(resolveDataDir(), 'backups')), tempBytes: this.walk(path.join(os.tmpdir(), 'campfire')), freeBytes, totalBytes, availableBytes: freeBytes };
    } catch {
      disk = check('unknown', 'DISK_SPACE_UNKNOWN', 'Filesystem capacity is unavailable on this platform.');
      storage = { dbFileBytes: safeBytes(dbFile), walBytes: safeBytes(`${dbFile}-wal`), shmBytes: safeBytes(`${dbFile}-shm`), uploadsBytes: safeWalk(path.join(resolveDataDir(), 'uploads')), backupsBytes: safeWalk(process.env.BACKUP_DIR || path.join(resolveDataDir(), 'backups')), tempBytes: safeWalk(path.join(os.tmpdir(), 'campfire')), freeBytes: null, totalBytes: null, availableBytes: null };
    }
    const wal = storage.walBytes !== null && storage.walBytes > LARGE_WAL ? check('degraded', 'WAL_LARGE', 'Write-ahead log exceeds the configured threshold.') : check('ok', 'WAL_OK', 'Write-ahead log is within configured threshold.');
    const checks = { ...ready.checks, disk, wal };
    const statuses = Object.values(checks).map((item) => item.status);
    const status: DiagnosticStatus = statuses.includes('failed') ? 'failed' : statuses.includes('degraded') ? 'degraded' : statuses.includes('unknown') ? 'unknown' : 'ok';
    const result = { status, ready: ready.ready, checks, storage, integrity: { quickCheck: this.quick, integrityCheck: this.integrity } };
    this.cached = result;
    return result;
  }

  /** Metrics polls consume the last scan rather than walking storage each interval. */
  cachedSnapshot(): StorageDiagnostics { return this.cached ?? this.snapshot(); }

  async runIntegrity(kind: 'quick' | 'full'): Promise<DiagnosticCheck> {
    if (this.scanning) return check('degraded', 'INTEGRITY_SCAN_BUSY', 'An integrity scan is already running.');
    this.scanning = true;
    try {
      const rows = this.holder.raw.pragma(kind === 'quick' ? 'quick_check' : 'integrity_check') as Array<Record<string, unknown>>;
      const values = rows.map((row) => String(Object.values(row)[0] ?? '')).filter(Boolean);
      const result = values.every((value) => value.toLowerCase() === 'ok')
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
    const db = this.holder.raw; const old = Number(db.prepare('PRAGMA busy_timeout').pluck().get() ?? 0);
    try { db.pragma('busy_timeout = 100'); db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS health_write_probe (id INTEGER); INSERT INTO health_write_probe DEFAULT VALUES; ROLLBACK;'); return check('ok', 'WRITE_OK', 'Rollback-only write probe succeeded.'); }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} const code = String((error as { code?: string }).code ?? ''); return check('failed', code.includes('FULL') ? 'WRITE_ENOSPC' : code.includes('READONLY') ? 'WRITE_EROFS' : code.includes('BUSY') || code.includes('LOCKED') ? 'WRITE_LOCKED' : 'WRITE_FAILED', 'Rollback-only database write probe failed.'); }
    finally { try { db.pragma(`busy_timeout = ${old}`); } catch {} }
  }
  private schemaCheck(): DiagnosticCheck { try { const db = this.holder.raw; for (const table of ['__migrations', '__db_meta', 'users', 'attachments']) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return check('failed', 'SCHEMA_MISMATCH', 'Required database schema is missing.'); if (!db.prepare("SELECT value FROM __db_meta WHERE key='app_version'").get()) return check('failed', 'MIGRATION_METADATA_MISSING', 'Database migration metadata is missing.'); return check('ok', 'SCHEMA_OK', 'Required schema and migration metadata are present.'); } catch { return check('failed', 'SCHEMA_UNAVAILABLE', 'Database schema could not be validated.'); } }
  private identityCheck(): DiagnosticCheck { try { const dataDir = resolveDataDir(); const sentinel = readInstallSentinel(sentinelFilePath(dataDir)); if (!sentinel.present || !sentinel.sentinel || !fs.statSync(dbFilePath(dataDir)).isFile()) return check('failed', 'STORAGE_IDENTITY_INVALID', 'Storage identity could not be validated.'); return check('ok', 'STORAGE_IDENTITY_OK', 'Storage identity is valid.'); } catch { return check('failed', 'STORAGE_IDENTITY_INVALID', 'Storage identity could not be validated.'); } }
  private uploadsCheck(): DiagnosticCheck { try { const committed = Number(this.holder.raw.prepare("SELECT count(*) FROM attachments WHERE state = 'committed'").pluck().get() ?? 0); const root = path.join(resolveDataDir(), 'uploads'); if (!fs.existsSync(root)) return committed > 0 ? check('failed', 'UPLOADS_MISSING', 'Committed uploads are missing from storage.') : check('ok', 'UPLOADS_EMPTY', 'No committed uploads require an uploads directory.'); return check('ok', 'UPLOADS_OK', 'Uploads storage is available.'); } catch { return check('unknown', 'UPLOADS_UNKNOWN', 'Uploads storage could not be validated.'); } }
  private walk(root: string): number | null { return walk(root); }
  private persistIntegrity(kind: string, result: DiagnosticCheck): void { try { const db = this.holder.raw; db.exec('CREATE TABLE IF NOT EXISTS health_integrity_results (kind TEXT PRIMARY KEY, status TEXT NOT NULL, code TEXT NOT NULL, checked_at TEXT NOT NULL)'); db.prepare('INSERT INTO health_integrity_results (kind,status,code,checked_at) VALUES (?,?,?,?) ON CONFLICT(kind) DO UPDATE SET status=excluded.status, code=excluded.code, checked_at=excluded.checked_at').run(kind, result.status, result.code, result.checkedAt); } catch { this.logger.warn(`Could not persist ${kind} integrity result`); } }
}
function safeBytes(file: string): number | null { try { return bytes(file); } catch { return null; } }
function walk(root: string): number | null { if (!fs.existsSync(root)) return 0; let total = 0; let entries = 0; const visit = (dir: string, depth: number) => { if (depth > 12 || entries > 10_000) throw new Error('scan limit'); for (const item of fs.readdirSync(dir, { withFileTypes: true })) { entries++; const file = path.join(dir, item.name); if (item.isDirectory()) visit(file, depth + 1); else if (item.isFile()) total += fs.statSync(file).size; } }; visit(root, 0); return total; }
function safeWalk(dir: string): number | null { try { return walk(dir); } catch { return null; } }
