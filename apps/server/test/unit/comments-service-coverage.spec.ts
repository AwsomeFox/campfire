import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { CommentsService } from '../../src/modules/comments/comments.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns, quests } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('CommentsService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let commentsService: CommentsService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;
  let questId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-comments-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const notifications = { queueMentionNotifications: jest.fn() } as unknown as NotificationsService;
    const moderation = new ModerationService(db, audit);
    const revisions = new RevisionsService(db, moderation);

    commentsService = new CommentsService(db, audit, notifications, revisions, moderation);

    const [camp] = await db
      .insert(campaigns)
      .values({
        name: 'Test Campaign',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();
    campaignId = camp.id;

    const [q] = await db
      .insert(quests)
      .values({
        campaignId,
        title: 'Main Quest',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();
    questId = q.id;
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates comments and lists threads', async () => {
    const comment = await commentsService.create(
      campaignId,
      {
        entityType: 'quest',
        entityId: questId,
        body: 'Great quest idea!',
      },
      adminActor,
      'dm',
    );
    expect(comment.id).toBeDefined();

    const threads = await commentsService.listThreadsForEntity(
      campaignId,
      'quest',
      questId,
      'dm',
      {},
    );
    expect(threads.items.length).toBeGreaterThan(0);
  });
});
