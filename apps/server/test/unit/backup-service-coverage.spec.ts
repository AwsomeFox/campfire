import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { AiProviderConfigService } from '../../src/modules/ai-provider-config/ai-provider-config.service';
import { BackupService } from '../../src/modules/backup/backup.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';

describe('BackupService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let backupService: BackupService;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-backup-unit-'));
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

    holder = new DbHolder();
    const db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const settings = new SettingsService(db);
    const fsDeletion = new FsDeletionService(db, audit);
    const derivatives = {
      resolveBestDerivative: jest.fn().mockResolvedValue(null),
      manifestForAttachment: jest.fn().mockResolvedValue({ variants: {} }),
      planDerivatives: jest.fn(),
      kickBackgroundGeneration: jest.fn(),
    } as unknown as AttachmentDerivativesService;
    const attachments = new AttachmentsService(db, audit, fsDeletion, derivatives);
    const aiProviderConfig = new AiProviderConfigService(db, audit);

    backupService = new BackupService(holder, audit, settings, attachments, aiProviderConfig);
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('fetches backup status and runs bootstrap checks', async () => {
    await backupService.onApplicationBootstrap();

    const status = await backupService.getStatus();
    expect(status).toBeDefined();
  });
});
