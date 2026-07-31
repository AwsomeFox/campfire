import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('CampaignLibraryService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let libraryService: CampaignLibraryService;

  const dmActor: RequestUser = {
    id: '1',
    name: 'DM',
    serverRole: 'user',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-library-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);

    libraryService = new CampaignLibraryService(db, audit);

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

  it('manages library monsters, tags, and collections', async () => {
    const monstersBefore = await libraryService.listForCampaign(campaignId);
    expect(monstersBefore.length).toBe(0);

    const monster = await libraryService.create(
      campaignId,
      {
        name: 'Dire Wolf',
        statblock: {
          ac: 14,
          abilityScores: { str: 16, dex: 14, con: 14, int: 3, wis: 12, cha: 7 },
          notes: '',
          actions: [],
          traits: [],
        },
      },
      dmActor,
      'dm',
    );
    expect(monster.name).toBe('Dire Wolf');

    const monstersAfter = await libraryService.listForCampaign(campaignId);
    expect(monstersAfter.length).toBe(1);

    const tag = await libraryService.createTag(
      campaignId,
      {
        name: 'Beasts',
        color: '#ff0000',
      },
      dmActor,
      'dm',
    );
    expect(tag.name).toBe('Beasts');

    const tags = await libraryService.listTags(campaignId);
    expect(tags.length).toBe(1);

    const collection = await libraryService.createCollection(
      campaignId,
      {
        name: 'Forest Encounter Pack',
      },
      dmActor,
      'dm',
    );
    expect(collection.name).toBe('Forest Encounter Pack');

    const collections = await libraryService.listCollections(campaignId);
    expect(collections.length).toBe(1);

    const searchRes = await libraryService.search(campaignId, 'dm', { q: 'Dire' });
    expect(searchRes).toBeDefined();
  });
});
