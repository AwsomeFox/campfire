import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns, diceRolls, encounters } from '../../src/db/schema';
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

  // Issue #1904 review finding (performance regression from the prior fix): the first
  // attempt at "apply the limit after hidden rows are removed" widened the candidate
  // fetch to the full retention ceiling (up to 1000 rows) on EVERY non-DM list call —
  // ~20x the DB/JSON-decode work per poll on the hottest polling endpoint in live play.
  // The fix pushes the hidden-encounter exclusion into the SQL query itself (a correlated
  // NOT EXISTS), so the existing LIMIT is already correct with no over-fetch. This test
  // proves BOTH properties together: a non-DM still gets a full page of VISIBLE rolls
  // when the newest rows are hidden (correctness), AND the query never asks the database
  // for anywhere near the retention ceiling to do it (no amplification) — instrumented by
  // capturing the bound LIMIT parameter better-sqlite3 actually receives for the
  // dice_rolls query, not just observing the returned row count.
  it('a non-DM list request returns a full page of visible rolls without over-fetching the retention window (#1904)', async () => {
    const [hiddenEncounter] = await db
      .insert(encounters)
      .values({
        campaignId,
        name: 'Perf Test Hidden Encounter',
        hidden: true,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();

    // One OLDER, permanently-visible roll — the one a correct implementation must still
    // surface once the newer, hidden-encounter rolls are excluded ahead of it.
    await db.insert(diceRolls).values({
      campaignId,
      rollerUserId: adminActor.id,
      rollerName: adminActor.name,
      expr: '1d20',
      rolls: '[7]',
      total: 7,
      label: 'Older visible roll',
      source: 'rolled',
      createdAt: nowIso(),
    });

    // A large batch of NEWER rolls, all tied to the hidden encounter — noise a naive
    // "LIMIT before redaction" query would fetch instead of the older visible roll, and
    // the exact rows an over-fetching redaction (the earlier, too-costly fix) would have
    // had to wade through the ENTIRE retention window to skip past correctly.
    for (let i = 0; i < 30; i++) {
      await db.insert(diceRolls).values({
        campaignId,
        rollerUserId: adminActor.id,
        rollerName: adminActor.name,
        expr: '1d20',
        rolls: '[10]',
        total: 10,
        label: `Hidden encounter roll ${i}`,
        source: 'rolled',
        encounterId: hiddenEncounter.id,
        createdAt: nowIso(),
      });
    }

    const rawDb = holder.raw;
    const originalPrepare = rawDb.prepare.bind(rawDb);
    const diceRollsLimitParams: number[] = [];
    // Capture the LIMIT actually bound to the top-level dice_rolls query (the LAST bound
    // param on that statement — SQL syntax always places LIMIT after WHERE/ORDER BY, so
    // it is the last parameter regardless of how many the correlated NOT EXISTS
    // subquery contributes earlier in the same statement).
    (rawDb as unknown as { prepare: typeof rawDb.prepare }).prepare = ((sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.startsWith('select') && sql.includes('from "dice_rolls"') && sql.includes('limit ?')) {
        const originalAll = stmt.all.bind(stmt);
        stmt.all = ((...args: unknown[]) => {
          const last = args[args.length - 1];
          if (typeof last === 'number') diceRollsLimitParams.push(last);
          return originalAll(...(args as []));
        }) as typeof stmt.all;
      }
      return stmt;
    }) as typeof rawDb.prepare;

    try {
      const page = await rollsService.listForCampaign(campaignId, 1, 'player');
      // Correctness: a full page of ONE visible roll, not an empty/short page even though
      // the newest 30 rows are all hidden.
      expect(page).toHaveLength(1);
      expect(page[0].label).toBe('Older visible roll');
    } finally {
      (rawDb as unknown as { prepare: typeof rawDb.prepare }).prepare = originalPrepare;
    }

    // No amplification: the dice_rolls query itself was asked for (about) the requested
    // page size, never anywhere near the 1000-row retention ceiling.
    expect(diceRollsLimitParams.length).toBeGreaterThan(0);
    for (const limitParam of diceRollsLimitParams) {
      expect(limitParam).toBeLessThanOrEqual(5);
    }
  });
});
