import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { NpcsService } from '../../src/modules/npcs/npcs.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('NpcsService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let npcsService: NpcsService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-npcs-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const moderation = new ModerationService(db, audit);
    const revisions = new RevisionsService(db, moderation);

    npcsService = new NpcsService(db, audit, revisions);

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

  it('manages NPCs CRUD and listing', async () => {
    const npc = await npcsService.create(
      campaignId,
      {
        name: 'Old Innkeeper',
        role: 'Innkeeper',
        disposition: 'friendly',
      },
      adminActor,
      'dm',
    );
    expect(npc.name).toBe('Old Innkeeper');

    const list = await npcsService.listForCampaign(campaignId, 'dm');
    expect(list.length).toBe(1);

    const fetched = await npcsService.getOrThrow(npc.id, 'dm');
    expect(fetched.id).toBe(npc.id);

    const updated = await npcsService.update(
      npc.id,
      { name: 'Wise Old Innkeeper' },
      adminActor,
      'dm',
    );
    expect(updated.name).toBe('Wise Old Innkeeper');

    await npcsService.remove(npc.id, adminActor, 'dm');
    await npcsService.restore(npc.id, adminActor, 'dm');
  });
});
