import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { BackupService } from '../../src/modules/backup/backup.service';
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
    (svc as any).archiveOperation = 'backup';
    const createStream = jest.spyOn(fs, 'createWriteStream');
    const writeFailure = jest.spyOn(svc as any, 'writeFailureCadence');
    try {
      await expect((svc as any).runScheduledBackup(60 * 60 * 1000)).resolves.toBeUndefined();
      expect(createStream).not.toHaveBeenCalled();
      expect(writeFailure).not.toHaveBeenCalled();
    } finally {
      writeFailure.mockRestore();
      createStream.mockRestore();
      (svc as any).archiveOperation = null;
      if (previous === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = previous;
    }
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
