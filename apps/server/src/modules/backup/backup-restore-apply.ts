import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dbFilePath } from '../../db/db.module';

/** #497: restore phases surfaced to operators and tests. */
export type RestoreProgressPhase =
  | 'validated'
  | 'staging-uploads'
  | 'quiescing'
  | 'snapshotting-rollback'
  | 'staging-incoming'
  | 'swapping-database'
  | 'swapping-uploads'
  | 'swapping-keyfile'
  | 'health-check'
  | 'cleanup'
  | 'rolled-back';

/** Fault-injection points for #497 rollback coverage (tests only). */
export type RestoreApplyFaultPoint =
  | 'after-rollback-snapshot'
  | 'after-stage-incoming-db'
  | 'after-stage-incoming-uploads'
  | 'after-db-swap'
  | 'after-uploads-swap'
  | 'after-keyfile-swap'
  | 'during-health-check';

export interface RestoreApplyInput {
  dataDir: string;
  stagedDbPath: string;
  stagedUploadsDir: string;
  /** When set, write the decrypted keyfile during apply (env-managed hosts skip). */
  restoredKeyBytes: Buffer | null;
  aiKeyfileName: string;
  envKeyManaged: boolean;
  onProgress?: (phase: RestoreProgressPhase) => void;
}

export interface RestoreApplyResult {
  phases: RestoreProgressPhase[];
}

let faultInjector: ((point: RestoreApplyFaultPoint) => void) | null = null;

/** Test-only hook — throws when the injector is configured to fail at `point`. */
export function __setRestoreApplyFaultInjector(
  injector: ((point: RestoreApplyFaultPoint) => void) | null,
): void {
  faultInjector = injector;
}

function uploadsRoot(dataDir: string): string {
  return path.join(dataDir, 'uploads');
}

function reportProgress(
  phases: RestoreProgressPhase[],
  onProgress: RestoreApplyInput['onProgress'],
  phase: RestoreProgressPhase,
): void {
  phases.push(phase);
  onProgress?.(phase);
}

function maybeFault(point: RestoreApplyFaultPoint): void {
  faultInjector?.(point);
}

function copyFileBestEffort(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyTree(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(srcPath, destPath);
    else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
  }
}

function movePath(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
}

function removePath(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

/** Move live DB files (+ wal/shm when present) into the rollback snapshot. */
function snapshotLiveDatabase(dbPath: string, rollbackDbDir: string): void {
  fs.mkdirSync(rollbackDbDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm'] as const) {
    const live = dbPath + suffix;
    if (!fs.existsSync(live)) continue;
    movePath(live, path.join(rollbackDbDir, path.basename(dbPath) + suffix));
  }
}

/** Restore live DB files from the rollback snapshot. */
function restoreLiveDatabase(dbPath: string, rollbackDbDir: string): void {
  const base = path.basename(dbPath);
  for (const suffix of ['', '-wal', '-shm'] as const) {
    const snap = path.join(rollbackDbDir, base + suffix);
    const live = dbPath + suffix;
    removePath(live);
    if (fs.existsSync(snap)) movePath(snap, live);
  }
}

function verifyRestoredDatabase(dbPath: string): void {
  const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = probe.pragma('integrity_check', { simple: true });
    const hasUsers = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .get();
    if (integrity !== 'ok' || !hasUsers) {
      throw new Error('Restored database failed post-swap health verification');
    }
  } finally {
    probe.close();
  }
}

/**
 * #497: Atomically replace the live database + uploads tree, retaining a rollback
 * snapshot until health verification succeeds. On any failure after the live
 * tree is touched, the previous state is restored automatically.
 */
