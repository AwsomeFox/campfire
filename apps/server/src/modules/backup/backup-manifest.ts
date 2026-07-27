import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { APP_VERSION } from '../../common/build-metadata';
import { MIGRATION_NAMES } from '../../db/db.module';
import { MAX_MANIFEST_BYTES } from './backup-archive-reader';

/** Marks an archive as a Campfire whole-server backup. */
export const BACKUP_APP = 'campfire';
export const BACKUP_KIND = 'server-backup';

/**
 * Current manifest format version written into new archives. Bump when the zip
 * layout or manifest schema changes; add an explicit migration for each older
 * version in {@link parseBackupManifest}.
 */
export const BACKUP_FORMAT_VERSION = 2;

/** Format version written for archives that include an AI keyfile envelope (#496).
 *  Older Campfire releases only understand format 1 and will reject these archives,
 *  preventing a silent restore that leaves credentials undecryptable. */
export const BACKUP_FORMAT_VERSION_WITH_KEY_ENVELOPE = 2;

/** @deprecated Use {@link BACKUP_FORMAT_VERSION}. Kept for existing imports/tests. */
export const BACKUP_VERSION = BACKUP_FORMAT_VERSION;

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
 * counts of zero indicate a fully consistent archive; a non-zero missing or
 * changed count means the archive is partial and should not be treated as a
 * clean restore source without operator review.
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
  /** Whether the archive is fully reconciled (missing === 0 && changed === 0). */
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
  /** AI credential encryption key posture at backup time (#496). Optional for
   *  backward compat — older archives simply omit it and the restore side
   *  assumes `keyfile` with no envelope. */
  aiKeySource?: AiKeySource;
  /** True when an encrypted keyfile envelope (ai-config.key.env.json) is
   *  present in the archive (#496). */
  aiKeyIncluded?: boolean;
  /** Number of AI provider config rows with a stored encrypted API key at
   *  backup time (#496). Lets the operator quickly see the size of the
   *  credential fleet that hinges on the keyfile. Non-secret — no key
   *  material or last-4 leaks through this count. */
  aiCredentialCount?: number;
  /**
   * Per-attachment reconciliation records (#828). Written by archives from
   * this Campfire release onward; older archives omit this field.
   */
  attachments?: BackupAttachmentRecord[];
  /**
   * Reconciliation summary (#828). Written by archives from this release onward;
   * older archives omit this field (they were produced before reconciliation).
   */
  reconciliation?: BackupReconciliation;
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
  /** The raw format version from the source archive before normalization (issue #997). */
  sourceFormatVersion: number;
  appVersion: string | null;
  schemaVersion: number | null;
  createdAt: string | null;
  dbEntry: string | null;
  dbBytes: number | null;
  uploadCount: number | null;
  uploads: string[];
  /** AI credential encryption key posture recorded at backup time (#496). */
  aiKeySource: AiKeySource | null;
  aiKeyIncluded: boolean;
  aiCredentialCount: number | null;
  /** Attachment checksums from the manifest when present (#444). */
  attachmentChecksums: BackupInspectAttachmentChecksum[];
  /** Reconciliation summary from the manifest when present (#444). */
  reconciliation: BackupInspectReconciliation | null;
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
 * Attachment checksum metadata is an all-or-nothing capability. Archives made
 * before #828 omit `attachments` entirely; once an archive claims the field,
 * every record must be safe and complete so callers cannot accidentally treat
 * a partially corrupt modern manifest as a legacy archive.
 */
function parseAttachmentRecords(raw: Record<string, unknown>): BackupAttachmentRecord[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(raw, 'attachments')) return undefined;
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

/** Expected db entry path for format version 1 archives (issue #997 fix 2). */
export const DB_ENTRY_V1 = 'db/campfire.db';

