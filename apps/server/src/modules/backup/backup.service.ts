import { createHash, scryptSync } from 'node:crypto';
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
import { DB, DB_HOLDER, DbHolder, dbFilePath, resolveDataDir, type DrizzleDb } from '../../db/db.module';
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
} from './backup-cadence';
import {
  BACKUP_APP,
  BACKUP_FORMAT_VERSION,
  BACKUP_FORMAT_VERSION_WITH_KEY_ENVELOPE,
  BACKUP_KIND,
  BACKUP_VERSION,
  CURRENT_SCHEMA_REVISION,
  DB_ENTRY_V1,
  manifestToInspectView,
  parseBackupManifest,
  serverAppVersion,
  type AiKeySource,
  type BackupInspectResult,
  type BackupManifest,
} from './backup-manifest';
import {
  KEY_ENVELOPE_ENTRY,
  KEY_ENVELOPE_MIN_PASSPHRASE_LEN,
  decryptKeyfile,
  encryptKeyfile,
  parseKeyEnvelopeJson,
} from './backup-key-envelope';

export { BACKUP_APP, BACKUP_KIND, BACKUP_VERSION, BACKUP_FORMAT_VERSION };
export type { BackupManifest, BackupInspectResult };

/** Canonical zip entry name for the database in format-1 archives. */
const DB_ENTRY = DB_ENTRY_V1;
export { DB_ENTRY };

/** Zip entry names inside a backup archive. */
export const MANIFEST_ENTRY = 'manifest.json';
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
}

/** Options accepted by {@link BackupService.restore}. */
export interface RestoreOptions {
  /** #496: operator-supplied passphrase used to unwrap the AI keyfile
   *  envelope (`ai-config.key.env.json`) inside the archive. Required when
   *  the archive carries an envelope; ignored when it does not. */
  keyPassphrase?: string;
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
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly attachments: AttachmentsService,
    private readonly aiProviderConfig: AiProviderConfigService,
  ) {}

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
      // #496: Scheduled backups pick up a passphrase from BACKUP_KEY_PASSPHRASE
      // so an unattended cron produces credential-portable archives when the
      // server is running with the auto-generated keyfile. Empty / unset means
      // no envelope (backward compatible).
      const scheduledPassphrase = process.env.BACKUP_KEY_PASSPHRASE?.trim();
      const buffer = await this.buildBackup(
        scheduledPassphrase ? { keyPassphrase: scheduledPassphrase } : undefined,
      );
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
   *
   * #496: When the running server relies on an auto-generated
   * `DATA_DIR/ai-config.key` and the caller supplies a `keyPassphrase`, the
   * keyfile is wrapped in an AES-256-GCM envelope (scrypt(passphrase, salt))
   * and included as `ai-config.key.env.json` inside the archive so a restore
   * to a fresh host can rehydrate stored provider credentials. The manifest
   * always records the key source (`env` vs `keyfile`) and whether an
   * envelope was included, so operators can see up-front whether their
   * archive is credential-portable. Plaintext key material never enters the
   * archive.
   */
  async buildBackup(options?: BuildBackupOptions): Promise<Buffer> {
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
        const envelope = encryptKeyfile(keyBytes, requestedPassphrase);
        zip.file(KEY_ENVELOPE_ENTRY, JSON.stringify(envelope, null, 2));
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
        version: aiKeyIncluded ? BACKUP_FORMAT_VERSION_WITH_KEY_ENVELOPE : 1,
        appVersion: serverAppVersion(),
        schemaVersion: CURRENT_SCHEMA_REVISION,
        createdAt: nowIso(),
        db: DB_ENTRY,
        dbBytes: dbBytes.length,
        uploadCount: uploadFiles.length,
        aiKeySource,
        aiKeyIncluded,
        ...(aiCredentialCount !== null ? { aiCredentialCount } : {}),
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
    const { manifest, sourceFormatVersion } = await this.readManifestFromZipWithSource(zip);
    const uploads: string[] = [];
    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (entry.dir || !name.startsWith(UPLOADS_PREFIX)) continue;
      const rel = name.slice(UPLOADS_PREFIX.length);
      // Reject unsafe paths the same way restore() does (issue #997 fix 1).
      if (rel === '' || rel.includes('..') || path.isAbsolute(rel)) {
        throw new BadRequestException('Invalid backup archive — unsafe upload path');
      }
      uploads.push(rel);
    }
    uploads.sort();
    return manifestToInspectView(manifest, uploads, sourceFormatVersion);
  }

  async restore(
    buffer: Buffer,
    confirm: string | undefined,
    user: RequestUser,
    options?: RestoreOptions,
  ): Promise<RestoreResult> {
    if (confirm !== RESTORE_CONFIRM_TOKEN) {
      throw new BadRequestException(
        `Restore is destructive — resend with the confirmation token "${RESTORE_CONFIRM_TOKEN}" in the "confirm" field`,
      );
    }

    const zip = await this.loadBackupZip(buffer);
    const manifest = await this.readManifestFromZip(zip);

    const envelopeEntry = zip.file(KEY_ENVELOPE_ENTRY);
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
        envelope = parseKeyEnvelopeJson(await envelopeEntry.async('string'));
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

        // #496: If the archive shipped an encrypted AI keyfile envelope AND
        // this host is not overriding the key via AI_CONFIG_KEY, write the
        // decrypted keyfile so stored provider credentials remain decryptable
        // after the DB restore. When AI_CONFIG_KEY is set the operator has
        // asserted external key management — do NOT overwrite what they might
        // already have configured on disk (which would be silently ignored
        // anyway, but writing it would leak the source keyfile onto a host
        // that is not supposed to keep one). The env key was already validated
        // against the staged credentials before this destructive block.
        if (restoredKeyBytes) {
          if (!envSetOnHost) {
            const keyfilePath = path.join(dataDir, AI_KEYFILE_NAME);
            fs.mkdirSync(path.dirname(keyfilePath), { recursive: true });
            fs.rmSync(keyfilePath, { force: true });
            fs.writeFileSync(keyfilePath, restoredKeyBytes.toString('utf8'), { mode: 0o600 });
          } else {
            this.logger.warn(
              'restore: AI_CONFIG_KEY is set on this host — skipping keyfile write from the archive envelope. ' +
                'The env var takes precedence; if it decrypts the DB rows, no keyfile is needed.',
            );
          }
        }
      });

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

  /**
   * Like readManifestFromZip, but also returns the raw source format version
   * from the archive (before normalization). Used by inspect() to surface the
   * original version to operators (issue #997 fix 3).
   */
  private async readManifestFromZipWithSource(zip: JSZip): Promise<{ manifest: BackupManifest; sourceFormatVersion: number }> {
    const manifestFile = zip.file(MANIFEST_ENTRY);
    if (!manifestFile) throw new BadRequestException('Invalid backup archive — manifest.json is missing');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await manifestFile.async('string'));
    } catch {
      throw new BadRequestException('Invalid backup archive — manifest.json is not valid JSON');
    }
    // Capture raw version before parseBackupManifest normalizes it.
    const rawVersion = (parsed as Record<string, unknown>)?.version;
    const sourceFormatVersion = typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion >= 0
      ? rawVersion
      : 0; // missing/null → legacy format 0
    const manifest = parseBackupManifest(parsed);
    return { manifest, sourceFormatVersion };
  }
}
