import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import {
  ArchiveOperationBusyError,
  AttachmentCaptureChangedError,
  BackupService,
  captureFileBytesOrNullIfMissing,
  MAX_ATTACHMENT_RETRIES,
  stageAndHashFileWithRetry,
} from '../../src/modules/backup/backup.service';
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

  it('retries a transient attachment rewrite and keeps only the stable staged copy', async () => {
    const source = path.join(dataDir, 'source.bin');
    const staged = path.join(dataDir, 'stage', 'source.bin');
    fs.writeFileSync(source, Buffer.alloc(10, 1));
    const actualStat = fs.statSync.bind(fs);
    let reads = 0;
    const stat = jest.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
      const result = actualStat(target, ...(args as []));
      if (String(target) !== source) return result;
      reads += 1;
      // First attempt changes between before/after; second is stable.
      const size = reads === 2 ? 11 : 10;
      return Object.assign(Object.create(Object.getPrototypeOf(result)), result, { size });
    }) as typeof fs.statSync);
    try {
      const captured = await stageAndHashFileWithRetry(source, staged);
      expect(captured.bytes).toBe(10);
      expect(reads).toBe(4);
      expect(fs.readFileSync(staged)).toEqual(Buffer.alloc(10, 1));
    } finally {
      stat.mockRestore();
    }
  });

  it('fails after bounded unstable attempts and removes every staged copy', async () => {
    const source = path.join(dataDir, 'moving.bin');
    const staged = path.join(dataDir, 'stage', 'moving.bin');
    fs.writeFileSync(source, Buffer.alloc(10, 2));
    const actualStat = fs.statSync.bind(fs);
    let reads = 0;
    const stat = jest.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
      const result = actualStat(target, ...(args as []));
      if (String(target) !== source) return result;
      reads += 1;
      return Object.assign(Object.create(Object.getPrototypeOf(result)), result, { size: reads % 2 === 0 ? 11 : 10 });
    }) as typeof fs.statSync);
    try {
      await expect(stageAndHashFileWithRetry(source, staged)).rejects.toBeInstanceOf(AttachmentCaptureChangedError);
      expect(reads).toBe(MAX_ATTACHMENT_RETRIES * 2);
      expect(fs.existsSync(staged)).toBe(false);
    } finally {
      stat.mockRestore();
    }
  });

  it('stops retry capture immediately when cancelled', async () => {
    const source = path.join(dataDir, 'cancelled.bin');
    const staged = path.join(dataDir, 'stage', 'cancelled.bin');
    fs.writeFileSync(source, Buffer.alloc(10));
    const controller = new AbortController();
    controller.abort();
    await expect(stageAndHashFileWithRetry(source, staged, controller.signal)).rejects.toThrow('cancelled');
    expect(fs.existsSync(staged)).toBe(false);
  });

  it('reports the size of a present attachment, including an empty file', () => {
    const source = path.join(dataDir, 'empty.bin');
    fs.writeFileSync(source, '');
    expect(captureFileBytesOrNullIfMissing(source)).toBe(0);
  });

  it('maps only ENOENT to a missing attachment', () => {
    const source = path.join(dataDir, 'missing.bin');
    expect(captureFileBytesOrNullIfMissing(source)).toBeNull();
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('preserves %s while statting an attachment', (code) => {
    const source = path.join(dataDir, 'protected.bin');
    const error = Object.assign(new Error(`stat failed: ${code}`), { code });
    const actualStat = fs.statSync.bind(fs);
    const stat = jest.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
      if (String(target) === source) throw error;
      return actualStat(target, ...(args as []));
    }) as typeof fs.statSync);
    try {
      expect(() => captureFileBytesOrNullIfMissing(source)).toThrow(error);
    } finally {
      stat.mockRestore();
    }
  });

  it('writes a valid archive to a Writable without producing a response buffer', async () => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    await service().buildBackup(undefined, output);
    expect(Buffer.concat(chunks).subarray(0, 4).toString()).toBe('PK\u0003\u0004');
  });

  it('allows interactive staging when free space exactly matches the estimate despite the scheduled reserve', async () => {
    const previousMinFree = process.env.BACKUP_MIN_FREE_BYTES;
    process.env.BACKUP_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
    const estimatedBytes = 1024;
    const svc = service();
    const estimate = jest.spyOn(svc as any, 'estimateFallbackBackupBytes').mockReturnValue(estimatedBytes);
    const probeDisk = jest.spyOn(svc as any, 'probeDisk');
    const statfs = jest.spyOn(fs, 'statfsSync').mockReturnValue({
      type: 0,
      bsize: 1,
      blocks: estimatedBytes * 2,
      bfree: estimatedBytes,
      bavail: estimatedBytes,
      files: 0,
      ffree: 0,
    });
    const output = new PassThrough();
    output.resume();
    try {
      await expect(svc.buildBackup(undefined, output)).resolves.toBeUndefined();
      expect(probeDisk).toHaveBeenCalledWith(os.tmpdir(), 0, estimatedBytes);
    } finally {
      statfs.mockRestore();
      probeDisk.mockRestore();
      estimate.mockRestore();
      if (previousMinFree === undefined) delete process.env.BACKUP_MIN_FREE_BYTES;
      else process.env.BACKUP_MIN_FREE_BYTES = previousMinFree;
    }
  });

  it('rejects interactive staging when free space is below the estimate', async () => {
    const previousMinFree = process.env.BACKUP_MIN_FREE_BYTES;
    process.env.BACKUP_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
    const estimatedBytes = 1024;
    const freeBytes = estimatedBytes - 1;
    const svc = service();
    const estimate = jest.spyOn(svc as any, 'estimateFallbackBackupBytes').mockReturnValue(estimatedBytes);
    const probeDisk = jest.spyOn(svc as any, 'probeDisk');
    const statfs = jest.spyOn(fs, 'statfsSync').mockReturnValue({
      type: 0,
      bsize: 1,
      blocks: estimatedBytes * 2,
      bfree: freeBytes,
      bavail: freeBytes,
      files: 0,
      ffree: 0,
    });
    const output = new PassThrough();
    output.resume();
    try {
      await expect(svc.buildBackup(undefined, output)).rejects.toThrow('low temporary disk space');
      expect(probeDisk).toHaveBeenCalledWith(os.tmpdir(), 0, estimatedBytes);
    } finally {
      statfs.mockRestore();
      probeDisk.mockRestore();
      estimate.mockRestore();
      if (previousMinFree === undefined) delete process.env.BACKUP_MIN_FREE_BYTES;
      else process.env.BACKUP_MIN_FREE_BYTES = previousMinFree;
    }
  });

  it('preserves archive-reader failures while loading the manifest', async () => {
    const readError = new Error('manifest entry exceeds configured limit');
    const zip = {
      get: jest.fn(() => ({ fileName: 'manifest.json' })),
      readBuffer: jest.fn().mockRejectedValue(readError),
    };

    await expect((service() as any).readManifestFromArchive(zip)).rejects.toBe(readError);
  });

  it('maps only manifest JSON parsing failures to the JSON validation error', async () => {
    const zip = {
      get: jest.fn(() => ({ fileName: 'manifest.json' })),
      readBuffer: jest.fn().mockResolvedValue(Buffer.from('{not-json')),
    };

    await expect((service() as any).readManifestFromArchive(zip)).rejects.toThrow(
      'manifest.json is not valid JSON',
    );
  });

  it('reuses buffered compatibility chunks without copying Buffers', async () => {
    const from = jest.spyOn(Buffer, 'from');
    try {
      const archive = await service().buildBackup();
      expect(archive.subarray(0, 4).toString()).toBe('PK\u0003\u0004');
      expect(from.mock.calls.filter(([value]) => Buffer.isBuffer(value))).toHaveLength(0);
    } finally {
      from.mockRestore();
    }
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
    const probeDisk = jest.spyOn(svc as any, 'probeDisk');
    try {
      await expect((svc as any).runScheduledBackup(60 * 60 * 1000)).resolves.toBeUndefined();
      expect(createStream).not.toHaveBeenCalled();
      expect(writeFailure).not.toHaveBeenCalled();
      expect(probeDisk).not.toHaveBeenCalled();
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
      probeDisk.mockRestore();
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

  it('awaits a pending scheduled output open before deleting its partial', async () => {
    const backupDir = path.join(dataDir, 'backups');
    const previous = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = backupDir;
    const svc = service();
    class DelayedOpenOutput extends PassThrough {
      constructor(private readonly target: string) {
        super();
      }

      override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        setImmediate(() => {
          fs.writeFileSync(this.target, '');
          callback(error);
        });
      }
    }
    jest.spyOn(fs, 'createWriteStream').mockImplementation(
      ((target: fs.PathLike) => new DelayedOpenOutput(String(target)) as unknown as fs.WriteStream) as typeof fs.createWriteStream,
    );
    jest
      .spyOn(svc, 'buildBackup')
      .mockRejectedValue(new ArchiveOperationBusyError('A whole-server backup operation is already in progress') as never);
    try {
      await expect((svc as any).runScheduledBackup(60 * 60 * 1000)).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fs.readdirSync(backupDir).filter((name) => name.endsWith('.partial'))).toEqual([]);
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
      estimate.mockRestore();
    };
    return { svc, backupDir, stagingBytes, archiveBytes, estimateFallback: estimate, probeDisk, createStream, restore };
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

  it('reports the combined staging and archive estimate when status shares the filesystem', async () => {
    await withScheduledEnv(async () => {
      const t = runScheduledWithDisk(true);
      try {
        const status = await t.svc.getStatus();
        expect(status.disk).toMatchObject({
          estimatedNextBytes: t.archiveBytes + t.stagingBytes,
          lowSpace: true,
        });
        expect(t.probeDisk).toHaveBeenCalledWith(t.backupDir, 1024, t.archiveBytes + t.stagingBytes);
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

  it('reports only the archive estimate when status uses a different filesystem for staging', async () => {
    await withScheduledEnv(async () => {
      const t = runScheduledWithDisk(false);
      try {
        const status = await t.svc.getStatus();
        expect(status.disk).toMatchObject({
          estimatedNextBytes: t.archiveBytes,
          lowSpace: false,
        });
        expect(t.probeDisk).toHaveBeenCalledWith(t.backupDir, 1024, t.archiveBytes);
      } finally {
        t.restore();
      }
    });
  });

  it('does not walk uploads when a known archive is staged on a separate filesystem', () => {
    const t = runScheduledWithDisk(false);
    const previousArchiveBytes = 20 * 1024 * 1024;
    try {
      const estimate = (t.svc as any).scheduledBackupDiskEstimate(t.backupDir, previousArchiveBytes);
      expect(t.estimateFallback).not.toHaveBeenCalled();
      expect(estimate).toEqual({
        archiveBytes: Math.ceil(previousArchiveBytes * 1.15),
        requiredBytes: Math.ceil(previousArchiveBytes * 1.15),
      });
    } finally {
      t.restore();
    }
  });

  it('still walks uploads for a known archive when staging shares its filesystem', () => {
    const t = runScheduledWithDisk(true);
    const previousArchiveBytes = 20 * 1024 * 1024;
    try {
      const estimate = (t.svc as any).scheduledBackupDiskEstimate(t.backupDir, previousArchiveBytes);
      expect(t.estimateFallback).toHaveBeenCalledTimes(1);
      expect(estimate.requiredBytes).toBe(Math.ceil(previousArchiveBytes * 1.15) + t.stagingBytes);
    } finally {
      t.restore();
    }
  });

  it('walks uploads when the archive size is unknown, even on a separate filesystem', () => {
    const t = runScheduledWithDisk(false);
    try {
      const estimate = (t.svc as any).scheduledBackupDiskEstimate(t.backupDir, null);
      expect(t.estimateFallback).toHaveBeenCalledTimes(1);
      expect(estimate).toEqual({ archiveBytes: t.archiveBytes, requiredBytes: t.archiveBytes });
    } finally {
      t.restore();
    }
  });

  it('uses the same disk-requirement calculation for status and scheduled execution', async () => {
    await withScheduledEnv(async () => {
      const t = runScheduledWithDisk(true);
      const estimate = jest.spyOn(t.svc as any, 'scheduledBackupDiskEstimate');
      try {
        await t.svc.getStatus();
        await (t.svc as any).runScheduledBackup(60 * 60 * 1000);
        expect(estimate).toHaveBeenCalledTimes(2);
        expect(estimate).toHaveBeenNthCalledWith(1, t.backupDir, null);
        expect(estimate).toHaveBeenNthCalledWith(2, t.backupDir, null);
        expect(t.probeDisk).toHaveBeenCalledWith(t.backupDir, 1024, t.archiveBytes + t.stagingBytes);
      } finally {
        estimate.mockRestore();
        t.restore();
      }
    });
  });

  it('publishes scheduled archives atomically and leaves no partial file', async () => {
    const backupDir = path.join(dataDir, 'backups');
    const previous = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = backupDir;
    try {
      const svc = service();
      const reads = jest.spyOn(fs, 'createReadStream');
      const open = jest.spyOn(fs, 'openSync');
      await (svc as any).runScheduledBackup(60 * 60 * 1000);
      const names = fs.readdirSync(backupDir);
      const archiveName = names.find((name) => name.endsWith('.zip'));
      expect(archiveName).toBeDefined();
      expect(names.some((name) => name.endsWith('.partial'))).toBe(false);
      // Verification performs the one required checksum pass. Cadence size is
      // obtained from the fsynced descriptor, not by hashing the partial again.
      expect(reads.mock.calls.filter(([filePath]) => String(filePath).endsWith('.partial'))).toHaveLength(1);
      reads.mockRestore();
      expect(open.mock.calls.some(([filePath, flags]) => String(filePath).endsWith('.partial') && flags === 'r+')).toBe(true);
      open.mockRestore();

      const archivePath = path.join(backupDir, archiveName!);
      const cadence = await (svc as any).readCadence();
      expect(cadence.lastSize).toBe(fs.statSync(archivePath).size);
      expect(cadence.lastChecksum).toBe(
        createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex'),
      );
    } finally {
      if (previous === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = previous;
    }
  });

  it('does not re-verify the just-published archive while retaining verification of older candidates', async () => {
    const backupDir = path.join(dataDir, 'backups');
    const previous = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = backupDir;
    const svc = service();
    try {
      // Create an older, known-good retention candidate before observing calls.
      await (svc as any).runScheduledBackup(60 * 60 * 1000);
      const verify = jest.spyOn(svc as any, 'verifyScheduledArchive');

      await (svc as any).runScheduledBackup(60 * 60 * 1000);

      // One call verifies the new archive under its partial name; one verifies
      // the older candidate during retention. The renamed new path is trusted
      // only through the explicit handoff, never re-read by prune.
      expect(verify).toHaveBeenCalledTimes(2);
      expect(verify.mock.calls.filter(([filePath]) => String(filePath).endsWith('.partial'))).toHaveLength(1);
      expect(verify.mock.calls.filter(([filePath]) => String(filePath).endsWith('.zip'))).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = previous;
    }
  });

  it('does not hand an initially unverified archive to retention', async () => {
    const backupDir = path.join(dataDir, 'backups');
    const previous = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = backupDir;
    const svc = service();
    const verify = jest.spyOn(svc as any, 'verifyScheduledArchive').mockResolvedValue({
      verified: false,
      checksum: null,
      error: 'invalid archive',
    });
    try {
      await expect((svc as any).runScheduledBackup(60 * 60 * 1000)).rejects.toThrow('failed verification');
      expect(verify).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((name) => name.endsWith('.zip')) : []).toEqual([]);
      expect(fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((name) => name.endsWith('.partial')) : []).toEqual([]);
    } finally {
      verify.mockRestore();
      if (previous === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = previous;
    }
  });

  it('does not promote an incomplete scheduled archive over the last known good backup', async () => {
    const backupDir = path.join(dataDir, 'backups');
    const previous = process.env.BACKUP_DIR;
    const previousKeepCount = process.env.BACKUP_KEEP_COUNT;
    process.env.BACKUP_DIR = backupDir;
    process.env.BACKUP_KEEP_COUNT = '1';
    const svc = service();
    await (svc as any).runScheduledBackup(60 * 60 * 1000);
    const before = await (svc as any).readCadence();
    const verify = jest.spyOn(svc as any, 'verifyScheduledArchive').mockResolvedValue({
      verified: true,
      checksum: 'a'.repeat(64),
      clean: false,
      error: '',
    });
    try {
      await (svc as any).runScheduledBackup(60 * 60 * 1000);
      await (svc as any).runScheduledBackup(60 * 60 * 1000);
      const cadence = await (svc as any).readCadence();
      expect(fs.readdirSync(backupDir).filter((name) => name.endsWith('.zip'))).toHaveLength(2);
      expect(cadence.lastSuccessAt).toBe(before.lastSuccessAt);
      expect(cadence.lastArchiveName).toBe(before.lastArchiveName);
      expect(cadence.lastError).toMatch(/incomplete/i);
    } finally {
      verify.mockRestore();
      if (previous === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = previous;
      if (previousKeepCount === undefined) delete process.env.BACKUP_KEEP_COUNT;
      else process.env.BACKUP_KEEP_COUNT = previousKeepCount;
    }
  });
});
