import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { APP_VERSION } from '../../common/build-metadata';
import { MIGRATION_NAMES } from '../../db/db.module';
import { MAX_MANIFEST_BYTES } from './backup-archive-reader';

/** Marks an archive as a Campfire whole-server backup. */
export const BACKUP_APP = 'campfire';
export const BACKUP_KIND = 'server-backup';

/**
 * Current manifest format version written into new archives. Bump when the zip
 * layout or manifest schema changes.  Pre-1.0 backups deliberately have no
 * compatibility promise: readers accept this version only.
 */
export const BACKUP_FORMAT_VERSION = 3;

/** DB migration count at backup time — a coarse schema revision for operators. */
export const CURRENT_SCHEMA_REVISION = MIGRATION_NAMES.length;

export function serverAppVersion(): string {
  return APP_VERSION;
}

/**
 * How the running server sourced its AI credential encryption key at backup
 * time (#496). Recorded in the manifest so an operator restoring to a fresh
 * host knows what they need to do to keep stored provider credentials working:
 *  - `env`      — operator manages the key via the AI_CONFIG_KEY env var; set
 *                 the SAME value on the restore host and no envelope is needed.
 *  - `keyfile`  — the server used an auto-generated `DATA_DIR/ai-config.key`.
 *                 If `aiKeyIncluded=true`, the archive carries an encrypted
 *                 envelope of that keyfile (unlock during restore with the
 *                 passphrase supplied when the backup was cut). If false,
 *                 stored provider credentials will not be decryptable on a
 *                 fresh DATA_DIR — the operator must supply the original
 *                 keyfile out-of-band or reconfigure providers.
 */
export type AiKeySource = 'env' | 'keyfile';

/**
 * Per-attachment reconciliation record in the manifest (#828). Written by
 * buildBackup for every committed attachment row visible in the DB snapshot,
 * so a restore can verify each file's bytes match the DB's expectation.
 */
export interface BackupAttachmentRecord {
  /** Attachment row id (primary key). */
  id: number;
  /** Owning campaign id. */
  campaignId: number;
  /** Canonical path within the archive (relative to uploads/ root). */
  path: string;
  /** File size in bytes at snapshot time. */
  size: number;
  /** Attachment mime type. */
  mime: string;
  /** DM-only visibility flag. */
  hidden: boolean;
  /** sha256 hex digest of the file bytes as captured. */
  sha256: string;
}

/**
 * Reconciliation summary written to the manifest (#828). Records how well the
 * uploaded files match the DB snapshot's attachment rows. missing/changed/orphan
 * counts of zero indicate a fully consistent archive. Missing files are
 * recorded but do not prevent a recoverable archive; changed files never
 * publish an archive because their captured bytes are untrustworthy.
 */
export interface BackupReconciliation {
  /** Unique id for this backup generation (uuid-ish, monotonically fresh). */
  generation: string;
  /** Total committed attachment rows found in the DB snapshot. */
  totalAttachments: number;
  /** Attachment rows whose file could not be read from disk (missing/ENOENT). */
  missing: number;
  /** Files whose size changed between initial listing and final read (retries exhausted). */
  changed: number;
  /**
   * Files present under uploads/ that no attachment row references (paths, capped for
   * archive size — the full count is `orphanCount`). Includes reserved / uncommitted
   * upload staging leftovers.
   */
  orphans: string[];
  /** Total number of orphan files (may exceed `orphans.length` if capped). */
  orphanCount: number;
  /** Whether every committed attachment row had a captured file. */
  clean: boolean;
}

/** Cap on how many orphan paths we list in the manifest before truncating. */
export const BACKUP_ORPHAN_LIST_CAP = 500;

