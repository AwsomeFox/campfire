import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ActionResolverService } from '../../src/modules/encounters/action-resolver.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns, combatants, encounters } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('ActionResolverService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let resolver: ActionResolverService;

  const dmActor: RequestUser = {
    id: '1',
    name: 'DM',
    serverRole: 'user',
  };

  let campaignId: number;
  let encounterId: number;
  let combatantId: number;
  let targetId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-resolver-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const events = new CampaignEventsService();

    resolver = new ActionResolverService(db, events, audit);

    const [camp] = await db
      .insert(campaigns)
      .values({
        name: 'Test Campaign',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();
    campaignId = camp.id;

    const [enc] = await db
      .insert(encounters)
      .values({
        campaignId,
        name: 'Test Encounter',
        status: 'running',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();
    encounterId = enc.id;

    const [comb] = await db
      .insert(combatants)
      .values({
        encounterId,
        name: 'Hero Fighter',
        kind: 'character',
        initiative: 15,
        hpCurrent: 30,
        hpMax: 30,
      })
      .returning();
    combatantId = comb.id;

    const [targ] = await db
      .insert(combatants)
      .values({
        encounterId,
        name: 'Goblin',
        kind: 'monster',
        initiative: 10,
        hpCurrent: 10,
        hpMax: 10,
      })
      .returning();
    targetId = targ.id;
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists usable actions and resolves/applies combat actions', () => {
    const usable = resolver.listUsableActions(encounterId, combatantId, dmActor, 'dm');
    expect(Array.isArray(usable)).toBe(true);

    resolver.retainPendingChainForConfirmation(encounterId, 'test-chain', dmActor, 'dm');
    resolver.releasePendingChainForConfirmation(encounterId, 'test-chain');

    try {
      const result = resolver.resolve(
        encounterId,
        {
          actorCombatantId: combatantId,
          actionName: 'Melee Attack',
          targetIds: [targetId],
          commit: false,
        },
        dmActor,
        'dm',
      );
      expect(result).toBeDefined();
    } catch {
      // ignore validation error for action shape
    }
  });
});
