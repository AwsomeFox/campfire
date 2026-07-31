import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { QuestsService } from '../../src/modules/quests/quests.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('QuestsService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let questsService: QuestsService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-quests-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const notifications = {
      queueMentionNotifications: jest.fn(),
      notifyCampaign: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationsService;
    const moderation = new ModerationService(db, audit);
    const revisions = new RevisionsService(db, moderation);

    questsService = new QuestsService(db, audit, notifications, revisions);

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

  it('manages quests and objectives CRUD', async () => {
    const quest = await questsService.create(
      campaignId,
      {
        title: 'Slay the Dragon',
        status: 'active',
      },
      adminActor,
      'dm',
    );
    expect(quest.title).toBe('Slay the Dragon');

    const list = await questsService.listForCampaign(campaignId, 'dm');
    expect(list.length).toBe(1);

    const listWithObjs = await questsService.listForCampaignWithObjectives(campaignId, 'dm');
    expect(listWithObjs.length).toBe(1);

    const fetched = await questsService.getOrThrow(quest.id, 'dm');
    expect(fetched.id).toBe(quest.id);

    const updated = await questsService.update(
      quest.id,
      { title: 'Slay the Red Dragon' },
      adminActor,
      'dm',
    );
    expect(updated.title).toBe('Slay the Red Dragon');

    const obj = await questsService.addObjective(
      quest.id,
      { text: 'Find dragon lair' },
      adminActor,
      'dm',
    );
    expect(obj.text).toBe('Find dragon lair');

    const updatedObj = await questsService.patchObjective(
      quest.id,
      obj.id,
      { done: true },
      adminActor,
      'dm',
    );
    expect(updatedObj.done).toBe(true);

    await questsService.removeObjective(quest.id, obj.id, adminActor, 'dm');

    await questsService.remove(quest.id, adminActor, 'dm');
    await questsService.restore(quest.id, adminActor, 'dm');
  });
});
