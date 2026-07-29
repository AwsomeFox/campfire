import crypto, { createHash, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Transform, type Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import {
  BackupArchiveReader,
  MAX_ARCHIVE_COMPRESSED_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_ENTRY_UNCOMPRESSED_BYTES,
  MAX_KEY_ENVELOPE_BYTES,
  MAX_MANIFEST_BYTES,
} from './backup-archive-reader';
import { DB_HOLDER, DbHolder, dbFilePath, resolveDataDir } from '../../db/db.module';
import { decryptSecret } from '../../common/crypto';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AttachmentsService } from '../attachments/attachments.service';
import { SettingsService } from '../settings/settings.service';
import {
  BACKUP_CADENCE_KEY,
  isBackupOverdue,
  parseBackupIntervalHours,
  type BackupCadenceState,
  type BackupCadenceMetrics,
} from './backup-cadence';
import {
  estimateNextBackupBytes,
  parseBackupMinFreeBytes,
  parseBackupRetentionPolicy,
  planBackupRetention,
  type BackupRetentionCandidate,
  type BackupRetentionPolicy,
} from './backup-retention';
import {
  BACKUP_APP,
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  BACKUP_ORPHAN_LIST_CAP,
  CURRENT_SCHEMA_REVISION,
  DB_ENTRY,
  manifestToInspectView,
  parseBackupManifest,
  serializeBackupManifest,
  serverAppVersion,
  type AiKeySource,
  type BackupAttachmentRecord,
  type BackupInspectResult,
  type BackupManifest,
  type BackupReconciliation,
} from './backup-manifest';
import {
  KEY_ENVELOPE_ENTRY,
  KEY_ENVELOPE_MIN_PASSPHRASE_LEN,
  decryptKeyfile,
  encryptKeyfile,
  parseKeyEnvelopeJson,
} from './backup-key-envelope';
import {
  applyRestoredState,
  type RestoreProgressPhase,
} from './backup-restore-apply';

export { BACKUP_APP, BACKUP_KIND, BACKUP_FORMAT_VERSION };
export type { BackupManifest, BackupInspectResult };

export { DB_ENTRY };

/** Zip entry names inside a backup archive. */
export const MANIFEST_ENTRY = 'manifest.json';
const UPLOADS_PREFIX = 'uploads/';
const SCHEDULED_BACKUP_PREFIX = 'campfire-backup-';
const SCHEDULED_BACKUP_SUFFIX = '.zip';
const BACKUP_SCHEDULER_POLL_MS = 60 * 1000;
const BACKUP_FAILURE_BACKOFF_MIN_MS = 5 * 60 * 1000;
const BACKUP_FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

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

export type { RestoreProgressPhase };

export interface RestoreResult {
  ok: true;
  restoredAt: string;
  dbBytes: number;
  uploadCount: number;
  /** #497: ordered phases completed during the restore (including rollback when applicable). */
  phases: RestoreProgressPhase[];
}

/** One on-disk scheduled backup archive listed by {@link BackupService.getStatus}. */
export interface BackupOnDiskEntry {
  name: string;
  bytes: number;
  mtime: string;
}

export interface BackupDiskStatus {
  freeBytes: number;
  totalBytes: number;
  reserveBytes: number;
  /** Archive estimate, or the staging-plus-archive peak when both paths share a filesystem. */
  estimatedNextBytes: number;
  lowSpace: boolean;
}

type ScheduledArchiveVerification =
  | { verified: true; checksum: string; clean: boolean; error: '' }
  | { verified: false; checksum: string | null; error: string };

export interface BackupRetentionStatus {
  policy: BackupRetentionPolicy;
  archiveCount: number;
  totalBytes: number;
  protectedLastGoodName: string | null;
  pruneCount: number;
  prunedBytes: number;
  lastPruneAt: string | null;
  lastPruneError: string;
}

/** Operator-facing scheduled-backup status (issue #444). */
export interface BackupStatus {
  scheduleEnabled: boolean;
  intervalHours: number;
  backupDir: string;
  cadence: BackupCadenceState | null;
  disk: BackupDiskStatus | null;
  retention: BackupRetentionStatus;
  alerts: string[];
  onDisk: BackupOnDiskEntry[];
}

function uploadsRoot(dataDir: string): string {
  return path.join(dataDir, 'uploads');
}

/** #496: the auto-generated AI credential encryption keyfile. Kept in sync with
 *  {@link AI_CONFIG_KEYFILE} in the ai-provider-config service. Duplicated here
 *  as a plain string to avoid a cross-module dependency (backup already sits
 *  above provider config in the module graph). */
const AI_KEYFILE_NAME = 'ai-config.key';

/** Options accepted by {@link BackupService.buildBackup}. */
export interface BuildBackupOptions {
  /** #496: optional operator-supplied passphrase for wrapping the
   *  auto-generated `ai-config.key` in an encrypted envelope. Ignored when the
   *  server is running with `AI_CONFIG_KEY` set — the operator manages that
   *  secret out-of-band. When the passphrase is present but the running server
   *  has no keyfile to include (e.g. env-managed or no AI providers ever
   *  configured), it is silently ignored. */
  keyPassphrase?: string;
  /** Abort archive generation (for example when an HTTP client disconnects). */
  signal?: AbortSignal;
  /**
   * Invoked once, immediately before the first archive byte reaches `output`.
   * HTTP callers use it to commit download headers only when bytes are genuinely on
   * their way, so a failure during snapshot/reconciliation still yields a normal error
   * response rather than a JSON body wearing `Content-Type: application/zip`.
   */
  onFirstByte?: () => void;
}

/** Options accepted by {@link BackupService.restore}. */
export interface RestoreOptions {
  /** #496: operator-supplied passphrase used to unwrap the AI keyfile
   *  envelope (`ai-config.key.env.json`) inside the archive. Required when
   *  the archive carries an envelope; ignored when it does not. */
  keyPassphrase?: string;
  /** #497: optional progress callback as each restore phase completes. */
  onProgress?: (phase: RestoreProgressPhase) => void;
  /** Cancels archive I/O and removes all restore staging before live data changes. */
  signal?: AbortSignal;
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

function scheduledBackupName(stamp: string): string {
  return `${SCHEDULED_BACKUP_PREFIX}${stamp}${SCHEDULED_BACKUP_SUFFIX}`;
}

function isScheduledBackupArchiveName(name: string): boolean {
  return name.startsWith(SCHEDULED_BACKUP_PREFIX) && name.endsWith(SCHEDULED_BACKUP_SUFFIX);
}

function safeFileBytes(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Read an attachment's size for capture/reconciliation. Unlike the best-effort
 * size helper above, this preserves permission and I/O failures: only a proven
 * ENOENT means the attachment disappeared.
 */
export function captureFileBytesOrNullIfMissing(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

function lastScheduledAttemptAlert(lastError: string): string {
  const lowDiskSkipPrefix = 'Scheduled backup skipped: low disk space';
  if (lastError.toLowerCase().startsWith(lowDiskSkipPrefix.toLowerCase())) {
    return `Last scheduled backup skipped: ${lastError.slice('Scheduled backup skipped: '.length)}`;
  }
  return `Last scheduled backup failed: ${lastError}`;
}

function looksLikeSqlite(buf: Buffer): boolean {
  return buf.length >= SQLITE_MAGIC.length && buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC);
}

/** Hash a file without retaining its contents in the V8 heap. */
async function hashFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const source = fs.createReadStream(filePath);
  source.on('data', (chunk: string | Buffer) => {
    const bytesChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += bytesChunk.length;
    hash.update(bytesChunk);
  });
  await finished(source);
  return { bytes, sha256: hash.digest('hex') };
}

/** Keep the historical bounded retry contract for files rewritten during backup. */
export const MAX_ATTACHMENT_RETRIES = 3;

export class AttachmentCaptureChangedError extends Error {
  constructor(readonly sourcePath: string) {
    super(`Attachment changed during capture after ${MAX_ATTACHMENT_RETRIES} attempts: ${sourcePath}`);
  }
}

/** Make an immutable per-run attachment copy while calculating its manifest hash. */
async function stageAndHashFile(
  sourcePath: string,
  stagedPath: string,
  signal?: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const tap = new PassThrough();
  tap.on('data', (chunk: Buffer) => { bytes += chunk.length; hash.update(chunk); });
  fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
  await pipeline(
    fs.createReadStream(sourcePath),
    tap,
    fs.createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }),
    { signal },
  );
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * Stage an attachment only when an attempt observes a stable source size before
 * and after streaming it. Failed attempts remove their partial/stale stage so
 * archiver can never consume bytes from an unstable capture.
 */