export interface BackupManifest {
  app: string;
  kind: string;
  /** Archive layout / manifest schema version (not the Campfire app semver). */
  version: number;
  createdAt: string;
  db: string;
  dbBytes: number;
  uploadCount: number;
  /** Campfire app semver that produced the archive. */
  appVersion?: string;
  /** Recorded migration count at backup time. */
  schemaVersion?: number;
  /**
   * Set by newer Campfire releases when they bump {@link BACKUP_FORMAT_VERSION} so
   * an older server can tell the operator which app version is required.
   */
  minCampfireVersion?: string;
  /** AI credential encryption key posture at backup time. */
  aiKeySource: AiKeySource;
  /** True when an encrypted keyfile envelope (ai-config.key.env.json) is
   *  present in the archive (#496). */
  aiKeyIncluded: boolean;
  /** Number of AI provider config rows with a stored encrypted API key at
   *  backup time (#496). Lets the operator quickly see the size of the
   *  credential fleet that hinges on the keyfile. Non-secret — no key
   *  material or last-4 leaks through this count. */
  aiCredentialCount?: number;
  /** Per-attachment checksum records required by the v3 archive contract. */
  attachments: BackupAttachmentRecord[];
  /** Reconciliation summary required by the v3 archive contract. */
  reconciliation: BackupReconciliation;
}

/** Per-attachment checksum row surfaced by inspect (issue #444). */
export interface BackupInspectAttachmentChecksum {
  path: string;
  size: number;
  sha256: string;
}

/** Reconciliation summary surfaced by inspect (issue #444). */
export interface BackupInspectReconciliation {
  generation: string;
  totalAttachments: number;
  missing: number;
  changed: number;
  orphanCount: number;
  clean: boolean;
  orphans: string[];
}

/** Non-destructive summary returned by backup inspect (issue #514). */
export interface BackupInspectResult {
  app: string;
  kind: string;
  formatVersion: number;
  appVersion: string | null;
  schemaVersion: number | null;
  createdAt: string;
  dbEntry: string;
  dbBytes: number;
  uploadCount: number;
  uploads: string[];
  /** AI credential encryption key posture recorded at backup time (#496). */
  aiKeySource: AiKeySource;
  aiKeyIncluded: boolean;
  aiCredentialCount: number | null;
  /** Attachment checksums from the v3 manifest (#444). */
  attachmentChecksums: BackupInspectAttachmentChecksum[];
  /** Reconciliation summary from the v3 manifest (#444). */
  reconciliation: BackupInspectReconciliation;
}

/** Enforce the shared writer/reader manifest entry ceiling. */
export function assertBackupManifestBytes(bytes: number): void {
  if (bytes > MAX_MANIFEST_BYTES) {
    throw new ServiceUnavailableException(
      `Backup manifest exceeds the ${MAX_MANIFEST_BYTES} byte restore manifest limit`,
    );
  }
}

/** Compact serialization keeps checksum metadata practical at the entry cap. */
export function serializeBackupManifest(manifest: BackupManifest): string {
  const json = JSON.stringify(manifest);
  assertBackupManifestBytes(Buffer.byteLength(json));
  return json;
}

/** Cap checksum rows returned by inspect so huge archives stay UI-safe. */
export const BACKUP_INSPECT_CHECKSUM_CAP = 100;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Format v3 requires complete attachment checksum metadata. Every record must
 * be safe and complete so restore validation can require exact archive coverage.
 */
