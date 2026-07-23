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
}

/** Non-destructive summary returned by backup inspect (issue #514). */
export interface BackupInspectResult {
  app: string;
  kind: string;
  formatVersion: number;
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

function normalizeManifestV1(raw: Record<string, unknown>): BackupManifest {
  const createdAt = asNonEmptyString(raw.createdAt);
  const db = asNonEmptyString(raw.db);
  const dbBytes = raw.dbBytes;
  const uploadCount = raw.uploadCount;
  if (!createdAt || !db) {
    throw new BadRequestException('Invalid backup archive — manifest is missing required fields');
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

export function manifestToInspectView(manifest: BackupManifest, uploads: string[]): BackupInspectResult {
  return {
    app: manifest.app,
    kind: manifest.kind,
    formatVersion: manifest.version,
    appVersion: manifest.appVersion ?? null,
    schemaVersion: manifest.schemaVersion ?? null,
    createdAt: manifest.createdAt ?? null,
    dbEntry: manifest.db ?? null,
    dbBytes: manifest.dbBytes ?? null,
    uploadCount: manifest.uploadCount ?? null,
    uploads,
  };
}
