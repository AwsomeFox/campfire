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
import { eq } from 'drizzle-orm';
import { campaigns, characters, combatants, encounterOpIdempotency, encounters, npcs } from '../../src/db/schema';
import { ConflictException, ForbiddenException } from '@nestjs/common';
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

  it('rejects updateCombatant when the campaign is archived, even if the encounter is running', async () => {
    const enc = await encountersService.create(campaignId, { name: 'Running Fight', hidden: false }, dmActor, 'dm');
    const goblin = await encountersService.addCombatant(
      enc.id,
      { name: 'Goblin', kind: 'monster', hpMax: 10 },
      dmActor,
      'dm',
    );
    await encountersService.rollInitiative(enc.id, dmActor, 'dm');
    const running = await encountersService.start(enc.id, dmActor, 'dm');
    expect(running.status).toBe('running');

    await db.update(campaigns).set({ status: 'archived' }).where(eq(campaigns.id, campaignId));

    await expect(
      encountersService.updateCombatant(
        enc.id,
        goblin.id,
        { hpDelta: -1, idempotencyKey: 'archived-campaign-guard' },
        dmActor,
        'dm',
      ),
    ).rejects.toThrow(/read-only/);
  });

  it('re-derives a keyed updateCombatant replay through a role-filtered read on responseRole mismatch', async () => {
    const [char] = await db
      .insert(characters)
      .values({
        campaignId,
        ownerUserId: dmActor.id,
        name: 'Hero',
        hpCurrent: 20,
        hpMax: 20,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();

    const enc = await encountersService.create(campaignId, { name: 'Role Replay', hidden: false }, dmActor, 'dm');
    const hero = enc.combatants.find((c) => c.characterId === char.id)!;
    expect(hero).toBeDefined();
    await encountersService.rollInitiative(enc.id, dmActor, 'dm');
    await encountersService.start(enc.id, dmActor, 'dm');

    const key = 'role-replay-key';
    const dmResult = await encountersService.updateCombatant(enc.id, hero.id, { hpDelta: -2, idempotencyKey: key }, dmActor, 'dm');
    expect(dmResult.hpCurrent).toBe(18);

    const spy = jest.spyOn(encountersService, 'getWithCombatantsOrThrow').mockResolvedValueOnce({
      combatants: [{ ...dmResult, name: 'Redacted' }],
    } as any);

    // try/finally: a failing assertion below would otherwise skip `mockRestore` and leak
    // this spy into every later test in the file, turning one real failure into a cascade
    // of unrelated ones that obscures it.
    try {
      const playerResult = await encountersService.updateCombatant(
        enc.id,
        hero.id,
        { hpDelta: -2, idempotencyKey: key },
        dmActor,
        'player',
      );

      expect(playerResult.name).toBe('Redacted');
      expect(spy).toHaveBeenCalledWith(enc.id, 'player', undefined, true);
    } finally {
      spy.mockRestore();
    }
  });

  it('replays a keyed updateCombatant from current state when the stored response body is missing', async () => {
    const enc = await encountersService.create(campaignId, { name: 'Null Body Replay', hidden: false }, dmActor, 'dm');
    const goblin = await encountersService.addCombatant(
      enc.id,
      { name: 'Goblin', kind: 'monster', hpMax: 10 },
      dmActor,
      'dm',
    );
    await encountersService.rollInitiative(enc.id, dmActor, 'dm');
    await encountersService.start(enc.id, dmActor, 'dm');

    const key = 'null-body-key';
    const result = await encountersService.updateCombatant(
      enc.id,
      goblin.id,
      { hpDelta: -3, idempotencyKey: key },
      dmActor,
      'dm',
    );
    expect(result.hpCurrent).toBe(7);

    // Simulate a committed claim whose response body was never backfilled (or was lost).
    await db
      .update(encounterOpIdempotency)
      .set({ responseJson: null })
      .where(eq(encounterOpIdempotency.key, key));

    const replay = await encountersService.updateCombatant(
      enc.id,
      goblin.id,
      { hpDelta: -3, idempotencyKey: key },
      dmActor,
      'dm',
    );
    expect(replay.hpCurrent).toBe(7);
  });

  // Copilot review on #2043. The twin of the test above, one path over: that one covers a
  // PRIOR invocation's claim having a null stored body; this covers THIS invocation's own
  // body being the missing one. Left unhandled, `replayCommittedDeathSave` returned null and
  // `rollDeathSave` threw — a 500 for a death save that had actually committed, and every
  // retry re-found the same bodiless claim and threw again, so the roll was unreachable
  // forever. Same asymmetry-between-symmetric-paths shape as the rest of this PR.
  it('returns the committed death save when THIS invocation wrote it and its own stored body is missing', async () => {
    const enc = await encountersService.create(campaignId, { name: 'Own Null Body', hidden: false }, dmActor, 'dm');
    const hero = await encountersService.addCombatant(
      enc.id,
      { name: 'Fighter', kind: 'character', initMod: 0, hpMax: 15 },
      dmActor,
      'dm',
    );
    await encountersService.rollInitiative(enc.id, dmActor, 'dm');
    await encountersService.start(enc.id, dmActor, 'dm');
    await encountersService.updateCombatant(enc.id, hero.id, { hpSet: 0, deathState: 'dying' }, dmActor, 'dm');

    const key = 'own-null-body-key';
    // Null the claim's body the instant the write commits and before `rollDeathSave` looks
    // it up — i.e. no PRIOR claim was replayed, so `replayedPriorClaim` stays false and the
    // recovery path under test is the one exercised.
    const original = encountersService.updateCombatant.bind(encountersService);
    const spy = jest
      .spyOn(encountersService, 'updateCombatant')
      .mockImplementation(async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        await db.update(encounterOpIdempotency).set({ responseJson: null }).where(eq(encounterOpIdempotency.key, key));
        return result;
      });

    try {
      const save = await encountersService.rollDeathSave(enc.id, hero.id, key, dmActor, 'dm');
      expect(save.combatant.id).toBe(hero.id);
      expect(save.roll).toBeDefined();
      // The roll really did land: the death-save counters moved off their starting state.
      const stored = db.select().from(combatants).where(eq(combatants.id, hero.id)).all()[0];
      expect((stored.deathSaveSuccesses ?? 0) + (stored.deathSaveFailures ?? 0) > 0 || stored.deathState !== 'dying').toBe(
        true,
      );
    } finally {
      spy.mockRestore();
    }
  });

  // Devin review on #2043, and the other half of the twin above — which I had fixed only on
  // the writer's own side, in a PR whose whole thesis is that fixing one symmetric path does
  // not fix its partner. When a PRIOR invocation owns the claim and ITS body is missing, the
  // roll is unrecoverable (this repo has no per-combatant roll lookup) so the request must
  // still fail — but as a deterministic 409 the client can act on, not a bare 500 it can only
  // retry into forever.
  it('fails a retried death save with an actionable 409, not a 500, when a prior claim has no stored body', async () => {
    const enc = await encountersService.create(campaignId, { name: 'Prior Null Body', hidden: false }, dmActor, 'dm');
    const hero = await encountersService.addCombatant(
      enc.id,
      { name: 'Fighter', kind: 'character', initMod: 0, hpMax: 15 },
      dmActor,
      'dm',
    );
    await encountersService.rollInitiative(enc.id, dmActor, 'dm');
    await encountersService.start(enc.id, dmActor, 'dm');
    await encountersService.updateCombatant(enc.id, hero.id, { hpSet: 0, deathState: 'dying' }, dmActor, 'dm');

    const key = 'prior-null-body-key';
    // First call commits the claim for this key normally.
    await encountersService.rollDeathSave(enc.id, hero.id, key, dmActor, 'dm');
    // Now blank the stored body, so the RETRY below finds a prior claim it cannot replay.
    await db.update(encounterOpIdempotency).set({ responseJson: null }).where(eq(encounterOpIdempotency.key, key));

    // Asserted by catching the rejection and interrogating it directly, NOT via
    // `rejects.toMatchObject({ status: 409, ... })`. Jest compares Error objects by message
    // and ignores extra own properties, so that form passes against a bare
    // `new Error('Death-save dice roll was not persisted')` — it pins nothing. (Found by
    // mutating the fix and watching the test stay green, which is the only way this kind of
    // vacuous assertion ever surfaces.)
    const err = await encountersService.rollDeathSave(enc.id, hero.id, key, dmActor, 'dm').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'DEATH_SAVE_RESULT_UNAVAILABLE' });
  });

  // Devin review on #2043: making an eac/kac-only PATCH actually persist turned it into a real
  // domain write, and AGENTS.md requires every domain write to be audited. #74's exemption is
  // scoped to high-frequency HP ticks; defence values are identity-like and rare.
  it('audits a DM patch that touches only eac/kac', async () => {
    const enc = await encountersService.create(campaignId, { name: 'Audited Defenses', hidden: false }, dmActor, 'dm');
    const goblin = await encountersService.addCombatant(
      enc.id,
      { name: 'Goblin', kind: 'monster', hpMax: 10 },
      dmActor,
      'dm',
    );
    await encountersService.rollInitiative(enc.id, dmActor, 'dm');
    await encountersService.start(enc.id, dmActor, 'dm');

    const logSpy = jest.spyOn((encountersService as any).audit as AuditService, 'log');
    try {
      await encountersService.updateCombatant(enc.id, goblin.id, { eac: 12, kac: 14 }, dmActor, 'dm');
      const combatantUpdates = logSpy.mock.calls.filter(
        ([entry]) => (entry as { action?: string }).action === 'encounter.combatant.update',
      );
      expect(combatantUpdates.length).toBe(1);
      expect(combatantUpdates[0][0]).toMatchObject({ entityType: 'combatant', entityId: goblin.id, actorRole: 'dm' });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('rejects a keyed no-op updateCombatant for a soft-deleted encounter', async () => {
    const enc = await encountersService.create(campaignId, { name: 'Deleted Fight', hidden: false }, dmActor, 'dm');
    const goblin = await encountersService.addCombatant(
      enc.id,
      { name: 'Goblin', kind: 'monster', hpMax: 10 },
      dmActor,
      'dm',
    );
    await encountersService.rollInitiative(enc.id, dmActor, 'dm');
    await encountersService.start(enc.id, dmActor, 'dm');

    await db.update(encounters).set({ deletedAt: nowIso() }).where(eq(encounters.id, enc.id));

    await expect(
      encountersService.updateCombatant(
        enc.id,
        goblin.id,
        { idempotencyKey: 'deleted-noop' },
        dmActor,
        'dm',
      ),
    ).rejects.toThrow(/not found/i);
  });

  // Devin review of #1990: `eac`/`kac` are the only writable combatant fields that never
  // enter `staticUpdate` — they go straight onto `writeSet` inside the transaction. The
  // no-op early return did not consider them, so an armour-class-only PATCH matched the
  // "nothing to do" condition and answered 200 having written nothing. Pre-existing, but
  // it lives in the exact block this PR touches.
  it('persists a DM patch that carries only eac/kac instead of silently no-opping', async () => {
    const enc = await encountersService.create(campaignId, { name: 'AC Only Patch', hidden: false }, dmActor, 'dm');
    const goblin = await encountersService.addCombatant(enc.id, { name: 'Goblin', kind: 'monster', hpMax: 10 }, dmActor, 'dm');

    const patched = await encountersService.updateCombatant(enc.id, goblin.id, { eac: 12, kac: 14 }, dmActor, 'dm');
    expect(patched.eac).toBe(12);
    expect(patched.kac).toBe(14);

    // Assert what was STORED, not just the returned projection — the defect was that the
    // response looked correct while nothing had been written.
    const reread = await encountersService.getWithCombatantsOrThrow(enc.id, 'dm');
    const stored = reread.combatants.find((c) => c.id === goblin.id)!;
    expect(stored.eac).toBe(12);
    expect(stored.kac).toBe(14);
  });

  // Devin review of #1990: `statblock`, `eac`, and `kac` are each written only under
  // `isDm`, but the no-op early return tested `patch.statblock === undefined` without the
  // isDm qualifier. A non-DM patch carrying only one of them slipped past the guard,
  // entered the transaction with an empty writeSet, and drizzle threw "No values to set"
  // — a 500 where a 403 was owed. Exactly the same asymmetry as the eac/kac no-op fix
  // earlier on this branch, one field over.
  it('rejects a non-DM patch carrying only a DM-only field instead of 500ing on an empty write', async () => {
    const [char] = await db
      .insert(characters)
      .values({ campaignId, ownerUserId: 'player-9', name: 'Owned Hero', createdAt: nowIso(), updatedAt: nowIso() })
      .returning();
    const enc = await encountersService.create(campaignId, { name: 'DM-Only Field Guard', hidden: false }, dmActor, 'dm');
    const combatant = enc.combatants.find((c) => c.characterId === char.id)!;
    const player: RequestUser = { id: 'player-9', name: 'Player Nine', serverRole: 'user' };

    for (const patch of [{ statblock: { ac: 15 } }, { eac: 12 }, { kac: 14 }] as const) {
      await expect(
        encountersService.updateCombatant(enc.id, combatant.id, patch as never, player, 'player'),
      ).rejects.toThrow(ForbiddenException);
    }

    // A DM sending the same statblock still succeeds — the guard is about role, not field.
    const asDm = await encountersService.updateCombatant(enc.id, combatant.id, { eac: 12 }, dmActor, 'dm');
    expect(asDm.eac).toBe(12);
  });
});
