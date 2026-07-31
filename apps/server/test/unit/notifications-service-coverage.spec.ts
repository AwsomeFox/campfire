import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('NotificationsService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let notificationsService: NotificationsService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  const userActor: RequestUser = {
    id: '2',
    name: 'User 2',
    serverRole: 'user',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-notif-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;

    notificationsService = new NotificationsService(db);

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

  it('manages notifications, user listing, and preferences', async () => {
    notificationsService.onApplicationBootstrap();

    await notificationsService.notifyUser(
      2,
      campaignId,
      adminActor,
      {
        type: 'added_to_campaign',
        title: 'Invited to Campaign',
        body: 'You have been invited.',
      },
    );

    const page = await notificationsService.listForUser(userActor, {});
    expect(page.items.length).toBeGreaterThan(0);

    const unread = await notificationsService.unreadCount(userActor);
    expect(unread).toBeGreaterThan(0);

    await notificationsService.markAllRead(userActor);

    const prefs = await notificationsService.getPreferences(userActor);
    expect(prefs).toBeDefined();
  });
});
