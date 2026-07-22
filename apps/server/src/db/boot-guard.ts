import { Logger } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Boot guard for DATA_DIR mount safety (issue #721).
 *
 * Persona-audit finding: a missing or wrong data mount caused Campfire to
 * silently create a fresh DB, report healthy, and redirect to first-run setup.
 * A recoverable mount mistake looked like total data loss and invited the
 * operator to write new data into the wrong volume.
 *
 * Acceptance criteria this addresses:
 *   - Persist an installation sentinel + instance UUID beside the DB.
 *   - Separate explicit initialization from normal startup.
 *   - After initialization, fail closed if the expected identity/data disappears
 *     rather than silently booting a half-broken server.
 *
 * Sentinel file: a JSON document placed beside campfire.db holding a stable
 * instance id (randomUUID) and the ISO timestamp of first initialization. It is
 * intentionally OUTSIDE the SQLite file so (a) it survives a DB-only restore,
 * (b) it can be read without opening SQLite, and (c) the operator can inspect it
 * directly when diagnosing a mount problem.
 *
 * The sentinel is the boundary between "first run" and "normal startup":
 *   - No sentinel yet  → first contact with this DATA_DIR (genuine fresh install,
 *     or a pre-#721 DB being upgraded). The sentinel is initialized; when a DB
 *     is already present this is logged loudly so an operator who did NOT expect
 *     an existing DB can stop and investigate (the wrong-mount signal).
 *   - Sentinel present → not first-run. If campfire.db has since disappeared the
 *     guard REFUSES to boot (data loss / incomplete restore suspected) unless the
 *     operator explicitly acknowledges via CAMPFIRE_ALLOW_FRESH_DB=1, which
 *     downgrades the refusal to a loud warning.
 *
 * Why not fail closed when a DB exists but no sentinel? Because that case is
 * indistinguishable from a legitimate upgrade of a pre-#721 install, and
 * failing closed there would break every upgrade. The sentinel-on-first-contact
 * path covers upgrades; subsequent boots are then protected by the sentinel.
 */

const dbLog = new Logger('Database');

/** Filename of the installation sentinel, placed beside campfire.db in DATA_DIR. */
export const SENTINEL_FILENAME = '.campfire-install.json';

/** Env escape hatch: acknowledge data loss and allow a fresh DB over a sentinel-protected install (issue #721). */
export const ALLOW_FRESH_DB_ENV = 'CAMPFIRE_ALLOW_FRESH_DB';

/** Shape of the sentinel document persisted beside the DB. */
export interface InstallSentinel {
  /** Stable instance identity (randomUUID), set once at first contact with this DATA_DIR. */
  instanceId: string;
  /** ISO timestamp of first initialization. */
  createdAt: string;
  /** Schema version of the sentinel document itself, for future evolution. */
  sentinelVersion: number;
}

/** Current sentinel document schema version. */
const SENTINEL_VERSION = 1;

/** Error thrown when the boot guard refuses to start (issue #721). */
export class DataMountGuardError extends Error {
  constructor(
    message: string,
    readonly details: {
      dataDir: string;
      dbFile: string;
      sentinelFile: string;
      dbExists: boolean;
      sentinelExists: boolean;
    },
  ) {
    super(message);
    this.name = 'DataMountGuardError';
  }
}

/** Absolute path to the sentinel file for a given data dir. */
export function sentinelFilePath(dataDir: string): string {
  return path.join(dataDir, SENTINEL_FILENAME);
}

/** Read and parse the sentinel. Returns `present:false` when the file is absent and `present:true, sentinel:undefined` when it exists but is corrupt. */
function readSentinel(sentinelFile: string): { present: boolean; sentinel: InstallSentinel | undefined } {
  let raw: string;
  try {
    raw = fs.readFileSync(sentinelFile, 'utf8');
  } catch {
    return { present: false, sentinel: undefined };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<InstallSentinel>;
    if (
      typeof parsed.instanceId === 'string' &&
      parsed.instanceId.length > 0 &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.sentinelVersion === 'number'
    ) {
      return {
        present: true,
        sentinel: {
          instanceId: parsed.instanceId,
          createdAt: parsed.createdAt,
          sentinelVersion: parsed.sentinelVersion,
        },
      };
    }
  } catch {
    // fall through — corrupt sentinel: present but unreadable.
  }
  return { present: true, sentinel: undefined };
}

/** Persist the sentinel atomically (temp + rename) so a crash mid-write can't half-create it. */
function writeSentinel(sentinelFile: string, sentinel: InstallSentinel): void {
  const tmp = `${sentinelFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sentinel, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, sentinelFile);
}

/** Build a brand-new sentinel document for first contact. */
function newSentinel(): InstallSentinel {
  return {
    instanceId: randomUUID(),
    createdAt: new Date().toISOString(),
    sentinelVersion: SENTINEL_VERSION,
  };
}

/**
 * Outcome of {@link assertDataMount} — distinguishes the first-contact path
 * (sentinel just initialized, fresh-install setup expected) from a normal restart.
 */
export type BootGuardOutcome =
  | { kind: 'initialized'; sentinel: InstallSentinel; adoptedExistingDb: boolean }
  | { kind: 'normal'; sentinel: InstallSentinel };

/**
 * Verify the DATA_DIR mount looks correct before the DB is opened.
 *
 * MUST run AFTER the data dir has been mkdir'd but BEFORE campfire.db is opened
 * — so the guard is the single arbiter of "fresh install vs broken mount" and
 * the SQLite open path never auto-creates a DB over a guard failure.
 *
 * Policy (see file header):
 *   - No sentinel + no DB      → fresh install; initialize sentinel. (info)
 *   - No sentinel + DB present → first contact adopting an existing DB (upgrade or
 *     wrong mount — indistinguishable, so initialize + WARN loudly). (warn)
 *   - Sentinel + DB present    → normal startup. (quiet)
 *   - Sentinel + DB missing    → data loss / incomplete restore suspected; REFUSE
 *     to boot unless CAMPFIRE_ALLOW_FRESH_DB=1 (then WARN and proceed).
 *
 * @param dataDir Absolute path to DATA_DIR.
 * @param dbFile  Absolute path to campfire.db (path.join(dataDir, 'campfire.db')).
 * @throws {DataMountGuardError} when an existing install's DB has disappeared and
 *   the operator has not acknowledged via CAMPFIRE_ALLOW_FRESH_DB=1.
 */
export function assertDataMount(dataDir: string, dbFile: string): BootGuardOutcome {
  const sentinelFile = sentinelFilePath(dataDir);
  const dbExists = fs.existsSync(dbFile);
  const { present: sentinelFilePresent, sentinel } = readSentinel(sentinelFile);
  const sentinelExists = sentinel !== undefined;
  const allowFreshDb = process.env[ALLOW_FRESH_DB_ENV] === '1';

  // Sentinel file is present but could not be parsed into a valid InstallSentinel.
  // The sentinel is written atomically (temp + rename), so a corrupt file is a
  // strong signal of external tampering, a failing disk, or a partial manual
  // edit — none of which we should paper over by minting a fresh identity over
  // real data. Refuse to boot; the operator inspects/removes the file and re-runs.
  if (sentinelFilePresent && !sentinelExists) {
    const err = new DataMountGuardError(
      'DATA_DIR mount guard: install sentinel is present but unreadable/corrupt at ' +
        `${sentinelFile}. The sentinel is written atomically, so corruption suggests external tampering ` +
        'or disk failure. Refusing to boot — inspect or remove the file and re-run (issue #721).',
      { dataDir, dbFile, sentinelFile, dbExists, sentinelExists: true },
    );
    dbLog.error(err.message);
    throw err;
  }

  // First contact: no sentinel file at all. This DATA_DIR has never been
  // initialized under the #721 scheme (genuine fresh install, or a pre-#721 DB
  // upgrading in).
  if (!sentinelFilePresent) {
    const fresh = newSentinel();
    writeSentinel(sentinelFile, fresh);
    if (dbExists) {
      // An existing campfire.db is being adopted. This is the expected upgrade
      // path for pre-#721 installs BUT is byte-for-byte indistinguishable from a
      // wrong bind mount onto a foreign DB, so it gets a prominent WARN rather
      // than silence. An operator who did not expect an existing DB here must
      // stop and verify the mount before writing new data.
      dbLog.warn(
        `Adopting an EXISTING campfire.db at ${dbFile} on first contact (no prior install sentinel). ` +
          `Recorded new instance id ${fresh.instanceId} at ${sentinelFile}. ` +
          `This is expected when upgrading an existing install, but if you did NOT expect a database here the mount may be wrong — ` +
          `STOP and verify DATA_DIR before continuing, or you may write new data into someone else's volume (issue #721).`,
      );
      return { kind: 'initialized', sentinel: fresh, adoptedExistingDb: true };
    }
    dbLog.log(
      `First run detected — initialized install sentinel ${fresh.instanceId} at ${sentinelFile}. ` +
        'This is the identity-of-record for this DATA_DIR; if the DB later disappears the server will refuse to boot (issue #721).',
    );
    return { kind: 'initialized', sentinel: fresh, adoptedExistingDb: false };
  }

  // Sentinel present but DB missing: the install had data and it's gone. This is
  // the "missing the expected db file when not first-run" case from the issue —
  // fail closed so a recoverable restore mistake is not papered over by a silent
  // fresh-DB + first-run-setup flow that invites the operator to write into the
  // wrong volume.
  if (!dbExists) {
    if (allowFreshDb) {
      dbLog.warn(
        `DATA_DIR mount: install sentinel ${sentinel!.instanceId} is present but campfire.db is MISSING at ${dbFile}, ` +
          `and CAMPFIRE_ALLOW_FRESH_DB=1 is set — proceeding to create a fresh empty DB. First-run setup will run. ` +
          `If you did not expect data loss, STOP and restore campfire.db before continuing (issue #721).`,
      );
      return { kind: 'normal', sentinel: sentinel! };
    }
    const err = new DataMountGuardError(
      'DATA_DIR mount guard: this install already has an install sentinel ' +
        `(${sentinel!.instanceId}) but campfire.db is MISSING at ${dbFile}. ` +
        'This looks like data loss or an incomplete restore. Refusing to boot rather than silently creating a fresh DB ' +
        '(issue #721). Restore campfire.db, or set CAMPFIRE_ALLOW_FRESH_DB=1 to acknowledge and start with an empty database.',
      { dataDir, dbFile, sentinelFile, dbExists, sentinelExists },
    );
    dbLog.error(err.message);
    throw err;
  }

  // Normal startup: sentinel and DB both present. Quiet path.
  return { kind: 'normal', sentinel: sentinel! };
}
