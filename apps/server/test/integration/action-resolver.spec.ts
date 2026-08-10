import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { ActionApplyRequest, ActionResolveRequest, ActionSpec, ActionUndoToken, CombatantTurnState } from '@campfire/schema';
import { openDatabase } from '../../src/db/db.module';
import { actionApplyChains, actionPendingResolutions, auditLog, campaigns, characters, combatants, encounterEvents, encounters, inventoryItems, ruleEntries, rulePacks, users } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { ActionResolverService } from '../../src/modules/encounters/action-resolver.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #414 — structured action resolver at the service layer against a real SQLite file
 * (mirrors encounter-turn-workspace.spec.ts). Covers the safety-critical, deterministic
 * requirements: authorization (player resolves only their OWN PC; monster actions DM-only),
 * atomic apply of damage/half-on-save/resistance/resource-cost, the campaign apply policy
 * (automatic vs dm-confirmed), and full undo (HP + spell slot + action-economy refund). The
 * roll-dependent branches are pinned deterministically by choosing save DCs of 1 (a d20 save
 * can never roll below 1 → always SUCCEEDS → half) or 21 (a +0 save tops out at 20 → always
 * FAILS → full), so no test depends on the RNG.
 */
describe('action resolver (real SQLite, service layer)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTempDataDir();
  });
  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const service = new ActionResolverService(orm, events, audit);
    return { orm, service };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };
  const alice: RequestUser = { id: 'user-1', name: 'Alice', serverRole: 'user', devRole: 'player' };
  const bob: RequestUser = { id: 'user-2', name: 'Bob', serverRole: 'user', devRole: 'player' };

  // A save spell (DEX save). DC is parameterised: 1 → always succeeds (half), 21 → always fails (full).
  const fireball = (dc: number) => ({
    name: 'Fireball',
    kind: 'spell',
    toHit: '',
    damage: '8d6 fire',
    notes: 'A bright streak flashes to a point you choose.',
    spec: {
      mode: 'save',
      save: { ability: 'DEX', dc: { kind: 'fixed', dc } },
      cost: { slot: 'action', count: 1 },
      uses: { spellLevel: 3 },
      targets: { count: 6, allow: 'any' },
      outcomes: { failure: { damage: [{ formula: '8d6', type: 'fire' }] }, success: { halfDamage: true } },
    },
  });
  const greatsword = {
    name: 'Greatsword',
    kind: 'melee',
    toHit: '+7',
    damage: '2d6+4 slashing',
    notes: 'Heavy, two-handed.',
    spec: {
      mode: 'attack',
      attack: { ability: 'STR', proficient: true },
      cost: { slot: 'action', count: 1 },
      targets: { count: 1, allow: 'enemy' },
      outcomes: { hit: { damage: [{ formula: '2d6', flat: 4, type: 'slashing' }] } },
    },
  };

  function seed(opts: { dmControlsTurns?: boolean; requireDmTurnConfirmation?: boolean; ruleSystem?: string } = {}) {
    const { orm, service } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({
        name: 'Resolver Test',
        ruleSystem: opts.ruleSystem ?? '',
        dmControlsTurns: opts.dmControlsTurns ?? false,
        requireDmTurnConfirmation: opts.requireDmTurnConfirmation ?? false,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [aliceChar] = orm
      .insert(characters)
      .values({
        campaignId: campaign.id,
        ownerUserId: alice.id,
        name: 'Alice PC',
        level: 5,
        stats: JSON.stringify({ STR: 18, DEX: 10 }),
        ac: 15,
        hpCurrent: 40,
        hpMax: 40,
        actions: JSON.stringify([greatsword, fireball(1), fireball(21)]),
        spellSlots: JSON.stringify({ '3': { max: 2, used: 0 } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    // A fire-resistant monster (statblock via rule entry) + a plain character target.
    // The rule entry FK-references a rule pack, so seed the pack first.
    const [rulePack] = orm
      .insert(rulePacks)
      .values({ slug: 'test-pack', name: 'Test Pack', installedAt: ts })
      .returning()
      .all();
    const [pack] = orm.insert(ruleEntries).values({
      packId: rulePack.id,
      slug: 'fire-drake',
      name: 'Fire Drake',
      type: 'monster',
      dataJson: JSON.stringify({ armor_class: 12, hit_points: 60, damage_resistances: ['fire'] }),
      createdAt: ts,
      updatedAt: ts,
    }).returning().all();
    const [bobChar] = orm
      .insert(characters)
      .values({ campaignId: campaign.id, ownerUserId: bob.id, name: 'Bob PC', level: 3, stats: JSON.stringify({ DEX: 10 }), ac: 14, hpCurrent: 30, hpMax: 30, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({ campaignId: campaign.id, name: 'Fight', status: 'running', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [aCombat] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: aliceChar.id, name: 'Alice PC', initiative: 20, hpCurrent: 40, hpMax: 40, sortOrder: 0 })
      .returning()
      .all();
    const [drake] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'monster', ruleEntryId: pack.id, name: 'Fire Drake', initiative: 15, hpCurrent: 60, hpMax: 60, sortOrder: 1 })
      .returning()
      .all();
    const [bCombat] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: bobChar.id, name: 'Bob PC', initiative: 10, hpCurrent: 30, hpMax: 30, sortOrder: 2 })
      .returning()
      .all();
    orm.update(encounters).set({ currentCombatantId: aCombat.id }).where(eq(encounters.id, encounter.id)).run();
    return { orm, service, campaignId: campaign.id, encounterId: encounter.id, aliceChar, actor: aCombat.id, drake: drake.id, bob: bCombat.id };
  }

  it('lists usable actions with a resolvable flag and preserved freeform notes', () => {
    const { service, encounterId, actor } = seed();
    const list = service.listUsableActions(encounterId, actor, alice, 'player');
    expect(list).toHaveLength(3);
    const gs = list.find((a) => a.name === 'Greatsword')!;
    expect(gs.mode).toBe('attack');
    expect(gs.resolvable).toBe(true);
    expect(gs.notes).toBe('Heavy, two-handed.'); // freeform preserved
  });

  it('a player cannot list another player’s character actions', () => {
    const { service, encounterId, actor } = seed();
    expect(() => service.listUsableActions(encounterId, actor, bob, 'player')).toThrow(/your own character/i);
  });

  it('#1941 withholds delegated statblock actions until the DM reveals the statblock', () => {
    const { orm, service, encounterId, drake } = seed();
    const controller: RequestUser = { id: '101', name: 'Controller', serverRole: 'user', devRole: 'player' };
    const ts = new Date().toISOString();
    orm.insert(users)
      .values({ id: 101, username: 'delegated-controller', displayName: 'Controller', createdAt: ts, updatedAt: ts })
      .run();
    orm.update(combatants)
      .set({
        controllerUserId: 101,
        statblockJson: JSON.stringify({
          ac: 18,
          dmNotes: 'secret encounter plan',
          actions: [
            {
              name: 'Delegated Claw',
              kind: 'action',
              spec: {
                mode: 'attack',
                attack: { bonus: '+5' },
                cost: { slot: 'action', count: 1 },
                targets: { count: 1, allow: 'enemy' },
                outcomes: {},
              },
            },
          ],
        }),
      })
      .where(eq(combatants.id, drake))
      .run();

    expect(service.listUsableActions(encounterId, drake, controller, 'player')).toEqual([]);
    expect(() =>
      service.resolve(
        encounterId,
        ActionResolveRequest.parse({
          actorCombatantId: drake,
          actionIndex: 0,
          targetIds: [],
          commit: false,
        }),
        controller,
        'player',
      ),
    ).toThrow(/reveal.*statblock/i);

    orm.update(combatants)
      .set({ statblockRevealed: true })
      .where(eq(combatants.id, drake))
      .run();

    const revealedActions = service.listUsableActions(encounterId, drake, controller, 'player');
    expect(revealedActions).toHaveLength(1);
    expect(revealedActions[0].name).toBe('Delegated Claw');
    expect(revealedActions[0]).not.toHaveProperty('dmNotes');
    expect(() => service.listUsableActions(encounterId, drake, bob, 'player')).toThrow(/your own character/i);
  });

  // Issue #1921: listUsableActions surfaces remaining-uses state, and it tracks a real spend.
  it('#1921: listUsableActions reports uses:null for an at-will action and the live pool for a recharge action', () => {
    const { orm, service, encounterId } = seed();
    const [monster] = orm
      .insert(combatants)
      .values({
        encounterId,
        kind: 'monster',
        name: 'Listed Drake',
        initiative: 5,
        hpCurrent: 80,
        hpMax: 80,
        sortOrder: 3,
        statblockJson: JSON.stringify({
          ac: 18,
          abilityScores: { STR: 22, DEX: 10, CON: 18, INT: 10, WIS: 12, CHA: 14 },
          actions: [
            { name: 'Claw', kind: 'action', spec: { mode: 'attack', attack: { bonus: '+5' }, cost: { slot: '', count: 0 }, targets: { count: 0, allow: 'enemy' }, outcomes: {} } },
            {
              name: 'Breath Weapon',
              kind: 'action',
              spec: {
                mode: 'attack',
                attack: { bonus: '+9' },
                cost: { slot: '', count: 0 },
                uses: { recharge: 'recharge-5-6' },
                targets: { count: 0, allow: 'enemy' },
                outcomes: {},
              },
            },
          ],
        }),
      })
      .returning()
      .all();

    const before = service.listUsableActions(encounterId, monster.id, dmUser, 'dm');
    expect(before.find((a) => a.name === 'Claw')!.uses).toBeNull();
    expect(before.find((a) => a.name === 'Breath Weapon')!.uses).toEqual({ max: 1, recharge: 'recharge-5-6', spent: 0, available: 1 });

    service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: monster.id, actionIndex: 1, targetIds: [], commit: true }), dmUser, 'dm');

    const after = service.listUsableActions(encounterId, monster.id, dmUser, 'dm');
    expect(after.find((a) => a.name === 'Breath Weapon')!.uses).toEqual({ max: 1, recharge: 'recharge-5-6', spent: 1, available: 0 });
  });

  // Issue #1326 — equipped inventory items surface as usable actions, merged after the
  // manually-authored sheet actions, and are resolvable/applyable through the SAME pipeline.
  const dagger = {
    name: 'Dagger',
    kind: 'melee',
    toHit: '+5',
    damage: '1d4+2 piercing',
    notes: 'A quick equipped-weapon action.',
    spec: {
      mode: 'attack',
      attack: { ability: 'DEX', proficient: true },
      cost: { slot: 'action', count: 1 },
      targets: { count: 1, allow: 'enemy' },
      outcomes: { hit: { damage: [{ formula: '1d4', flat: 2, type: 'piercing' }] } },
    },
  };

  function addInventoryItem(
    orm: ReturnType<typeof build>['orm'],
    opts: { campaignId: number; characterId: number; name?: string; equipped: boolean; equipSlot?: string | null; equippedAction?: unknown },
  ) {
    const ts = new Date().toISOString();
    const [row] = orm
      .insert(inventoryItems)
      .values({
        campaignId: opts.campaignId,
        ownerType: 'character',
        characterId: opts.characterId,
        name: opts.name ?? 'Dagger',
        qty: 1,
        equipped: opts.equipped,
        equipSlot: opts.equipSlot ?? null,
        equippedAction: opts.equippedAction !== undefined ? JSON.stringify(opts.equippedAction) : null,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    return row;
  }

  it('#1326: an equipped item with an authored action appears in listUsableActions, merged after sheet actions', () => {
    const { orm, service, campaignId, encounterId, actor, aliceChar } = seed();
    addInventoryItem(orm, { campaignId, characterId: aliceChar.id, equipped: true, equipSlot: 'off-hand', equippedAction: dagger });

    const list = service.listUsableActions(encounterId, actor, alice, 'player');
    // The 3 manual sheet actions (greatsword + 2 fireballs) come first, unchanged…
    expect(list).toHaveLength(4);
    expect(list[0].name).toBe('Greatsword');
    // …and the equipped item's action is appended at the end, resolvable like any other.
    const equippedAction = list[3];
    expect(equippedAction.name).toBe('Dagger');
    expect(equippedAction.mode).toBe('attack');
    expect(equippedAction.resolvable).toBe(true);
  });

  it('#1960: equipped item action source preserves long item names up to 200 chars', () => {
    const { orm, service, campaignId, encounterId, actor, aliceChar } = seed();
    const longItemName = 'Longsword of Extraordinary Ancient Dragon Slaying and Arcane Might';
    addInventoryItem(orm, { campaignId, characterId: aliceChar.id, name: longItemName, equipped: true, equipSlot: 'main-hand', equippedAction: dagger });

    const list = service.listUsableActions(encounterId, actor, alice, 'player');
    const equippedAction = list[3];
    expect(equippedAction.source).toBe(`equipped: ${longItemName}`);
  });

  it('#1326: unequipping the item removes its action from listUsableActions', () => {
    const { orm, service, campaignId, encounterId, actor, aliceChar } = seed();
    const item = addInventoryItem(orm, { campaignId, characterId: aliceChar.id, equipped: true, equipSlot: 'off-hand', equippedAction: dagger });

    expect(service.listUsableActions(encounterId, actor, alice, 'player')).toHaveLength(4);

    orm.update(inventoryItems).set({ equipped: false, equipSlot: null }).where(eq(inventoryItems.id, item.id)).run();

    const afterUnequip = service.listUsableActions(encounterId, actor, alice, 'player');
    expect(afterUnequip).toHaveLength(3);
    expect(afterUnequip.some((a) => a.name === 'Dagger')).toBe(false);
  });

  it('#1326: an equipped item with NO authored action contributes nothing (no auto-generated attack)', () => {
    const { orm, service, campaignId, encounterId, actor, aliceChar } = seed();
    addInventoryItem(orm, { campaignId, characterId: aliceChar.id, equipped: true, equipSlot: 'worn' });

    expect(service.listUsableActions(encounterId, actor, alice, 'player')).toHaveLength(3);
  });

  // Issue #1901 review (chatgpt-codex-connector P2): `character.actions` is itself capped at
  // 100 entries (packages/schema `actions: z.array(CharacterAction).max(100)`), and
  // ActionResolveRequest.actionIndex only accepts 0-99. A character already at that sheet
  // maximum would push every appended equipped-item action to index >= 100 — advertised by
  // listUsableActions/the encounter card, but permanently unresolvable (a 400 from the
  // request schema itself) and silently dropped by /turn's own 100-row slice. The merged
  // list must never advertise an action it cannot also resolve.
  it('#1901 review (codex P2): a character already at the 100-sheet-action maximum does not advertise an unresolvable equipped-item action', () => {
    const { orm, service, campaignId, encounterId, actor, drake, aliceChar } = seed();
    const fullSheet = Array.from({ length: 100 }, (_, i) => ({ ...greatsword, name: `Sheet Action ${i}` }));
    orm.update(characters).set({ actions: JSON.stringify(fullSheet) }).where(eq(characters.id, aliceChar.id)).run();
    addInventoryItem(orm, { campaignId, characterId: aliceChar.id, equipped: true, equipSlot: 'off-hand', equippedAction: dagger });

    const list = service.listUsableActions(encounterId, actor, alice, 'player');
    // The equipped item's action is NOT appended past the resolvable maximum — it would
    // otherwise land at index 100, which ActionResolveRequest.actionIndex (max 99) can never
    // accept. Every index this list DOES return must stay resolvable.
    expect(list).toHaveLength(100);
    expect(list.some((a) => a.name === 'Dagger')).toBe(false);
    for (const a of list) {
      expect(() => ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: a.index, targetIds: [] })).not.toThrow();
    }
    // The last sheet action (index 99) still resolves cleanly through the same shared cap.
    expect(() =>
      service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 99, targetIds: [drake], commit: false }), alice, 'player'),
    ).not.toThrow();
  });

  it('#1326: an equipped item action is resolvable and applyable through the existing action pipeline (by index and by name)', () => {
    const { orm, service, campaignId, encounterId, actor, drake, aliceChar } = seed();
    addInventoryItem(orm, { campaignId, characterId: aliceChar.id, equipped: true, equipSlot: 'off-hand', equippedAction: dagger });

    // By index (3 = after the 3 manual actions).
    const byIndex = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 3, targetIds: [drake], commit: true }),
      alice,
      'player',
    );
    expect(byIndex.applied).toBe(true);
    service.undo(encounterId, byIndex.undoToken!, alice, 'player');
    orm.update(combatants).set({ turnState: JSON.stringify({}) }).where(eq(combatants.id, actor)).run();

    // By name too.
    const byName = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionName: 'Dagger', targetIds: [drake], commit: true }),
      alice,
      'player',
    );
    expect(byName.applied).toBe(true);
    expect(byName.resolution.actionName).toBe('Dagger');
  });

  it('a player resolves + commits their own PC attack against a monster, atomically, then undoes it', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    // Greatsword vs the drake, index 0, commit under the automatic policy.
    const res = service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: true }), alice, 'player');
    expect(res.policy).toBe('automatic');
    expect(res.applied).toBe(true);
    expect(res.undoToken).not.toBeNull();
    const target = res.resolution.targets[0];
    const hpAfter = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent;
    if (target.outcome === 'hit' || target.outcome === 'crit') {
      expect(hpAfter).toBe(60 - target.totalDamage);
      const events = orm.select().from(encounterEvents).where(eq(encounterEvents.encounterId, encounterId)).all();
      expect(events.some((e) => e.type === 'damage')).toBe(true);
      // Issue #426: correlated action chain with declaration, ruling, and consequences.
      const chainIds = [...new Set(events.map((e) => e.chainId).filter(Boolean))];
      expect(chainIds).toHaveLength(1);
      const chainEvents = events.filter((e) => e.chainId === chainIds[0]);
      expect(chainEvents.some((e) => e.phase === 'declare')).toBe(true);
      expect(chainEvents.some((e) => e.phase === 'ruling')).toBe(true);
      expect(chainEvents.some((e) => e.phase === 'consequence' && e.type === 'damage')).toBe(true);
      expect(res.undoToken!.chainId).toBe(chainIds[0]);
    } else {
      expect(hpAfter).toBe(60); // miss
    }
    // Undo restores HP exactly and appends a linked correction chain.
    service.undo(encounterId, res.undoToken!, alice, 'player');
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
    const afterUndo = orm.select().from(encounterEvents).where(eq(encounterEvents.encounterId, encounterId)).all();
    const correction = afterUndo.find((e) => e.phase === 'undo');
    expect(correction).toBeDefined();
    if (correction?.metadataJson && res.undoToken?.chainId) {
      expect(JSON.parse(correction.metadataJson).undoOfChainId).toBe(res.undoToken.chainId);
    }
  });

  it('#1637: an actor with no action remaining cannot spend one through apply_action — legible rejection, not a silent overwrite', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    // The actor already spent their one 5e action this turn.
    orm.update(combatants).set({ turnState: JSON.stringify({ used: { action: 1 } }) }).where(eq(combatants.id, actor)).run();

    let threw: unknown;
    try {
      service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: true }), alice, 'player');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    const body = (threw as { getResponse?: () => unknown }).getResponse?.();
    expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'action', remaining: 0, max: 1 });

    // Nothing was written: no damage landed, and `used.action` did not grow past its max.
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
    const actorAfter = JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}');
    expect(actorAfter.used.action).toBe(1);
  });

  it('#1637: multi-cost rejection messages do not append a naive plural suffix to slot keys', () => {
    const { service, encounterId, actor } = seed();

    let threw: unknown;
    try {
      service.resolve(
        encounterId,
        ActionResolveRequest.parse({
          actorCombatantId: actor,
          actionName: 'Quickened Flurry',
          spec: {
            mode: 'attack',
            attack: { bonus: '+7' },
            cost: { slot: 'bonus', count: 2 },
            targets: { count: 0, allow: 'enemy' },
            outcomes: {},
          },
          targetIds: [],
          commit: true,
        }),
        alice,
        'player',
      );
    } catch (e) {
      threw = e;
    }

    const body = (threw as { getResponse?: () => unknown }).getResponse?.() as { message?: string } | undefined;
    expect(body?.message).toContain('"Quickened Flurry" costs 2 bonus,');
    expect(body?.message).not.toContain('bonuss');
  });

  it('#1637: PF2e default action costs spend the adapter actions slot and reject after it is exhausted', () => {
    const { orm, service, encounterId, actor } = seed({ ruleSystem: 'pf2e' });
    orm.update(combatants).set({ turnState: JSON.stringify({ used: { actions: 2 } }) }).where(eq(combatants.id, actor)).run();
    const req = ActionResolveRequest.parse({
      actorCombatantId: actor,
      actionName: 'Interact',
      spec: {
        mode: 'attack',
        attack: { bonus: '+7' },
        targets: { count: 0, allow: 'enemy' },
        outcomes: {},
      },
      targetIds: [],
      commit: true,
    });

    const applied = service.resolve(encounterId, req, alice, 'player');
    expect(applied.applied).toBe(true);
    let state = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}'),
    );
    expect(state.used.actions).toBe(3);
    expect(state.used.action).toBeUndefined();

    let threw: unknown;
    try {
      service.resolve(encounterId, req, alice, 'player');
    } catch (e) {
      threw = e;
    }
    const body = (threw as { getResponse?: () => unknown }).getResponse?.();
    expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'actions', remaining: 0, max: 3 });
    state = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}'),
    );
    expect(state.used.actions).toBe(3);
    expect(state.used.action).toBeUndefined();

    service.undo(encounterId, applied.undoToken!, alice, 'player');
    state = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}'),
    );
    expect(state.used.actions).toBe(2);
    expect(state.used.action).toBeUndefined();
  });

  it('#1637: movement-cost actions validate and write movementUsedFt instead of used.movement', () => {
    const { orm, service, encounterId, actor } = seed();
    const req = ActionResolveRequest.parse({
      actorCombatantId: actor,
      actionName: 'Tactical Step',
      spec: {
        mode: 'attack',
        attack: { bonus: '+7' },
        cost: { slot: 'movement', count: 10 },
        targets: { count: 0, allow: 'enemy' },
        outcomes: {},
      },
      targetIds: [],
      commit: true,
    });

    orm.update(combatants).set({ turnState: JSON.stringify({ used: {}, movementUsedFt: 25 }) }).where(eq(combatants.id, actor)).run();
    let threw: unknown;
    try {
      service.resolve(encounterId, req, alice, 'player');
    } catch (e) {
      threw = e;
    }
    expect((threw as { getResponse?: () => unknown }).getResponse?.()).toMatchObject({
      code: 'action_economy_exhausted',
      slot: 'movement',
      remaining: 5,
      max: 30,
    });
    let state = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}'),
    );
    expect(state.movementUsedFt).toBe(25);
    expect(state.used.movement).toBeUndefined();

    orm.update(combatants).set({ turnState: JSON.stringify({ used: {}, movementUsedFt: 20 }) }).where(eq(combatants.id, actor)).run();
    const applied = service.resolve(encounterId, req, alice, 'player');
    state = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}'),
    );
    expect(state.movementUsedFt).toBe(30);
    expect(state.used.movement).toBeUndefined();

    service.undo(encounterId, applied.undoToken!, alice, 'player');
    state = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}'),
    );
    expect(state.movementUsedFt).toBe(20);
    expect(state.used.movement).toBeUndefined();
  });

  // Issue #1910 round 5 review (Devin): getTurnWorkspace's DISPLAY resolved a per-combatant
  // movement max (the combatant's own speed snapshot, or the adapter default), but this
  // apply_action spend/guard path still bounded every movement cost by the flat adapter
  // constant regardless of that snapshot — a speed-40 PC was told 40 ft and rejected past 30.
  // Proves BOTH directions of the enforcement gap: a faster-than-default PC gets MORE room
  // than the old flat 30 (not rejected at a 35-ft total), and is still capped at their OWN
  // speed (rejected past 40, not unbounded).
  it('#1910: a combatant with a 40-ft speed snapshot is not rejected at the adapter default of 30, but is still capped at their own 40', () => {
    const { orm, service, encounterId, actor } = seed();
    orm.update(combatants).set({ speed: 40 }).where(eq(combatants.id, actor)).run();
    const req = ActionResolveRequest.parse({
      actorCombatantId: actor,
      actionName: 'Tactical Step',
      spec: {
        mode: 'attack',
        attack: { bonus: '+7' },
        cost: { slot: 'movement', count: 10 },
        targets: { count: 0, allow: 'enemy' },
        outcomes: {},
      },
      targetIds: [],
      commit: true,
    });

    // 25 + 10 = 35, past the old flat 30 cap but within this PC's own 40 — must succeed.
    orm.update(combatants).set({ turnState: JSON.stringify({ used: {}, movementUsedFt: 25 }) }).where(eq(combatants.id, actor)).run();
    const applied = service.resolve(encounterId, req, alice, 'player');
    expect(applied.applied).toBe(true);
    let state = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}'),
    );
    expect(state.movementUsedFt).toBe(35);

    // 35 + 10 = 45, past this PC's own 40 — must still be rejected, at 40 not 30.
    let threw: unknown;
    try {
      service.resolve(encounterId, req, alice, 'player');
    } catch (e) {
      threw = e;
    }
    expect((threw as { getResponse?: () => unknown }).getResponse?.()).toMatchObject({
      code: 'action_economy_exhausted',
      slot: 'movement',
      remaining: 5,
      max: 40,
    });
    state = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}'),
    );
    expect(state.movementUsedFt).toBe(35); // the rejected spend did not write
  });

  it('#1910: a combatant with a 25-ft speed snapshot is rejected past their own 25, not the adapter default of 30', () => {
    const { orm, service, encounterId, actor } = seed();
    orm.update(combatants).set({ speed: 25 }).where(eq(combatants.id, actor)).run();
    const req = ActionResolveRequest.parse({
      actorCombatantId: actor,
      actionName: 'Tactical Step',
      spec: {
        mode: 'attack',
        attack: { bonus: '+7' },
        cost: { slot: 'movement', count: 10 },
        targets: { count: 0, allow: 'enemy' },
        outcomes: {},
      },
      targetIds: [],
      commit: true,
    });

    // 20 + 10 = 30 — within the OLD flat adapter cap, but past this PC's own 25.
    orm.update(combatants).set({ turnState: JSON.stringify({ used: {}, movementUsedFt: 20 }) }).where(eq(combatants.id, actor)).run();
    let threw: unknown;
    try {
      service.resolve(encounterId, req, alice, 'player');
    } catch (e) {
      threw = e;
    }
    expect((threw as { getResponse?: () => unknown }).getResponse?.()).toMatchObject({
      code: 'action_economy_exhausted',
      slot: 'movement',
      remaining: 5,
      max: 25,
    });
    const state = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}'),
    );
    expect(state.movementUsedFt).toBe(20); // the rejected spend did not write
  });

  it('#1910: a combatant with no speed snapshot (null) is still bounded by the adapter default of 30, unchanged from pre-#1910 behavior', () => {
    const { orm, service, encounterId, actor } = seed();
    expect(orm.select({ speed: combatants.speed }).from(combatants).where(eq(combatants.id, actor)).get()!.speed).toBeNull();
    const req = ActionResolveRequest.parse({
      actorCombatantId: actor,
      actionName: 'Tactical Step',
      spec: {
        mode: 'attack',
        attack: { bonus: '+7' },
        cost: { slot: 'movement', count: 10 },
        targets: { count: 0, allow: 'enemy' },
        outcomes: {},
      },
      targetIds: [],
      commit: true,
    });
    orm.update(combatants).set({ turnState: JSON.stringify({ used: {}, movementUsedFt: 25 }) }).where(eq(combatants.id, actor)).run();
    let threw: unknown;
    try {
      service.resolve(encounterId, req, alice, 'player');
    } catch (e) {
      threw = e;
    }
    expect((threw as { getResponse?: () => unknown }).getResponse?.()).toMatchObject({
      code: 'action_economy_exhausted',
      slot: 'movement',
      remaining: 5,
      max: 30,
    });
  });

  it('#1637: inline statblock monsters with legendary actions can spend and refund that slot', () => {
    const { orm, service, encounterId } = seed();
    const [legendaryMonster] = orm
      .insert(combatants)
      .values({
        encounterId,
        kind: 'monster',
        name: 'Inline Ancient',
        initiative: 5,
        hpCurrent: 80,
        hpMax: 80,
        sortOrder: 3,
        statblockJson: JSON.stringify({
          ac: 18,
          abilityScores: { STR: 22, DEX: 10, CON: 18, INT: 10, WIS: 12, CHA: 14 },
          actions: [
            {
              name: 'Tail Swipe',
              kind: 'legendary',
              spec: {
                mode: 'attack',
                attack: { bonus: '+9' },
                cost: { slot: 'legendary', count: 1 },
                targets: { count: 0, allow: 'enemy' },
                outcomes: {},
              },
            },
          ],
        }),
      })
      .returning()
      .all();

    const applied = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: legendaryMonster.id, actionIndex: 0, targetIds: [], commit: true }),
      dmUser,
      'dm',
    );
    expect(applied.applied).toBe(true);
    let state = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, legendaryMonster.id)).get()!.turnState ?? '{}'),
    );
    expect(state.used.legendary).toBe(1);

    service.undo(encounterId, applied.undoToken!, dmUser, 'dm');
    state = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, legendaryMonster.id)).get()!.turnState ?? '{}'),
    );
    expect(state.used.legendary).toBe(0);
  });

  it('#1637: legendary-action spend is bounded by the MONSTER statblock, not a fixed constant — a drake with none cannot spend any', () => {
    const { orm, service, encounterId, drake } = seed();
    // The drake's statblock (dataJson: { armor_class, hit_points, damage_resistances }) has no
    // legendaryActions section at all, so its legendary-action max is 0 — spending even the
    // first one must be rejected, mirroring encounters.service.ts's updateCombatantTurnState
    // precedent for the same slot (issue #618): a monster WITHOUT legendary actions does not
    // get to spend them unbounded.
    let threw: unknown;
    try {
      service.resolve(
        encounterId,
        ActionResolveRequest.parse({
          actorCombatantId: drake,
          actionName: 'Tail Slam',
          spec: {
            mode: 'attack',
            attack: { bonus: '+5' },
            cost: { slot: 'legendary', count: 1 },
            targets: { count: 0, allow: 'enemy' },
            outcomes: {},
          },
          targetIds: [],
          commit: true,
        }),
        dmUser,
        'dm',
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    const body = (threw as { getResponse?: () => unknown }).getResponse?.();
    expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'legendary', remaining: 0, max: 0 });
    expect(JSON.parse(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.turnState ?? '{}').used?.legendary ?? 0).toBe(0);
  });

  // Issue #1921: limited-use/recharge action pools — persisted spend, rejection of a second
  // apply while exhausted, and undo refund.
  function seedRechargeMonster(orm: ReturnType<typeof build>['orm'], encounterId: number) {
    const [monster] = orm
      .insert(combatants)
      .values({
        encounterId,
        kind: 'monster',
        name: 'Recharge Drake',
        initiative: 5,
        hpCurrent: 80,
        hpMax: 80,
        sortOrder: 3,
        statblockJson: JSON.stringify({
          ac: 18,
          abilityScores: { STR: 22, DEX: 10, CON: 18, INT: 10, WIS: 12, CHA: 14 },
          actions: [
            {
              name: 'Breath Weapon',
              kind: 'action',
              spec: {
                mode: 'attack',
                attack: { bonus: '+9' },
                // No action-economy cost (isolates the uses-pool check from the
                // per-turn action-economy check — a second call in the same test
                // would otherwise be rejected by economy exhaustion first).
                cost: { slot: '', count: 0 },
                uses: { recharge: 'recharge-5-6' },
                targets: { count: 0, allow: 'enemy' },
                outcomes: {},
              },
            },
          ],
        }),
      })
      .returning()
      .all();
    return monster.id;
  }

  it('#1921: applying a recharge action twice is refused once spent, naming the recharge condition', () => {
    const { orm, service, encounterId } = seed();
    const monsterId = seedRechargeMonster(orm, encounterId);
    const req = ActionResolveRequest.parse({ actorCombatantId: monsterId, actionIndex: 0, targetIds: [], commit: true });

    const first = service.resolve(encounterId, req, dmUser, 'dm');
    expect(first.applied).toBe(true);
    const row = orm.select().from(combatants).where(eq(combatants.id, monsterId)).get()!;
    const uses = JSON.parse(row.actionUses ?? '{}');
    const usesKeys = Object.keys(uses);
    expect(usesKeys).toHaveLength(1);
    expect(usesKeys[0]).toMatch(/^statblock:/);
    expect(uses[usesKeys[0]]).toEqual({ spent: 1 });

    let threw: unknown;
    try {
      service.resolve(encounterId, req, dmUser, 'dm');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    const body = (threw as { getResponse?: () => unknown }).getResponse?.();
    expect(body).toMatchObject({ code: 'action_uses_exhausted', max: 1, remaining: 0 });
    expect((body as { message: string }).message).toContain('Recharge 5–6');
  });

  it('#1921: undo refunds a spent recharge action back to usable', () => {
    const { orm, service, encounterId } = seed();
    const monsterId = seedRechargeMonster(orm, encounterId);
    const req = ActionResolveRequest.parse({ actorCombatantId: monsterId, actionIndex: 0, targetIds: [], commit: true });

    const applied = service.resolve(encounterId, req, dmUser, 'dm');
    expect(applied.applied).toBe(true);
    const spentRow = orm.select().from(combatants).where(eq(combatants.id, monsterId)).get()!;
    const spentUses = JSON.parse(spentRow.actionUses ?? '{}');
    const usesKey = Object.keys(spentUses)[0];
    expect(spentUses[usesKey].spent).toBe(1);

    service.undo(encounterId, applied.undoToken!, dmUser, 'dm');
    const refundedRow = orm.select().from(combatants).where(eq(combatants.id, monsterId)).get()!;
    const refundedUses = JSON.parse(refundedRow.actionUses ?? '{}');
    expect(refundedUses[usesKey].spent).toBe(0);

    // Usable again after the refund — a third resolve+apply succeeds.
    const secondApply = service.resolve(encounterId, req, dmUser, 'dm');
    expect(secondApply.applied).toBe(true);
  });

  it('OSR descending-AC attack evidence shows the effective ascending threshold, not native descending AC as the threshold', () => {
    const { orm, service, encounterId, actor, drake } = seed({ ruleSystem: 'basic-fantasy' });
    const target = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!;
    orm.update(ruleEntries)
      .set({ dataJson: JSON.stringify({ armor_class: -5, hit_points: 60 }) })
      .where(eq(ruleEntries.id, target.ruleEntryId!))
      .run();

    const res = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    const dmText = res.resolution.targets[0].dmText;
    expect(dmText).toContain('vs ascending AC 24 (descending AC -5)');
    expect(dmText).not.toContain('vs AC -5');
  });

  it('save-for-half + fire resistance both apply on a successful save (DC 1 → always succeeds)', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    // Fireball at index 1 has DC 1, so the drake always SUCCEEDS the save → half damage,
    // and it is fire-resistant → halved again. 8d6 min 8 → half 4 → resist half 2 (>0).
    const res = service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 1, targetIds: [drake], commit: true }), alice, 'player');
    const t = res.resolution.targets[0];
    expect(t.outcome).toBe('success');
    expect(t.damage[0].applied).toBe('resistant');
    expect(t.totalDamage).toBeGreaterThan(0);
    const hpAfter = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent;
    expect(hpAfter).toBe(60 - t.totalDamage);
  });

  /**
   * Issue #2156 — `TargetDefenses` was already fully modeled and applied by the resolver, but
   * only ever derived from a monster/NPC statblock (`damageDefensesFromStatblock`); a
   * character-kind combatant always got `EMPTY_DEFENSES` because `statblockData` only reads
   * `ruleEntryId`, which a character-linked combatant never carried. These tests exercise the
   * new `ActionResolverService.targetDefenses` branch directly (the same private-method-access
   * pattern `resolvePinnedPf2eTarget` below already uses in this file) so the precedence rule
   * is pinned deterministically rather than through dice-roll-dependent full resolution.
   */
  describe('issue #2156: character-level damage defences', () => {
    function seedCharacterCombatant(characterOverrides: Record<string, unknown> = {}, combatantOverrides: Record<string, unknown> = {}) {
      const { orm, service } = build();
      const ts = new Date().toISOString();
      const [campaign] = orm.insert(campaigns).values({ name: 'Defenses Test', ruleSystem: '', createdAt: ts, updatedAt: ts }).returning().all();
      const [char] = orm
        .insert(characters)
        .values({
          campaignId: campaign.id,
          ownerUserId: alice.id,
          name: 'Defender PC',
          hpCurrent: 30,
          hpMax: 30,
          resistances: JSON.stringify(['cold']),
          vulnerabilities: JSON.stringify(['fire']),
          immunities: JSON.stringify(['poison']),
          createdAt: ts,
          updatedAt: ts,
          ...characterOverrides,
        })
        .returning()
        .all();
      const [encounter] = orm.insert(encounters).values({ campaignId: campaign.id, name: 'Fight', status: 'running', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts }).returning().all();
      const [combat] = orm
        .insert(combatants)
        .values({
          encounterId: encounter.id,
          kind: 'character',
          characterId: char.id,
          name: 'Defender PC',
          initiative: 10,
          hpCurrent: 30,
          hpMax: 30,
          sortOrder: 0,
          ...combatantOverrides,
        })
        .returning()
        .all();
      const row = orm.select().from(combatants).where(eq(combatants.id, combat.id)).get()!;
      return { orm, service, row };
    }

    it("a character-kind combatant applies its OWN authored resistances/vulnerabilities/immunities, not EMPTY_DEFENSES", () => {
      const { service, row } = seedCharacterCombatant();
      const defenses = (service as any).targetDefenses(row);
      expect(defenses).toEqual({ resistances: ['cold'], vulnerabilities: ['fire'], immunities: ['poison'] });
    });

    it('a full save-based resolution against a character target actually applies its resistance end to end (not just the private accessor above)', () => {
      const { orm, service } = build();
      const ts = new Date().toISOString();
      // Save-based, not attack-based (same reasoning as fireball(1)/fireball(21) above): a
      // 5e ATTACK roll auto-misses on a natural 1 regardless of AC, so an attack-based test
      // would carry a ~1-in-20 flake risk. A SAVE has no such quirk here (classifySaveOutcome
      // is a plain total>=dc comparison for the default/5e adapter) — DC 21 against a
      // DEX-10/no-proficiency defender (nat 20 + mod 0 = 20 < 21) always FAILS, guaranteeing
      // full (pre-resistance) damage every run.
      const iceLance = {
        name: 'Ice Lance',
        kind: 'spell',
        toHit: '',
        damage: '8d6 cold',
        notes: '',
        spec: {
          mode: 'save',
          save: { ability: 'DEX', dc: { kind: 'fixed', dc: 21 } },
          cost: { slot: 'action', count: 1 },
          uses: { spellLevel: 3 },
          // 'any' (like fireball above), not 'enemy': both combatants here are character-kind,
          // which assertTargetAllowed treats as allies, not enemies.
          targets: { count: 1, allow: 'any' },
          outcomes: { failure: { damage: [{ formula: '8d6', type: 'cold' }] }, success: { halfDamage: true } },
        },
      };
      const [campaign] = orm.insert(campaigns).values({ name: 'Defenses E2E Test', ruleSystem: '', createdAt: ts, updatedAt: ts }).returning().all();
      const [attackerChar] = orm
        .insert(characters)
        .values({
          campaignId: campaign.id,
          ownerUserId: alice.id,
          name: 'Attacker PC',
          level: 5,
          stats: JSON.stringify({ STR: 18 }),
          hpCurrent: 30,
          hpMax: 30,
          actions: JSON.stringify([iceLance]),
          spellSlots: JSON.stringify({ '3': { max: 1, used: 0 } }),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();
      const [defenderChar] = orm
        .insert(characters)
        .values({
          campaignId: campaign.id,
          ownerUserId: bob.id,
          name: 'Defender PC',
          hpCurrent: 30,
          hpMax: 30,
          resistances: JSON.stringify(['cold']),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();
      const [encounter] = orm.insert(encounters).values({ campaignId: campaign.id, name: 'Fight', status: 'running', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts }).returning().all();
      const [attackerCombat] = orm
        .insert(combatants)
        .values({ encounterId: encounter.id, kind: 'character', characterId: attackerChar.id, name: 'Attacker PC', initiative: 20, hpCurrent: 30, hpMax: 30, sortOrder: 0 })
        .returning()
        .all();
      const [defenderCombat] = orm
        .insert(combatants)
        .values({ encounterId: encounter.id, kind: 'character', characterId: defenderChar.id, name: 'Defender PC', initiative: 10, hpCurrent: 30, hpMax: 30, sortOrder: 1 })
        .returning()
        .all();
      orm.update(encounters).set({ currentCombatantId: attackerCombat.id }).where(eq(encounters.id, encounter.id)).run();

      const res = service.resolve(
        encounter.id,
        ActionResolveRequest.parse({ actorCombatantId: attackerCombat.id, actionIndex: 0, targetIds: [defenderCombat.id], commit: true }),
        alice,
        'player',
      );
      const t = res.resolution.targets[0];
      expect(t.outcome).toBe('failure');
      expect(t.damage[0].applied).toBe('resistant');
      expect(t.totalDamage).toBeGreaterThan(0);
      const hpAfter = orm.select().from(combatants).where(eq(combatants.id, defenderCombat.id)).get()!.hpCurrent;
      expect(hpAfter).toBe(30 - t.totalDamage);
    });

    it(
      "precedence: a linked character's defences win outright over a statblock/ruleEntry also present on the same combatant row — " +
        'the same rule targetDefenseValue already applies for AC, stated explicitly rather than left to evaluation order',
      () => {
        const { orm, service } = build();
        const ts = new Date().toISOString();
        const [campaign] = orm.insert(campaigns).values({ name: 'Precedence Test', ruleSystem: '', createdAt: ts, updatedAt: ts }).returning().all();
        const [rulePack] = orm.insert(rulePacks).values({ slug: 'precedence-pack', name: 'Precedence Pack', installedAt: ts }).returning().all();
        // A statblock that declares the OPPOSITE defence (immune, not resistant) for the same
        // damage type, so a test that passed by accident (e.g. reading the statblock branch
        // when it shouldn't) would fail loudly instead of silently agreeing with the character.
        const [entry] = orm
          .insert(ruleEntries)
          .values({
            packId: rulePack.id,
            slug: 'conflicting-statblock',
            name: 'Conflicting Statblock',
            type: 'monster',
            dataJson: JSON.stringify({ armor_class: 10, hit_points: 10, damage_immunities: ['cold'] }),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        const [char] = orm
          .insert(characters)
          .values({ campaignId: campaign.id, ownerUserId: alice.id, name: 'Defender PC', hpCurrent: 30, hpMax: 30, resistances: JSON.stringify(['cold']), createdAt: ts, updatedAt: ts })
          .returning()
          .all();
        const [encounter] = orm.insert(encounters).values({ campaignId: campaign.id, name: 'Fight', status: 'running', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts }).returning().all();
        // The combatant row carries BOTH a characterId AND a ruleEntryId — a shape the schema
        // permits even though ordinary application flow never produces it for a character-kind
        // combatant. The precedence rule must hold regardless.
        const [combat] = orm
          .insert(combatants)
          .values({ encounterId: encounter.id, kind: 'character', characterId: char.id, ruleEntryId: entry.id, name: 'Defender PC', initiative: 10, hpCurrent: 30, hpMax: 30, sortOrder: 0 })
          .returning()
          .all();
        const row = orm.select().from(combatants).where(eq(combatants.id, combat.id)).get()!;

        const defenses = (service as any).targetDefenses(row);
        expect(defenses.resistances).toContain('cold');
        expect(defenses.immunities).not.toContain('cold');
      },
    );
  });

  function resolvePinnedPf2eTarget(spec: ActionSpec, fixed: Record<string, number> = { '1d20': 1, '2d6': 7, '4d6': 14 }) {
    const { service, encounterId, actor, bob } = seed({ ruleSystem: 'pf2e' });
    const encounter = (service as any).encounterRowOrThrow(encounterId);
    const actorRow = (service as any).combatantRowOrThrow(encounterId, actor);
    const targetRow = (service as any).combatantRowOrThrow(encounterId, bob);
    const adapter = (service as any).adapterForCampaign(encounter.campaignId);
    const { stats, level } = (service as any).actorStats(actorRow);
    const prof = (service as any).proficiencyBonus(adapter, level);
    const fixedRoller = (expr: string) => ({ total: fixed[expr] ?? 0, rolls: [fixed[expr] ?? 0] });

    return (service as any).resolveOneTarget(spec, 'Test Save Spell', adapter, encounter, actorRow, stats, prof, fixedRoller, targetRow);
  }

  it('#1600: a PF2e critical save FAILURE doubles damage (double-total), not just an attack crit', () => {
    // resolveOneTarget is private — this drives it directly (same pattern as export-markdown-zip.spec.ts's
    // (service as any).<privateMethod>()) so the natural d20 roll is pinned via a fixed roller rather than
    // real crypto randomness, which PF2e's degree-of-success nat-1/nat-20 step adjustment makes otherwise
    // impossible to guarantee a critical failure against (a nat 20 always bumps the step UP, so no DC/mod
    // combination guarantees criticalFailure across every possible roll — only a pinned roll can).
    // nat 1 vs Bob's DEX 10 (mod 0) = total 1, DC 15 → 1 <= 15-10 → criticalFailure, and a nat 1
    // only ever pushes the degree further toward failure, never away from it, so this is deterministic.
    const spec = ActionSpec.parse({
      mode: 'save',
      save: { ability: 'DEX', dc: { kind: 'fixed', dc: 15 } },
      // No critFailure branch authored — pickOutcomeBranch falls back to `failure`, whose damage
      // is the full-damage branch of a basic save (ordinary success is half); the resolver itself
      // must apply PF2e's double-total rule on top.
      outcomes: { failure: { damage: [{ formula: '2d6', flat: 3, type: 'fire' }] }, success: { halfDamage: true } },
    });

    const result = resolvePinnedPf2eTarget(spec);
    expect(result.degree).toBe('criticalFailure');
    // Base (2d6=7)+3 = 10; PF2e double-total doubles the WHOLE thing after the flat modifier → 20.
    expect(result.damage[0].amount).toBe(20);
    expect(result.totalDamage).toBe(20);
  });

  it('#1600: a PF2e critical check failure does not double an authored failure branch', () => {
    const spec = ActionSpec.parse({
      mode: 'check',
      save: { ability: 'DEX', dc: { kind: 'fixed', dc: 15 } },
      outcomes: { failure: { damage: [{ formula: '2d6', flat: 3, type: 'fire' }] } },
    });

    const result = resolvePinnedPf2eTarget(spec);
    expect(result.degree).toBe('criticalFailure');
    expect(result.damage[0].amount).toBe(10);
    expect(result.totalDamage).toBe(10);
  });

  it('#1600: a PF2e critical save failure does not double an explicit critFailure branch', () => {
    const spec = ActionSpec.parse({
      mode: 'save',
      save: { ability: 'DEX', dc: { kind: 'fixed', dc: 15 } },
      outcomes: {
        failure: { damage: [{ formula: '2d6', flat: 3, type: 'fire' }] },
        success: { halfDamage: true },
        critFailure: { damage: [{ formula: '4d6', type: 'fire' }] },
      },
    });

    const result = resolvePinnedPf2eTarget(spec);
    expect(result.degree).toBe('criticalFailure');
    expect(result.damage[0].amount).toBe(14);
    expect(result.totalDamage).toBe(14);
  });

  it('returns a concentration save request for effective structured-action damage', () => {
    const { orm, service, encounterId, actor, drake, bob: bobCombat } = seed();
    // A structured condition on any target is the canonical source of truth for who
    // created the concentration effect. The caster need not carry a turn-state marker.
    orm
      .update(combatants)
      .set({
        conditionInstances: JSON.stringify([
          { id: 'bless', name: 'Bless', isConcentration: true, sourceCombatantId: drake },
        ]),
      })
      .where(eq(combatants.id, bobCombat))
      .run();

    const res = service.resolve(
      encounterId,
      ActionResolveRequest.parse({
        actorCombatantId: actor,
        actionIndex: 1,
        targetIds: [drake],
        commit: true,
      }),
      alice,
      'player',
    );
    const damage = res.resolution.targets[0].totalDamage;
    const persisted = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.turnState ?? '{}'),
    );
    expect(persisted.pendingConcentrationChecks).toEqual([
      expect.objectContaining({
        damage,
        dc: Math.max(10, Math.floor(damage / 2)),
      }),
    ]);

    service.undo(encounterId, res.undoToken!, alice, 'player');
    const afterUndo = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.turnState ?? '{}'),
    );
    expect(afterUndo.pendingConcentrationChecks).toEqual([]);
  });

  it('does not flatten a qualified Open5e display into unconditional action resistance', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const target = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!;
    orm.update(ruleEntries)
      .set({
        dataJson: JSON.stringify({
          resistances_and_immunities: {
            damage_resistances_display: 'fire from nonmagical attacks',
            damage_resistances: [{ name: 'Fire', key: 'fire' }],
          },
        }),
      })
      .where(eq(ruleEntries.id, target.ruleEntryId!))
      .run();

    // DC 21 always fails, so only an incorrectly flattened resistance could halve it.
    const res = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 2, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    expect(res.resolution.targets[0].outcome).toBe('failure');
    expect(res.resolution.targets[0].damage[0].applied).toBe('normal');
  });

  it('failed save (DC 21 → always fails) applies full damage and spends + refunds a spell slot', () => {
    const { orm, service, encounterId, actor, aliceChar, drake } = seed();
    const res = service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 2, targetIds: [drake], commit: true }), alice, 'player');
    const t = res.resolution.targets[0];
    expect(t.outcome).toBe('failure');
    // Full damage, but still fire-resistant → halved once (no save-half). 8d6 → resist half.
    expect(t.damage[0].applied).toBe('resistant');
    // Spell slot spent.
    const after = orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!;
    expect(JSON.parse(after.spellSlots)['3'].used).toBe(1);
    // Action-economy cost recorded on the actor.
    const actorRow = orm.select().from(combatants).where(eq(combatants.id, actor)).get()!;
    expect(JSON.parse(actorRow.turnState ?? '{}').used.action).toBe(1);
    // Undo refunds the slot + the action.
    service.undo(encounterId, res.undoToken!, alice, 'player');
    expect(JSON.parse(orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!.spellSlots)['3'].used).toBe(0);
    expect(JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}').used.action).toBe(0);
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
  });

  it('#1571: a caster at 0 remaining slots at a level cannot cast at that level through apply_action, and nothing else is written', () => {
    const { orm, service, encounterId, actor, aliceChar, drake } = seed();
    // Exhaust Alice's level-3 slots first, exactly like the prior test — then the NEXT
    // cast at that level is the one #1571 is about.
    orm.update(characters).set({ spellSlots: JSON.stringify({ '3': { max: 2, used: 2 } }) }).where(eq(characters.id, aliceChar.id)).run();

    let caught: { status?: number; response?: { code?: string; level?: number; remaining?: number; max?: number; message?: string } } | undefined;
    try {
      service.resolve(
        encounterId,
        ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 2, targetIds: [drake], commit: true }),
        alice,
        'player',
      );
    } catch (err) {
      caught = err as typeof caught;
    }
    expect(caught?.status).toBe(400);
    // Same shape `patchSpellSlots` / `adjust_spell_slots` throw (#1570): enough for the AI
    // Driver to self-correct (a different level, or a rest) instead of retrying blind.
    expect(caught?.response?.code).toBe('insufficient_slots');
    expect(caught?.response?.level).toBe(3);
    expect(caught?.response?.remaining).toBe(0);
    expect(caught?.response?.max).toBe(2);
    expect(caught?.response?.message).toMatch(/0 of 2 remain/);

    // FAIL BEFORE THE WORK — not a partial apply. Nothing about the rejected cast landed:
    // the drake took no damage, the sheet's slots are untouched, no action-economy cost was
    // spent, and no combat-log chain was written for it.
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
    expect(JSON.parse(orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!.spellSlots)['3'].used).toBe(2);
    expect(JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}').used?.action ?? 0).toBe(0);
    expect(orm.select().from(encounterEvents).where(eq(encounterEvents.encounterId, encounterId)).all()).toHaveLength(0);
  });

  it('a player may not resolve a monster/NPC action (DM-authorized)', () => {
    const { service, encounterId, drake } = seed();
    expect(() =>
      service.resolve(
        encounterId,
        ActionResolveRequest.parse({ actorCombatantId: drake, spec: { mode: 'attack', attack: { bonus: '+6' }, outcomes: { hit: { damage: [{ formula: '2d6', type: 'fire' }] } } }, targetIds: [], commit: true }),
        alice,
        'player',
      ),
    ).toThrow(/monster\/NPC action|your own character/i);
  });

  it('a player may not resolve another player’s character action', () => {
    const { service, encounterId, actor } = seed();
    expect(() => service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [] }), bob, 'player')).toThrow(/own character/i);
  });

  it('a player may resolve or apply only on their active turn, while the DM may override', async () => {
    const { orm, service, campaignId, encounterId, actor, drake } = seed();
    const request = ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false });

    // A direct resolve after the turn advances is refused even though Alice still owns the actor.
    orm.update(encounters).set({ currentCombatantId: drake }).where(eq(encounters.id, encounterId)).run();
    expect(() => service.resolve(encounterId, request, alice, 'player')).toThrow(/active turn/i);

    // A preview opened on Alice's turn cannot be applied after the turn advances.
    orm.update(encounters).set({ currentCombatantId: actor }).where(eq(encounters.id, encounterId)).run();
    const preview = service.resolve(encounterId, request, alice, 'player');
    orm.update(encounters).set({ currentCombatantId: drake }).where(eq(encounters.id, encounterId)).run();
    expect(() => service.apply(encounterId, { chainId: preview.chainId }, alice, 'player')).toThrow(/active turn/i);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rejected = orm
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.campaignId, campaignId), eq(auditLog.action, 'encounter.action.apply_rejected')))
      .all();
    expect(rejected.some((row) => JSON.parse(row.detail).reason === 'not_active_turn' && JSON.parse(row.detail).chainId === preview.chainId)).toBe(true);

    // DM override remains available for the same stale resolution.
    expect(service.apply(encounterId, { chainId: preview.chainId }, dmUser, 'dm').undoToken).toBeDefined();
  });

  it('keeps a player preview valid when initiative is re-sorted during that same turn', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );

    // Re-sorting initiative can change the positional index without changing the active
    // combatant or round. A preview remains tied to this actor's current turn, not its index.
    orm.update(encounters).set({ turnIndex: 1 }).where(eq(encounters.id, encounterId)).run();

    expect(service.apply(encounterId, { chainId: preview.chainId }, alice, 'player').undoToken).toBeDefined();
  });

  it('rechecks a player turn inside the apply transaction before writing consequences or resources', () => {
    const { orm, service, encounterId, actor, drake, aliceChar } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 2, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    expect(
      orm
        .select({ turnRound: actionPendingResolutions.turnRound, turnVersion: actionPendingResolutions.turnVersion })
        .from(actionPendingResolutions)
        .where(eq(actionPendingResolutions.id, preview.chainId))
        .get(),
    ).toEqual({ turnRound: 1, turnVersion: 0 });
    const internals = service as unknown as { applyInternal: (...args: unknown[]) => unknown };
    const originalApplyInternal = internals.applyInternal;
    internals.applyInternal = (...args) => {
      // Model the DM advancing between apply's outer authorization and its write transaction.
      orm.update(encounters).set({ currentCombatantId: drake }).where(eq(encounters.id, encounterId)).run();
      return originalApplyInternal.apply(service, args);
    };

    try {
      expect(() => service.apply(encounterId, { chainId: preview.chainId }, alice, 'player')).toThrow(/active turn/i);
    } finally {
      internals.applyInternal = originalApplyInternal;
    }

    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
    expect(JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}').used?.action ?? 0).toBe(0);
    expect(JSON.parse(orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!.spellSlots)).toEqual({ '3': { max: 2, used: 0 } });
  });

  it('rechecks a player preview round inside the apply transaction before writing consequences or resources', async () => {
    const { orm, service, campaignId, encounterId, actor, drake, aliceChar } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 2, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    const internals = service as unknown as { applyInternal: (...args: unknown[]) => unknown };
    const originalApplyInternal = internals.applyInternal;
    internals.applyInternal = (...args) => {
      // Model every other combatant completing their turn before the write transaction starts.
      orm.update(encounters).set({ currentCombatantId: actor, round: 2 }).where(eq(encounters.id, encounterId)).run();
      return originalApplyInternal.apply(service, args);
    };

    try {
      expect(() => service.apply(encounterId, { chainId: preview.chainId }, alice, 'player')).toThrow(/previous turn/i);
    } finally {
      internals.applyInternal = originalApplyInternal;
    }

    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
    expect(JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}').used?.action ?? 0).toBe(0);
    expect(JSON.parse(orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!.spellSlots)).toEqual({ '3': { max: 2, used: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rejected = orm
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.campaignId, campaignId), eq(auditLog.action, 'encounter.action.apply_rejected')))
      .all();
    expect(rejected.some((row) => JSON.parse(row.detail).reason === 'stale_preview_round' && JSON.parse(row.detail).chainId === preview.chainId)).toBe(true);
  });

  it('the DM resolves a monster action against a player via an inline spec', () => {
    const { orm, service, encounterId, drake, bob: bobCombat } = seed();
    const res = service.resolve(
      encounterId,
      ActionResolveRequest.parse({
        actorCombatantId: drake,
        actionName: 'Bite',
        spec: { mode: 'save', save: { ability: 'DEX', dc: { kind: 'fixed', dc: 21 } }, targets: { count: 1, allow: 'enemy' }, outcomes: { failure: { damage: [{ formula: '2d6', type: 'fire' }] } } },
        targetIds: [bobCombat],
        commit: true,
      }),
      dmUser,
      'dm',
    );
    expect(res.applied).toBe(true);
    const t = res.resolution.targets[0];
    // Bob has no fire resistance → normal fire damage.
    expect(t.damage[0].applied).toBe('normal');
    expect(orm.select().from(combatants).where(eq(combatants.id, bobCombat)).get()!.hpCurrent).toBe(30 - t.totalDamage);
  });

  it('dm-confirmed policy: a player resolve previews without applying; the DM applies it', () => {
    const { orm, service, encounterId, actor, drake } = seed({ requireDmTurnConfirmation: true });
    const preview = service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 2, targetIds: [drake], commit: true }), alice, 'player');
    expect(preview.policy).toBe('dm-confirmed');
    expect(preview.canApply).toBe(false);
    expect(preview.applied).toBe(false);
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60); // nothing applied
    // The DM commits the previewed resolution verbatim.
    orm
      .update(combatants)
      .set({ turnState: JSON.stringify({ concentration: 'Storm' }) })
      .where(eq(combatants.id, drake))
      .run();
    const { undoToken } = service.apply(encounterId, { chainId: preview.chainId }, dmUser, 'dm');
    const dmg = preview.resolution.targets[0].totalDamage;
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60 - dmg);
    expect(undoToken.targets[0].hpBefore).toBe(60);
    const persisted = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.turnState ?? '{}'),
    );
    expect(persisted.pendingConcentrationChecks).toEqual([
      expect.objectContaining({
        damage: dmg,
        dc: Math.max(10, Math.floor(dmg / 2)),
      }),
    ]);
  });

  it('self-damage plus new concentration restores only the exact prior queue on undo', () => {
    const { orm, service, encounterId, actor } = seed();
    orm
      .update(combatants)
      .set({
        turnState: JSON.stringify({
          concentration: 'Bless',
          pendingConcentrationChecks: [{ id: 'old-check', damage: 8, dc: 10 }],
        }),
      })
      .where(eq(combatants.id, actor))
      .run();

    const applied = service.resolve(
      encounterId,
      ActionResolveRequest.parse({
        actorCombatantId: actor,
        actionName: 'Hold Person',
        spec: {
          mode: 'save',
          save: { ability: 'WIS', dc: { kind: 'fixed', dc: 21 } },
          uses: { concentration: true },
          targets: { count: 1, allow: 'self' },
          outcomes: { failure: { damage: [{ flat: 1, type: 'untyped' }] } },
        },
        targetIds: [actor],
        commit: true,
      }),
      alice,
      'player',
    );

    const state = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}'),
    );
    expect(state.concentration).toBe('Hold Person');
    expect(state.pendingConcentrationChecks).toEqual([]);
    expect(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.hpCurrent).toBe(39);

    service.undo(encounterId, applied.undoToken!, alice, 'player');
    const restored = CombatantTurnState.parse(
      JSON.parse(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.turnState ?? '{}'),
    );
    expect(restored.concentration).toBe('Bless');
    expect(restored.pendingConcentrationChecks).toEqual([
      { id: 'old-check', damage: 8, dc: 10 },
    ]);
    expect(orm.select().from(combatants).where(eq(combatants.id, actor)).get()!.hpCurrent).toBe(40);
  });

  it('refuses an unsupported action shape rather than inventing numbers', () => {
    const { service, encounterId, actor } = seed();
    expect(() =>
      service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, spec: { mode: 'attack' }, targetIds: [] }), alice, 'player'),
    ).toThrow(/no resolvable|statblock/i);
  });

  // ---------------------------------------------------------------------------
  // Issue #1449 — undo() must not trust the client-echoed token. Only chainId is a lookup
  // key; the server-persisted snapshot (action_apply_chains) is the sole source of truth
  // for who gets touched and what their pre-apply values were.
  // ---------------------------------------------------------------------------

  it('#1449: an undo chain minted in a different encounter (same campaign) is rejected, and the victim in that other encounter is unchanged', () => {
    const { orm, service, campaignId, encounterId, actor, drake } = seed();
    // Alice applies a real, legitimate attack in HER OWN encounter — a genuine chainId.
    const applied = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: true }),
      alice,
      'player',
    );
    const realToken = applied.undoToken!;
    expect(realToken.chainId).toBeTruthy();

    // A second, unrelated encounter in the SAME campaign, with its own victim combatant.
    const ts = new Date().toISOString();
    const [otherEncounter] = orm
      .insert(encounters)
      .values({ campaignId, name: 'Other Fight', status: 'running', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [victim] = orm
      .insert(combatants)
      .values({ encounterId: otherEncounter.id, kind: 'monster', name: 'Innocent Bystander', initiative: 5, hpCurrent: 25, hpMax: 25, sortOrder: 0 })
      .returning()
      .all();

    // Forge a token: reuse the REAL chainId, but claim it belongs to the other encounter and
    // name the victim there as the target with maximally damaging hpBefore/deathState values.
    const forged = ActionUndoToken.parse({
      ...realToken,
      encounterId: otherEncounter.id,
      actorCombatantId: victim.id,
      targets: [
        { combatantId: victim.id, hpBefore: 0, hpTempBefore: 0, deathStateBefore: 'dead', deathSaveSuccessesBefore: 3, deathSaveFailuresBefore: 3, conditionsBefore: [], effectIdsAdded: [] },
      ],
    });

    expect(() => service.undo(otherEncounter.id, forged, alice, 'player')).toThrow(/different encounter/i);
    expect(orm.select().from(combatants).where(eq(combatants.id, victim.id)).get()!.hpCurrent).toBe(25);
    // The genuine chain must still be intact (not marked undone by the rejected attempt).
    const chainRow = orm.select().from(actionApplyChains).where(eq(actionApplyChains.id, realToken.chainId!)).get();
    expect(chainRow?.undoneAt).toBeFalsy();
  });

  it('#1449: an undo chain minted in a different campaign is rejected, and the victim character sheet is unchanged', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const applied = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: true }),
      alice,
      'player',
    );
    const realToken = applied.undoToken!;

    // An entirely separate campaign, with its own encounter and a victim CHARACTER.
    const ts = new Date().toISOString();
    const [otherCampaign] = orm
      .insert(campaigns)
      .values({ name: 'Other Campaign', ruleSystem: '', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [victimChar] = orm
      .insert(characters)
      .values({ campaignId: otherCampaign.id, ownerUserId: bob.id, name: 'Victim PC', level: 1, stats: '{}', ac: 10, hpCurrent: 12, hpMax: 12, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [otherEncounter] = orm
      .insert(encounters)
      .values({ campaignId: otherCampaign.id, name: 'Other Campaign Fight', status: 'running', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [victimCombatant] = orm
      .insert(combatants)
      .values({ encounterId: otherEncounter.id, kind: 'character', characterId: victimChar.id, name: 'Victim PC', initiative: 5, hpCurrent: 12, hpMax: 12, sortOrder: 0 })
      .returning()
      .all();

    const forged = ActionUndoToken.parse({
      ...realToken,
      encounterId: otherEncounter.id,
      actorCombatantId: victimCombatant.id,
      targets: [
        { combatantId: victimCombatant.id, hpBefore: 0, hpTempBefore: 0, deathStateBefore: 'dead', deathSaveSuccessesBefore: 3, deathSaveFailuresBefore: 3, conditionsBefore: [], effectIdsAdded: [] },
      ],
    });

    // The DM role is used here to isolate the assertion to chain/encounter scoping rather
    // than the actor-ownership gate (a non-DM would already be rejected on ownership too).
    expect(() => service.undo(otherEncounter.id, forged, dmUser, 'dm')).toThrow(/different encounter/i);
    expect(orm.select().from(combatants).where(eq(combatants.id, victimCombatant.id)).get()!.hpCurrent).toBe(12);
    expect(orm.select().from(characters).where(eq(characters.id, victimChar.id)).get()!.hpCurrent).toBe(12);
  });

  it('#1449: replaying a valid undo token a second time is rejected', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const applied = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: true }),
      alice,
      'player',
    );
    // Deliberately NOT gated on the (random) attack roll's hit/miss outcome: apply() mints
    // and persists an action_apply_chains row, and spends the actor's action-economy slot,
    // on a miss exactly as on a hit — a miss just deals zero damage. Gating this test on
    // "only meaningful on a landed hit" would make the replay-protection assertion below
    // silently never run on any test execution where the d20 came up low, which is itself
    // a tracked defect class (issue #1484): an assertion that can pass without ever having
    // exercised the behaviour it exists to verify.
    service.undo(encounterId, applied.undoToken!, alice, 'player');
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);

    expect(() => service.undo(encounterId, applied.undoToken!, alice, 'player')).toThrow(/already (been )?undone/i);
    // Still restored to the post-first-undo value — a second undo must not touch it again.
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
  });

  it('bumps combatant state when an action undo races a fight start', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const applied = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: true }),
      alice,
      'player',
    );
    orm.update(encounters)
      .set({ status: 'preparing', combatantStateVersion: 0 })
      .where(eq(encounters.id, encounterId))
      .run();
    const originalTransaction = orm.transaction.bind(orm);
    let startedBeforeUndoTransaction = false;
    const transactionSpy = jest.spyOn(orm, 'transaction').mockImplementation((callback) => {
      if (!startedBeforeUndoTransaction) {
        startedBeforeUndoTransaction = true;
        orm.update(encounters).set({ status: 'running' }).where(eq(encounters.id, encounterId)).run();
      }
      return originalTransaction(callback);
    });
    try {
      service.undo(encounterId, applied.undoToken!, alice, 'player');
    } finally {
      transactionSpy.mockRestore();
    }

    expect(startedBeforeUndoTransaction).toBe(true);
    expect(orm.select().from(encounters).where(eq(encounters.id, encounterId)).get()!.combatantStateVersion).toBe(1);
  });

  it('#1449: an undo token with an unknown chainId is rejected', () => {
    const { service, encounterId, actor } = seed();
    const bogus = ActionUndoToken.parse({
      encounterId,
      actorCombatantId: actor,
      actionName: 'Greatsword',
      chainId: 'chain-never-applied',
      targets: [],
      costSlot: 'action',
      costCount: 1,
    });
    expect(() => service.undo(encounterId, bogus, alice, 'player')).toThrow(/unknown chain|never applied/i);
  });

  it('#1449: undo still succeeds and restores the surviving target when the OTHER target was removed from the encounter after apply', () => {
    const { orm, service, encounterId, actor, drake, bob, aliceChar } = seed();
    // Fireball (actionIndex 2, DC 21 -> always fails -> full damage) hits both the drake and
    // Bob's PC — an ordinary multi-target AoE, and a real level-3 spell-slot spend.
    const applied = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 2, targetIds: [drake, bob], commit: true }),
      alice,
      'player',
    );
    expect(applied.applied).toBe(true);
    const drakeTarget = applied.resolution.targets.find((t) => t.combatantId === drake)!;
    const bobTarget = applied.resolution.targets.find((t) => t.combatantId === bob)!;
    expect(drakeTarget.totalDamage).toBeGreaterThan(0);
    expect(bobTarget.totalDamage).toBeGreaterThan(0);
    // Bob took damage (8d6 fire can exceed his 30 HP and clamp/drop him — the exact number
    // isn't the point here, only that undo restores him to his exact PRE-apply snapshot).
    expect(orm.select().from(combatants).where(eq(combatants.id, bob)).get()!.hpCurrent).toBeLessThan(30);

    // The DM ordinarily removes a dead/cleared monster from the encounter — the drake is
    // gone by the time anyone undoes the fireball. This must NOT block restoring Bob.
    orm.delete(combatants).where(eq(combatants.id, drake)).run();
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()).toBeUndefined();

    expect(() => service.undo(encounterId, applied.undoToken!, alice, 'player')).not.toThrow();

    // Bob (the surviving target) is fully restored.
    expect(orm.select().from(combatants).where(eq(combatants.id, bob)).get()!.hpCurrent).toBe(30);
    // The actor's spent level-3 spell slot is refunded — not left consumed forever.
    const aliceCharAfter = orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!;
    const slots = JSON.parse(aliceCharAfter.spellSlots ?? '{}');
    expect(slots['3'].used).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Issue #1451 — apply() must not trust a client-supplied resolution. `chainId` is a
  // LOOKUP KEY into the exact resolution `resolve()` computed and persisted server-side
  // (`action_pending_resolutions`); nothing else the caller supplies is ever read. Fireball
  // (actionIndex 2) at DC 21 vs the drake's +0 save is used throughout: the save ALWAYS
  // fails, so the drake ALWAYS takes damage (halved for its fire resistance, but never
  // zero) — a deterministic, non-RNG-dependent target for these security assertions.
  // ---------------------------------------------------------------------------

  it('#1451: a player cannot inflate totalDamage by editing the resolution — apply() only ever reads req.chainId', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionName: 'Fireball', actionIndex: 2, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    expect(preview.applied).toBe(false);
    const honestDamage = preview.resolution.targets[0].totalDamage;
    expect(honestDamage).toBeGreaterThan(0); // DC 21 always fails vs +0 -> always damages (resisted, never zero)

    // Forge the exact pre-#1451 exploit shape: the full resolution, edited to a one-shot
    // amount, with the REAL chainId tacked on as an attacker using today's request shape
    // would try. Cast through `unknown` to bypass the type system exactly as an untyped
    // HTTP/MCP body would arrive — `apply()`'s signature only destructures `req.chainId`.
    const forged = {
      chainId: preview.chainId,
      ...preview.resolution,
      targets: preview.resolution.targets.map((t) => ({ ...t, totalDamage: 999999 })),
    } as unknown as ActionApplyRequest;

    const { undoToken } = service.apply(encounterId, forged, alice, 'player');
    expect(undoToken.targets[0].hpBefore).toBe(60);
    const drakeRow = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!;
    // The HONEST server-derived damage landed — never the forged 999999.
    expect(drakeRow.hpCurrent).toBe(60 - honestDamage);
  });

  it('#1451: a player cannot inject a condition/effect never in the resolved spec — apply() never reads it from the caller', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionName: 'Fireball', actionIndex: 2, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    expect(preview.resolution.targets[0].effects).toEqual([]); // this fireball declares no effects at all

    const forged = {
      chainId: preview.chainId,
      ...preview.resolution,
      targets: preview.resolution.targets.map((t) => ({
        ...t,
        effects: [{ condition: 'stunned', rounds: null, saveEnds: false, ongoingDamage: 0 }],
      })),
    } as unknown as ActionApplyRequest;

    service.apply(encounterId, forged, alice, 'player');
    const drakeRow = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!;
    expect(JSON.parse(drakeRow.conditions ?? '[]')).toEqual([]); // the injected condition never landed
  });

  it('#1451: DM apply(chainId) commits a result byte-identical to the resolve() preview', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionName: 'Fireball', actionIndex: 2, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    expect(preview.applied).toBe(false);
    expect(preview.chainId).toBeTruthy();

    const { undoToken } = service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), dmUser, 'dm');

    // Every field the table read in the preview is exactly what got committed — nothing
    // re-derived or drifted between resolve and apply.
    expect(undoToken.actionName).toBe(preview.resolution.actionName);
    expect(undoToken.costSlot).toBe(preview.resolution.costSlot);
    expect(undoToken.costCount).toBe(preview.resolution.costCount);
    expect(undoToken.spellLevelSpent).toBe(preview.resolution.spellLevelSpent);
    expect(undoToken.targets[0].hpBefore).toBe(60);
    const drakeTarget = preview.resolution.targets[0];
    const drakeRow = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!;
    expect(drakeRow.hpCurrent).toBe(60 - drakeTarget.totalDamage);
  });

  it('#1451 cheap backstop: a persisted resolution altered to exceed what the dice spec could ever roll is rejected even via a legitimate chainId', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionName: 'Fireball', actionIndex: 2, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    const chainId = preview.chainId;

    // Simulate a compromised/altered persisted row — something no REST or MCP caller can
    // ever write, but the dice-spec backstop should still catch (issue #1451 acceptance:
    // "bound damage/heal magnitude ... as a cheap backstop even on the DM path").
    const row = orm.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.id, chainId)).get()!;
    const tampered = JSON.parse(row.resolutionJson);
    tampered.targets[0].totalDamage = 999999;
    orm.update(actionPendingResolutions).set({ resolutionJson: JSON.stringify(tampered) }).where(eq(actionPendingResolutions.id, chainId)).run();

    expect(() => service.apply(encounterId, ActionApplyRequest.parse({ chainId }), dmUser, 'dm')).toThrow(/dice spec bounds/i);
    // Rejected before the transaction opened — nothing was written.
    const drakeRow = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!;
    expect(drakeRow.hpCurrent).toBe(60);
  });

  it('#1451 review: duplicate action names retain their selected actionIndex for current-spec bounds validation', () => {
    const { orm, service, encounterId, actor, drake, aliceChar } = seed();
    const character = orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!;
    const actions = JSON.parse(character.actions ?? '[]');
    // Both entries have the same display name. The first's small bound would reject a perfectly
    // valid result from the second if apply() fell back to actionName instead of the saved index.
    actions.push(
      { ...fireball(21), name: 'Twin Fire', spec: { ...fireball(21).spec, outcomes: { failure: { damage: [{ formula: '1d4', type: 'fire' }] } } } },
      { ...fireball(21), name: 'Twin Fire', spec: { ...fireball(21).spec, outcomes: { failure: { damage: [{ formula: '20d6', type: 'fire' }] } } } },
    );
    orm.update(characters).set({ actions: JSON.stringify(actions) }).where(eq(characters.id, aliceChar.id)).run();

    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 4, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    expect(preview.resolution.targets[0].totalDamage).toBeGreaterThan(4);

    expect(() => service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player')).not.toThrow();
  });

  it('#1451 review: a selected action shifted to a different name before apply is rejected', () => {
    const { orm, service, encounterId, actor, drake, aliceChar } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    const character = orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!;
    const actions = JSON.parse(character.actions ?? '[]');
    // The old index 0 now identifies a different, permissive action. Applying the saved
    // Greatsword resolution against that replacement would validate the wrong current spec.
    actions.unshift({ ...fireball(21), name: 'Replacement Action' });
    orm.update(characters).set({ actions: JSON.stringify(actions) }).where(eq(characters.id, aliceChar.id)).run();

    expect(() => service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player')).toThrow(
      /changed or moved/i,
    );
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
  });

  it('#1451 review: a same-named replacement at the saved index is rejected before its permissive spec can validate', () => {
    const { orm, service, encounterId, actor, drake, aliceChar } = seed();
    const beforePreview = orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!;
    const beforeActions = JSON.parse(beforePreview.actions ?? '[]');
    // Character sheets allow duplicate names. Add a second, permissive "Greatsword" before
    // previewing the original, then swap their positions before apply.
    beforeActions.splice(1, 0, { ...fireball(21), name: 'Greatsword' });
    orm.update(characters).set({ actions: JSON.stringify(beforeActions) }).where(eq(characters.id, aliceChar.id)).run();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    const character = orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!;
    const actions = JSON.parse(character.actions ?? '[]');
    [actions[0], actions[1]] = [actions[1], actions[0]];
    orm.update(characters).set({ actions: JSON.stringify(actions) }).where(eq(characters.id, aliceChar.id)).run();

    expect(() => service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player')).toThrow(
      /changed or moved/i,
    );
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
  });

  // Issue #1901 review (chatgpt-codex-connector P1, PR #1951): the ActionUsePanel scenario —
  // it fetches a row's exact spec when the panel opens, then later POSTs actionIndex +
  // actionName to /resolve. If, in between, the item/action that occupied that index is
  // removed/unequipped and a DIFFERENT action that happens to share the same display name
  // shifts into the same index (equipped-item actions are appended after sheet actions in one
  // merged, reindexable list — see ActionResolverService.characterUsableActionRows), the
  // existing actionIndex+actionName guard in resolveSpec cannot catch it: the name still
  // matches. `expectedSpec` closes that gap by checking CONTENT, not just name.
  it('#1901 review (codex P1): resolve rejects a same-named replacement at the requested index when expectedSpec is supplied', () => {
    const { orm, service, encounterId, actor, drake, aliceChar } = seed();
    const character = orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!;
    const originalActions = JSON.parse(character.actions ?? '[]');
    // The exact spec the panel would have fetched and displayed for "Greatsword" at index 0.
    const expectedSpec = originalActions[0].spec;

    // Between the panel opening and the resolve request, a different action — coincidentally
    // sharing the same display name — takes over index 0 (e.g. a re-equip swapped in a
    // different item's action under a name that collides with the sheet action the player
    // actually selected).
    const actions = JSON.parse(character.actions ?? '[]');
    actions[0] = { ...fireball(21), name: 'Greatsword' };
    orm.update(characters).set({ actions: JSON.stringify(actions) }).where(eq(characters.id, aliceChar.id)).run();

    expect(() =>
      service.resolve(
        encounterId,
        ActionResolveRequest.parse({
          actorCombatantId: actor,
          actionIndex: 0,
          actionName: 'Greatsword',
          expectedSpec,
          targetIds: [drake],
          commit: false,
        }),
        alice,
        'player',
      ),
    ).toThrow(/changed or moved/i);
    // Rejected before any pending resolution was persisted or damage applied.
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
  });

  it('#1901 review (codex P1): resolve succeeds when expectedSpec matches the current row at that index', () => {
    const { orm, service, encounterId, actor, drake, aliceChar } = seed();
    const character = orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!;
    const expectedSpec = JSON.parse(character.actions ?? '[]')[0].spec;

    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({
        actorCombatantId: actor,
        actionIndex: 0,
        actionName: 'Greatsword',
        expectedSpec,
        targetIds: [drake],
        commit: false,
      }),
      alice,
      'player',
    );
    expect(preview.resolution.targets).toHaveLength(1);
  });

  // Same underlying flaw as the two tests above, on the equipped-item half of the merged
  // action list (issue #1901's own feature surface): unequipping the selected item and
  // equipping a DIFFERENT item whose authored action happens to share the same name into the
  // same merged index must not let a stale expectedSpec silently resolve the new content.
  it('#1901 review (codex P1): resolve rejects when an equipped-item action is swapped for a same-named one at the same merged index', () => {
    const { orm, service, campaignId, encounterId, actor, drake, aliceChar } = seed();
    const dagger = {
      name: 'Sidearm',
      kind: 'melee',
      toHit: '+5',
      damage: '1d4+2 piercing',
      notes: '',
      spec: {
        mode: 'attack',
        attack: { ability: 'DEX', proficient: true },
        cost: { slot: 'action', count: 1 },
        targets: { count: 1, allow: 'enemy' },
        outcomes: { hit: { damage: [{ formula: '1d4', flat: 2, type: 'piercing' }] } },
      },
    };
    const item = addInventoryItem(orm, { campaignId, characterId: aliceChar.id, equipped: true, equipSlot: 'off-hand', equippedAction: dagger });
    const expectedSpec = dagger.spec;
    const mergedIndex = 3; // after the 3 manual sheet actions from seed()

    // The item is unequipped and a DIFFERENT item, whose authored action happens to share the
    // same name "Sidearm", is equipped into the same slot — the merged list re-derives on
    // every read, so index 3 is now a different action's content under the old name.
    orm.update(inventoryItems).set({ equipped: false, equipSlot: null }).where(eq(inventoryItems.id, item.id)).run();
    addInventoryItem(orm, {
      campaignId,
      characterId: aliceChar.id,
      equipped: true,
      equipSlot: 'off-hand',
      equippedAction: { ...dagger, spec: { ...dagger.spec, outcomes: { hit: { damage: [{ formula: '20d6', type: 'piercing' }] } } } },
    });

    expect(() =>
      service.resolve(
        encounterId,
        ActionResolveRequest.parse({
          actorCombatantId: actor,
          actionIndex: mergedIndex,
          actionName: 'Sidearm',
          expectedSpec,
          targetIds: [drake],
          commit: false,
        }),
        alice,
        'player',
      ),
    ).toThrow(/changed or moved/i);
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
  });

  it('#1451 review: a fingerprint-less legacy pending row is never applied', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    orm
      .update(actionPendingResolutions)
      .set({ actionFingerprint: null })
      .where(eq(actionPendingResolutions.id, preview.chainId))
      .run();

    expect(() => service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player')).toThrow(
      /created before action identity verification/i,
    );
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
  });

  it('#1451: an unknown chainId is rejected, and a chainId from a different encounter is rejected', () => {
    const { orm, service, campaignId, encounterId, actor, drake } = seed();
    expect(() => service.apply(encounterId, ActionApplyRequest.parse({ chainId: 'chain-never-resolved' }), alice, 'player')).toThrow(
      /unknown|never (computed|applied)/i,
    );

    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    const ts = new Date().toISOString();
    const [otherEncounter] = orm
      .insert(encounters)
      .values({ campaignId, name: 'Other Fight', status: 'running', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    expect(() => service.apply(otherEncounter.id, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player')).toThrow(
      /different encounter/i,
    );
    // The genuine chain is untouched — still applicable from its real encounter.
    const applied = service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player');
    expect(applied.undoToken).toBeTruthy();
  });

  it('#1474: applying the same chainId a second time is idempotent — returns stored undoToken and does not double-apply damage', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    const res1 = service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player');
    const hpAfterFirst = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent;

    // Retry with the exact same chainId (e.g. network timeout / double-click retry)
    const res2 = service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player');
    const hpAfterSecond = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent;

    expect(hpAfterSecond).toBe(hpAfterFirst);
    expect(res2.undoToken.chainId).toBe(res1.undoToken.chainId);
    expect(res2.undoToken.targets).toEqual(res1.undoToken.targets);
  });

  it('#1474: retrying an already-undone chain is rejected', () => {
    const { service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    const res = service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player');
    service.undo(encounterId, res.undoToken, alice, 'player');
    expect(() => service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player')).toThrow(
      /unknown or has already been applied/i,
    );
  });

  it('#1474: re-applying a chainId after turn advancement returns stored undoToken without 403', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    const res1 = service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player');

    // Advance the encounter turn so the actor is no longer active
    orm.update(encounters).set({ currentCombatantId: drake, turnVersion: 2 }).where(eq(encounters.id, encounterId)).run();

    // A network retry after turn advance should still succeed idempotently without throwing 403
    const res2 = service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player');
    expect(res2.undoToken.chainId).toBe(res1.undoToken.chainId);
  });

  it('#1474: replayed apply enforces original applier user identity', () => {
    const { service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player');

    // Another player attempting to replay Alice's chainId is rejected
    expect(() => service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), bob, 'player')).toThrow(
      /original applier or a DM/i,
    );

    // The DM is allowed to replay it
    const resDm = service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), dmUser, 'dm');
    expect(resDm.undoToken.chainId).toBe(preview.chainId);
  });

  it('#1474: replaying an already-completed chain returns stored undoToken even when safety hold is active', () => {
    const { service, campaignId, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    const res1 = service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player');

    // Activate safety hold on the campaign
    (service as any).safety = {
      assertNotHeld: (cId: number) => {
        if (cId === campaignId) throw new Error('Safety hold active');
      },
    };

    // Replay of the completed chain should bypass safety hold assertion and return the stored undo token
    const res2 = service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player');
    expect(res2.undoToken.chainId).toBe(res1.undoToken.chainId);
  });

  // ---------------------------------------------------------------------------
  // Issue #1451 review round — Devin/Codex/Kilo findings on the original PR.
  // ---------------------------------------------------------------------------

  it('#1451 review: a consumed resolution is DELETED, not merely flagged — action_pending_resolutions does not grow unbounded', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    expect(orm.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.id, preview.chainId)).get()).toBeTruthy();

    service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player');

    expect(orm.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.id, preview.chainId)).get()).toBeUndefined();
  });

  it('#1451 review: an abandoned (never-applied) preview is swept out by TTL on the next resolve for its encounter', () => {
    const { orm, service, campaignId, encounterId, actor, drake } = seed();
    // Simulate a preview from 31 minutes ago that the player never applied — inserted directly
    // so the test does not depend on real wall-clock time.
    const staleId = 'chain-stale-review-test';
    orm
      .insert(actionPendingResolutions)
      .values({
        id: staleId,
        encounterId,
        campaignId,
        actorCombatantId: actor,
        actionName: 'Greatsword',
        resolutionJson: '{}',
        createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      })
      .run();
    expect(orm.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.id, staleId)).get()).toBeTruthy();

    // ANY resolve on this encounter sweeps its own stale rows — the player need not touch the
    // abandoned preview at all for it to be reclaimed.
    service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }), alice, 'player');

    expect(orm.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.id, staleId)).get()).toBeUndefined();
  });

  it('#1451 review: an encounter that accumulates too many pending resolutions has the oldest evicted (per-encounter cap)', () => {
    const { orm, service, campaignId, encounterId, actor, drake } = seed();
    const now = Date.now();
    for (let i = 0; i < 205; i++) {
      orm
        .insert(actionPendingResolutions)
        .values({
          id: `chain-cap-review-test-${i}`,
          encounterId,
          campaignId,
          actorCombatantId: actor,
          actionName: 'Greatsword',
          resolutionJson: '{}',
          // Ascending: index 0 is the OLDEST row, index 204 the newest of the synthetic batch —
          // all well within the TTL, so only the per-encounter CAP can evict any of these.
          createdAt: new Date(now - (205 - i) * 1000).toISOString(),
        })
        .run();
    }
    expect(orm.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.encounterId, encounterId)).all()).toHaveLength(205);

    service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }), alice, 'player');

    const after = orm.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.encounterId, encounterId)).all();
    expect(after.length).toBeLessThanOrEqual(200);
    // The globally oldest synthetic row is gone; a recent one from the same batch survives.
    expect(after.some((r) => r.id === 'chain-cap-review-test-0')).toBe(false);
    expect(after.some((r) => r.id === 'chain-cap-review-test-204')).toBe(true);
  });

  it('#1451 review (Codex): an action narrowed to FEWER targets between resolve and apply cannot still apply its old wider target set', () => {
    const { orm, service, encounterId, actor, drake, bob, aliceChar } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 2, targetIds: [drake, bob], commit: false }),
      alice,
      'player',
    );
    expect(preview.resolution.targets).toHaveLength(2);

    // The sheet is edited between preview and apply: Fireball narrows from a 6-target AoE to a
    // single-enemy hit. Validating against a resolve-time snapshot (the pre-review bug) would
    // still let this stale, wider chain through; the CURRENT spec must not. The fixture carries
    // two sheet entries both named "Fireball" (DC 1 and DC 21), so narrow BOTH rather than
    // accidentally testing an unrelated duplicate-action selection detail.
    const beforeChar = orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!;
    const actions = JSON.parse(beforeChar.actions ?? '[]');
    for (const a of actions) if (a.name === 'Fireball') a.spec.targets = { count: 1, allow: 'enemy' };
    orm.update(characters).set({ actions: JSON.stringify(actions) }).where(eq(characters.id, aliceChar.id)).run();

    expect(() => service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player')).toThrow(
      /targets at most/i,
    );
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
    expect(orm.select().from(combatants).where(eq(combatants.id, bob)).get()!.hpCurrent).toBe(30);
  });

  it('#1451 review (Codex): an action narrowed to SELF-only between resolve and apply cannot still hit its old enemy target', () => {
    const { orm, service, encounterId, actor, drake, aliceChar } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    expect(preview.resolution.targets).toHaveLength(1);

    const beforeChar = orm.select().from(characters).where(eq(characters.id, aliceChar.id)).get()!;
    const actions = JSON.parse(beforeChar.actions ?? '[]');
    actions[0].spec.targets = { count: 1, allow: 'self' };
    orm.update(characters).set({ actions: JSON.stringify(actions) }).where(eq(characters.id, aliceChar.id)).run();

    expect(() => service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player')).toThrow(
      /may only target/i,
    );
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
  });

  it('#1474: two "simultaneous" applies of the same chainId — both fulfill idempotently and damage lands exactly once', async () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionName: 'Fireball', actionIndex: 2, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    const honestDamage = preview.resolution.targets[0].totalDamage;
    expect(honestDamage).toBeGreaterThan(0); // DC 21 always fails vs +0 -> always damages (resisted, never zero)

    const attempt = () =>
      Promise.resolve().then(() => service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), alice, 'player'));
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);

    const drakeRow = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!;
    expect(drakeRow.hpCurrent).toBe(60 - honestDamage); // damage landed exactly once, never twice
  });

  it('#1451 review (Codex P1, second pass): ActionApplyRequest carries chainId only — a forged actionName/actorCombatantId is stripped at parse, not merely ignored at apply', () => {
    // The confirmation-spoofing vector this closes lived in the AI-driver confirmation queue,
    // not here (see apps/server/test/ai-dm-tool-confirmation-lifecycle.e2e-spec.ts for that
    // regression) — but the schema itself must not even shape-accept these fields, so a future
    // caller cannot quietly reintroduce them as a "just read it for display" shortcut.
    const parsed = ActionApplyRequest.parse({
      chainId: 'chain-whatever',
      actionName: 'Nonexistent Spell',
      actorCombatantId: 999999,
    });
    expect(parsed).toEqual({ chainId: 'chain-whatever' });
  });

  // ---------------------------------------------------------------------------
  // Issue #1451 review, second pass (Devin) — the growth-bound fix above must not silently
  // expire a legitimate declaration awaiting DM confirmation under dm-confirmed/player-declares
  // policy. Lifetime now depends on state, not just age.
  // ---------------------------------------------------------------------------

  it('#1451 review (Devin, corrected): a declaration awaiting DM confirmation is NOT evicted by the TTL, no matter how old', () => {
    const { orm, service, encounterId, actor, drake } = seed({ requireDmTurnConfirmation: true });
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    expect(preview.canApply).toBe(false); // a genuine declaration, not an ordinary preview

    // Backdate it WAY past the ordinary-preview TTL — a real DM confirmation queue can easily
    // sit unattended longer than 30 minutes.
    orm
      .update(actionPendingResolutions)
      .set({ createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() }) // 6 hours old
      .where(eq(actionPendingResolutions.id, preview.chainId))
      .run();

    // Any subsequent resolve on this encounter runs the sweep — a declaration must survive it.
    service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }), alice, 'player');

    const row = orm.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.id, preview.chainId)).get();
    expect(row).toBeTruthy();

    // And the DM can still apply it.
    const { undoToken } = service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), dmUser, 'dm');
    expect(undoToken).toBeTruthy();
  });

  it('#1451 review (Devin, corrected): an ordinary abandoned preview (automatic policy) is still TTL-swept — only declarations are exempt', () => {
    const { orm, service, encounterId, actor, drake } = seed(); // default policy: automatic
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    expect(preview.canApply).toBe(true); // an ordinary, disposable preview — NOT a declaration

    orm
      .update(actionPendingResolutions)
      .set({ createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() })
      .where(eq(actionPendingResolutions.id, preview.chainId))
      .run();

    service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }), alice, 'player');

    expect(orm.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.id, preview.chainId)).get()).toBeUndefined();
  });

  it('#1451 review (collaborative AI): an automatic-policy chain queued for delayed human approval is retained past the preview TTL', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );
    expect(preview.canApply).toBe(true); // automatic policy: it starts as a disposable preview
    expect(orm.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.id, preview.chainId)).get()?.awaitingConfirmation).toBe(false);

    // Collaborative handoff queues apply_action even though its AI seat can apply automatically.
    // The queue transition, not the original caller's policy, must pin this exact server-owned
    // chain until the human DM has a chance to approve it.
    expect(service.retainPendingChainForConfirmation(encounterId, preview.chainId, dmUser, 'dm')).toMatchObject({
      actionName: 'Greatsword',
      actorCombatantId: actor,
    });
    orm
      .update(actionPendingResolutions)
      .set({ createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() })
      .where(eq(actionPendingResolutions.id, preview.chainId))
      .run();

    // A later resolution performs the ordinary sweep. The delayed confirmation's chain survives
    // and the DM can still apply exactly the original server-computed result.
    service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }), alice, 'player');
    expect(orm.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.id, preview.chainId)).get()).toBeTruthy();
    expect(service.apply(encounterId, ActionApplyRequest.parse({ chainId: preview.chainId }), dmUser, 'dm').undoToken).toBeTruthy();
  });

  it('#1451 review (Devin, corrected): the per-encounter cap still bounds declarations, but eviction is audited — never silent', async () => {
    const { orm, service, campaignId, encounterId, actor, drake } = seed({ requireDmTurnConfirmation: true });
    const tokenAlice: RequestUser = {
      ...alice,
      tokenContext: { tokenId: 1, name: 'alice-action-token', scope: 'player', writeScope: 'direct', campaignId, adminEnabled: false },
    };
    const now = Date.now();
    for (let i = 0; i < 205; i++) {
      orm
        .insert(actionPendingResolutions)
        .values({
          id: `chain-decl-cap-test-${i}`,
          encounterId,
          campaignId,
          actorCombatantId: actor,
          actionName: 'Greatsword',
          awaitingConfirmation: true,
          resolutionJson: '{}',
          createdAt: new Date(now - (205 - i) * 1000).toISOString(),
        })
        .run();
    }

    service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }), tokenAlice, 'player');

    const after = orm
      .select()
      .from(actionPendingResolutions)
      .where(and(eq(actionPendingResolutions.encounterId, encounterId), eq(actionPendingResolutions.awaitingConfirmation, true)))
      .all();
    expect(after.length).toBeLessThanOrEqual(200);
    expect(after.some((r) => r.id === 'chain-decl-cap-test-0')).toBe(false); // oldest, evicted

    // The eviction audit write is fire-and-forget (matches every other audit call in this
    // service) — flush pending microtasks before reading it back.
    await new Promise((resolve) => setImmediate(resolve));

    // Never silent (issue #1451 review): the eviction is audited.
    const evicted = orm
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.campaignId, campaignId), eq(auditLog.action, 'encounter.action.declaration_evicted')))
      .all();
    expect(evicted.length).toBeGreaterThan(0);
    expect(evicted[0].actor).toBe('token:alice-action-token');
    expect(String(evicted[0].detail)).toContain('chain-decl-cap-test-0');
    expect(String(evicted[0].detail)).toContain('never applied');
  });

  it('#1451 review (Devin): a full declaration partition is preserved when an ordinary preview arrives', () => {
    const { orm, service, campaignId, encounterId, actor, drake } = seed();
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      orm
        .insert(actionPendingResolutions)
        .values({
          id: `chain-full-declaration-${i}`,
          encounterId,
          campaignId,
          actorCombatantId: actor,
          actionName: 'Greatsword',
          awaitingConfirmation: true,
          resolutionJson: '{}',
          createdAt: new Date(now - (200 - i) * 1000).toISOString(),
        })
        .run();
    }

    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );

    const declarations = orm
      .select()
      .from(actionPendingResolutions)
      .where(and(eq(actionPendingResolutions.encounterId, encounterId), eq(actionPendingResolutions.awaitingConfirmation, true)))
      .all();
    expect(declarations).toHaveLength(200);
    expect(declarations.map((row) => row.id)).toEqual(expect.arrayContaining(Array.from({ length: 200 }, (_, i) => `chain-full-declaration-${i}`)));
    expect(orm.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.id, preview.chainId)).get()?.awaitingConfirmation).toBe(false);
  });

  it('#1451 review (Devin): an incoming declaration reserves one slot and remains capped at 200', () => {
    const { orm, service, campaignId, encounterId, actor, drake } = seed({ requireDmTurnConfirmation: true });
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      orm
        .insert(actionPendingResolutions)
        .values({
          id: `chain-declaration-reserve-${i}`,
          encounterId,
          campaignId,
          actorCombatantId: actor,
          actionName: 'Greatsword',
          awaitingConfirmation: true,
          resolutionJson: '{}',
          createdAt: new Date(now - (200 - i) * 1000).toISOString(),
        })
        .run();
    }

    const declaration = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );

    const declarations = orm
      .select()
      .from(actionPendingResolutions)
      .where(and(eq(actionPendingResolutions.encounterId, encounterId), eq(actionPendingResolutions.awaitingConfirmation, true)))
      .all();
    expect(declarations).toHaveLength(200);
    expect(declarations.some((row) => row.id === 'chain-declaration-reserve-0')).toBe(false);
    expect(declarations.some((row) => row.id === declaration.chainId)).toBe(true);
  });

  it('#1451 review (Codex): promoting a preview for collaborative confirmation also reserves and audits the declaration cap', async () => {
    const { orm, service, campaignId, encounterId, actor, drake } = seed();
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      orm
        .insert(actionPendingResolutions)
        .values({
          id: `chain-promotion-cap-${i}`,
          encounterId,
          campaignId,
          actorCombatantId: actor,
          actionName: 'Greatsword',
          awaitingConfirmation: true,
          resolutionJson: '{}',
          createdAt: new Date(now - (200 - i) * 1000).toISOString(),
        })
        .run();
    }
    const preview = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: false }),
      alice,
      'player',
    );

    const aiSeat: RequestUser = {
      id: `ai-dm-seat:${campaignId}`,
      name: 'AI Dungeon Master',
      serverRole: 'user',
      devRole: 'dm',
      tokenContext: { tokenId: 0, name: `ai-dm-seat:${campaignId}`, scope: 'dm', writeScope: 'direct', campaignId, adminEnabled: false },
    };
    expect(service.retainPendingChainForConfirmation(encounterId, preview.chainId, aiSeat, 'dm')?.promoted).toBe(true);
    const declarations = orm
      .select()
      .from(actionPendingResolutions)
      .where(and(eq(actionPendingResolutions.encounterId, encounterId), eq(actionPendingResolutions.awaitingConfirmation, true)))
      .all();
    expect(declarations).toHaveLength(200);
    expect(declarations.some((row) => row.id === 'chain-promotion-cap-0')).toBe(false);
    expect(declarations.some((row) => row.id === preview.chainId)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    const evicted = orm
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.campaignId, campaignId), eq(auditLog.action, 'encounter.action.declaration_evicted')))
      .all();
    expect(evicted.some((entry) => String(entry.detail).includes('chain-promotion-cap-0'))).toBe(true);
    expect(evicted.some((entry) => entry.actor === `token:ai-dm-seat:${campaignId}`)).toBe(true);
  });

  it('#1452: re-casting a concentration spell refreshes the condition on target rather than leaving it empty', () => {
    const { orm, service, encounterId, actor, drake, aliceChar } = seed();
    const holdPersonSpec = {
      name: 'Hold Person',
      kind: 'spell',
      toHit: '',
      damage: '1d4 psychic',
      notes: 'Paralyzes a humanoid target.',
      spec: ActionSpec.parse({
        mode: 'save',
        save: { ability: 'WIS', dc: { kind: 'fixed', dc: 30 } },
        cost: { slot: 'action', count: 1 },
        uses: { concentration: true, spellLevel: 2 },
        targets: { count: 1, allow: 'enemy' },
        outcomes: {
          failure: {
            damage: [{ formula: '1d4', type: 'psychic' }],
            effects: [{ condition: 'paralyzed', rounds: 10, saveEnds: false, ongoingDamage: 0 }],
          },
        },
      }),
    };
    orm.update(characters).set({ actions: JSON.stringify([holdPersonSpec]), spellSlots: JSON.stringify({ 2: { max: 3, used: 0 } }) }).where(eq(characters.id, aliceChar.id)).run();

    const res1 = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionName: 'Hold Person', targetIds: [drake], commit: true }),
      alice,
      'player',
    );
    expect(res1.applied).toBe(true);
    let drakeRow = orm.select().from(combatants).where(eq(combatants.id, drake)).get();
    expect(drakeRow?.conditions).toContain('paralyzed');

    orm.update(combatants).set({ turnState: JSON.stringify({ used: {} }) }).where(eq(combatants.id, actor)).run();

    const res2 = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionName: 'Hold Person', targetIds: [drake], commit: true }),
      alice,
      'player',
    );
    expect(res2.applied).toBe(true);
    drakeRow = orm.select().from(combatants).where(eq(combatants.id, drake)).get();
    expect(drakeRow?.conditions).toContain('paralyzed');
  });

  it('#1452: undoing an attack removes its pending check without restoring resolved checks', () => {
    const { orm, service, encounterId, actor, drake } = seed();
    const preCheck = { id: 'pre-existing-1', dc: 15, damage: 20 };
    orm.update(combatants).set({ turnState: JSON.stringify({ pendingConcentrationChecks: [preCheck] }) }).where(eq(combatants.id, drake)).run();

    const res = service.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: actor, actionIndex: 0, targetIds: [drake], commit: true }),
      alice,
      'player',
    );
    expect(res.applied).toBe(true);

    let drakeRow = orm.select().from(combatants).where(eq(combatants.id, drake)).get();
    const currentTs = CombatantTurnState.parse(JSON.parse(drakeRow?.turnState ?? '{}'));
    currentTs.pendingConcentrationChecks = currentTs.pendingConcentrationChecks.filter((c) => c.id !== 'pre-existing-1');
    orm.update(combatants).set({ turnState: JSON.stringify(currentTs) }).where(eq(combatants.id, drake)).run();

    service.undo(encounterId, res.undoToken!, alice, 'player');
    drakeRow = orm.select().from(combatants).where(eq(combatants.id, drake)).get();
    const undoneTs = CombatantTurnState.parse(JSON.parse(drakeRow?.turnState ?? '{}'));
    expect(undoneTs.pendingConcentrationChecks.some((c) => c.id === 'pre-existing-1')).toBe(false);
  });
});