export async function stageAndHashFileWithRetry(
  sourcePath: string,
  stagedPath: string,
  signal?: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
  for (let attempt = 0; attempt < MAX_ATTACHMENT_RETRIES; attempt += 1) {
    assertBackupNotCancelled(signal);
    const before = captureFileBytesOrNullIfMissing(sourcePath);
    if (before === null) {
      const error = new Error(`Attachment disappeared during capture: ${sourcePath}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    await fs.promises.rm(stagedPath, { force: true });
    try {
      const captured = await stageAndHashFile(sourcePath, stagedPath, signal);
      const after = captureFileBytesOrNullIfMissing(sourcePath);
      if (after === null) {
        const error = new Error(`Attachment disappeared during capture: ${sourcePath}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      if (before === after && captured.bytes === before) return captured;
    } catch (err) {
      await fs.promises.rm(stagedPath, { force: true });
      throw err;
    }
    await fs.promises.rm(stagedPath, { force: true });
    assertBackupNotCancelled(signal);
  }
  throw new AttachmentCaptureChangedError(sourcePath);
}

function assertBackupNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Backup generation cancelled');
}

function assertRestoreNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BadRequestException('Restore was cancelled before it was applied');
  }
}

/** Normalize on-disk keyfile bytes (64-hex UTF-8) or raw 32-byte material. */
function aiKeyMaterialToBuffer(material: Buffer): Buffer {
  const asText = material.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(asText)) return Buffer.from(asText, 'hex');
  return material;
}

function countAiCredentialsInSnapshot(snapshotPath: string): number | null {
  try {
    const probe = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      const hasTable = probe
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_provider_configs'")
        .get();
      if (!hasTable) return 0;
      const row = probe
        .prepare(
          'SELECT COUNT(*) AS n FROM ai_provider_configs WHERE encrypted_api_key IS NOT NULL',
        )
        .get() as { n: number };
      return row?.n ?? 0;
    } finally {
      probe.close();
    }
  } catch {
    return null;
  }
}

/** #496: Kept in sync with AI_CONFIG_KEY_SALT in ai-provider-config.service.ts. */
const AI_CONFIG_KEY_SALT = 'campfire:ai-provider-config:v1';

/**
 * #496: Derive the key that `AiProviderConfigService` will use on THIS host
 * from `AI_CONFIG_KEY`. Mirrors `resolveAiConfigKey` in ai-provider-config.service.ts
 * (duplicated to avoid a circular dependency and to keep the logic local to restore).
 */
