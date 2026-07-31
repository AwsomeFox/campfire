import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { SchedulingService } from '../../src/modules/sessions/scheduling.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { RoleResolver } from '../../src/modules/membership/role-resolver.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('Sessions and Scheduling Service unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let sessionsService: SessionsService;
  let schedulingService: SchedulingService;

  const dmActor: RequestUser = {
    id: '1',
    name: 'DM',
    serverRole: 'user',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-sessions-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const notifications = {
      queueCampaignLifecycleNotification: jest.fn(),
      notifyCampaign: jest.fn().mockResolvedValue(undefined),
      memberRoles: jest.fn().mockResolvedValue(new Map()),
    } as unknown as NotificationsService;
    const moderation = {} as unknown as ModerationService;
    const revisions = new RevisionsService(db, moderation);
    const roles = {
      resolveEffectiveRole: jest.fn().mockResolvedValue('dm'),
      accessibleCampaignIds: jest.fn().mockResolvedValue('all'),
    } as unknown as RoleResolver;
    const events = { emit: jest.fn() } as unknown as CampaignEventsService;

    schedulingService = new SchedulingService(
      db,
      audit,
      notifications,
      roles,
      events,
      revisions,
    );

    sessionsService = new SessionsService(
      db,
      audit,
      notifications,
      revisions,
      schedulingService,
    );

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

  it('manages scheduled sessions and RSVPs', async () => {
    const scheduled = await schedulingService.create(
      campaignId,
      {
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        durationMinutes: 180,
        title: 'Session 1 Planning',
      },
      dmActor,
      'dm',
    );
    expect(scheduled.title).toBe('Session 1 Planning');

    const next = await schedulingService.nextForCampaign(campaignId);
    expect(next?.id).toBe(scheduled.id);

    const rsvp = await schedulingService.setRsvp(
      scheduled.id,
      { status: 'yes', note: 'Ready to play!' },
      dmActor,
      'dm',
    );
    expect(rsvp).toBeDefined();

    const list = await schedulingService.listForCampaign(campaignId);
    expect(list.length).toBe(1);

    const cancelled = await schedulingService.remove(
      scheduled.id,
      dmActor,
      'dm',
      { reason: 'DM sick' },
    );
    expect(cancelled.status).toBe('cancelled');
  });

  it('manages session recaps and attendance', async () => {
    const sess = await sessionsService.create(
      campaignId,
      {
        title: 'The Great Heist',
        recap: 'The party successfully snuck into the vault.',
      },
      dmActor,
      'dm',
    );
    expect(sess.title).toBe('The Great Heist');

    const list = await sessionsService.listForCampaign(campaignId, 'dm');
    expect(list.length).toBe(1);

    const page = await sessionsService.listPageForCampaign(campaignId, 'dm', {});
    expect(page.items.length).toBe(1);

    const recaps = await sessionsService.listRecapsForCampaign(campaignId, 'dm');
    expect(recaps.length).toBe(1);

    const searchRes = await sessionsService.searchForCampaign(campaignId, 'dm', 'Heist', 10);
    expect(searchRes.length).toBe(1);

    const attendanceList = await sessionsService.listAttendanceForCampaign(campaignId);
    expect(attendanceList).toBeDefined();

    const att = await sessionsService.getAttendance(sess.id);
    expect(Array.isArray(att)).toBe(true);

    const fetched = await sessionsService.getOrThrow(sess.id, 'dm');
    expect(fetched.id).toBe(sess.id);

    const updated = await sessionsService.update(
      sess.id,
      {
        title: 'The Great Heist (Completed)',
      },
      dmActor,
      'dm',
    );
    expect(updated.title).toBe('The Great Heist (Completed)');

    await sessionsService.remove(sess.id, dmActor, 'dm');
    await sessionsService.restore(sess.id, dmActor, 'dm');
  });
});
