import { BadRequestException } from '@nestjs/common';
import { APP_VERSION } from '../../common/build-metadata';
import { MIGRATION_NAMES } from '../../db/db.module';

/** Marks an archive as a Campfire whole-server backup. */
export const BACKUP_APP = 'campfire';
export const BACKUP_KIND = 'server-backup';

/**
 * Current manifest format version written into new archives. Bump when the zip
 * layout or manifest schema changes; add an explicit migration for each older
 * version in {@link parseBackupManifest}.
 */
export const BACKUP_FORMAT_VERSION = 1;

/** @deprecated Use {@link BACKUP_FORMAT_VERSION}. Kept for existing imports/tests. */
export const BACKUP_VERSION = BACKUP_FORMAT_VERSION;

/** DB migration count at backup time — a coarse schema revision for operators. */
export const CURRENT_SCHEMA_REVISION = MIGRATION_NAMES.length;

export function serverAppVersion(): string {
  return APP_VERSION;
}

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
  /**
   * Per-attachment reconciliation records (#828). Written by v1 archives from
   * this Campfire release onward; older archives omit this field.
   */
  attachments?: BackupAttachmentRecord[];
  /**
   * Reconciliation summary (#828). Written by v1 archives from this release onward;
   * older archives omit this field (they were produced before reconciliation).
   */
  reconciliation?: BackupReconciliation;
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
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Expected db entry path for format version 1 archives (issue #997 fix 2). */
export const DB_ENTRY_V1 = 'db/campfire.db';

function normalizeManifestV1(raw: Record<string, unknown>): BackupManifest {
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
      `Invalid backup archive — manifest.db must be "${DB_ENTRY_V1}" for format version 1, got "${truncated}"`,
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

  // #828: preserve optional reconciliation fields when re-reading a manifest.
  const attachments = Array.isArray(raw.attachments)
    ? (raw.attachments as unknown[])
        .map((entry): BackupAttachmentRecord | null => {
          if (!entry || typeof entry !== 'object') return null;
          const rec = entry as Record<string, unknown>;
          if (
            typeof rec.id !== 'number' ||
            typeof rec.campaignId !== 'number' ||
            typeof rec.path !== 'string' ||
            typeof rec.size !== 'number' ||
            typeof rec.mime !== 'string' ||
            typeof rec.sha256 !== 'string'
          ) {
            return null;
          }
          return {
            id: rec.id,
            campaignId: rec.campaignId,
            path: rec.path,
            size: rec.size,
            mime: rec.mime,
            hidden: rec.hidden === true,
            sha256: rec.sha256,
          };
        })
        .filter((r): r is BackupAttachmentRecord => r !== null)
    : undefined;

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
    version: BACKUP_FORMAT_VERSION,
    createdAt,
    db,
    dbBytes,
    uploadCount,
    ...(appVersion ? { appVersion } : {}),
    ...(parsedSchema !== undefined ? { schemaVersion: parsedSchema } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
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
    return normalizeManifestV1(record);
  }

  throw new BadRequestException(
    `Invalid backup archive — unrecognized manifest format version ${formatVersion}`,
  );
}

export function manifestToInspectView(manifest: BackupManifest, uploads: string[], sourceFormatVersion: number): BackupInspectResult {
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
  };
}
