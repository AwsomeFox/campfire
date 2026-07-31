import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';

describe('AuditService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let auditService: AuditService;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-audit-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;

    auditService = new AuditService(db);
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('logs events, queries audit logs, and manages retention and legal hold', async () => {
    await auditService.onApplicationBootstrap();

    await auditService.log({
      actor: 'user:1',
      actorRole: 'dm',
      action: 'campaign.create',
      entityType: 'campaign',
      entityId: 1,
      campaignId: 1,
      detail: 'Created campaign',
    });

    await auditService.log({
      actor: 'admin:1',
      actorRole: 'admin',
      action: 'system.update',
      entityType: 'system',
      detail: 'Server update',
    });

    const page = await auditService.listServerAdmin();
    expect(page.length).toBeGreaterThan(0);

    const campaignPage = await auditService.listForCampaignPage(1, {});
    expect(campaignPage.items.length).toBeGreaterThan(0);

    const policy = await auditService.getRetentionPolicy();
    expect(policy.days).toBeGreaterThan(0);

    const updatedPolicy = await auditService.updateRetentionPolicy(
      { days: 180 },
      { actor: 'admin:1', actorRole: 'admin' },
    );
    expect(updatedPolicy.days).toBe(180);

    const legalHold = await auditService.getLegalHold();
    expect(legalHold.global).toBe(false);

    const updatedLegalHold = await auditService.updateLegalHold(
      { global: true, campaignIds: [] },
      { actor: 'admin:1', actorRole: 'admin' },
    );
    expect(updatedLegalHold.global).toBe(true);
  });
});
