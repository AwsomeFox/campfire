import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { ActionSpec } from '@campfire/schema';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, characters, combatants, encounters, ruleEntries, rulePacks } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
// Issue #604: AttachmentsService now delegates responsive derivative generation.
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { ActionResolverService } from '../../src/modules/encounters/action-resolver.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #413 — current-turn workspace + player End-turn, at the service layer against a real
 * SQLite file (mirrors encounter-condition-concurrency.spec.ts). Covers the safety-critical
 * requirements: ownership + current-turn authorization, serialized advancement with a
 * double-advance guard, the DM-only-advancement + DM-confirmation campaign settings, the
 * delay/ready turn-order tools, and undo.
 */
describe('encounter turn workspace (real SQLite, service layer)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    // Issue #601: RevisionsService fires the moderation pre-mutation evidence hook
    // on restore, so it takes a real ModerationService. Deliberately not optional —
    // an absent hook would silently stop capturing abuse evidence.
    const revisions = new RevisionsService(orm, new ModerationService(orm, audit));
    const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit), new AttachmentDerivativesService(orm));
    const campaignLibrary = new CampaignLibraryService(orm, audit);
    const service = new EncountersService(orm, audit, events, rolls, revisions, attachments, campaignLibrary);
    const actions = new ActionResolverService(orm, events, audit);
    return { orm, service, actions };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };
  const player1: RequestUser = { id: 'user-1', name: 'Alice', serverRole: 'user', devRole: 'player' };
  const player2: RequestUser = { id: 'user-2', name: 'Bob', serverRole: 'user', devRole: 'player' };

  /**
   * Seed a running encounter with two character combatants owned by player1 (c1, top of
   * initiative and the current actor) and player2 (c2). Returns the ids + the campaign.
   */
  function seed(
    orm: ReturnType<typeof build>['orm'],
    opts: { dmControlsTurns?: boolean; requireDmTurnConfirmation?: boolean } = {},
  ): { campaignId: number; encounterId: number; c1: number; c2: number } {
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({
        name: 'Turn Test',
        dmControlsTurns: opts.dmControlsTurns ?? false,
        requireDmTurnConfirmation: opts.requireDmTurnConfirmation ?? false,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [char1] = orm
      .insert(characters)
      .values({ campaignId: campaign.id, ownerUserId: player1.id, name: 'Alice PC', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [char2] = orm
      .insert(characters)
      .values({ campaignId: campaign.id, ownerUserId: player2.id, name: 'Bob PC', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({ campaignId: campaign.id, name: 'Fight', status: 'running', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [c1] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: char1.id, name: 'Alice PC', initiative: 20, hpCurrent: 20, hpMax: 20, sortOrder: 0 })
      .returning()
      .all();
    const [c2] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: char2.id, name: 'Bob PC', initiative: 10, hpCurrent: 18, hpMax: 18, sortOrder: 1 })
      .returning()
      .all();
    orm.update(encounters).set({ currentCombatantId: c1.id }).where(eq(encounters.id, encounter.id)).run();
    return { campaignId: campaign.id, encounterId: encounter.id, c1: c1.id, c2: c2.id };
  }

  function currentId(orm: ReturnType<typeof build>['orm'], encounterId: number): number | null {
    const [row] = orm.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
    return row.currentCombatantId;
  }

  it('the current combatant owner may end their own turn; it advances to the next actor', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);

    const result = await service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, player1, 'player');
    expect(result.currentCombatantId).toBe(c2);
    expect(currentId(orm, encounterId)).toBe(c2);
  });

  it('a player may NOT end another player’s active turn (ownership authorization)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm);

    // player2 owns c2, but c1 (player1) currently has the turn.
    await expect(service.endTurn(encounterId, {}, player2, 'player')).rejects.toThrow(/your own/i);
    expect(currentId(orm, encounterId)).toBe(c1); // no advance
  });

  it('dmControlsTurns forbids a player ending their own turn', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm, { dmControlsTurns: true });

    await expect(service.endTurn(encounterId, {}, player1, 'player')).rejects.toThrow(/DM-only/i);
    expect(currentId(orm, encounterId)).toBe(c1);
    // the DM can still advance.
    const result = await service.endTurn(encounterId, {}, dmUser, 'dm');
    expect(result.currentCombatantId).not.toBe(c1);
  });

  it('serializes advancement and prevents double-advance (two concurrent end-turns)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);

    // Both callers try to end c1's turn concurrently, each guarding on expected=c1.
    const results = await Promise.allSettled([
      service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm'),
      service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // Exactly one advances; the other 409s on the double-advance guard.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The turn advanced exactly once — to c2, not skipped past it.
    expect(currentId(orm, encounterId)).toBe(c2);
  });

  it('requireDmTurnConfirmation stages a player end-turn until the DM confirms', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm, { requireDmTurnConfirmation: true });

    // player1 ending their own turn is staged (no advance), surfaced as a 409-style conflict.
    await expect(service.endTurn(encounterId, {}, player1, 'player')).rejects.toThrow(/confirm/i);
    expect(currentId(orm, encounterId)).toBe(c1);
    // The DM confirms → advances.
    const result = await service.endTurn(encounterId, {}, dmUser, 'dm');
    expect(result.currentCombatantId).toBe(c2);
  });

  it('undo steps the turn pointer back to the previous combatant', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);

    await service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm');
    expect(currentId(orm, encounterId)).toBe(c2);
    const undone = await service.undoTurn(encounterId, dmUser, 'dm');
    expect(undone.currentCombatantId).toBe(c1);
    expect(currentId(orm, encounterId)).toBe(c1);
  });

  it('undo resets the restored combatant’s per-turn action economy', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);

    await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'action', moveFt: 30 }, dmUser, 'dm');
    await service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm');
    expect(currentId(orm, encounterId)).toBe(c2);
    await service.undoTurn(encounterId, dmUser, 'dm');
    const [c1row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
    const turnState = JSON.parse(c1row.turnState ?? '{}');
    expect(turnState.used).toEqual({});
    expect(turnState.movementUsedFt).toBe(0);
  });

  it('advancing resets the incoming combatant’s per-turn action economy', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);

    // c2 has spent its action + movement in a prior round.
    await service.updateCombatantTurnState(encounterId, c2, { useSlot: 'action', moveFt: 30 }, dmUser, 'dm');
    // Advance so c2's turn begins — its per-turn slice must reset.
    await service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm');
    const [c2row] = orm.select().from(combatants).where(eq(combatants.id, c2)).limit(1).all();
    const turnState = JSON.parse(c2row.turnState ?? '{}');
    expect(turnState.used).toEqual({});
    expect(turnState.movementUsedFt).toBe(0);
  });

  it('removing the active combatant starts the selected successor’s turn lifecycle', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    const [c3] = orm
      .insert(combatants)
      .values({ encounterId, kind: 'monster', name: 'Eligible successor', initiative: 5, hpCurrent: 8, hpMax: 8, sortOrder: 2 })
      .returning()
      .all();
    // The next ordered actor is down, so removal skips it and starts c3 instead.
    orm.update(combatants).set({ deathState: 'dead' }).where(eq(combatants.id, c2)).run();
    await service.updateCombatantTurnState(encounterId, c3.id, { useSlot: 'action', moveFt: 30 }, dmUser, 'dm');
    const startTick = {
      id: 'remove_start_tick', name: 'hexed', ruleEntryId: null, source: null, sourceCombatantId: null,
      durationRounds: 2, roundsRemaining: 2, timing: 'start-of-turn', saveTiming: 'none', saveDc: null,
      saveAbility: null, isConcentration: false, stacks: 1, notes: '', custom: false,
    };
    orm.update(combatants)
      .set({ conditions: JSON.stringify(['hexed']), conditionInstances: JSON.stringify([startTick]) })
      .where(eq(combatants.id, c3.id))
      .run();

    await service.removeCombatant(encounterId, c1, dmUser, 'dm');

    expect(currentId(orm, encounterId)).toBe(c3.id);
    const [successor] = orm.select().from(combatants).where(eq(combatants.id, c3.id)).limit(1).all();
    expect(JSON.parse(successor.turnState ?? '{}')).toMatchObject({ used: {}, movementUsedFt: 0 });
    expect(JSON.parse(successor.conditionInstances ?? '[]')).toEqual([expect.objectContaining({ id: 'remove_start_tick', roundsRemaining: 1 })]);
  });

  it('undoing an active removal restores the combatant phase after entering a lair slot', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    const ts = new Date().toISOString();
    const [pack] = orm.insert(rulePacks)
      .values({ slug: 'lair-turn-test', name: 'Lair turn test', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 1 })
      .returning()
      .all();
    const [lairEntry] = orm.insert(ruleEntries)
      .values({
        packId: pack.id, slug: 'lair-turn-monster', name: 'Lair turn monster', type: 'monster', summary: '', body: '',
        dataJson: JSON.stringify({ lairActions: [{ name: 'Shifting walls' }] }), createdAt: ts, updatedAt: ts,
      })
      .returning()
      .all();
    orm.update(combatants).set({ ruleEntryId: lairEntry.id }).where(eq(combatants.id, c1)).run();

    const removal = await service.removeCombatant(encounterId, c1, dmUser, 'dm');
    const [afterRemoval] = orm.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
    expect(afterRemoval).toMatchObject({ turnPhase: 'lair', currentCombatantId: null, lairResumeCombatantId: c2 });

    await service.undoRemoveCombatant(encounterId, removal.undoToken, dmUser, 'dm');
    const [afterUndo] = orm.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
    expect(afterUndo).toMatchObject({ turnPhase: 'combatant', currentCombatantId: c1, lairResumeCombatantId: null });
  });

  it('delay / ready flags persist and are player-authorized on their own combatant', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm);

    const delayed = await service.updateCombatantTurnState(encounterId, c1, { delaying: true }, player1, 'player');
    expect(delayed.turnState.delaying).toBe(true);
    const readied = await service.updateCombatantTurnState(encounterId, c1, { readied: 'Fire when the door opens' }, player1, 'player');
    expect(readied.turnState.readied).toBe('Fire when the door opens');

    // player2 cannot touch player1's combatant turn state.
    await expect(
      service.updateCombatantTurnState(encounterId, c1, { delaying: false }, player2, 'player'),
    ).rejects.toThrow(/your own/i);
  });

  it('turn workspace shows the owner their action economy + your-turn flag, and hides detail from others', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm);

    const owner = await service.getTurnWorkspace(encounterId, player1, 'player');
    expect(owner.isYourTurn).toBe(true);
    expect(owner.canEndTurn).toBe(true);
    expect(owner.current?.combatantId).toBe(c1);
    // Default (empty) ruleSystem resolves to the 5e adapter — action economy is present.
    expect(owner.actionEconomy.map((s) => s.key)).toEqual(['action', 'bonus', 'reaction', 'movement']);

    // A different player sees identity + round but no detailed workspace (secrecy).
    const other = await service.getTurnWorkspace(encounterId, player2, 'player');
    expect(other.isYourTurn).toBe(false);
    expect(other.current?.combatantId).toBe(c1);
    expect(other.actionEconomy).toHaveLength(0);
  });

  it('13th Age auto-added PCs get DEX + level initiative breakdowns', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Archmage', ruleSystem: 'archmage', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    await orm
      .insert(characters)
      .values({
        campaignId: campaign.id,
        ownerUserId: player1.id,
        name: 'Iconic Rogue',
        level: 5,
        stats: JSON.stringify({ DEX: 14 }),
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const created = await service.create(campaign.id, { name: 'Ambush' }, dmUser, 'dm');
    expect(created.combatants).toHaveLength(1);
    expect(created.combatants[0].initMod).toBe(7);
    expect(created.combatants[0].initiativeBreakdown?.terms).toEqual([
      { label: 'DEX', value: 2 },
      { label: 'level', value: 5 },
    ]);
  });

  it('13th Age escalation advances rounds 1-8, caps at +6, supports hold/override, and undo restores round default', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId } = seedArchmageRunningEncounter(orm);

    let snapshot = await service.nextTurn(encounterId, {}, dmUser, 'dm');
    expect(snapshot.round).toBe(1);
    expect(snapshot.escalationDie).toBe(0);

    for (let round = 2; round <= 8; round++) {
      snapshot = await service.nextTurn(encounterId, {}, dmUser, 'dm');
      expect(snapshot.round).toBe(round);
      expect(snapshot.escalationDie).toBe(Math.min(round - 1, 6));
      if (round < 8) {
        snapshot = await service.nextTurn(encounterId, {}, dmUser, 'dm');
        expect(snapshot.round).toBe(round);
      }
    }

    const heldSeed = seedArchmageRunningEncounter(orm);
    await service.nextTurn(heldSeed.encounterId, {}, dmUser, 'dm');
    snapshot = await service.nextTurn(heldSeed.encounterId, {}, dmUser, 'dm');
    expect(snapshot.round).toBe(2);
    expect(snapshot.escalationDie).toBe(1);

    snapshot = await service.updateEscalationDie(heldSeed.encounterId, { held: true }, dmUser, 'dm');
    expect(snapshot.escalationDieHeld).toBe(true);
    await service.nextTurn(heldSeed.encounterId, {}, dmUser, 'dm');
    snapshot = await service.nextTurn(heldSeed.encounterId, {}, dmUser, 'dm');
    expect(snapshot.round).toBe(3);
    expect(snapshot.escalationDie).toBe(1);

    snapshot = await service.updateEscalationDie(heldSeed.encounterId, { override: 4 }, dmUser, 'dm');
    expect(snapshot.escalationDie).toBe(4);
    await service.nextTurn(heldSeed.encounterId, {}, dmUser, 'dm');
    snapshot = await service.nextTurn(heldSeed.encounterId, {}, dmUser, 'dm');
    expect(snapshot.round).toBe(4);
    expect(snapshot.escalationDie).toBe(4);

    snapshot = await service.updateEscalationDie(heldSeed.encounterId, { held: false, override: null }, dmUser, 'dm');
    expect(snapshot.escalationDie).toBe(3);
    snapshot = await service.undoTurn(heldSeed.encounterId, dmUser, 'dm');
    expect(snapshot.round).toBe(3);
    expect(snapshot.escalationDie).toBe(2);
    expect(snapshot.escalationDieHistory.length).toBeGreaterThan(0);
  });

  it('13th Age action resolution applies escalation to PCs only and Fear blocks it', () => {
    dataDir = makeTempDataDir();
    const { orm, actions } = build();
    const { encounterId, pc, monster } = seedArchmageActionEncounter(orm);
    const strike = ActionSpec.parse({
      mode: 'attack',
      attack: { bonus: '+5' },
      targets: { count: 1, allow: 'enemy' },
      outcomes: { hit: { damage: [{ flat: 1, type: 'untyped' }] } },
    });

    let resolved = actions.resolve(
      encounterId,
      { actorCombatantId: pc, spec: strike, targetIds: [monster], commit: false },
      dmUser,
      'dm',
    );
    expect(resolved.resolution.dmSummary).toContain('escalation die +3');

    orm.update(combatants).set({ conditions: JSON.stringify(['fear']) }).where(eq(combatants.id, pc)).run();
    resolved = actions.resolve(
      encounterId,
      { actorCombatantId: pc, spec: strike, targetIds: [monster], commit: false },
      dmUser,
      'dm',
    );
    expect(resolved.resolution.dmSummary).toContain('blocked by Fear');

    resolved = actions.resolve(
      encounterId,
      { actorCombatantId: monster, spec: strike, targetIds: [pc], commit: false },
      dmUser,
      'dm',
    );
    expect(resolved.resolution.dmSummary).toContain('no escalation die for monsters/NPCs');
    expect(resolved.resolution.dmSummary).not.toContain('escalation die +3');
  });

  function seedArchmageRunningEncounter(
    orm: ReturnType<typeof build>['orm'],
  ): { campaignId: number; encounterId: number; c1: number; c2: number } {
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Archmage Turns', ruleSystem: 'archmage', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({
        campaignId: campaign.id,
        name: 'Escalating Fight',
        status: 'running',
        round: 1,
        escalationDie: 0,
        turnIndex: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [c1] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', name: 'PC One', initiative: 20, hpCurrent: 20, hpMax: 20, sortOrder: 0 })
      .returning()
      .all();
    const [c2] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', name: 'PC Two', initiative: 10, hpCurrent: 20, hpMax: 20, sortOrder: 1 })
      .returning()
      .all();
    orm.update(encounters).set({ currentCombatantId: c1.id }).where(eq(encounters.id, encounter.id)).run();
    return { campaignId: campaign.id, encounterId: encounter.id, c1: c1.id, c2: c2.id };
  }

  function seedArchmageActionEncounter(
    orm: ReturnType<typeof build>['orm'],
  ): { campaignId: number; encounterId: number; pc: number; monster: number } {
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Archmage Actions', ruleSystem: 'archmage', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [pack] = orm
      .insert(rulePacks)
      .values({ slug: `archmage-test-${campaign.id}`, name: 'Archmage Test', installedAt: ts })
      .returning()
      .all();
    const [entry] = orm
      .insert(ruleEntries)
      .values({
        packId: pack.id,
        slug: `monster-${campaign.id}`,
        name: 'Test Monster',
        type: 'monster',
        dataJson: JSON.stringify({ ac: 16, hp: 30, initiative: 4 }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [character] = orm
      .insert(characters)
      .values({
        campaignId: campaign.id,
        ownerUserId: player1.id,
        name: 'Hero',
        ac: 15,
        stats: JSON.stringify({ STR: 18, DEX: 14 }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({
        campaignId: campaign.id,
        name: 'Action Fight',
        status: 'running',
        round: 4,
        escalationDie: 3,
        turnIndex: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [pc] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: character.id, name: 'Hero', initiative: 20, hpCurrent: 25, hpMax: 25, sortOrder: 0 })
      .returning()
      .all();
    const [monster] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'monster', name: 'Test Monster', initiative: 10, initMod: 4, hpCurrent: 30, hpMax: 30, ruleEntryId: entry.id, sortOrder: 1 })
      .returning()
      .all();
    orm.update(encounters).set({ currentCombatantId: pc.id }).where(eq(encounters.id, encounter.id)).run();
    return { campaignId: campaign.id, encounterId: encounter.id, pc: pc.id, monster: monster.id };
  }

  it('persists player-applied structured-action checks in the DM encounter state (issue #606)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service, actions } = build();
    const { encounterId, c1, c2 } = seed(orm);
    orm
      .update(combatants)
      .set({
        conditionInstances: JSON.stringify([
          { id: 'focus', name: 'Focus', isConcentration: true, sourceCombatantId: c2 },
        ]),
      })
      .where(eq(combatants.id, c1))
      .run();

    const strike = ActionSpec.parse({
      mode: 'save',
      save: { ability: 'DEX', dc: { kind: 'fixed', dc: 21 } },
      targets: { count: 1, allow: 'any' },
      outcomes: { failure: { damage: [{ flat: 12, type: 'untyped' }] } },
    });
    actions.resolve(
      encounterId,
      { actorCombatantId: c1, spec: strike, targetIds: [c2], commit: true },
      player1,
      'player',
    );

    const dmView = await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id);
    const damaged = dmView.combatants.find((combatant) => combatant.id === c2)!;
    expect(damaged.turnState.pendingConcentrationChecks).toEqual([
      expect.objectContaining({ damage: 12, dc: 10 }),
    ]);
  });

  it('authorizes and resolves the persisted queue atomically (issue #606)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    orm
      .update(combatants)
      .set({ conditionInstances: JSON.stringify([{ id: 'bless', name: 'Bless', isConcentration: true, sourceCombatantId: c1 }]) })
      .where(eq(combatants.id, c2))
      .run();

    await service.updateCombatant(encounterId, c1, { hpDelta: -4, idempotencyKey: 'concentration-replay' }, dmUser, 'dm');
    await service.updateCombatant(encounterId, c1, { hpDelta: -4, idempotencyKey: 'concentration-replay' }, dmUser, 'dm');
    let state = (await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id)).combatants
      .find((combatant) => combatant.id === c1)!.turnState;
    expect(state.pendingConcentrationChecks).toHaveLength(1);
    await service.updateCombatant(encounterId, c1, { hpDelta: -12 }, dmUser, 'dm');
    state = (await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id)).combatants
      .find((combatant) => combatant.id === c1)!.turnState;
    expect(state.pendingConcentrationChecks).toHaveLength(2);
    expect(state.pendingConcentrationChecks.map(({ damage, dc }) => ({ damage, dc }))).toEqual([
      { damage: 4, dc: 10 },
      { damage: 12, dc: 10 },
    ]);
    expect((await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id)).combatants.find((combatant) => combatant.id === c1)?.hpCurrent).toBe(4);

    await expect(
      service.updateCombatantTurnState(
        encounterId,
        c1,
        { resolveConcentrationCheck: { id: state.pendingConcentrationChecks[0].id, outcome: 'pass' } },
        player2,
        'player',
      ),
    ).rejects.toThrow(/own character/i);

    const passedCheckId = state.pendingConcentrationChecks[0].id;
    await service.updateCombatantTurnState(
      encounterId,
      c1,
      { resolveConcentrationCheck: { id: passedCheckId, outcome: 'pass' } },
      player1,
      'player',
    );
    state = (await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id)).combatants
      .find((combatant) => combatant.id === c1)!.turnState;
    expect(state.pendingConcentrationChecks).toHaveLength(1);
    await expect(
      service.updateCombatantTurnState(
        encounterId,
        c1,
        { resolveConcentrationCheck: { id: passedCheckId, outcome: 'pass' } },
        player1,
        'player',
      ),
    ).rejects.toThrow(/no longer first/i);

    await service.updateCombatantTurnState(
      encounterId,
      c1,
      { resolveConcentrationCheck: { id: state.pendingConcentrationChecks[0].id, outcome: 'fail' } },
      player1,
      'player',
    );
    state = (await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id)).combatants
      .find((combatant) => combatant.id === c1)!.turnState;
    expect(state.pendingConcentrationChecks).toEqual([]);
    expect(state.concentration).toBeNull();
    const [target] = orm.select().from(combatants).where(eq(combatants.id, c2)).all();
    expect(target.conditionInstances).toBe('[]');
  });

  it('drops stale checks only when concentration is explicitly replaced (issue #606)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm);
    orm
      .update(combatants)
      .set({ turnState: JSON.stringify({ concentration: 'Bless' }) })
      .where(eq(combatants.id, c1))
      .run();
    await service.updateCombatant(encounterId, c1, { hpDelta: -8 }, dmUser, 'dm');

    let updated = await service.updateCombatantTurnState(
      encounterId,
      c1,
      { concentration: 'Bless' },
      player1,
      'player',
    );
    expect(updated.turnState.pendingConcentrationChecks).toHaveLength(1);

    updated = await service.updateCombatantTurnState(
      encounterId,
      c1,
      { concentration: 'Haste' },
      player1,
      'player',
    );
    expect(updated.turnState.concentration).toBe('Haste');
    expect(updated.turnState.pendingConcentrationChecks).toEqual([]);
  });

  it('queues only post-mitigation direct typed damage (issue #606)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm);
    const ts = new Date().toISOString();
    const [pack] = orm
      .insert(rulePacks)
      .values({ slug: 'concentration-defences', name: 'Concentration Defences', installedAt: ts })
      .returning()
      .all();
    const [entry] = orm
      .insert(ruleEntries)
      .values({
        packId: pack.id,
        slug: 'resistant-caster',
        name: 'Resistant Caster',
        type: 'monster',
        dataJson: JSON.stringify({ damage_resistances: ['fire'] }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    orm
      .update(combatants)
      .set({
        hpCurrent: 100,
        hpMax: 100,
        ruleEntryId: entry.id,
        turnState: JSON.stringify({ concentration: 'Wall of Fire' }),
      })
      .where(eq(combatants.id, c1))
      .run();

    let updated = await service.updateCombatant(
      encounterId,
      c1,
      { hpDelta: -42, damageType: 'fire' },
      dmUser,
      'dm',
    );
    expect(updated.hpCurrent).toBe(79);
    expect(updated.turnState.pendingConcentrationChecks).toEqual([
      expect.objectContaining({ damage: 21, dc: 10 }),
    ]);

    orm
      .update(ruleEntries)
      .set({ dataJson: JSON.stringify({ damage_immunities: ['fire'] }) })
      .where(eq(ruleEntries.id, entry.id))
      .run();
    updated = await service.updateCombatant(
      encounterId,
      c1,
      { hpDelta: -20, damageType: 'fire' },
      dmUser,
      'dm',
    );
    expect(updated.hpCurrent).toBe(79);
    expect(updated.turnState.pendingConcentrationChecks).toHaveLength(1);
  });

  it('does not apply 5e concentration checks in a non-5e campaign (issue #606)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    const encounter = orm.select().from(encounters).where(eq(encounters.id, encounterId)).get()!;
    orm.update(campaigns).set({ ruleSystem: 'pf2e' }).where(eq(campaigns.id, encounter.campaignId)).run();
    orm.update(combatants).set({ conditionInstances: JSON.stringify([{ id: 'focus', name: 'Focus', isConcentration: true, sourceCombatantId: c1 }]) }).where(eq(combatants.id, c2)).run();
    const updated = await service.updateCombatant(encounterId, c1, { hpDelta: -8 }, dmUser, 'dm');
    expect(updated.turnState.pendingConcentrationChecks).toEqual([]);
  });

  it('redacts monster pending concentration checks from non-DM encounter reads (issue #606 / #43)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm);
    const [monster] = orm
      .insert(combatants)
      .values({
        encounterId,
        kind: 'monster',
        name: 'Concentrating Drake',
        initiative: 5,
        hpCurrent: 40,
        hpMax: 40,
        sortOrder: 2,
        turnState: JSON.stringify({ concentration: 'Hold Person' }),
      })
      .returning()
      .all();

    await service.updateCombatant(encounterId, monster.id, { hpDelta: -21 }, dmUser, 'dm');

    const dmView = await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id);
    expect(dmView.combatants.find((combatant) => combatant.id === monster.id)?.turnState.pendingConcentrationChecks).toEqual([
      expect.objectContaining({ damage: 21, dc: 10 }),
    ]);

    const playerView = await service.getWithCombatantsOrThrow(encounterId, 'player', player1.id);
    const playerMonster = playerView.combatants.find((combatant) => combatant.id === monster.id)!;
    expect(playerMonster.hpCurrent).toBeNull();
    expect(playerMonster.turnState.pendingConcentrationChecks).toEqual([]);

    // Character combatant checks remain visible to non-DM viewers (shared table knowledge).
    orm
      .update(combatants)
      .set({ turnState: JSON.stringify({ concentration: 'Bless' }) })
      .where(eq(combatants.id, c1))
      .run();
    await service.updateCombatant(encounterId, c1, { hpDelta: -8 }, dmUser, 'dm');
    const playerPc = (await service.getWithCombatantsOrThrow(encounterId, 'player', player1.id)).combatants.find(
      (combatant) => combatant.id === c1,
    )!;
    expect(playerPc.turnState.pendingConcentrationChecks).toEqual([
      expect.objectContaining({ damage: 8, dc: 10 }),
    ]);
  });

  /**
   * Issue #1674 — `updateCombatantTurnState` bounded ONLY the legendary slot; every other slot
   * (action, bonus, reaction, movement, PF2e's `actions`) incremented/absolute-set with no
   * check against the adapter's action-economy model, reachable directly via the turn-workspace
   * endpoint. Convention (#1570/#1571, extended by #1637): spends error, restores clamp.
   */
  describe('action-economy slot bounds (issue #1674)', () => {
    async function expectRejected(promise: Promise<unknown>): Promise<{ code?: string; slot?: string; remaining?: number; max?: number }> {
      let threw: unknown;
      try {
        await promise;
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeDefined();
      const body = (threw as { getResponse?: () => unknown }).getResponse?.();
      return body as { code?: string; slot?: string; remaining?: number; max?: number };
    }

    it('useSlot rejects a 5e action once the action slot is already spent — 400 with code/slot/remaining/max', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'action' }, dmUser, 'dm');
      const body = await expectRejected(service.updateCombatantTurnState(encounterId, c1, { useSlot: 'action' }, dmUser, 'dm'));
      expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'action', remaining: 0, max: 1 });

      // Nothing was overwritten past the legal value.
      const [row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      expect(JSON.parse(row.turnState ?? '{}').used.action).toBe(1);
    });

    it('useSlot rejects a 5e bonus action and reaction past their max of 1 each', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'bonus' }, dmUser, 'dm');
      const bonusBody = await expectRejected(service.updateCombatantTurnState(encounterId, c1, { useSlot: 'bonus' }, dmUser, 'dm'));
      expect(bonusBody).toMatchObject({ code: 'action_economy_exhausted', slot: 'bonus', remaining: 0, max: 1 });

      await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'reaction' }, dmUser, 'dm');
      const reactionBody = await expectRejected(service.updateCombatantTurnState(encounterId, c1, { useSlot: 'reaction' }, dmUser, 'dm'));
      expect(reactionBody).toMatchObject({ code: 'action_economy_exhausted', slot: 'reaction', remaining: 0, max: 1 });
    });

    it("setSlotUsed rejects an absolute overshoot just as easily as useSlot's increment", async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      const body = await expectRejected(
        service.updateCombatantTurnState(encounterId, c1, { setSlotUsed: { key: 'action', used: 2 } }, dmUser, 'dm'),
      );
      expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'action', remaining: 1, max: 1 });

      const [row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      expect(JSON.parse(row.turnState ?? '{}').used?.action ?? 0).toBe(0);
    });

    it('moveFt tracks movement past the adapter default, while a negative correction still floors at 0', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      const moved = await service.updateCombatantTurnState(encounterId, c1, { moveFt: 45 }, dmUser, 'dm');
      expect(moved.turnState.movementUsedFt).toBe(45);

      // A decrement (correcting overcounted movement) is never rejected — floors at 0.
      const corrected = await service.updateCombatantTurnState(encounterId, c1, { moveFt: -100 }, dmUser, 'dm');
      expect(corrected.turnState.movementUsedFt).toBe(0);
    });

    it('releaseSlot keeps flooring at 0 rather than erroring on over-release', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      const released = await service.updateCombatantTurnState(encounterId, c1, { releaseSlot: 'action' }, dmUser, 'dm');
      expect(released.turnState.used.action ?? 0).toBe(0);
      const releasedAgain = await service.updateCombatantTurnState(encounterId, c1, { releaseSlot: 'action' }, dmUser, 'dm');
      expect(releasedAgain.turnState.used.action ?? 0).toBe(0);
    });

    it('legendary-action spend is still bounded by the monster statblock: none declared means none spendable', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId } = seed(orm);
      const ts = new Date().toISOString();
      const [pack] = orm.insert(rulePacks).values({ slug: 'plain-monster', name: 'Plain Monster', installedAt: ts }).returning().all();
      const [entry] = orm
        .insert(ruleEntries)
        .values({
          packId: pack.id,
          slug: 'no-legendary-drake',
          name: 'No-Legendary Drake',
          type: 'monster',
          dataJson: JSON.stringify({ armor_class: 15, hit_points: 60 }),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();
      const [monster] = orm
        .insert(combatants)
        .values({ encounterId, kind: 'monster', name: 'Drake', initiative: 1, hpCurrent: 60, hpMax: 60, sortOrder: 3, ruleEntryId: entry.id })
        .returning()
        .all();

      const body = await expectRejected(service.updateCombatantTurnState(encounterId, monster.id, { useSlot: 'legendary' }, dmUser, 'dm'));
      expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'legendary', remaining: 0, max: 0 });
    });

    it('legendary-action spend is bounded at 3 for a monster whose statblock declares legendary actions, and rejected on the 4th', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId } = seed(orm);
      const ts = new Date().toISOString();
      const [pack] = orm.insert(rulePacks).values({ slug: 'legendary-monster', name: 'Legendary Monster', installedAt: ts }).returning().all();
      const [entry] = orm
        .insert(ruleEntries)
        .values({
          packId: pack.id,
          slug: 'legendary-drake',
          name: 'Legendary Drake',
          type: 'monster',
          dataJson: JSON.stringify({
            armor_class: 18,
            hit_points: 120,
            legendary_actions: [{ name: 'Tail Attack', desc: 'The drake makes a tail attack.' }],
          }),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();
      const [monster] = orm
        .insert(combatants)
        .values({ encounterId, kind: 'monster', name: 'Ancient Drake', initiative: 1, hpCurrent: 120, hpMax: 120, sortOrder: 3, ruleEntryId: entry.id })
        .returning()
        .all();

      await service.updateCombatantTurnState(encounterId, monster.id, { useSlot: 'legendary' }, dmUser, 'dm');
      await service.updateCombatantTurnState(encounterId, monster.id, { useSlot: 'legendary' }, dmUser, 'dm');
      await service.updateCombatantTurnState(encounterId, monster.id, { useSlot: 'legendary' }, dmUser, 'dm');
      const body = await expectRejected(service.updateCombatantTurnState(encounterId, monster.id, { useSlot: 'legendary' }, dmUser, 'dm'));
      expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'legendary', remaining: 0, max: 3 });

      const [row] = orm.select().from(combatants).where(eq(combatants.id, monster.id)).limit(1).all();
      expect(JSON.parse(row.turnState ?? '{}').used.legendary).toBe(3);
    });

    it("PF2e is bounded by ITS action economy (3 actions, no bonus/movement slot) — not 5e's numbers", async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);
      const encounter = orm.select().from(encounters).where(eq(encounters.id, encounterId)).get()!;
      orm.update(campaigns).set({ ruleSystem: 'pf2e' }).where(eq(campaigns.id, encounter.campaignId)).run();

      // Three PF2e actions are all spendable — 5e would have capped a single "action" at 1.
      await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'actions' }, dmUser, 'dm');
      await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'actions' }, dmUser, 'dm');
      const third = await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'actions' }, dmUser, 'dm');
      expect(third.turnState.used.actions).toBe(3);

      const body = await expectRejected(service.updateCombatantTurnState(encounterId, c1, { useSlot: 'actions' }, dmUser, 'dm'));
      expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'actions', remaining: 0, max: 3 });
    });
  });
});
