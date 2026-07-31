import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('AttachmentsService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let attachmentsService: AttachmentsService;


  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-attach-unit-'));
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const fsDeletion = new FsDeletionService(db, audit);
    const derivatives = {
      resolveBestDerivative: jest.fn().mockResolvedValue(null),
      manifestForAttachment: jest.fn().mockResolvedValue({ variants: {} }),
      planDerivatives: jest.fn(),
      kickBackgroundGeneration: jest.fn(),
    } as unknown as AttachmentDerivativesService;

    attachmentsService = new AttachmentsService(db, audit, fsDeletion, derivatives);

    const [camp] = await db
      .insert(campaigns)
      .values({
        name: 'Test Campaign',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();
    campaignId = camp.id;
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('manages attachment storage stats and listing', async () => {
    attachmentsService.onApplicationBootstrap();

    const stats = await attachmentsService.storageStats();
    expect(stats.totalBytes).toBeGreaterThanOrEqual(0);

    const list = await attachmentsService.listForCampaign(campaignId);
    expect(list.length).toBe(0);

    const cleanup = await attachmentsService.cleanupOrphans(true);
    expect(cleanup.dryRun).toBe(true);
  });
});