function deriveEnvManagedKey(): Buffer {
  const env = (process.env.AI_CONFIG_KEY ?? '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(env)) return Buffer.from(env, 'hex');
  return scryptSync(env, AI_CONFIG_KEY_SALT, 32);
}

/** #496: prove staged credentials decrypt with the restored envelope key before overwriting live data. */
function validateStagedAiCredentialDecryptability(stagedDbPath: string, key: Buffer): void {
  const probe = new Database(stagedDbPath, { readonly: true, fileMustExist: true });
  try {
    const row = probe
      .prepare(
        "SELECT encrypted_api_key AS encryptedApiKey FROM ai_provider_configs WHERE encrypted_api_key IS NOT NULL LIMIT 1",
      )
      .get() as { encryptedApiKey: string } | undefined;
    if (!row?.encryptedApiKey) return;
    try {
      decryptSecret(row.encryptedApiKey, key);
    } catch {
      throw new BadRequestException(
        'Invalid backup archive — stored AI credentials cannot be decrypted with the restored encryption key',
      );
    }
  } finally {
    probe.close();
  }
}

/**
 * The single archive lane is already held by another whole-server operation.
 *
 * This is a *deferral*, not a fault: an interactive download and a scheduled run
 * simply cannot overlap. It is a distinct type so schedule-driven callers can tell
 * "come back shortly" apart from "this backup did not work", instead of matching on
 * a message. Stamping contention as a failure would raise a false backup alert and
 * push the next run out by the exponential backoff.
 */
export class ArchiveOperationBusyError extends ServiceUnavailableException {}

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
  /** Whole-server archive creation and destructive restore share one serialized lane. */
  private archiveOperation: 'backup' | 'restore' | null = null;

  constructor(
    @Inject(DB_HOLDER) private readonly holder: DbHolder,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly attachments: AttachmentsService,
    private readonly aiProviderConfig: AiProviderConfigService,
  ) {}

  private beginArchiveOperation(kind: 'backup' | 'restore'): void {
    if (this.archiveOperation) {
      throw new ArchiveOperationBusyError(
        `A whole-server ${this.archiveOperation} operation is already in progress; retry shortly`,
      );
    }
    this.archiveOperation = kind;
  }

  private endArchiveOperation(kind: 'backup' | 'restore'): void {
    if (this.archiveOperation === kind) this.archiveOperation = null;
  }

  /**
   * #496: Detect where the running server sourced its AI credential
   * encryption key at backup time. This is a lightweight probe of the
   * environment + filesystem — the actual key material is not read or
   * touched unless the caller opts into including the encrypted envelope
   * via {@link buildBackup}'s `keyPassphrase`.
   */
  private detectAiKeySource(dataDir: string): { source: AiKeySource; keyfilePath: string | null } {
    if (process.env.AI_CONFIG_KEY && process.env.AI_CONFIG_KEY.trim().length > 0) {
      return { source: 'env', keyfilePath: null };
    }
    const keyfile = path.join(dataDir, AI_KEYFILE_NAME);
    return { source: 'keyfile', keyfilePath: fs.existsSync(keyfile) ? keyfile : null };
  }

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
      if (this.isScheduledRunDue(cadence, intervalMs)) {
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
      void this.runScheduledBackupIfDue(intervalMs).catch((err) => {
        this.logger.error(`Scheduled backup failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, Math.min(intervalMs, BACKUP_SCHEDULER_POLL_MS));
    timer.unref();
  }

  private backupDir(): string {
    return process.env.BACKUP_DIR || path.join(resolveDataDir(), 'backups');
  }

  private isScheduledRunDue(cadence: BackupCadenceState | null, intervalMs: number): boolean {
    if (!cadence) return true;
    const nextMs = Date.parse(cadence.nextRunAt);
    if (!Number.isNaN(nextMs)) return Date.now() >= nextMs;
    return isBackupOverdue(cadence.lastAttemptAt, intervalMs);
  }

  private async runScheduledBackupIfDue(intervalMs: number): Promise<void> {
    const cadence = await this.readCadence();
    if (!this.isScheduledRunDue(cadence, intervalMs)) return;
    await this.runScheduledBackup(intervalMs);
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
    let previous: BackupCadenceState | null = null;
    let disk: BackupDiskStatus | null = null;
    let estimatedBytes = 0;
    try {
      previous = await this.readCadence();
      // An interactive backup or restore owns the same archive lane. This is
      // expected coordination, not a failed scheduled attempt. Check before
      // disk preflight so the active operation's temporary staging cannot turn
      // a deferral into a false low-space failure and cadence backoff.
      if (this.archiveOperation) {
        this.logger.warn(
          `Scheduled backup deferred: whole-server ${this.archiveOperation} operation is already in progress`,
        );
        return;
      }
      const retentionPolicy = parseBackupRetentionPolicy();
      const minFreeBytes = parseBackupMinFreeBytes();
      const dir = this.backupDir();
      const diskEstimate = this.scheduledBackupDiskEstimate(dir, previous?.lastSize ?? null);
      estimatedBytes = diskEstimate.archiveBytes;
      disk = this.probeDisk(dir, minFreeBytes, diskEstimate.requiredBytes);
      fs.mkdirSync(dir, { recursive: true });
      disk = this.probeDisk(dir, minFreeBytes, diskEstimate.requiredBytes);
      if (disk && disk.lowSpace) {
        const message =
          `Scheduled backup skipped: low disk space in BACKUP_DIR ` +
          `(free ${disk.freeBytes}B, estimate ${disk.estimatedNextBytes}B, reserve ${disk.reserveBytes}B)`;
        await this.writeFailureCadence(previous, attemptAt, intervalMs, message, disk, estimatedBytes);
        this.logger.warn(message);
        return;
      }
      // Retain this second check as the atomic guard against an interactive
      // operation beginning while the disk preflight was running.
      if (this.archiveOperation) {
        this.logger.warn(
          `Scheduled backup deferred: whole-server ${this.archiveOperation} operation is already in progress`,
        );
        return;
      }
      // #496: Scheduled backups pick up a passphrase from BACKUP_KEY_PASSPHRASE
      // so an unattended cron produces credential-portable archives when the
      // server is running with the auto-generated keyfile. Empty / unset means
      // no envelope (backward compatible).
      const scheduledPassphrase = process.env.BACKUP_KEY_PASSPHRASE?.trim();
      const stamp = attemptAt.replace(/[:.]/g, '-');
      const archiveName = scheduledBackupName(stamp);
      const filePath = path.join(dir, archiveName);
      // Same-filesystem temporary file means a completed archive becomes visible
      // atomically. Interrupted runs leave only a removable .partial artifact.
      const partialPath = path.join(dir, `.${archiveName}.${crypto.randomUUID()}.partial`);
      const partialOutput = fs.createWriteStream(partialPath, { flags: 'wx', mode: 0o600 });
      // Handle failures that occur before buildBackup reaches pipeline(), where
      // it would otherwise attach the stream's error handling.
      partialOutput.on('error', () => undefined);
      try {
        await this.buildBackup(
          scheduledPassphrase ? { keyPassphrase: scheduledPassphrase } : undefined,
          partialOutput,
        );
        // fsync requires a writable descriptor on some platforms/filesystems.
        const descriptor = fs.openSync(partialPath, 'r+');
        let size: number;
        try {
          fs.fsyncSync(descriptor);
          // The file is durable now. Use its descriptor metadata for cadence
          // size instead of making a second full pass solely to count bytes.
          size = fs.fstatSync(descriptor).size;
        } finally { fs.closeSync(descriptor); }
        // Verify BEFORE publishing the final name. Renaming first would leave an archive
        // that failed verification sitting under a name indistinguishable from a good
        // scheduled backup — the inner finally only removes `partialPath` — and an
        // unrestorable archive that looks healthy is the worst outcome a backup can have.
        // Verifying here also makes the atomicity note above true: a failed run leaves
        // only the removable `.partial`.
        const verification = await this.verifyScheduledArchive(partialPath);
        if (!verification.verified) {
          throw new Error(`Scheduled backup failed verification after write: ${verification.error}`);
        }
        // This is guaranteed by ScheduledArchiveVerification, but retain a
        // runtime guard so a future/mock verifier cannot publish a cadence row
        // with a null checksum.
        if (!verification.checksum) {
          throw new Error('Scheduled backup verification succeeded without a checksum');
        }
        fs.renameSync(partialPath, filePath);
        const checksum = verification.checksum;
        if (!verification.clean) {
          const message =
            `Scheduled backup archived but is incomplete (${filePath}); preserving the prior last-known-good archive.`;
          // A missing upload must not erase the scheduled archive or block future
          // attempts, but an incomplete archive is not a restore-complete success.
          // Keep the prior known-good cadence record and skip retention so it cannot
          // be displaced by the recoverable-but-partial archive.
          await this.writeFailureCadence(previous, attemptAt, intervalMs, message, disk, estimatedBytes);
          this.logger.warn(message);
          return;
        }
        const prune = await this.pruneVerifiedScheduledBackups(dir, retentionPolicy, archiveName, checksum, filePath);
        const nextRunAt = new Date(Date.now() + intervalMs).toISOString();
        const metrics = this.metricsAfterSuccess(previous?.metrics, disk, estimatedBytes, prune);
        await this.writeCadence({
          lastAttemptAt: attemptAt,
          lastSuccessAt: attemptAt,
          nextRunAt,
          lastSize: size,
          lastChecksum: checksum,
          lastError: '',
          lastArchiveName: archiveName,
          lastVerifiedAt: attemptAt,
          consecutiveFailures: 0,
          metrics,
        });
        this.logger.log(
          `Scheduled backup written: ${filePath} (${size} bytes, sha256 ${checksum.slice(0, 16)}…); ` +
            `pruned ${prune.count} archive(s), ${prune.bytes} bytes; next run ${nextRunAt}`,
        );
      } finally {
        if (!partialOutput.destroyed && !partialOutput.writableFinished) partialOutput.destroy();
        await finished(partialOutput, { cleanup: true }).catch(() => undefined);
        fs.rmSync(partialPath, { force: true });
      }
    } catch (err) {
      if (err instanceof ArchiveOperationBusyError) {
        // An interactive download or restore holds the archive lane. Recording this as
        // a failed attempt would invent a backup alert out of a routine admin download
        // and delay the real run by the failure backoff. Leave the cadence row — and
        // therefore nextRunAt — untouched so the next scheduler poll simply retries
        // once the lane frees.
        this.logger.warn(`Scheduled backup deferred: ${err.message}`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // Stamp the attempt even on failure so the overdue check on the next boot
      // doesn't immediately re-fire (and potentially busy-loop). lastSuccessAt
      // / lastSize / lastChecksum are deliberately NOT advanced — an operator
      // reading the row sees the real last-good time + size, not a misleading
      // recent timestamp. lastError records the failure for diagnostics.
      try {
        await this.writeFailureCadence(previous, attemptAt, intervalMs, message, disk, estimatedBytes);
      } catch {
        // best-effort — the original error is the one that matters
      }
      throw err;
    } finally {
      this.scheduledRunning = false;
    }
  }

  private estimateFallbackBackupBytes(): number {
    const dataDir = resolveDataDir();
    // The archive stages only committed attachment rows. Do not walk uploads/:
    // that includes orphan/staging files which are intentionally excluded and
    // would make the preflight both pessimistic and O(all filesystem entries).
    const row = this.holder.raw
      .prepare(`SELECT COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE state = 'committed'`)
      .get() as { bytes?: number | string };
    const attachmentBytes = Number(row.bytes ?? 0);
    return safeFileBytes(dbFilePath(dataDir)) + (Number.isFinite(attachmentBytes) ? attachmentBytes : 0);
  }

  /**
   * Space required on BACKUP_DIR's filesystem for a scheduled backup. buildBackup
   * stages a full DB/uploads copy under os.tmpdir() while the .partial ZIP grows in
   * BACKUP_DIR. If those paths share a filesystem, both allocations are live at
   * once; otherwise BACKUP_DIR needs only the archive estimate. Keep status and
   * execution on this one calculation so operator warnings match the actual guard.
   */
  private scheduledBackupDiskEstimate(
    backupDir: string,
    previousArchiveBytes: number | null,
  ): { archiveBytes: number; requiredBytes: number } {
    if (!this.pathsShareFilesystem(backupDir, os.tmpdir())) {
      // A known prior archive is enough to budget BACKUP_DIR when staging lives
      // elsewhere. Keep the fallback lazy so status/preflight do not walk every
      // upload merely to calculate an estimate they will not use.
      const archiveBytes = estimateNextBackupBytes(
        previousArchiveBytes,
        () => this.estimateFallbackBackupBytes(),
      );
      return { archiveBytes, requiredBytes: archiveBytes };
    }

    // Same filesystem means staging and the archive coexist, so we must measure
    // the source bytes even when a previous archive gives us its archive estimate.
    const stagingBytes = this.estimateFallbackBackupBytes();
    const archiveBytes = estimateNextBackupBytes(previousArchiveBytes, stagingBytes);
    return { archiveBytes, requiredBytes: archiveBytes + stagingBytes };
  }

  private probeDisk(
    dir: string,
    reserveBytes: number,
    estimatedNextBytes: number,
  ): BackupDiskStatus | null {
    const statRoot = this.existingPathForStatfs(dir);
    if (!statRoot) return null;
    try {
      const stat = fs.statfsSync(statRoot);
      const freeBytes = stat.bavail * stat.bsize;
      const totalBytes = stat.blocks * stat.bsize;
      return {
        freeBytes,
        totalBytes,
        reserveBytes,
        estimatedNextBytes,
        lowSpace:
          freeBytes < estimatedNextBytes ||
          (reserveBytes > 0 && freeBytes - estimatedNextBytes < reserveBytes),
      };
    } catch {
      return null;
    }
  }

  private existingPathForStatfs(target: string): string | null {
    let current = path.resolve(target);
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
    return current;
  }

  private pathsShareFilesystem(left: string, right: string): boolean {
    const leftRoot = this.existingPathForStatfs(left);
    const rightRoot = this.existingPathForStatfs(right);
    if (!leftRoot || !rightRoot) return false;
    try {
      return fs.statSync(leftRoot).dev === fs.statSync(rightRoot).dev;
    } catch {
      return false;
    }
  }

  private failureBackoffMs(previous: BackupCadenceState | null, intervalMs: number): number {
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const exponential = BACKUP_FAILURE_BACKOFF_MIN_MS * 2 ** Math.min(consecutiveFailures - 1, 10);
    return Math.min(intervalMs, BACKUP_FAILURE_BACKOFF_MAX_MS, exponential);
  }

  private async writeFailureCadence(
    previous: BackupCadenceState | null,
    attemptAt: string,
    intervalMs: number,
    message: string,
    disk: BackupDiskStatus | null,
    estimatedBytes: number,
  ): Promise<void> {
    const nextRunAt = new Date(Date.now() + this.failureBackoffMs(previous, intervalMs)).toISOString();
    await this.writeCadence({
      lastAttemptAt: attemptAt,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      nextRunAt,
      lastSize: previous?.lastSize ?? null,
      lastChecksum: previous?.lastChecksum ?? null,
      lastError: message,
      lastArchiveName: previous?.lastArchiveName ?? null,
      lastVerifiedAt: previous?.lastVerifiedAt ?? null,
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      metrics: this.metricsAfterFailure(previous?.metrics, disk, estimatedBytes),
    });
  }

  private defaultMetrics(): BackupCadenceMetrics {
    return {
      successCount: 0,
      failureCount: 0,
      pruneCount: 0,
      prunedBytes: 0,
      lastFreeBytes: null,
      lastEstimatedBytes: null,
      lastPruneAt: null,
      lastPruneError: '',
    };
  }

  private normalizeMetrics(metrics: BackupCadenceMetrics | undefined): BackupCadenceMetrics {
    return { ...this.defaultMetrics(), ...(metrics ?? {}) };
  }

  private metricsAfterFailure(
    previous: BackupCadenceMetrics | undefined,
    disk: BackupDiskStatus | null,
    estimatedBytes: number,
  ): BackupCadenceMetrics {
    const metrics = this.normalizeMetrics(previous);
    return {
      ...metrics,
      failureCount: metrics.failureCount + 1,
      lastFreeBytes: disk?.freeBytes ?? null,
      lastEstimatedBytes: estimatedBytes,
    };
  }

  private metricsAfterSuccess(
    previous: BackupCadenceMetrics | undefined,
    disk: BackupDiskStatus | null,
    estimatedBytes: number,
    prune: { count: number; bytes: number; error: string },
  ): BackupCadenceMetrics {
    const metrics = this.normalizeMetrics(previous);
    return {
      ...metrics,
      successCount: metrics.successCount + 1,
      pruneCount: metrics.pruneCount + prune.count,
      prunedBytes: metrics.prunedBytes + prune.bytes,
      lastFreeBytes: disk?.freeBytes ?? null,
      lastEstimatedBytes: estimatedBytes,
      lastPruneAt: prune.count > 0 ? nowIso() : metrics.lastPruneAt,
      lastPruneError: prune.error,
    };
  }

  private listScheduledBackupFiles(dir: string): Array<BackupOnDiskEntry & { abs: string; mtimeMs: number }> {
    const onDisk: Array<BackupOnDiskEntry & { abs: string; mtimeMs: number }> = [];
    if (!fs.existsSync(dir)) return onDisk;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!isScheduledBackupArchiveName(name)) continue;
        const abs = path.join(dir, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        onDisk.push({ name, abs, bytes: stat.size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs });
      }
      onDisk.sort((a, b) => b.mtime.localeCompare(a.mtime));
    } catch {
      // BACKUP_DIR exists but is unreadable or not a directory — degrade to empty listing.
    }
    return onDisk;
  }

  private async verifyScheduledArchive(filePath: string): Promise<ScheduledArchiveVerification> {
    let checksum: string;
    try {
      checksum = (await hashFile(filePath)).sha256;
    } catch (err) {
      return { verified: false, checksum: null, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const inspection = await this.inspectFile(filePath);
      return { verified: true, checksum, clean: inspection.reconciliation.clean, error: '' };
    } catch (err) {
      return { verified: false, checksum, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private retentionMarkers(abs: string): { pinned: boolean; offsite: boolean } {
    return {
      pinned: fs.existsSync(`${abs}.pin`) || fs.existsSync(`${abs}.keep`),
      offsite: fs.existsSync(`${abs}.offsite`),
    };
  }

  private async pruneVerifiedScheduledBackups(
    dir: string,
    policy: BackupRetentionPolicy,
    lastArchiveName: string,
    lastChecksum: string,
    knownVerifiedPath?: string,
  ): Promise<{ count: number; bytes: number; error: string }> {
    const files = this.listScheduledBackupFiles(dir);
    const candidates: BackupRetentionCandidate[] = [];
    for (const file of files) {
      // The just-published archive was comprehensively verified while it still
      // had its partial name. Reusing that result avoids another full archive
      // read/decompression pass, but only for this explicit path in this run.
      const verification = knownVerifiedPath && path.resolve(file.abs) === path.resolve(knownVerifiedPath)
        ? { verified: true, checksum: lastChecksum, clean: true, error: '' }
        : await this.verifyScheduledArchive(file.abs);
      const markers = this.retentionMarkers(file.abs);
      candidates.push({
        name: file.name,
        bytes: file.bytes,
        mtimeMs: file.mtimeMs,
        verified: verification.verified && verification.clean,
        lastKnownGood:
          file.name === lastArchiveName ||
          (lastArchiveName.length === 0 && verification.checksum === lastChecksum),
        pinned: markers.pinned,
        offsite: markers.offsite,
      });
      if (!verification.verified) {
        this.logger.warn(`Retention will not prune unverified backup ${file.name}: ${verification.error}`);
      }
    }

    const plan = planBackupRetention(candidates, policy);
    let count = 0;
    let bytes = 0;
    const errors: string[] = [];
    for (const decision of plan.prune) {
      const file = files.find((entry) => entry.name === decision.name);
      if (!file) continue;
      try {
        fs.rmSync(file.abs);
        count += 1;
        bytes += decision.bytes;
        this.logger.log(
          `Pruned scheduled backup ${decision.name} (${decision.bytes} bytes; ${decision.reasons.join(', ')})`,
        );
      } catch (err) {
        errors.push(`${decision.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { count, bytes, error: errors.join('; ') };
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

  private backupStatusAlerts(input: {
    scheduleEnabled: boolean;
    cadence: BackupCadenceState | null;
    disk: BackupDiskStatus | null;
    retention: BackupRetentionStatus;
    onDisk: BackupOnDiskEntry[];
  }): string[] {
    const alerts: string[] = [];
    if (input.cadence?.lastError) {
      alerts.push(lastScheduledAttemptAlert(input.cadence.lastError));
    }
    if (input.disk?.lowSpace) {
      alerts.push(
        `Backup volume is below reserve: free ${input.disk.freeBytes}B, ` +
          `estimated required space ${input.disk.estimatedNextBytes}B, reserve ${input.disk.reserveBytes}B`,
      );
    }
    if (input.retention.lastPruneError) {
      alerts.push(`Last retention prune had errors: ${input.retention.lastPruneError}`);
    }
    if (
      input.scheduleEnabled &&
      input.retention.policy.protectLastGood &&
      input.cadence?.lastArchiveName &&
      !input.onDisk.some((entry) => entry.name === input.cadence?.lastArchiveName)
    ) {
      alerts.push(`Last-known-good archive ${input.cadence.lastArchiveName} is not present in BACKUP_DIR`);
    }
    return alerts;
  }

  /**
   * Operator-facing scheduled-backup status (issue #444). Read-only — cadence
   * is driven by env (`BACKUP_SCHEDULE_ENABLED`, `BACKUP_INTERVAL_HOURS`,
   * `BACKUP_DIR`) and the persisted `backup.cadence` settings row.
   */
  async getStatus(): Promise<BackupStatus> {
    const scheduleEnabled = process.env.BACKUP_SCHEDULE_ENABLED === '1';
    const intervalHours = parseBackupIntervalHours();
    const dir = this.backupDir();
    const cadence = await this.readCadence();
    const onDiskWithPaths = this.listScheduledBackupFiles(dir);
    const onDisk: BackupOnDiskEntry[] = onDiskWithPaths.map(({ name, bytes, mtime }) => ({ name, bytes, mtime }));
    const policy = parseBackupRetentionPolicy();
    const reserveBytes = parseBackupMinFreeBytes();
    const diskEstimate = this.scheduledBackupDiskEstimate(dir, cadence?.lastSize ?? null);
    const disk = this.probeDisk(dir, reserveBytes, diskEstimate.requiredBytes);
    const metrics = this.normalizeMetrics(cadence?.metrics);
    const totalBytes = onDisk.reduce((sum, entry) => sum + entry.bytes, 0);
    const retention: BackupRetentionStatus = {
      policy,
      archiveCount: onDisk.length,
      totalBytes,
      protectedLastGoodName: policy.protectLastGood ? cadence?.lastArchiveName ?? null : null,
      pruneCount: metrics.pruneCount,
      prunedBytes: metrics.prunedBytes,
      lastPruneAt: metrics.lastPruneAt,
      lastPruneError: metrics.lastPruneError,
    };
    const alerts = this.backupStatusAlerts({ scheduleEnabled, cadence, disk, retention, onDisk });
    return {
      scheduleEnabled,
      intervalHours,
      backupDir: dir,
      cadence,
      disk,
      retention,
      alerts,
      onDisk: onDisk.slice(0, 20),
    };
  }

  /**
   * Build a downloadable backup archive with attachment reconciliation (#828)
   * and optional AI keyfile envelope (#496).
   *
   * Flow:
   *   1. Snapshot the DB via `VACUUM INTO` (WAL-safe hot snapshot; does not block writers)
   *      — this fixes the "generation" for the whole backup. The snapshot is the
   *      authoritative source of truth about which attachment rows exist.
   *   2. Open the snapshot read-only and enumerate every committed attachment row.
   *   3. For each row, resolve its on-disk path via {@link AttachmentsService.filePath}
   *      (same MIME→ext maps as live serving) and read with retry-on-size-change.
   *   4. Compute sha256 of the captured bytes and record the attachment in the manifest.
   *      A captured byte length that differs from the snapshot row's `size` counts as
   *      `changed` (restoring would leave the DB inconsistent with the file).
   *   5. Scan the live uploads/ tree once more and record any files that are NOT
   *      referenced by any committed attachment row as `orphans`.
   *   6. Record missing files in the manifest and fail loudly if a file changed
   *      under capture; missing files are already absent from the live server,
   *      while changed bytes would make the archive internally inconsistent.
   *   7. #496: When the running server relies on an auto-generated
   *      `DATA_DIR/ai-config.key` and the caller supplies a `keyPassphrase`, the
   *      keyfile is wrapped in an AES-256-GCM envelope (scrypt(passphrase, salt))
   *      and included as `ai-config.key.env.json` inside the archive so a restore
   *      to a fresh host can rehydrate stored provider credentials. The manifest
   *      always records the key source (`env` vs `keyfile`) and whether an
   *      envelope was included. Plaintext key material never enters the archive.
   *
   * Uploads referenced by the DB snapshot land at their canonical path
   * `<campaignId>/<id>.<ext>` under `uploads/` in the archive. Orphan files (in the
   * live tree but not referenced) are NOT copied — they were the "concurrent write"
   * case the DB snapshot doesn't know about, and including them would defeat the point.
   */
  async buildBackup(options?: BuildBackupOptions): Promise<Buffer>;
  async buildBackup(options: BuildBackupOptions | undefined, output: Writable): Promise<void>;
  async buildBackup(options?: BuildBackupOptions, output?: Writable): Promise<Buffer | void> {
    this.beginArchiveOperation('backup');
    let tmpDir: string | null = null;
    // The archiver accumulates queued sources (zip.file(...) keeps a read stream per
    // attachment) from the moment it is created, but teardown only becomes pipeline()'s
    // job once streaming starts. Between those two points nothing else owns it, so hold
    // a reference the outer finally can destroy.
    let zip: ReturnType<typeof archiver> | null = null;
    try {
      assertBackupNotCancelled(options?.signal);
      const dataDir = resolveDataDir();
      const estimatedBytes = this.estimateFallbackBackupBytes();
      // Interactive downloads only need their temporary staging footprint to fit.
      // BACKUP_MIN_FREE_BYTES protects the scheduled BACKUP_DIR after publishing
      // an archive and must not reserve the same margin in an unrelated temp mount.
      const tempDisk = this.probeDisk(os.tmpdir(), 0, estimatedBytes);
      if (tempDisk?.lowSpace) {
        throw new ServiceUnavailableException(
          `Backup staging skipped: low temporary disk space ` +
            `(free ${tempDisk.freeBytes}B, estimate ${estimatedBytes}B, reserve ${tempDisk.reserveBytes}B)`,
        );
      }
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-backup-'));
      const snapshotPath = path.join(tmpDir, 'campfire.db');
      // VACUUM INTO requires the target file NOT to exist (tmpDir is empty). Escape the
      // path for the SQL string literal. This is our generation boundary — every read
      // below is against this snapshot, not the live DB.
      this.holder.raw.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
      assertBackupNotCancelled(options?.signal);
      zip = archiver('zip', { zlib: { level: 6 } });
      // Keep a permanent sink for errors emitted asynchronously after scoped
      // pipeline listeners are removed during teardown. Other listeners still
      // receive the same event; this only prevents a late unhandled error from
      // terminating the server.
      zip.on('error', () => undefined);
      // Keep the snapshot on disk and let the ZIP writer pull from it under
      // output backpressure instead of materializing the database in the V8 heap.
      const dbSize = safeFileBytes(snapshotPath);
      if (dbSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
        throw new ServiceUnavailableException(
          `Backup database exceeds the ${MAX_ENTRY_UNCOMPRESSED_BYTES} byte restore entry limit`,
        );
      }
      let declaredArchiveBytes = dbSize;
      zip.file(snapshotPath, { name: DB_ENTRY });

      // Read committed attachment rows from the SNAPSHOT. Rows in state 'reserved' are
      // uploads that hadn't yet finished publishing at snapshot time — their bytes may
      // or may not exist on disk; excluding them keeps the archive semantically clean
      // (a restored server sees the same attachment set the snapshot's DB saw).
      const snapshotDb = new Database(snapshotPath, { readonly: true, fileMustExist: true });
      let snapshotRows: Array<{
        id: number;
        campaignId: number;
        mime: string;
        size: number;
        hidden: number;
      }>;
      try {
        snapshotRows = snapshotDb
          .prepare(
            `SELECT id, campaign_id AS campaignId, mime, size, hidden
             FROM attachments
             WHERE state = 'committed'`,
          )
          .all() as Array<{ id: number; campaignId: number; mime: string; size: number; hidden: number }>;
      } finally {
        snapshotDb.close();
      }

      const uploads = uploadsRoot(dataDir);
      const attachmentRecords: BackupAttachmentRecord[] = [];
      const capturedPaths = new Set<string>();
      let missing = 0;
      let changed = 0;

      for (const row of snapshotRows) {
        // Resolve through AttachmentsService so backup MIME→ext matches live storage
        // (ALLOWED_MIME_TO_EXT + GENERATED_MIME_TO_EXT, else `.bin`) — never invent
        // extensions the app would not have written.
        const abs = this.attachments.filePath(row);
        const rel = path.relative(uploads, abs).split(path.sep).join('/');
        const before = captureFileBytesOrNullIfMissing(abs);
        if (before === null) {
          // The file is truly gone (ENOENT after retries). Do NOT add the file to the
          // zip — a restore that references a missing file would fail on read; the
          // reconciliation section signals the problem loudly.
          missing++;
          continue;
        }
        // Concurrent overwrite OR captured bytes disagree with the snapshot row size
        // → restored DB would be internally inconsistent with the archived file.
        const staged = path.join(tmpDir, 'uploads', rel);
        let captured: { bytes: number; sha256: string };
        try {
          captured = await stageAndHashFileWithRetry(abs, staged, options?.signal);
        } catch (err) {
          // The file can be deleted between the existsSync above and the read stream
          // opening. Letting a raw ENOENT escape here would abort mid-loop with no
          // reconciliation report — the operator would see an opaque path error instead
          // of "which attachments went missing". Route it to the same `missing` outcome
          // the pre-check produces so the failure stays legible and complete.
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            missing++;
            continue;
          }
          if (err instanceof AttachmentCaptureChangedError) {
            changed++;
            continue;
          }
          throw err;
        }
        if (captured.bytes > MAX_ENTRY_UNCOMPRESSED_BYTES) {
          throw new ServiceUnavailableException(
            `Backup attachment ${rel} exceeds the ${MAX_ENTRY_UNCOMPRESSED_BYTES} byte restore entry limit`,
          );
        }
        declaredArchiveBytes += captured.bytes;
        if (declaredArchiveBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
          throw new ServiceUnavailableException(
            `Backup contents exceed the ${MAX_ARCHIVE_UNCOMPRESSED_BYTES} byte restore archive limit`,
          );
        }
        if (captured.bytes !== row.size) changed++;
        // Do not retain attachment bytes: the ZIP producer reads this file as
        // its downstream consumer has capacity.
        zip.file(staged, { name: `${UPLOADS_PREFIX}${rel}` });
        capturedPaths.add(rel);
        attachmentRecords.push({
          id: row.id,
          campaignId: row.campaignId,
          path: rel,
          size: captured.bytes,
          mime: row.mime,
          hidden: row.hidden === 1,
          sha256: captured.sha256,
        });
      }

      // Orphans: files on disk that no committed attachment row references. These include
      // uncommitted staging leftovers and any concurrent uploads that landed after the
      // snapshot. Reported in the manifest but NOT copied — the DB doesn't know about them.
      const liveFiles = listFilesRecursive(uploads);
      const orphanPaths: string[] = [];
      for (const rel of liveFiles) {
        // Normalize to forward slashes for stable manifest paths (zip + cross-OS).
        const normalized = rel.split(path.sep).join('/');
        if (!capturedPaths.has(normalized)) orphanPaths.push(normalized);
      }
      orphanPaths.sort();

      const reconciliation: BackupReconciliation = {
        generation: crypto.randomUUID(),
        totalAttachments: snapshotRows.length,
        missing,
        changed,
        orphans: orphanPaths.slice(0, BACKUP_ORPHAN_LIST_CAP),
        orphanCount: orphanPaths.length,
        clean: missing === 0 && changed === 0,
      };

      // #496: probe the key source + credential count for the manifest, and
      // (opt-in) include an encrypted envelope of the keyfile.
      const { source: aiKeySource, keyfilePath } = this.detectAiKeySource(dataDir);
      const aiCredentialCount = countAiCredentialsInSnapshot(snapshotPath);
      let aiKeyIncluded = false;
      const requestedPassphrase = options?.keyPassphrase?.trim();
      if (
        (aiCredentialCount ?? 0) > 0 &&
        aiKeySource === 'keyfile' &&
        !keyfilePath &&
        requestedPassphrase
      ) {
        this.logger.warn(
          'buildBackup: encrypted AI credentials are present in the snapshot but no keyfile was found on disk — envelope omitted.',
        );
      }
      if (requestedPassphrase && aiKeySource === 'keyfile' && keyfilePath) {
        // Fail loudly if the passphrase is too short — an unencrypted-in-practice
        // envelope is worse than none (it lures the operator into thinking they
        // are covered).
        if (requestedPassphrase.length < KEY_ENVELOPE_MIN_PASSPHRASE_LEN) {
          throw new BadRequestException(
            `keyPassphrase must be at least ${KEY_ENVELOPE_MIN_PASSPHRASE_LEN} characters`,
          );
        }
        const keyBytes = fs.readFileSync(keyfilePath);
        if ((aiCredentialCount ?? 0) > 0) {
          const key = aiKeyMaterialToBuffer(keyBytes);
          const probe = new Database(snapshotPath, { readonly: true, fileMustExist: true });
          try {
            const row = probe
              .prepare(
                'SELECT encrypted_api_key AS encryptedApiKey FROM ai_provider_configs WHERE encrypted_api_key IS NOT NULL LIMIT 1',
              )
              .get() as { encryptedApiKey: string } | undefined;
            if (row?.encryptedApiKey) decryptSecret(row.encryptedApiKey, key);
          } finally {
            probe.close();
          }
        }
        const envelope = JSON.stringify(encryptKeyfile(keyBytes, requestedPassphrase), null, 2);
        const envelopeBytes = Buffer.byteLength(envelope);
        if (envelopeBytes > MAX_KEY_ENVELOPE_BYTES) {
          throw new ServiceUnavailableException(
            `Backup key envelope exceeds the ${MAX_KEY_ENVELOPE_BYTES} byte restore entry limit`,
          );
        }
        declaredArchiveBytes += envelopeBytes;
        if (declaredArchiveBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
          throw new ServiceUnavailableException(
            `Backup contents exceed the ${MAX_ARCHIVE_UNCOMPRESSED_BYTES} byte restore archive limit`,
          );
        }
        zip.append(envelope, { name: KEY_ENVELOPE_ENTRY });
        aiKeyIncluded = true;
      } else if (requestedPassphrase && aiKeySource === 'env') {
        this.logger.warn(
          'buildBackup: keyPassphrase supplied but AI_CONFIG_KEY env is set — envelope not included ' +
            '(the operator already manages the key out-of-band).',
        );
      }

      const manifest: BackupManifest = {
        app: BACKUP_APP,
        kind: BACKUP_KIND,
        version: BACKUP_FORMAT_VERSION,
        appVersion: serverAppVersion(),
        schemaVersion: CURRENT_SCHEMA_REVISION,
        createdAt: nowIso(),
        db: DB_ENTRY,
        dbBytes: dbSize,
        uploadCount: attachmentRecords.length,
        aiKeySource,
        aiKeyIncluded,
        ...(aiCredentialCount !== null ? { aiCredentialCount } : {}),
        attachments: attachmentRecords,
        reconciliation,
      };
      const manifestJson = serializeBackupManifest(manifest);
      const manifestBytes = Buffer.byteLength(manifestJson);
      const entryCount = 2 + attachmentRecords.length + (aiKeyIncluded ? 1 : 0);
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        throw new ServiceUnavailableException(
          `Backup contents exceed the ${MAX_ARCHIVE_ENTRIES} entry restore archive limit`,
        );
      }
      declaredArchiveBytes += manifestBytes;
      if (declaredArchiveBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
        throw new ServiceUnavailableException(
          `Backup contents exceed the ${MAX_ARCHIVE_UNCOMPRESSED_BYTES} byte restore archive limit`,
        );
      }
      zip.append(manifestJson, { name: MANIFEST_ENTRY });

      // Missing files are already unavailable in the live server and are recorded in
      // manifest.reconciliation. Changed files, however, make the captured bytes
      // inconsistent with the snapshot and must still abort this archive.
      if (missing > 0) {
        this.logger.warn(
          `Backup reconciliation found ${missing} attachment file(s) missing from storage; recording them in the manifest.`,
        );
      }

      if (changed > 0) {
        throw new Error(
          `Backup failed reconciliation: ${missing} missing, ${changed} changed attachment file(s). ` +
            `Backup generation ${reconciliation.generation} — see manifest.reconciliation for details.`,
        );
      }

      const archive = zip;
      const chunks: Buffer[] = [];
      const sink = output ?? new PassThrough();
      if (!output) {
        sink.on('data', (chunk: Buffer) => chunks.push(chunk));
      }
      let compressedBytes = 0;
      const onFirstByte = options?.onFirstByte;
      const compressedLimit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (compressedBytes === 0) onFirstByte?.();
          compressedBytes += chunk.length;
          if (compressedBytes > MAX_ARCHIVE_COMPRESSED_BYTES) {
            callback(new Error(`Backup archive exceeds the ${MAX_ARCHIVE_COMPRESSED_BYTES} byte compressed restore limit`));
            return;
          }
          callback(null, chunk);
        },
      });
      const abort = () => archive.destroy(new Error('Backup generation cancelled'));
      options?.signal?.addEventListener('abort', abort, { once: true });
      // addEventListener never fires for an already-aborted signal, so a cancellation
      // landing between archive creation and this line would otherwise leave the
      // archive alive while the throw below unwinds.
      if (options?.signal?.aborted) abort();
      // pipeline() owns teardown from here; the outer finally's !destroyed guard keeps
      // it from double-destroying an archive this call already tore down.
      const done = pipeline(archive, compressedLimit, sink);
      void done.catch(() => undefined);
      try {
        assertBackupNotCancelled(options?.signal);
        await archive.finalize();
        await done;
        return output ? undefined : Buffer.concat(chunks);
      } finally {
        options?.signal?.removeEventListener('abort', abort);
      }
    } finally {
      try {
        // Failed before streaming started: release the queued attachment read streams
        // ourselves, otherwise they stay open for the process lifetime and can make the
        // staging removal below fail on platforms that refuse to unlink open files.
        // After a completed pipeline the archive is already destroyed, so this is a no-op.
        if (zip && !zip.destroyed) zip.destroy();
      } finally {
        try {
          if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        } finally {
          // Releasing the lane must not depend on cleanup succeeding. A single throwing
          // rmSync would otherwise wedge the guard permanently and every subsequent
          // backup and restore would 503 for the lifetime of the process.
          this.endArchiveOperation('backup');
        }
      }
    }
  }

  /**
   * Validate and apply a backup archive over the whole server: replaces the
   * SQLite DB and the uploads tree, then re-opens the DB in place. Destructive
   * — every current row and file is discarded. The archive is fully validated
   * BEFORE the live DB is touched, so a malformed upload leaves the server
   * untouched (it 400s and the running DB is never closed).
   */
  private expectedAttachmentChecksums(
    manifest: BackupManifest,
  ): Map<string, BackupAttachmentRecord> {
    return new Map(manifest.attachments.map((attachment) => [attachment.path, attachment]));
  }

  private validateAttachmentChecksum(
    expectedAttachments: Map<string, BackupAttachmentRecord>,
    foundAttachments: Set<string>,
    relativePath: string,
    actual: { bytes: number; sha256: string },
  ): void {
    const expected = expectedAttachments.get(relativePath);
    if (!expected) {
      throw new BadRequestException('Invalid backup archive — upload is missing manifest attachment checksum');
    }
    if (expected.size !== actual.bytes || expected.sha256 !== actual.sha256) {
      throw new BadRequestException('Invalid backup archive — upload checksum does not match manifest');
    }
    foundAttachments.add(relativePath);
  }

  private validateAttachmentCoverage(
    expectedAttachments: Map<string, BackupAttachmentRecord>,
    foundAttachments: Set<string>,
  ): void {
    if (foundAttachments.size !== expectedAttachments.size) {
      throw new BadRequestException('Invalid backup archive — manifest attachment is missing');
    }
  }

  /** Ensure v3 metadata describes the committed rows in the staged snapshot. */
  private validateManifestAttachmentsAgainstSnapshot(manifest: BackupManifest, dbPath: string): void {
    const byId = new Map(manifest.attachments.map((record) => [record.id, record]));
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let capturedCount = 0;
    let missingCount = 0;
    try {
      try {
        for (const row of db.prepare(
          `SELECT id, campaign_id AS campaignId, mime, size, hidden FROM attachments WHERE state = 'committed'`,
        ).iterate() as Iterable<{ id: number; campaignId: number; mime: string; size: number; hidden: number }>) {
          const record = byId.get(row.id);
          const expectedPath = path.relative(uploadsRoot(resolveDataDir()), this.attachments.filePath(row)).split(path.sep).join('/');
          if (!record) {
            missingCount++;
            continue;
          }
          if (record.campaignId !== row.campaignId || record.mime !== row.mime ||
            record.size !== row.size || record.hidden !== (row.hidden === 1) || record.path !== expectedPath) {
            throw new BadRequestException('Invalid backup archive — manifest attachments do not match database snapshot');
          }
          byId.delete(row.id);
          capturedCount++;
        }
      } catch (err) {
        // The earlier integrity probe intentionally accepts any SQLite database
        // with a users table. A missing/older attachments schema is still an
        // invalid v3 archive, not an internal server failure.
        if (err instanceof Database.SqliteError || (err as any)?.code?.startsWith('SQLITE_') || (err as any)?.name === 'SqliteError') {
          throw new BadRequestException('Invalid backup archive — database attachment schema could not be read');
        }
        throw err;
      }
    } finally { db.close(); }
    if (
      capturedCount !== manifest.attachments.length ||
      missingCount !== manifest.reconciliation.missing ||
      byId.size !== 0
    ) {
      throw new BadRequestException('Invalid backup archive — manifest attachments do not match database snapshot');
    }
  }

  /**
   * Validate every payload an archive promises without applying it. This is used
   * by inspect and therefore scheduled-backup verification; entries are hashed
   * as streams so an operator check never accumulates large upload buffers.
   */
  private async validateArchivePayload(
    zip: BackupArchiveReader,
    manifest: BackupManifest,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const envelopeEntry = zip.get(KEY_ENVELOPE_ENTRY);
    if (manifest.aiKeyIncluded && !envelopeEntry) {
      throw new BadRequestException(
        'Invalid backup archive — manifest claims an AI key envelope but the entry is missing',
      );
    }
    if (!manifest.aiKeyIncluded && envelopeEntry) {
      throw new BadRequestException(
        `Invalid backup archive — manifest does not include an AI key envelope but ${KEY_ENVELOPE_ENTRY} is present`,
      );
    }
    if (envelopeEntry) {
      try {
        parseKeyEnvelopeJson((await zip.readBuffer(envelopeEntry, MAX_KEY_ENVELOPE_BYTES, signal)).toString('utf8'));
      } catch (err) {
        throw new BadRequestException(
          `Invalid backup key envelope: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const dbFile = zip.get(manifest.db);
    if (!dbFile) throw new BadRequestException('Invalid backup archive — database is missing');

    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-inspect-'));
    try {
      const stagedDbPath = path.join(stageDir, 'campfire.db');
      const stagedDb = await zip.extractToFile(dbFile, stagedDbPath, signal);
      if (manifest.dbBytes !== stagedDb.bytes) {
        throw new BadRequestException('Invalid backup archive — database size does not match manifest');
      }
      const dbHeader = await fs.promises.open(stagedDbPath, 'r').then(async (handle) => {
        try {
          const header = Buffer.alloc(SQLITE_MAGIC.length);
          await handle.read(header, 0, header.length, 0);
          return header;
        } finally {
          await handle.close();
        }
      });
      if (!looksLikeSqlite(dbHeader)) throw new BadRequestException('Invalid backup archive — database is not a SQLite file');
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
      this.validateManifestAttachmentsAgainstSnapshot(manifest, stagedDbPath);

      const expectedAttachments = this.expectedAttachmentChecksums(manifest);
      const foundAttachments = new Set<string>();
      const uploads: string[] = [];
      for (const entry of zip.entries) {
        const name = entry.fileName;
        if (name.endsWith('/') || !name.startsWith(UPLOADS_PREFIX)) continue;
        const rel = name.slice(UPLOADS_PREFIX.length);
        if (rel === '' || rel.includes('..') || path.isAbsolute(rel)) {
          throw new BadRequestException('Invalid backup archive — unsafe upload path');
        }
        const actual = await zip.hashEntry(entry, signal);
        this.validateAttachmentChecksum(expectedAttachments, foundAttachments, rel, actual);
        uploads.push(rel);
      }
      if (manifest.uploadCount !== uploads.length) {
        throw new BadRequestException('Invalid backup archive — upload count does not match manifest');
      }
      this.validateAttachmentCoverage(expectedAttachments, foundAttachments);
      uploads.sort();
      return uploads;
    } finally {
      await fs.promises.rm(stageDir, { recursive: true, force: true });
    }
  }

  async inspectFile(archivePath: string, signal?: AbortSignal): Promise<BackupInspectResult> {
    const zip = await BackupArchiveReader.open(archivePath, signal);
    try {
      const manifest = await this.readManifestFromArchive(zip, signal);
      const uploads = await this.validateArchivePayload(zip, manifest, signal);
      const view = manifestToInspectView(manifest, uploads);
      return view;
    } finally { zip.close(); }
  }

  async restoreFile(
    archivePath: string,
    confirm: string | undefined,
    user: RequestUser,
    options?: RestoreOptions,
  ): Promise<RestoreResult> {
    if (confirm !== RESTORE_CONFIRM_TOKEN) {
      throw new BadRequestException(
        `Restore is destructive — resend with the confirmation token "${RESTORE_CONFIRM_TOKEN}" in the "confirm" field`,
      );
    }

    this.beginArchiveOperation('restore');
    try {
      const zip = await BackupArchiveReader.open(archivePath, options?.signal);
      try {
        const manifest = await this.readManifestFromArchive(zip, options?.signal);

    const envelopeEntry = zip.get(KEY_ENVELOPE_ENTRY);
    if (manifest.aiKeyIncluded && !envelopeEntry) {
      throw new BadRequestException(
        'Invalid backup archive — manifest claims an AI key envelope but the entry is missing',
      );
    }
    if (!manifest.aiKeyIncluded && envelopeEntry) {
      throw new BadRequestException(
        `Invalid backup archive — manifest does not include an AI key envelope but ${KEY_ENVELOPE_ENTRY} is present`,
      );
    }

    // #496: If the archive carries an encrypted AI keyfile envelope, unwrap it
    // BEFORE we destroy the live DB — a wrong/missing passphrase must fail with
    // the server untouched. `keyBytes` may be null (no envelope in archive OR
    // no passphrase supplied but archive has no envelope either).
    let restoredKeyBytes: Buffer | null = null;
    if (envelopeEntry) {
      const passphrase = options?.keyPassphrase?.trim();
      if (!passphrase) {
        throw new BadRequestException(
          'Backup archive contains an encrypted AI keyfile envelope — resend with the "keyPassphrase" field to unwrap it, or the archive without the envelope to skip credential recovery.',
        );
      }
      let envelope;
      try {
        envelope = parseKeyEnvelopeJson((await zip.readBuffer(envelopeEntry, MAX_KEY_ENVELOPE_BYTES, options?.signal)).toString('utf8'));
      } catch (err) {
        throw new BadRequestException(
          `Invalid backup key envelope: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        restoredKeyBytes = decryptKeyfile(envelope, passphrase);
      } catch (err) {
        throw new BadRequestException(
          err instanceof Error ? err.message : 'Backup key envelope failed to decrypt',
        );
      }
    }

    // --- Validate DB payload ---
    const dbFile = zip.get(manifest.db);
    if (!dbFile) throw new BadRequestException('Invalid backup archive — database is missing');
    // Open the incoming DB read-only in a throwaway location to confirm it's a
    // real, non-corrupt Campfire database (right magic bytes alone aren't enough).
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-restore-'));
    const stagedDbPath = path.join(stageDir, 'campfire.db');
    try {
      const stagedDb = await zip.extractToFile(dbFile, stagedDbPath, options?.signal);
      if (manifest.dbBytes !== stagedDb.bytes) throw new BadRequestException('Invalid backup archive — database size does not match manifest');
      const dbHeader = await fs.promises.open(stagedDbPath, 'r').then(async (handle) => {
        try { const header = Buffer.alloc(SQLITE_MAGIC.length); await handle.read(header, 0, header.length, 0); return header; }
        finally { await handle.close(); }
      });
      if (!looksLikeSqlite(dbHeader)) throw new BadRequestException('Invalid backup archive — database is not a SQLite file');
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

      this.validateManifestAttachmentsAgainstSnapshot(manifest, stagedDbPath);

      if (restoredKeyBytes) {
        validateStagedAiCredentialDecryptability(
          stagedDbPath,
          aiKeyMaterialToBuffer(restoredKeyBytes),
        );
      }

      // #496: When the restore host has AI_CONFIG_KEY set, the keyfile from the
      // envelope will NOT be written (env takes precedence). Validate that the
      // env-managed key can actually decrypt the staged credentials BEFORE the
      // destructive apply — a key mismatch here would silently leave every
      // restored credential undecryptable. The check is skipped when there are
      // no credentials in the archive (no encrypted rows → no key needed).
      const envSetOnHost = !!process.env.AI_CONFIG_KEY && process.env.AI_CONFIG_KEY.trim().length > 0;
      if (envSetOnHost && restoredKeyBytes) {
        try {
          validateStagedAiCredentialDecryptability(stagedDbPath, deriveEnvManagedKey());
        } catch {
          throw new BadRequestException(
            'Cannot restore: AI_CONFIG_KEY on this host does not match the key used to encrypt the archive credentials. ' +
              'Either unset AI_CONFIG_KEY so the archive keyfile can be installed, or set AI_CONFIG_KEY to the value used when these credentials were stored.',
          );
        }
      }

      // --- Collect + path-check uploads, then stage them on disk (#497) ---
      const stagedUploadsDir = path.join(stageDir, 'uploads');
      const uploadEntries: Array<{ rel: string; bytes: number }> = [];
      const expectedAttachments = this.expectedAttachmentChecksums(manifest);
      const foundAttachments = new Set<string>();
      for (const entry of zip.entries) {
        const name = entry.fileName;
        if (name.endsWith('/') || !name.startsWith(UPLOADS_PREFIX)) continue;
        const rel = name.slice(UPLOADS_PREFIX.length);
        // Zip-slip guard: reject any entry that would escape the uploads root.
        if (rel === '' || rel.includes('..') || path.isAbsolute(rel)) {
          throw new BadRequestException('Invalid backup archive — unsafe upload path');
        }
        const uploadsRoot = path.resolve(stagedUploadsDir);
        const dest = path.resolve(uploadsRoot, rel);
        if (!dest.startsWith(`${uploadsRoot}${path.sep}`)) {
          throw new BadRequestException('Invalid backup archive — unsafe upload path');
        }
        const extracted = await zip.extractToFile(entry, dest, options?.signal);
        this.validateAttachmentChecksum(expectedAttachments, foundAttachments, rel, extracted);
        uploadEntries.push({ rel, bytes: extracted.bytes });
      }
      if (manifest.uploadCount !== uploadEntries.length) throw new BadRequestException('Invalid backup archive — upload count does not match manifest');
      this.validateAttachmentCoverage(expectedAttachments, foundAttachments);
      if (restoredKeyBytes && envSetOnHost) {
        this.logger.warn(
          'restore: AI_CONFIG_KEY is set on this host — skipping keyfile write from the archive envelope. ' +
            'The env var takes precedence; if it decrypts the DB rows, no keyfile is needed.',
        );
      }

      // --- Apply with atomic swap + automatic rollback (#497) ---
      // Last chance to honour a cancellation. Everything above is validation against
      // staging; everything below replaces the live database and uploads tree. The
      // signal is polled at each extract, but validation continues afterwards, so an
      // abort landing in that window would otherwise carry straight through into the
      // destructive phase. Every other failure in this path costs a temp file; this one
      // would cost the operator their live data after they pressed cancel.
      assertRestoreNotCancelled(options?.signal);
      const progressPhases: RestoreProgressPhase[] = ['validated', 'staging-uploads'];
      options?.onProgress?.('validated');
      options?.onProgress?.('staging-uploads');
      // Validation and extraction are intentionally non-destructive. Recheck
      // cancellation at the last boundary before closing the live database so
      // an abort during staging cannot cross into the atomic replacement.
      assertRestoreNotCancelled(options?.signal);
      let applyPhases: RestoreProgressPhase[] = [];
      this.holder.withDatabaseClosed((dataDir) => {
        options?.onProgress?.('quiescing');
        progressPhases.push('quiescing');
        const applied = applyRestoredState({
          dataDir,
          stagedDbPath,
          stagedUploadsDir,
          restoredKeyBytes,
          aiKeyfileName: AI_KEYFILE_NAME,
          envKeyManaged: envSetOnHost,
          onProgress: options?.onProgress,
        });
        applyPhases = applied.phases;
      });
      progressPhases.push(...applyPhases);

      // A backup may have been cut while an upload was between its SQLite
      // reservation and final commit. The restored DB is already reopened here;
      // apply the same rollback protocol startup uses before any restored metadata
      // can be served from this still-running process.
      //
      // Full-root `.stage` scrubbing is intentional after restore: stage files can
      // exist without a reserved row after a backup cut, so gating on reserved
      // count would miss them. Scrubbing skips ids that are still reserved so an
      // in-flight publish after reopen is not deleted. Top-level FS errors must
      // not abort an otherwise successful restore (mirrors startup try/catch).
      try {
        this.attachments.recoverPendingPublications({ scrubDanglingStages: true });
      } catch (err) {
        this.logger.error(
          `Attachment publication recovery failed after restore: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      this.aiProviderConfig.invalidateCachedKey();

      const result: RestoreResult = {
        ok: true,
        restoredAt: nowIso(),
        dbBytes: stagedDb.bytes,
        uploadCount: uploadEntries.length,
        phases: progressPhases,
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
      } finally {
        zip.close();
      }
    } finally {
      this.endArchiveOperation('restore');
    }
  }

  private async readManifestFromArchive(zip: BackupArchiveReader, signal?: AbortSignal): Promise<BackupManifest> {
    const manifestFile = zip.get(MANIFEST_ENTRY);
    if (!manifestFile) throw new BadRequestException('Invalid backup archive — manifest.json is missing');
    const manifestBytes = await zip.readBuffer(manifestFile, MAX_MANIFEST_BYTES, signal);
    let parsed: unknown;
    try { parsed = JSON.parse(manifestBytes.toString('utf8')); }
    catch { throw new BadRequestException('Invalid backup archive — manifest.json is not valid JSON'); }
    return parseBackupManifest(parsed);
  }

}
