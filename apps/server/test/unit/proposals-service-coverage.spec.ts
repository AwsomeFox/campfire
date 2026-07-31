import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { ProposalRecordsService } from '../../src/modules/proposals/proposal-records.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('ProposalRecordsService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let proposalsService: ProposalRecordsService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-props-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const notifications = {
      queueMentionNotifications: jest.fn(),
      notifyCampaign: jest.fn().mockResolvedValue(undefined),
      memberRoles: jest.fn().mockResolvedValue(new Map()),
    } as unknown as NotificationsService;

    proposalsService = new ProposalRecordsService(db, audit, notifications);

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

  it('manages proposals lifecycle', async () => {
    const prop = await proposalsService.create(
      campaignId,
      'quest',
      null,
      'create',
      { title: 'Proposed Quest' },
      adminActor,
      'dm',
    );
    expect(prop.id).toBeDefined();

    const list = await proposalsService.listForCampaign(campaignId, undefined, 'dm');
    expect(list.length).toBe(1);

    const latest = await proposalsService.latestForCampaign(campaignId, 50, 'dm');
    expect(latest.length).toBe(1);

    const fetchedRow = await proposalsService.getRowOrThrow(prop.id);
    expect(fetchedRow.id).toBe(prop.id);

    await proposalsService.markResolved(prop.id, 'rejected', 'Not aligned with campaign', adminActor);
  });
});
