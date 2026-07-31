import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { TimelineService } from '../../src/modules/timeline/timeline.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('TimelineService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let timelineService: TimelineService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-time-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const moderation = new ModerationService(db, audit);
    const revisions = new RevisionsService(db, moderation);

    timelineService = new TimelineService(db, audit, revisions);

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

  it('manages timeline events and calendars CRUD', async () => {
    const event = await timelineService.createEvent(
      campaignId,
      {
        title: 'Battle of Red Mountain',
        inWorldDate: 'Year 1420',
      },
      adminActor,
      'dm',
    );
    expect(event.title).toBe('Battle of Red Mountain');

    const page = await timelineService.listEventsPage(campaignId, 'dm', {});
    expect(page.items.length).toBe(1);

    const list = await timelineService.listEvents(campaignId, 'dm');
    expect(list.length).toBe(1);

    const fetched = await timelineService.getEventOrThrow(event.id, 'dm');
    expect(fetched.id).toBe(event.id);

    const updated = await timelineService.updateEvent(
      event.id,
      { title: 'Great Battle of Red Mountain' },
      adminActor,
      'dm',
    );
    expect(updated.title).toBe('Great Battle of Red Mountain');

    await timelineService.removeEvent(event.id, adminActor, 'dm');
    await timelineService.restoreEvent(event.id, adminActor, 'dm');

    const cal = await timelineService.getCalendar(campaignId);
    expect(cal).toBeDefined();

    const updatedCal = await timelineService.setCalendar(
      campaignId,
      { currentDate: '1420-05-12' },
      adminActor,
      'dm',
    );
    expect(updatedCal.currentDate).toBe('1420-05-12');
  });
});
