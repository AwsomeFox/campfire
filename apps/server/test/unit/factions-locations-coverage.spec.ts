import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { NpcsService } from '../../src/modules/npcs/npcs.service';
import { FactionsService } from '../../src/modules/factions/factions.service';
import { LocationsService } from '../../src/modules/locations/locations.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('Factions and Locations Services unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let factionsService: FactionsService;
  let locationsService: LocationsService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-facloc-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const moderation = new ModerationService(db, audit);
    const revisions = new RevisionsService(db, moderation);
    const npcs = new NpcsService(db, audit, revisions);

    factionsService = new FactionsService(db, audit, revisions, npcs);
    locationsService = new LocationsService(db, audit, revisions);

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

  it('manages factions CRUD', async () => {
    const faction = await factionsService.create(
      campaignId,
      {
        name: 'Thieves Guild',
        standing: 'neutral',
      },
      adminActor,
      'dm',
    );
    expect(faction.name).toBe('Thieves Guild');

    const list = await factionsService.listForCampaign(campaignId, 'dm');
    expect(list.length).toBe(1);

    const fetched = await factionsService.getOrThrow(faction.id, 'dm');
    expect(fetched.id).toBe(faction.id);

    const updated = await factionsService.update(
      faction.id,
      { name: 'Shadow Thieves' },
      adminActor,
      'dm',
    );
    expect(updated.name).toBe('Shadow Thieves');

    await factionsService.remove(faction.id, adminActor, 'dm');
    await factionsService.restore(faction.id, adminActor, 'dm');
  });

  it('manages locations CRUD', async () => {
    const loc = await locationsService.create(
      campaignId,
      {
        name: 'Dark Forest',
        status: 'explored',
      },
      adminActor,
      'dm',
    );
    expect(loc.name).toBe('Dark Forest');

    const list = await locationsService.listForCampaign(campaignId, 'dm');
    expect(list.length).toBe(1);

    const fetched = await locationsService.getOrThrow(loc.id, 'dm');
    expect(fetched.id).toBe(loc.id);

    const updated = await locationsService.update(
      loc.id,
      { name: 'Whispering Forest' },
      adminActor,
      'dm',
    );
    expect(updated.name).toBe('Whispering Forest');

    await locationsService.remove(loc.id, adminActor, 'dm');
    await locationsService.restore(loc.id, adminActor, 'dm');
  });
});
