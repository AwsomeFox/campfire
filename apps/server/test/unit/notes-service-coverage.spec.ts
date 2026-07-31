import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { NotesService } from '../../src/modules/notes/notes.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('NotesService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let notesService: NotesService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-notes-unit-'));
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

    notesService = new NotesService(db, audit, notifications, revisions, moderation);

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

  it('manages notes CRUD and listing', async () => {
    const note = await notesService.create(
      campaignId,
      {
        body: 'Secret clue found in the tavern.',
        visibility: 'party_shared',
      },
      adminActor,
      'dm',
    );
    expect(note.body).toBe('Secret clue found in the tavern.');

    const page = await notesService.listForCampaign(campaignId, adminActor, 'dm', {});
    expect(page.items.length).toBeGreaterThan(0);

    const fetched = await notesService.getOrThrow(note.id, adminActor, 'dm');
    expect(fetched.id).toBe(note.id);

    const updated = await notesService.update(
      note.id,
      { body: 'Updated clue text.' },
      adminActor,
      'dm',
    );
    expect(updated.body).toBe('Updated clue text.');

    await notesService.remove(note.id, adminActor, 'dm');
    await notesService.restore(note.id, adminActor, 'dm');
  });
});