export function applyRestoredState(input: RestoreApplyInput): RestoreApplyResult {
  const phases: RestoreProgressPhase[] = [];
  const {
    dataDir,
    stagedDbPath,
    stagedUploadsDir,
    restoredKeyBytes,
    aiKeyfileName,
    envKeyManaged,
    onProgress,
  } = input;

  const dbPath = dbFilePath(dataDir);
  const uploads = uploadsRoot(dataDir);
  const keyfilePath = path.join(dataDir, aiKeyfileName);

  const willReplaceKeyfile = !!(restoredKeyBytes && !envKeyManaged);

  const token = `${process.pid}-${Date.now()}`;
  const rollbackRoot = path.join(dataDir, `.restore-rollback-${token}`);
  const rollbackDbDir = path.join(rollbackRoot, 'db');
  const rollbackUploadsDir = path.join(rollbackRoot, 'uploads');
  const rollbackKeyfile = path.join(rollbackRoot, aiKeyfileName);

  const incomingDbPath = `${dbPath}.incoming-${token}`;
  const incomingUploadsDir = `${uploads}.incoming-${token}`;
  const incomingKeyfile = `${keyfilePath}.incoming-${token}`;

  let rollbackSnapshotted = false;
  let uploadsSwapped = false;
  let keyfileSwapped = false;

  const rollback = (): void => {
    try {
      if (keyfileSwapped) removePath(keyfilePath);
      if (fs.existsSync(rollbackKeyfile)) movePath(rollbackKeyfile, keyfilePath);

      if (uploadsSwapped) removePath(uploads);
      if (fs.existsSync(rollbackUploadsDir)) movePath(rollbackUploadsDir, uploads);

      for (const suffix of ['', '-wal', '-shm'] as const) {
        removePath(dbPath + suffix);
      }
      if (fs.existsSync(rollbackDbDir)) restoreLiveDatabase(dbPath, rollbackDbDir);

      reportProgress(phases, onProgress, 'rolled-back');
    } finally {
      removePath(rollbackRoot);
      removePath(incomingDbPath);
      removePath(`${incomingDbPath}-wal`);
      removePath(`${incomingDbPath}-shm`);
      removePath(incomingUploadsDir);
      removePath(incomingKeyfile);
    }
  };

  try {
    reportProgress(phases, onProgress, 'snapshotting-rollback');
    snapshotLiveDatabase(dbPath, rollbackDbDir);
    if (fs.existsSync(uploads)) movePath(uploads, rollbackUploadsDir);
    if (willReplaceKeyfile && fs.existsSync(keyfilePath)) movePath(keyfilePath, rollbackKeyfile);
    rollbackSnapshotted = true;
    maybeFault('after-rollback-snapshot');

    reportProgress(phases, onProgress, 'staging-incoming');
    copyFileBestEffort(stagedDbPath, incomingDbPath);
    maybeFault('after-stage-incoming-db');
    copyTree(stagedUploadsDir, incomingUploadsDir);
    maybeFault('after-stage-incoming-uploads');

    if (willReplaceKeyfile) {
      fs.writeFileSync(incomingKeyfile, restoredKeyBytes!.toString('utf8'), { mode: 0o600 });
    }

    reportProgress(phases, onProgress, 'swapping-database');
    movePath(incomingDbPath, dbPath);
    maybeFault('after-db-swap');

    reportProgress(phases, onProgress, 'swapping-uploads');
    if (fs.existsSync(incomingUploadsDir)) movePath(incomingUploadsDir, uploads);
    uploadsSwapped = true;
    maybeFault('after-uploads-swap');

    if (willReplaceKeyfile && fs.existsSync(incomingKeyfile)) {
      reportProgress(phases, onProgress, 'swapping-keyfile');
      movePath(incomingKeyfile, keyfilePath);
      keyfileSwapped = true;
      maybeFault('after-keyfile-swap');
    }

    reportProgress(phases, onProgress, 'health-check');
    maybeFault('during-health-check');
    verifyRestoredDatabase(dbPath);

    reportProgress(phases, onProgress, 'cleanup');
    removePath(rollbackRoot);
    return { phases };
  } catch (err) {
    if (rollbackSnapshotted) rollback();
    throw err;
  }
}
