import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { ArchiveOperationBusyError, BackupService } from '../../src/modules/backup/backup.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { AiProviderConfigService } from '../../src/modules/ai-provider-config/ai-provider-config.service';

describe('backup streaming writer (#603)', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-backup-stream-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function service(): BackupService {
    const db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    return new BackupService(
      holder, audit, new SettingsService(db),
      new AttachmentsService(db, audit, new FsDeletionService(db, audit), new AttachmentDerivativesService(db)),
      { invalidateCachedKey: jest.fn() } as unknown as AiProviderConfigService,
    );
  }

  it('writes a valid archive to a Writable without producing a response buffer', async () => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    await service().buildBackup(undefined, output);
    expect(Buffer.concat(chunks).subarray(0, 4).toString()).toBe('PK\u0003\u0004');
  });

  it('rejects an overlapping whole-server backup', async () => {
    const svc = service();
    const output = new PassThrough();
    output.resume();
    const first = svc.buildBackup(undefined, output);
    await expect(svc.buildBackup()).rejects.toThrow('already in progress');
    await first;
  });

  it('aborts a streaming archive when its signal is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(service().buildBackup({ signal: controller.signal }, new PassThrough())).rejects.toThrow('cancelled');
  });

  it('refuses to publish a database entry larger than restore accepts', async () => {
    const realStatSync = fs.statSync.bind(fs);
    const stat = jest.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
      const actual = realStatSync(target, ...(args as []));
      return String(target).endsWith(`${path.sep}campfire.db`)
        ? Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, { size: 512 * 1024 * 1024 + 1 })
        : actual;
    }) as typeof fs.statSync);
    try {
      await expect(service().buildBackup(undefined, new PassThrough())).rejects.toThrow('restore entry limit');
    } finally {
      stat.mockRestore();
    }
  });

  it('releases the archive operation lane after a pre-pipeline failure', async () => {
    const svc = service();
    const realStatSync = fs.statSync.bind(fs);
    const stat = jest.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
      const actual = realStatSync(target, ...(args as []));
      return String(target).endsWith(`${path.sep}campfire.db`)
        ? Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, { size: 512 * 1024 * 1024 + 1 })
        : actual;
    }) as typeof fs.statSync);
    try {
      await expect(svc.buildBackup(undefined, new PassThrough())).rejects.toThrow('restore entry limit');
    } finally {
      stat.mockRestore();
    }
    const output = new PassThrough();
    output.resume();
    await expect(svc.buildBackup(undefined, output)).resolves.toBeUndefined();
  });

  it('defers a scheduled backup without creating output when the archive lane is occupied', async () => {
    const backupDir = path.join(dataDir, 'backups');
    const previous = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = backupDir;
    const svc = service();
    const seeded = {
      lastAttemptAt: '2026-07-01T00:00:00.000Z',
      lastSuccessAt: '2026-07-01T00:00:00.000Z',
      nextRunAt: '2026-07-02T00:00:00.000Z',
      lastSize: 1024,
      lastChecksum: 'a'.repeat(64),
      lastError: '',
      consecutiveFailures: 0,
    };
    await (svc as any).writeCadence(seeded);
    // Stand in for an admin download streaming while the scheduler fires.
    (svc as any).archiveOperation = 'backup';
    const createStream = jest.spyOn(fs, 'createWriteStream');
    const writeFailure = jest.spyOn(svc as any, 'writeFailureCadence');
    try {
      await expect((svc as any).runScheduledBackup(60 * 60 * 1000)).resolves.toBeUndefined();
      expect(createStream).not.toHaveBeenCalled();
      expect(writeFailure).not.toHaveBeenCalled();
      // Contention is a deferral. Recording it as a failure would raise a backup alert
      // out of a routine admin download and push the real run out by the failure
      // backoff — corrupting the one signal an operator must be able to trust.
      const after = await (svc as any).readCadence();
      expect(after.consecutiveFailures ?? 0).toBe(0);
      expect(after.lastError).toBe('');
      expect(after.nextRunAt).toBe(seeded.nextRunAt);
      expect(after.lastSuccessAt).toBe(seeded.lastSuccessAt);
    } finally {
      writeFailure.mockRestore();
      createStream.mockRestore();
      (svc as any).archiveOperation = null;
      if (previous === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = previous;
    }
  });

  it('defers when the lane is taken after the pre-check, not just before it', async () => {
    const backupDir = path.join(dataDir, 'backups');
    const previous = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = backupDir;
    const svc = service();
    // The pre-check above cannot close the window between its own read and
    // beginArchiveOperation(); a download starting inside it must still defer rather
    // than be stamped as a failed backup.
    jest
      .spyOn(svc, 'buildBackup')
      .mockRejectedValue(new ArchiveOperationBusyError('A whole-server backup operation is already in progress') as never);
    const writeFailure = jest.spyOn(svc as any, 'writeFailureCadence');
    try {
      await expect((svc as any).runScheduledBackup(60 * 60 * 1000)).resolves.toBeUndefined();
      expect(writeFailure).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      if (previous === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = previous;
    }
  });

  it('still records a genuine scheduled failure as a failure', async () => {
    const backupDir = path.join(dataDir, 'backups');
    const previous = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = backupDir;
    const svc = service();
    // Guards the deferral branch above: only lane contention is exempt, so a real
    // fault must still stamp lastError and advance consecutiveFailures.
    jest.spyOn(svc, 'buildBackup').mockRejectedValue(new Error('vacuum exploded') as never);
    try {
      await expect((svc as any).runScheduledBackup(60 * 60 * 1000)).rejects.toThrow('vacuum exploded');
      const after = await (svc as any).readCadence();
      expect(after.consecutiveFailures).toBe(1);
      expect(after.lastError).toContain('vacuum exploded');
    } finally {
      jest.restoreAllMocks();
      if (previous === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = previous;
    }
  });

  // Whether staging and archive share a budget is stubbed rather than inherited: both
  // BACKUP_DIR and os.tmpdir() resolve under /tmp here, and on a runner that mounts /tmp
  // separately the branch taken would come from the box's layout instead of the test.
  // Both branches are therefore driven explicitly.
  function runScheduledWithDisk(sameDevice: boolean) {
    const backupDir = path.join(dataDir, 'backups');
    const stagingBytes = 10 * 1024 * 1024;
    const archiveBytes = Math.ceil(stagingBytes * 1.15);
    const freeBytes = archiveBytes + 1024 + 1;
    const svc = service();
    const estimate = jest
      .spyOn(svc as any, 'estimateFallbackBackupBytes')
      .mockReturnValue(stagingBytes);
    const sameFilesystem = jest
      .spyOn(svc as any, 'pathsShareFilesystem')
      .mockReturnValue(true);
    const probeDisk = jest.spyOn(svc as any, 'probeDisk');
    const shareFs = jest.spyOn(svc as any, 'pathsShareFilesystem').mockReturnValue(sameDevice);
    const statfs = jest.spyOn(fs, 'statfsSync').mockReturnValue({
      type: 0,
      bsize: 1,
      blocks: freeBytes * 2,
      bfree: freeBytes,
      bavail: freeBytes,
      files: 0,
      ffree: 0,
    });
    const createStream = jest.spyOn(fs, 'createWriteStream');
    const restore = () => {
      createStream.mockRestore();
      statfs.mockRestore();
      shareFs.mockRestore();
      probeDisk.mockRestore();
      sameFilesystem.mockRestore();
      estimate.mockRestore();
    };
    return { svc, backupDir, stagingBytes, archiveBytes, probeDisk, createStream, restore };
  }

  async function withScheduledEnv(run: () => Promise<void>): Promise<void> {
    const previousBackupDir = process.env.BACKUP_DIR;
    const previousMinFree = process.env.BACKUP_MIN_FREE_BYTES;
    process.env.BACKUP_DIR = path.join(dataDir, 'backups');
    process.env.BACKUP_MIN_FREE_BYTES = '1024';
    try {
      await run();
    } finally {
      if (previousBackupDir === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = previousBackupDir;
      if (previousMinFree === undefined) delete process.env.BACKUP_MIN_FREE_BYTES;
      else process.env.BACKUP_MIN_FREE_BYTES = previousMinFree;
    }
  }

  it('reserves staging plus archive space when scheduled output shares its filesystem', async () => {
    await withScheduledEnv(async () => {
      const t = runScheduledWithDisk(true);
      try {
        await expect((t.svc as any).runScheduledBackup(60 * 60 * 1000)).resolves.toBeUndefined();
        expect(t.createStream).not.toHaveBeenCalled();
        expect(t.probeDisk).toHaveBeenCalledWith(t.backupDir, 1024, t.archiveBytes + t.stagingBytes);
        expect((await t.svc.getStatus()).cadence?.lastError).toMatch(/low disk space/i);
      } finally {
        t.restore();
      }
    });
  });

  it('reserves only the archive estimate when staging is on a different filesystem', async () => {
    await withScheduledEnv(async () => {
      const t = runScheduledWithDisk(false);
      try {
        // Independent budgets: doubling here would refuse backups a host can actually take.
        await expect((t.svc as any).runScheduledBackup(60 * 60 * 1000)).resolves.toBeUndefined();
        expect(t.probeDisk).toHaveBeenCalledWith(t.backupDir, 1024, t.archiveBytes);
        expect(t.probeDisk).not.toHaveBeenCalledWith(t.backupDir, 1024, t.archiveBytes + t.stagingBytes);
      } finally {
        t.restore();
      }
    });
  });

  it('publishes scheduled archives atomically and leaves no partial file', async () => {
    const backupDir = path.join(dataDir, 'backups');
    const previous = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = backupDir;
    try {
      await (service() as any).runScheduledBackup(60 * 60 * 1000);
      const names = fs.readdirSync(backupDir);
      expect(names.some((name) => name.endsWith('.zip'))).toBe(true);
      expect(names.some((name) => name.endsWith('.partial'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = previous;
    }
  });
});
