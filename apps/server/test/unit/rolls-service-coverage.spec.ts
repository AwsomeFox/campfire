import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('RollsService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let rollsService: RollsService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-rolls-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;

    rollsService = new RollsService(db);

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

  it('records rolls and lists roll history', async () => {
    await rollsService.onApplicationBootstrap();

    const roll = await rollsService.record(
      campaignId,
      {
        expr: '1d20+5',
        rolls: [13],
        total: 18,
        terms: [{ value: 13, term: '1d20', rolls: [13] }],
      },
      adminActor,
    );
    expect(roll.total).toBe(18);

    const list = await rollsService.listForCampaign(campaignId, 10);
    expect(list.length).toBe(1);

    await rollsService.pruneOverCap();
  });
});
