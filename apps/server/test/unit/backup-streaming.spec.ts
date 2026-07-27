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