function normalizeManifestV1(raw: Record<string, unknown>, sourceVersion = 1): BackupManifest {
  const createdAt = asNonEmptyString(raw.createdAt);
  const db = asNonEmptyString(raw.db);
  const dbBytes = raw.dbBytes;
  const uploadCount = raw.uploadCount;
  if (!createdAt || !db) {
    throw new BadRequestException('Invalid backup archive — manifest is missing required fields');
  }
  // Validate that db points to the canonical entry for this format (issue #997 fix 2).
  if (db !== DB_ENTRY_V1) {
    // Truncate user-controlled value to avoid log/response inflation.
    const truncated = db.length > 60 ? db.slice(0, 60) + '…' : db;
    throw new BadRequestException(
      `Invalid backup archive — manifest.db must be "${DB_ENTRY_V1}" for format version ${sourceVersion}, got "${truncated}"`,
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

  // #496: AI credential key posture — all optional for backward compat.
  const rawKeySource = raw.aiKeySource;
  const aiKeySource: AiKeySource | undefined =
    rawKeySource === 'env' || rawKeySource === 'keyfile' ? rawKeySource : undefined;
  const aiKeyIncluded = raw.aiKeyIncluded === true ? true : undefined;
  const rawCredentialCount = raw.aiCredentialCount;
  const aiCredentialCount =
    typeof rawCredentialCount === 'number' &&
    Number.isInteger(rawCredentialCount) &&
    rawCredentialCount >= 0
      ? rawCredentialCount
      : undefined;

  // #828: legacy archives genuinely omit this field. A claimed field is
  // strict: filtering malformed rows here would allow checksum coverage to be
  // silently downgraded when uploadCount still happens to match.
  const attachments = parseAttachmentRecords(raw);
  // Format 2 was introduced after attachment reconciliation. Unlike v0/v1,
  // it can never be a genuinely pre-checksum archive, even if a repackager
  // strips both modern metadata fields.
  if (attachments === undefined && sourceVersion >= 2) {
    throw new BadRequestException(
      `Invalid backup archive — format version ${sourceVersion} requires attachment checksum metadata`,
    );
  }
  // Reconciliation and attachment checksums were introduced together. Its
  // presence proves this is a checksum-era archive, so accepting a missing
  // `attachments` field here would let a repackaged modern archive downgrade
  // itself to the legacy compatibility path.
  if (attachments === undefined && Object.prototype.hasOwnProperty.call(raw, 'reconciliation')) {
    throw new BadRequestException(
      'Invalid backup archive — manifest reconciliation requires attachment checksum metadata',
    );
  }

  let reconciliation: BackupReconciliation | undefined;
  if (raw.reconciliation && typeof raw.reconciliation === 'object') {
    const r = raw.reconciliation as Record<string, unknown>;
    if (
      typeof r.generation === 'string' &&
      typeof r.totalAttachments === 'number' &&
      typeof r.missing === 'number' &&
      typeof r.changed === 'number' &&
      Array.isArray(r.orphans) &&
      typeof r.orphanCount === 'number'
    ) {
      // `clean` is derived — never trust a caller-supplied boolean that could disagree
      // with missing/changed (e.g. missing:1 + clean:true).
      reconciliation = {
        generation: r.generation,
        totalAttachments: r.totalAttachments,
        missing: r.missing,
        changed: r.changed,
        orphans: (r.orphans as unknown[]).filter((x): x is string => typeof x === 'string'),
        orphanCount: r.orphanCount,
        clean: r.missing === 0 && r.changed === 0,
      };
    }
  }

  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: sourceVersion,
    createdAt,
    db,
    dbBytes,
    uploadCount,
    ...(appVersion ? { appVersion } : {}),
    ...(parsedSchema !== undefined ? { schemaVersion: parsedSchema } : {}),
    ...(aiKeySource ? { aiKeySource } : {}),
    ...(aiKeyIncluded !== undefined ? { aiKeyIncluded } : {}),
    ...(aiCredentialCount !== undefined ? { aiCredentialCount } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(reconciliation ? { reconciliation } : {}),
  };
}

/**
 * Validate app/kind, reject unsupported future format versions (before any DB
 * work), and migrate recognized older formats to the current shape.
 */
export function parseBackupManifest(raw: unknown): BackupManifest {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestException('Invalid backup archive — manifest.json is not an object');
  }
  const record = raw as Record<string, unknown>;
  if (record.app !== BACKUP_APP || record.kind !== BACKUP_KIND) {
    throw new BadRequestException('Invalid backup archive — not a Campfire server backup');
  }

  let formatVersion = record.version;
  if (formatVersion === undefined || formatVersion === null) {
    formatVersion = 0;
  }
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 0) {
    throw new BadRequestException('Invalid backup archive — manifest format version is missing or invalid');
  }

  if (formatVersion > BACKUP_FORMAT_VERSION) {
    const required = asNonEmptyString(record.minCampfireVersion);
    const hint = required
      ? `Upgrade Campfire to at least v${required} before restoring this archive.`
      : `Upgrade Campfire to a release that supports backup format version ${formatVersion}.`;
    throw new BadRequestException(
      `Invalid backup archive — manifest format version ${formatVersion} is newer than this server supports (format version ${BACKUP_FORMAT_VERSION}). ${hint}`,
    );
  }

  if (formatVersion === 0) {
    return normalizeManifestV1({ ...record, version: 1 });
  }
  if (formatVersion === 1) {
    return normalizeManifestV1(record, formatVersion);
  }
  if (formatVersion === 2) {
    // Format 2 exists solely for envelope-bearing archives. Reject incomplete
    // or repackaged v2 manifests that omit the posture markers so restore cannot
    // silently apply the DB without its credential key (#496).
    if (record.aiKeyIncluded !== true || record.aiKeySource !== 'keyfile') {
      throw new BadRequestException(
        'Invalid backup archive — format version 2 requires aiKeyIncluded=true and aiKeySource="keyfile"',
      );
    }
    return normalizeManifestV1(record, formatVersion);
  }

  throw new BadRequestException(
    `Invalid backup archive — unrecognized manifest format version ${formatVersion}`,
  );
}

export function manifestToInspectView(manifest: BackupManifest, uploads: string[], sourceFormatVersion: number): BackupInspectResult {
  const reconciliation = manifest.reconciliation
    ? {
        generation: manifest.reconciliation.generation,
        totalAttachments: manifest.reconciliation.totalAttachments,
        missing: manifest.reconciliation.missing,
        changed: manifest.reconciliation.changed,
        orphanCount: manifest.reconciliation.orphanCount,
        clean: manifest.reconciliation.clean,
        orphans: manifest.reconciliation.orphans,
      }
    : null;

  const attachmentChecksums = (manifest.attachments ?? [])
    .slice(0, BACKUP_INSPECT_CHECKSUM_CAP)
    .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }));

  return {
    app: manifest.app,
    kind: manifest.kind,
    formatVersion: manifest.version,
    sourceFormatVersion,
    appVersion: manifest.appVersion ?? null,
    schemaVersion: manifest.schemaVersion ?? null,
    createdAt: manifest.createdAt ?? null,
    dbEntry: manifest.db ?? null,
    dbBytes: manifest.dbBytes ?? null,
    uploadCount: manifest.uploadCount ?? null,
    uploads,
    aiKeySource: manifest.aiKeySource ?? null,
    aiKeyIncluded: manifest.aiKeyIncluded === true,
    aiCredentialCount: manifest.aiCredentialCount ?? null,
    attachmentChecksums,
    reconciliation,
  };
}
