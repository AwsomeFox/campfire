import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns, notes } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('ModerationService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let moderationService: ModerationService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;
  let noteId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-mod-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);

    moderationService = new ModerationService(db, audit);

    const [camp] = await db
      .insert(campaigns)
      .values({
        name: 'Test Campaign',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();
    campaignId = camp.id;

    const [n] = await db
      .insert(notes)
      .values({
        campaignId,
        authorUserId: 'user-2',
        visibility: 'party_shared',
        body: 'Inappropriate content',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();
    noteId = n.id;
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('manages moderation policy, reports, and evidence retention', async () => {
    await moderationService.onApplicationBootstrap();

    const policy = await moderationService.getRetentionPolicy();
    expect(policy.days).toBeGreaterThan(0);

    const updatedPolicy = await moderationService.updateRetentionPolicy(
      { days: 90 },
      { actor: '1', actorRole: 'admin' },
    );
    expect(updatedPolicy.days).toBe(90);

    const report = await moderationService.createReport(
      campaignId,
      {
        targetType: 'note',
        targetId: noteId,
        reason: 'harassment',
        details: 'Inappropriate message',
      },
      adminActor,
      'dm',
    );
    expect(report.id).toBeDefined();

    const fetchedReport = await moderationService.getReport(campaignId, report.id, adminActor, 'dm');
    expect(fetchedReport.id).toBe(report.id);

    const incidentExport = await moderationService.exportIncident(campaignId, report.id, adminActor, 'dm');
    expect(incidentExport.timeline.length).toBeGreaterThan(0);
    expect(incidentExport.timeline[0]).toMatchObject({ payload: null });
    expect(incidentExport.timeline[0]).not.toHaveProperty('payloadJson');

    const reportsPage = await moderationService.listReports(campaignId, adminActor, 'dm');
    expect(reportsPage.items.length).toBeGreaterThan(0);

    const escalated = await moderationService.adminListEscalated(adminActor);
    expect(escalated.items).toBeDefined();
  });
});
