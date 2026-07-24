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
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  if (formatVersion === 1 || formatVersion === 2) {
    return normalizeManifestV1(record, formatVersion);
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
    aiKeySource: manifest.aiKeySource ?? null,
    aiKeyIncluded: manifest.aiKeyIncluded === true,
    aiCredentialCount: manifest.aiCredentialCount ?? null,
  };
}
