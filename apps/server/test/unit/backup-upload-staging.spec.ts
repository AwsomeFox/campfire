import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrivateUploadStageRoot } from '../../src/modules/backup/backup.controller';

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
});
