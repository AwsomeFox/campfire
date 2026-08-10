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
import { runWithRequestContext } from '../../src/common/request-context';

describe('TimelineService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let timelineService: TimelineService;
  let audit: AuditService;

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
    audit = new AuditService(db);
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

  it('records versioned timeline diffs with MCP attribution and keeps the audit write atomic', async () => {
    const created = await runWithRequestContext(
      { requestId: 'audit-810-mcp', transport: 'mcp', startedAt: Date.now() },
      () => timelineService.createEvent(campaignId, { title: 'Veiled comet', dmSecret: 'first secret' }, adminActor, 'dm'),
    );
    await runWithRequestContext(
      { requestId: 'audit-810-mcp', transport: 'mcp', startedAt: Date.now() },
      () => timelineService.updateEvent(created.id, { title: 'Fallen comet', dmSecret: 'second secret' }, adminActor, 'dm'),
    );

    const update = (await audit.listForCampaign(campaignId)).find((row) => row.action === 'timeline.event.update');
    expect(update?.detail).toBe('Timeline event “Fallen comet” updated: title, DM secret');
    expect(update?.payload).toMatchObject({
      version: 1,
      kind: 'timeline_event',
      action: 'timeline.event.update',
      actor: { id: '1', role: 'dm' },
      source: { transport: 'mcp', requestId: 'audit-810-mcp' },
      entity: { id: created.id, label: 'Fallen comet', navigation: { route: 'timeline', query: 'event' } },
    });
    expect(update?.payload?.changes).toEqual(expect.arrayContaining([
      { field: 'title', before: 'Veiled comet', after: 'Fallen comet', visibility: 'member' },
      { field: 'dmSecret', before: 'first secret', after: 'second secret', visibility: 'dm' },
    ]));
    // `searchByRequestId` backs the server-admin correlation endpoint. It may
    // locate this campaign write, but server-admin status is not campaign
    // membership and therefore cannot reveal the raw secret-bearing payload.
    const correlated = (await audit.searchByRequestId('audit-810-mcp')).find((row) => row.action === 'timeline.event.update');
    expect(correlated?.payload).toBeNull();

    const failingAudit: Pick<AuditService, 'log' | 'logInTx'> = {
      log: async () => undefined,
      logInTx: () => {
        throw new Error('audit storage unavailable');
      },
    };
    const serviceWithFailingAudit = new TimelineService(db, failingAudit, new RevisionsService(db, new ModerationService(db, audit)));
    await expect(
      serviceWithFailingAudit.createEvent(campaignId, { title: 'must roll back' }, adminActor, 'dm'),
    ).rejects.toThrow('audit storage unavailable');
    expect((await timelineService.listEvents(campaignId, 'dm')).map((event) => event.title)).not.toContain('must roll back');
    await expect(
      serviceWithFailingAudit.updateEvent(created.id, { body: 'must also roll back' }, adminActor, 'dm'),
    ).rejects.toThrow('audit storage unavailable');
    expect((await timelineService.getEventOrThrow(created.id, 'dm')).body).toBe('');

    await timelineService.removeEvent(created.id, adminActor, 'dm');
    await timelineService.restoreEvent(created.id, adminActor, 'dm');
    const snapshots = await audit.listForCampaign(campaignId);
    const deletedPayload = snapshots.find((row) => row.action === 'timeline.event.delete')?.payload;
    const restoredPayload = snapshots.find((row) => row.action === 'timeline.event.restore')?.payload;
    expect(deletedPayload?.kind).toBe('timeline_event');
    expect(restoredPayload?.kind).toBe('timeline_event');
    if (deletedPayload?.kind === 'timeline_event') expect(deletedPayload.snapshot?.dmSecret).toBe('second secret');
    if (restoredPayload?.kind === 'timeline_event') expect(restoredPayload.snapshot?.dmSecret).toBe('second secret');
  });
});