function parseAttachmentRecords(raw: Record<string, unknown>): BackupAttachmentRecord[] {
  if (!Object.prototype.hasOwnProperty.call(raw, 'attachments')) {
    throw new BadRequestException('Invalid backup archive — format version 3 requires attachment checksum metadata');
  }
  if (!Array.isArray(raw.attachments)) {
    throw new BadRequestException('Invalid backup archive — manifest attachments must be an array');
  }

  const seenPaths = new Set<string>();
  return raw.attachments.map((entry): BackupAttachmentRecord => {
    if (!entry || typeof entry !== 'object') {
      throw new BadRequestException('Invalid backup archive — manifest attachment record is invalid');
    }
    const record = entry as Record<string, unknown>;
    const validPath =
      typeof record.path === 'string' &&
      record.path.length > 0 &&
      !record.path.startsWith('/') &&
      !record.path.includes('\\') &&
      !record.path.includes('\0') &&
      !record.path.split('/').some((part) => part === '' || part === '.' || part === '..');
    const validSha256 = typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.sha256);
    if (
      typeof record.id !== 'number' || !Number.isInteger(record.id) || record.id < 0 ||
      typeof record.campaignId !== 'number' || !Number.isInteger(record.campaignId) || record.campaignId < 0 ||
      !validPath ||
      typeof record.size !== 'number' || !Number.isInteger(record.size) || record.size < 0 ||
      !asNonEmptyString(record.mime) ||
      typeof record.hidden !== 'boolean' ||
      !validSha256
    ) {
      throw new BadRequestException('Invalid backup archive — manifest attachment record is invalid');
    }
    // The checks above establish these string types; keep local names so the
    // validation boundary is also clear to TypeScript.
    const attachmentPath = record.path as string;
    const mime = record.mime as string;
    const sha256 = record.sha256 as string;
    if (seenPaths.has(attachmentPath)) {
      throw new BadRequestException('Invalid backup archive — manifest attachment paths must be unique');
    }
    seenPaths.add(attachmentPath);
    return {
      id: record.id,
      campaignId: record.campaignId,
      path: attachmentPath,
      size: record.size,
      mime,
      hidden: record.hidden,
      sha256,
    };
  });
}

/** Expected database entry path for backup archives. */
export const DB_ENTRY = 'db/campfire.db';

function parseManifestV3(raw: Record<string, unknown>): BackupManifest {
  const createdAt = asNonEmptyString(raw.createdAt);
  const db = asNonEmptyString(raw.db);
  const dbBytes = raw.dbBytes;
  const uploadCount = raw.uploadCount;
  if (!createdAt || !db) {
    throw new BadRequestException('Invalid backup archive — manifest is missing required fields');
  }
  // Validate that db points to the canonical entry for this format (issue #997 fix 2).
  if (db !== DB_ENTRY) {
    // Truncate user-controlled value to avoid log/response inflation.
    const truncated = db.length > 60 ? db.slice(0, 60) + '…' : db;
    throw new BadRequestException(
      `Invalid backup archive — manifest.db must be "${DB_ENTRY}" for format version ${BACKUP_FORMAT_VERSION}, got "${truncated}"`,
    );
  }
  if (typeof dbBytes !== 'number' || !Number.isFinite(dbBytes) || dbBytes < 0) {
    throw new BadRequestException('Invalid backup archive — manifest dbBytes is invalid');
  }
  if (typeof uploadCount !== 'number' || !Number.isInteger(uploadCount) || uploadCount < 0) {
    throw new BadRequestException('Invalid backup archive — manifest uploadCount is invalid');
  }

  const appVersion = asNonEmptyString(raw.appVersion);
  const schemaVersion = raw.schemaVersion;
  const parsedSchema =
    typeof schemaVersion === 'number' && Number.isInteger(schemaVersion) && schemaVersion >= 0
      ? schemaVersion
      : undefined;

  const rawKeySource = raw.aiKeySource;
  if (rawKeySource !== 'env' && rawKeySource !== 'keyfile') {
    throw new BadRequestException('Invalid backup archive — format version 3 requires aiKeySource to be "env" or "keyfile"');
  }
  const aiKeySource: AiKeySource = rawKeySource;
  if (typeof raw.aiKeyIncluded !== 'boolean') {
    throw new BadRequestException('Invalid backup archive — format version 3 requires aiKeyIncluded to be a boolean');
  }
  const aiKeyIncluded = raw.aiKeyIncluded;
  if (aiKeyIncluded && aiKeySource !== 'keyfile') {
    throw new BadRequestException('Invalid backup archive — aiKeyIncluded=true requires aiKeySource="keyfile"');
  }
  const rawCredentialCount = raw.aiCredentialCount;
  const aiCredentialCount =
    typeof rawCredentialCount === 'number' &&
    Number.isInteger(rawCredentialCount) &&
    rawCredentialCount >= 0
      ? rawCredentialCount
      : undefined;

  const attachments = parseAttachmentRecords(raw);
  if (!raw.reconciliation || typeof raw.reconciliation !== 'object') {
    throw new BadRequestException('Invalid backup archive — format version 3 requires reconciliation metadata');
  }
  const r = raw.reconciliation as Record<string, unknown>;
  const validCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
  const totalAttachments = r.totalAttachments as number;
  const missing = r.missing as number;
  const changed = r.changed as number;
  const orphanCount = r.orphanCount as number;
  const orphans = r.orphans as unknown[];
  const clean = r.clean as boolean;
  if (
    !asNonEmptyString(r.generation) || !validCount(r.totalAttachments) || !validCount(r.missing) ||
    !validCount(r.changed) || !Array.isArray(r.orphans) || !validCount(r.orphanCount) ||
    typeof r.clean !== 'boolean' || !orphans.every((value) => typeof value === 'string') ||
    totalAttachments !== attachments.length + missing || uploadCount !== attachments.length ||
    changed !== 0 || orphanCount < orphans.length || clean !== (missing === 0)
  ) {
    throw new BadRequestException('Invalid backup archive — manifest reconciliation is invalid');
  }
  const reconciliation: BackupReconciliation = {
    generation: r.generation as string,
    totalAttachments,
    missing,
    changed,
    orphans: orphans as string[],
    orphanCount,
    clean: missing === 0 && changed === 0,
  };

  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: BACKUP_FORMAT_VERSION,
    createdAt,
    db,
    dbBytes,
    uploadCount,
    ...(appVersion ? { appVersion } : {}),
    ...(parsedSchema !== undefined ? { schemaVersion: parsedSchema } : {}),
    aiKeySource,
    aiKeyIncluded,
    ...(aiCredentialCount !== undefined ? { aiCredentialCount } : {}),
    attachments,
    reconciliation,
  };
}

