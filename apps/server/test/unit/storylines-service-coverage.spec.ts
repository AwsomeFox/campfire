import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { StorylinesService } from '../../src/modules/storylines/storylines.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('StorylinesService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let audit: AuditService;
  let revisions: RevisionsService;
  let storylinesService: StorylinesService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-story-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    audit = new AuditService(db);
    const moderation = new ModerationService(db, audit);
    revisions = new RevisionsService(db, moderation);

    storylinesService = new StorylinesService(db, audit, revisions);

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

  it('manages story arcs and beats CRUD', async () => {
    const arc = await storylinesService.createArc(
      campaignId,
      {
        title: 'Act I: The Beginning',
        summary: 'Opening story arc.',
      },
      adminActor,
      'dm',
    );
    expect(arc.title).toBe('Act I: The Beginning');

    const arcs = await storylinesService.listArcs(campaignId);
    expect(arcs.length).toBe(1);

    const arcsWithBeats = await storylinesService.listArcsWithBeats(campaignId);
    expect(arcsWithBeats.length).toBe(1);

    const fetchedArc = await storylinesService.getArcWithBeatsOrThrow(arc.id);
    expect(fetchedArc.id).toBe(arc.id);

    const updatedArc = await storylinesService.updateArc(
      arc.id,
      { title: 'Act I: The Hero Rises' },
      adminActor,
      'dm',
    );
    expect(updatedArc.title).toBe('Act I: The Hero Rises');

    const beat = await storylinesService.addBeat(
      arc.id,
      { title: 'Call to Adventure', body: 'The hero leaves home.' },
      adminActor,
      'dm',
    );
    expect(beat.title).toBe('Call to Adventure');

    const updatedBeat = await storylinesService.updateBeat(
      beat.id,
      { title: 'Refusal of the Call' },
      adminActor,
      'dm',
    );
    expect(updatedBeat.title).toBe('Refusal of the Call');

    await storylinesService.removeBeat(beat.id, adminActor, 'dm');
    await storylinesService.removeArc(arc.id, adminActor, 'dm');
  });

  it('rolls an arc update back when its prose revision cannot be committed', async () => {
    const arc = await storylinesService.createArc(
      campaignId,
      { title: 'Atomic Arc', summary: 'The original summary.' },
      adminActor,
      'dm',
    );
    jest.spyOn(revisions, 'commitProseVersionInTx').mockImplementationOnce(() => {
      throw new Error('revision write failed');
    });

    await expect(
      storylinesService.updateArc(arc.id, { summary: 'A partial update must not land.' }, adminActor, 'dm'),
    ).rejects.toThrow('revision write failed');

    const unchanged = await storylinesService.getArcWithBeatsOrThrow(arc.id);
    expect(unchanged.summary).toBe('The original summary.');
    expect(unchanged.updatedAt).toBe(arc.updatedAt);
  });

  it('rolls a beat update back when its prose revision cannot be committed', async () => {
    const arc = await storylinesService.createArc(campaignId, { title: 'Atomic Beat Arc' }, adminActor, 'dm');
    const beat = await storylinesService.addBeat(
      arc.id,
      { title: 'Atomic Beat', body: 'The original body.' },
      adminActor,
      'dm',
    );
    jest.spyOn(revisions, 'commitProseVersionInTx').mockImplementationOnce(() => {
      throw new Error('revision write failed');
    });

    await expect(
      storylinesService.updateBeat(beat.id, { body: 'A partial update must not land.' }, adminActor, 'dm'),
    ).rejects.toThrow('revision write failed');

    const unchanged = await storylinesService.getBeatWithBranchesOrThrow(beat.id);
    expect(unchanged.body).toBe('The original body.');
    expect(unchanged.updatedAt).toBe(beat.updatedAt);
  });

  it('rolls an arc update and revision back when its audit cannot be committed', async () => {
    const arc = await storylinesService.createArc(
      campaignId,
      { title: 'Audited Arc', summary: 'The original summary.' },
      adminActor,
      'dm',
    );
    jest.spyOn(audit, 'logInTx').mockImplementationOnce(() => {
      throw new Error('audit write failed');
    });

    await expect(
      storylinesService.updateArc(arc.id, { summary: 'An unaudited update must not land.' }, adminActor, 'dm'),
    ).rejects.toThrow('audit write failed');

    const unchanged = await storylinesService.getArcWithBeatsOrThrow(arc.id);
    expect(unchanged.summary).toBe('The original summary.');
    expect(unchanged.updatedAt).toBe(arc.updatedAt);
    expect(await revisions.listForEntity('story_arc', arc.id)).toEqual([]);
  });

  it('rolls a beat update and revision back when its audit cannot be committed', async () => {
    const arc = await storylinesService.createArc(campaignId, { title: 'Audited Beat Arc' }, adminActor, 'dm');
    const beat = await storylinesService.addBeat(
      arc.id,
      { title: 'Audited Beat', body: 'The original body.' },
      adminActor,
      'dm',
    );
    jest.spyOn(audit, 'logInTx').mockImplementationOnce(() => {
      throw new Error('audit write failed');
    });

    await expect(
      storylinesService.updateBeat(beat.id, { body: 'An unaudited update must not land.' }, adminActor, 'dm'),
    ).rejects.toThrow('audit write failed');

    const unchanged = await storylinesService.getBeatWithBranchesOrThrow(beat.id);
    expect(unchanged.body).toBe('The original body.');
    expect(unchanged.updatedAt).toBe(beat.updatedAt);
    expect(await revisions.listForEntity('story_beat', beat.id)).toEqual([]);
  });
});
