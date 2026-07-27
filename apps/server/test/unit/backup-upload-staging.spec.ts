import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUP_UPLOAD_STAGE_OWNER_FILE,
  BACKUP_UPLOAD_STAGE_PREFIX,
  createPrivateUploadStageRoot,
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
    fs.writeFileSync(
      path.join(stale, BACKUP_UPLOAD_STAGE_OWNER_FILE),
      JSON.stringify({ pid: 999_999_999 }),
    );
    fs.writeFileSync(path.join(live, 'active.zip'), 'live upload');

    reclaimStaleUploadStageRoots(tmpDir, live);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(path.join(live, 'active.zip'), 'utf8')).toBe('live upload');
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
    fs.writeFileSync(
      path.join(stale, BACKUP_UPLOAD_STAGE_OWNER_FILE),
      JSON.stringify({ pid: 999_999_999 }),
    );
    const remove = jest.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
      if (path.resolve(String(target)) === stale) throw new Error('permission denied');
      return fs.rmSync(target, ...(args as []));
    }) as typeof fs.rmSync);
    try {
      expect(() => reclaimStaleUploadStageRoots(tmpDir)).not.toThrow();
      expect(fs.existsSync(stale)).toBe(true);
    } finally {
      remove.mockRestore();
    }
  });
});
