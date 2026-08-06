import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns, characters, npcs } from '../../src/db/schema';
import { UNKNOWN_COMBATANT_LABEL } from '../../src/modules/encounters/encounters.logic';
import { nowIso } from '../../src/common/time';

describe('EncountersService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let encountersService: EncountersService;

  const dmActor: RequestUser = {
    id: '1',
    name: 'DM',
    serverRole: 'user',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-encounters-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const events = new CampaignEventsService();
    const rolls = {
      record: jest.fn().mockResolvedValue({ id: 1 }),
      recordRoll: jest.fn().mockResolvedValue({ id: 1 }),
      recordInTransaction: jest.fn().mockReturnValue({ id: 1 }),
      emitDiceRolled: jest.fn(),
    } as unknown as RollsService;
    const moderation = {
      quarantineNoteIfWatched: jest.fn(),
      snapshotCommentIfWatched: jest.fn(),
    } as unknown as ModerationService;
    const revisions = new RevisionsService(db, moderation);
    const attachmentsService = { assertCommitted: jest.fn() } as unknown as AttachmentsService;
    const campaignLibrary = {} as unknown as CampaignLibraryService;

    encountersService = new EncountersService(
      db,
      audit,
      events,
      rolls,
      revisions,
      attachmentsService,
      campaignLibrary,
      { notifyCampaign: jest.fn().mockResolvedValue(undefined), notifyUser: jest.fn().mockResolvedValue(undefined) } as any,
      null as any,
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

  it('creates, lists, updates, and fetches encounters', async () => {
    const enc = await encountersService.create(
      campaignId,
      {
        name: 'Goblin Ambush',
      },
      dmActor,
      'dm',
    );
    expect(enc.name).toBe('Goblin Ambush');

    const list = await encountersService.listForCampaign(campaignId);
    expect(list.length).toBe(1);

    const searchResults = await encountersService.searchForCampaign(campaignId, 'dm', 'Goblin', 10);
    expect(searchResults.length).toBeGreaterThan(0);

    const fetched = await encountersService.getWithCombatantsOrThrow(enc.id, 'dm');
    expect(fetched.id).toBe(enc.id);

    const updated = await encountersService.updateEncounter(
      enc.id,
      {
        name: 'Deadly Goblin Ambush',
      },
      dmActor,
      'dm',
    );
    expect(updated.name).toBe('Deadly Goblin Ambush');

    const digest = await encountersService.digestForCampaign(campaignId, 'dm');
    expect(digest).toBeDefined();

    const eventsMap = await encountersService.listEventsForEncounters([enc.id]);
    expect(eventsMap).toBeDefined();

    const headId = await encountersService.getEventsHeadId(enc.id);
    expect(headId).toBeDefined();

    const events = await encountersService.listEvents(enc.id, 'dm');
    expect(Array.isArray(events)).toBe(true);

    const backlinks = await encountersService.listBacklinks(enc.id, {});
    expect(Array.isArray(backlinks)).toBe(true);
  });

  it('manages combatants and runs encounter turn flow', async () => {
    const enc = await encountersService.create(
      campaignId,
      {
        name: 'Bandit Raid',
        hidden: false,
      },
      dmActor,
      'dm',
    );

    const c1 = await encountersService.addCombatant(
      enc.id,
      {
        name: 'Goblin Scout',
        kind: 'monster',
        initMod: 2,
        hpMax: 10,
      },
      dmActor,
      'dm',
    );
    expect(c1.name).toBe('Goblin Scout');

    const c2 = await encountersService.addCombatant(
      enc.id,
      {
        name: 'Goblin Leader',
        kind: 'monster',
        initMod: 4,
        hpMax: 20,
      },
      dmActor,
      'dm',
    );
    expect(c2.name).toBe('Goblin Leader');

    const combatants = await encountersService.listCombatantRows(enc.id);
    expect(combatants.length).toBe(2);

    await encountersService.rollInitiative(enc.id, dmActor, 'dm');

    const activeEnc = await encountersService.start(enc.id, dmActor, 'dm');
    expect(activeEnc.status).toBe('running');

    const updatedC1 = await encountersService.updateCombatant(
      enc.id,
      c1.id,
      {
        name: 'Wounded Goblin Scout',
      },
      dmActor,
      'dm',
    );
    expect(updatedC1.name).toBe('Wounded Goblin Scout');

    const workspace = await encountersService.getTurnWorkspace(enc.id, dmActor, 'dm');
    expect(workspace).toBeDefined();

    const nextState = await encountersService.nextTurn(enc.id, {}, dmActor, 'dm');
    expect(nextState).toBeDefined();

    const undone = await encountersService.undoTurn(enc.id, dmActor, 'dm');
    expect(undone).toBeDefined();

    const diff = await encountersService.getDifficulty(enc.id, 'dm');
    expect(diff).toBeDefined();

    const endedEnc = await encountersService.end(enc.id, dmActor, 'dm');
    expect(endedEnc.status).toBe('ended');

    const aftermath = await encountersService.getAftermath(enc.id, 'dm');
    expect(aftermath).toBeDefined();
    expect(aftermath.loot).toBeDefined();
    expect(aftermath.loot.items.length).toBeGreaterThan(0);

    const xpResult = await encountersService.applyAftermathXp(enc.id, { amount: 100 }, dmActor, 'dm');
    expect(xpResult.xpAwarded).toBe(true);

    const lootItem = aftermath.loot.items[0];
    const lootResult = await encountersService.transferAftermathLoot(enc.id, { itemId: lootItem.id, ownerType: 'party' }, dmActor, 'dm');
    expect(lootResult.loot.items.find((i) => i.id === lootItem.id)?.claimed).toBe(true);

    const coinsResult = await encountersService.transferAftermathLoot(enc.id, { transferCoins: { gp: 50 } }, dmActor, 'dm');
    expect(coinsResult.loot.coinsClaimed).toBe(true);

    const beatResult = await encountersService.updateAftermathBeat(enc.id, { title: 'Victorious Raid', status: 'done' }, dmActor, 'dm');
    expect(beatResult).toBeDefined();

    const timelineResult = await encountersService.addAftermathTimelineEvent(enc.id, { title: 'Raid Defeated' }, dmActor, 'dm');
    expect(timelineResult).toBeDefined();

    await encountersService.reopen(enc.id, dmActor, 'dm');
    await encountersService.remove(enc.id, dmActor, 'dm');
    await encountersService.restore(enc.id, dmActor, 'dm');
  });

  it('handles fog of war, death saves, escalation die, and token formations', async () => {
    const enc = await encountersService.create(
      campaignId,
      {
        name: 'Dungeon Fight',
        hidden: false,
      },
      dmActor,
      'dm',
    );

    const c = await encountersService.addCombatant(
      enc.id,
      {
        name: 'Fighter',
        kind: 'character',
        initMod: 0,
        hpMax: 15,
      },
      dmActor,
      'dm',
    );

    await encountersService.rollInitiative(enc.id, dmActor, 'dm');
    await encountersService.start(enc.id, dmActor, 'dm');

    await encountersService.updateCombatant(
      enc.id,
      c.id,
      { hpSet: 0, deathState: 'dying' },
      dmActor,
      'dm',
    );

    const fogged = await encountersService.revealFogRegion(
      enc.id,
      { x: 0, y: 0, w: 10, h: 10 },
      dmActor,
      'dm',
    );
    expect(fogged).toBeDefined();

    const saveResult = await encountersService.rollDeathSave(enc.id, c.id, 'key-123', dmActor, 'dm');
    expect(saveResult).toBeDefined();

    try {
      await encountersService.updateEscalationDie(enc.id, { override: 2 }, dmActor, 'dm');
    } catch {
      // 13th age only
    }

    const formation = await encountersService.createTokenFormation(
      campaignId,
      { name: 'V-Formation', slots: [{ x: 1, y: 2 }] },
      dmActor,
      'dm',
    );
    expect(formation.name).toBe('V-Formation');

    const formations = await encountersService.listTokenFormations(campaignId, 'dm');
    expect(formations.length).toBe(1);

    await encountersService.deleteTokenFormation(campaignId, formation.id, 'dm');
    const formationsAfter = await encountersService.listTokenFormations(campaignId, 'dm');
    expect(formationsAfter.length).toBe(0);
  });

  it('quickRoll enforces authorization for non-DM player and redacts hidden NPC identity in campaign dice feed', async () => {
    const player1: RequestUser = { id: 'player-1', name: 'Bob', serverRole: 'user' };
    const player2: RequestUser = { id: 'player-2', name: 'Charlie', serverRole: 'user' };

    const [char1] = await db
      .insert(characters)
      .values({ campaignId, ownerUserId: player1.id, name: 'Hero 1', createdAt: nowIso(), updatedAt: nowIso() })
      .returning();
    const [char2] = await db
      .insert(characters)
      .values({ campaignId, ownerUserId: player2.id, name: 'Hero 2', createdAt: nowIso(), updatedAt: nowIso() })
      .returning();

    const [hiddenNpc] = await db
      .insert(npcs)
      .values({ campaignId, name: 'Secret Boss', hidden: true, createdAt: nowIso(), updatedAt: nowIso() })
      .returning();

    const enc = await encountersService.create(campaignId, { name: 'Quick Roll Test' }, dmActor, 'dm');
    const hero1Combatant = enc.combatants.find((c) => c.characterId === char1.id)!;
    const hero2Combatant = enc.combatants.find((c) => c.characterId === char2.id)!;
    const monsterCombatant = await encountersService.addCombatant(enc.id, { name: 'Goblin', kind: 'monster', hpMax: 10 }, dmActor, 'dm');
    const npcCombatant = await encountersService.addCombatant(enc.id, { name: 'Secret Boss', kind: 'npc', npcId: hiddenNpc.id, hpMax: 50 }, dmActor, 'dm');

    // 1. Player 1 quick-rolls for their own character -> succeeds
    const res1 = await encountersService.quickRoll(
      enc.id,
      { combatantId: hero1Combatant.id, actionName: 'Longsword', kind: 'to-hit', expr: '+5', mode: 'flat' },
      player1,
      'player',
    );
    expect(res1.roll).toBeDefined();

    // 2. Player 1 tries to quick-roll for Player 2's character -> throws ForbiddenException
    await expect(
      encountersService.quickRoll(
        enc.id,
        { combatantId: hero2Combatant.id, actionName: 'Fireball', kind: 'to-hit', expr: '+4', mode: 'flat' },
        player1,
        'player',
      ),
    ).rejects.toThrow('You may only quick-roll for your own character');

    // 3. Player 1 tries to quick-roll for a monster -> throws ForbiddenException
    await expect(
      encountersService.quickRoll(
        enc.id,
        { combatantId: monsterCombatant.id, actionName: 'Bite', kind: 'to-hit', expr: '+3', mode: 'flat' },
        player1,
        'player',
      ),
    ).rejects.toThrow('Only the DM may quick-roll for monsters or NPCs');

    // 4. DM quick-rolls for hidden NPC -> campaign dice feed records actor as 'Unknown combatant'
    let recordedLabel = '';
    let recordedActor = '';
    const mockRollsService = {
      record: jest.fn().mockImplementation((_cid, data) => {
        recordedLabel = data.label;
        recordedActor = data.actor;
        return Promise.resolve({ id: 99 });
      }),
      emitDiceRolled: jest.fn(),
    };
    (encountersService as any).rolls = mockRollsService;

    await encountersService.quickRoll(
      enc.id,
      { combatantId: npcCombatant.id, actionName: 'Dark Blast', kind: 'to-hit', expr: '+8', mode: 'flat' },
      dmActor,
      'dm',
    );

    expect(recordedActor).toBe(UNKNOWN_COMBATANT_LABEL);
    expect(recordedLabel).toBe(`${UNKNOWN_COMBATANT_LABEL} · Dark Blast (to-hit)`);
  });
});