/**
 * Validate the one supported manifest version before any DB work.
 */
export function parseBackupManifest(raw: unknown): BackupManifest {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestException('Invalid backup archive — manifest.json is not an object');
  }
  const record = raw as Record<string, unknown>;
  if (record.app !== BACKUP_APP || record.kind !== BACKUP_KIND) {
    throw new BadRequestException('Invalid backup archive — not a Campfire server backup');
  }

  const formatVersion = record.version;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 0) {
    throw new BadRequestException('Invalid backup archive — manifest format version is missing or invalid');
  }
  if (formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BadRequestException(
      `Invalid backup archive — manifest format version ${formatVersion} is unsupported; this pre-1.0 server accepts format version ${BACKUP_FORMAT_VERSION} only.`,
    );
  }
  return parseManifestV3(record);
}

export function manifestToInspectView(manifest: BackupManifest, uploads: string[]): BackupInspectResult {
  const reconciliation = {
    generation: manifest.reconciliation.generation,
    totalAttachments: manifest.reconciliation.totalAttachments,
    missing: manifest.reconciliation.missing,
    changed: manifest.reconciliation.changed,
    orphanCount: manifest.reconciliation.orphanCount,
    clean: manifest.reconciliation.clean,
    orphans: manifest.reconciliation.orphans,
  };

  const attachmentChecksums = manifest.attachments
    .slice(0, BACKUP_INSPECT_CHECKSUM_CAP)
    .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }));

  return {
    app: manifest.app,
    kind: manifest.kind,
    formatVersion: manifest.version,
    appVersion: manifest.appVersion ?? null,
    schemaVersion: manifest.schemaVersion ?? null,
    createdAt: manifest.createdAt,
    dbEntry: manifest.db,
    dbBytes: manifest.dbBytes,
    uploadCount: manifest.uploadCount,
    uploads,
    aiKeySource: manifest.aiKeySource,
    aiKeyIncluded: manifest.aiKeyIncluded,
    aiCredentialCount: manifest.aiCredentialCount ?? null,
    attachmentChecksums,
    reconciliation,
  };
}
