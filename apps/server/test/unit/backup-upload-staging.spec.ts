import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUP_UPLOAD_STAGE_OWNER_FILE,
  BACKUP_UPLOAD_STAGE_PREFIX,
  createPrivateUploadStageRoot,
  linuxProcessState,
  reclaimStaleUploadStageRoots,
} from '../../src/modules/backup/backup.controller';

describe('backup upload staging root', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-backup-upload-stage-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function owner(root: string, value: object): void {
    fs.writeFileSync(path.join(root, BACKUP_UPLOAD_STAGE_OWNER_FILE), JSON.stringify(value));
  }

  it('uses a unique private directory instead of a pre-created predictable temp path', () => {
    const predictablePath = path.join(tmpDir, 'campfire-backup-uploads');
    const attackerTarget = path.join(tmpDir, 'attacker-target');
    fs.mkdirSync(attackerTarget);
    fs.symlinkSync(attackerTarget, predictablePath);

    const root = createPrivateUploadStageRoot(tmpDir);

    expect(root).not.toBe(predictablePath);
    expect(path.dirname(root)).toBe(tmpDir);
    expect(fs.lstatSync(root).isDirectory()).toBe(true);
    expect(fs.lstatSync(root).isSymbolicLink()).toBe(false);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  });

  it('reclaims a dead-owner staging root while preserving the current live root', () => {
    const stale = createPrivateUploadStageRoot(tmpDir);
    const live = createPrivateUploadStageRoot(tmpDir);
    owner(stale, { version: 1, pid: 999_999_999 });
    fs.writeFileSync(path.join(live, 'active.zip'), 'live upload');

    reclaimStaleUploadStageRoots(tmpDir, live, () => ({ state: 'dead' }));

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(path.join(live, 'active.zip'), 'utf8')).toBe('live upload');
  });

  it('preserves a live sibling root even when it is not the current-root exemption', () => {
    const current = createPrivateUploadStageRoot(tmpDir);
    const sibling = createPrivateUploadStageRoot(tmpDir);
    fs.writeFileSync(path.join(sibling, 'active.zip'), 'sibling upload');

    reclaimStaleUploadStageRoots(tmpDir, current);

    expect(fs.readFileSync(path.join(sibling, 'active.zip'), 'utf8')).toBe('sibling upload');
  });

  it('distinguishes a reused current PID by its process token', () => {
    const stale = createPrivateUploadStageRoot(tmpDir);
    owner(stale, { version: 1, pid: process.pid, token: 'old-process-instance' });

    reclaimStaleUploadStageRoots(tmpDir, undefined, () => ({ state: 'unknown' }));

    expect(fs.existsSync(stale)).toBe(false);
  });

  it('preserves matching sibling process identity and reclaims boot/start mismatches', () => {
    const matching = createPrivateUploadStageRoot(tmpDir);
    const bootMismatch = createPrivateUploadStageRoot(tmpDir);
    const startMismatch = createPrivateUploadStageRoot(tmpDir);
    owner(matching, { version: 1, pid: 42, bootId: 'boot-a', startTicks: '100' });
    owner(bootMismatch, { version: 1, pid: 43, bootId: 'boot-old', startTicks: '100' });
    owner(startMismatch, { version: 1, pid: 44, bootId: 'boot-a', startTicks: '99' });
    const lookup = (pid: number) => pid === 42
      ? { state: 'alive' as const, bootId: 'boot-a', startTicks: '100' }
      : { state: 'alive' as const, bootId: 'boot-a', startTicks: '100' };

    reclaimStaleUploadStageRoots(tmpDir, undefined, lookup);

    expect(fs.existsSync(matching)).toBe(true);
    expect(fs.existsSync(bootMismatch)).toBe(false);
    expect(fs.existsSync(startMismatch)).toBe(false);
  });

  it('preserves unknown, malformed, and legacy owner identities', () => {
    const unknown = createPrivateUploadStageRoot(tmpDir);
    const malformed = createPrivateUploadStageRoot(tmpDir);
    const legacy = createPrivateUploadStageRoot(tmpDir);
    owner(unknown, { version: 1, pid: 42, bootId: 'boot-a', startTicks: '1' });
    owner(malformed, { version: 1, pid: 43, bootId: 'boot-a' });
    owner(legacy, { pid: 44 });

    reclaimStaleUploadStageRoots(tmpDir, undefined, () => ({ state: 'unknown' }));
    expect(fs.existsSync(unknown)).toBe(true);
    expect(fs.existsSync(malformed)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it('parses Linux start ticks after a stat comm containing spaces and parentheses', () => {
    const realRead = fs.readFileSync.bind(fs);
    const suffix = Array.from({ length: 20 }, (_, index) => (index === 19 ? '4242' : index === 0 ? 'R' : '0'));
    const read = jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file) === '/proc/42/stat') return `42 (worker ) with spaces) ${suffix.join(' ')}`;
      if (String(file) === '/proc/sys/kernel/random/boot_id') return 'boot-a\n';
      return realRead(file, ...(args as []));
    }) as typeof fs.readFileSync);
    try {
      expect(linuxProcessState(42, 'linux')).toEqual({ state: 'alive', bootId: 'boot-a', startTicks: '4242' });
    } finally {
      read.mockRestore();
    }
  });

  it('preserves identity when Linux proc identity is unavailable on another platform', () => {
    expect(linuxProcessState(42, 'darwin')).toEqual({ state: 'unknown' });
  });

  it('treats a missing Linux boot identity as unavailable rather than a dead PID', () => {
    const realRead = fs.readFileSync.bind(fs);
    const read = jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file) === '/proc/sys/kernel/random/boot_id') {
        const error = new Error('procfs unavailable') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return realRead(file, ...(args as []));
    }) as typeof fs.readFileSync);
    try {
      expect(linuxProcessState(42, 'linux')).toEqual({ state: 'unknown' });
    } finally {
      read.mockRestore();
    }
  });

  it('does not touch unsafe or unowned temp entries', () => {
    const target = path.join(tmpDir, 'do-not-delete');
    fs.mkdirSync(target);
    const symlink = path.join(tmpDir, `${BACKUP_UPLOAD_STAGE_PREFIX}symlink`);
    fs.symlinkSync(target, symlink);
    const unrelated = path.join(tmpDir, 'unrelated-dir');
    fs.mkdirSync(unrelated);

    reclaimStaleUploadStageRoots(tmpDir);

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.lstatSync(symlink).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('makes stale-root cleanup failure best-effort', () => {
    const stale = createPrivateUploadStageRoot(tmpDir);
    owner(stale, { version: 1, pid: 999_999_999 });
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('permission denied'); });
    try {
      expect(() => reclaimStaleUploadStageRoots(tmpDir, undefined, () => ({ state: 'dead' }))).not.toThrow();
      expect(fs.existsSync(stale)).toBe(true);
    } finally {
      rename.mockRestore();
    }
  });

  it('removes the exact new root when writing its owner marker fails', () => {
    const error = new Error('marker write failed');
    const realWriteFileSync = fs.writeFileSync.bind(fs);
    const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
      if (String(file).endsWith(BACKUP_UPLOAD_STAGE_OWNER_FILE)) throw error;
      return realWriteFileSync(file, data, ...(args as []));
    }) as typeof fs.writeFileSync);
    try {
      expect(() => createPrivateUploadStageRoot(tmpDir)).toThrow(error);
      expect(fs.readdirSync(tmpDir).filter((name) => name.startsWith(BACKUP_UPLOAD_STAGE_PREFIX))).toEqual([]);
    } finally {
      write.mockRestore();
    }
  });
});
