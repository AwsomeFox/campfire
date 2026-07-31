import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { SearchService } from '../../src/modules/search/search.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('SearchService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let searchService: SearchService;

  const dmActor: RequestUser = {
    id: '1',
    name: 'DM',
    serverRole: 'user',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-search-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;

    const mockLocations = {
      listForCampaign: jest.fn().mockResolvedValue([{ id: 1, name: 'Crystal Cavern', body: 'shiny blue crystals', kind: 'cave', status: 'explored' }]),
    };
    const mockNpcs = {
      listForCampaign: jest.fn().mockResolvedValue([{ id: 2, name: 'Grom the Orc', body: 'Orc warrior', role: 'ally' }]),
    };
    const mockQuests = {
      listForCampaign: jest.fn().mockResolvedValue([{ id: 3, title: 'Find the Sunken Treasure', body: 'Search ocean floor', status: 'available' }]),
    };

    const emptyMock = {
      listForCampaign: jest.fn().mockResolvedValue([]),
      listAllForCampaign: jest.fn().mockResolvedValue([]),
      listEvents: jest.fn().mockResolvedValue([]),
      listArcsWithBeats: jest.fn().mockResolvedValue([]),
      searchForCampaign: jest.fn().mockResolvedValue([]),
    };

    searchService = new SearchService(
      db,
      false, // FTS fallback mode
      mockQuests as any,
      mockNpcs as any,
      emptyMock as any,
      mockLocations as any,
      emptyMock as any,
      emptyMock as any,
      emptyMock as any,
      emptyMock as any,
      emptyMock as any,
      emptyMock as any,
      emptyMock as any,
      emptyMock as any,
      emptyMock as any,
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

  it('searches campaign entities via fallback scan', async () => {
    const resEmpty = await searchService.search(campaignId, dmActor, 'dm', '');
    expect(resEmpty.results.length).toBe(0);

    const resCavern = await searchService.search(campaignId, dmActor, 'dm', 'Cavern');
    expect(resCavern.results.length).toBeGreaterThan(0);
    expect(resCavern.results.some((r) => r.title.includes('Crystal Cavern'))).toBe(true);

    const resOrc = await searchService.search(campaignId, dmActor, 'dm', 'Grom');
    expect(resOrc.results.length).toBeGreaterThan(0);

    const resTreasure = await searchService.search(campaignId, dmActor, 'dm', 'Treasure');
    expect(resTreasure.results.length).toBeGreaterThan(0);
  });
});
