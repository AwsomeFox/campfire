import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { ActionResolveRequest } from '@campfire/schema';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, characters, combatants, encounterEvents, encounters, ruleEntries, rulePacks } from '../../src/db/schema';
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

  function seed(opts: { dmControlsTurns?: boolean; requireDmTurnConfirmation?: boolean } = {}) {
    const { orm, service } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({
        name: 'Resolver Test',
        ruleSystem: '',
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
      // A combat-log damage event was written.
      const events = orm.select().from(encounterEvents).where(eq(encounterEvents.encounterId, encounterId)).all();
      expect(events.some((e) => e.type === 'damage')).toBe(true);
    } else {
      expect(hpAfter).toBe(60); // miss
    }
    // Undo restores HP exactly.
    service.undo(encounterId, res.undoToken!, alice, 'player');
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60);
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
    const { undoToken } = service.apply(encounterId, preview.resolution, dmUser, 'dm');
    const dmg = preview.resolution.targets[0].totalDamage;
    expect(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.hpCurrent).toBe(60 - dmg);
    expect(undoToken.targets[0].hpBefore).toBe(60);
  });

  it('refuses an unsupported action shape rather than inventing numbers', () => {
    const { service, encounterId, actor } = seed();
    expect(() =>
      service.resolve(encounterId, ActionResolveRequest.parse({ actorCombatantId: actor, spec: { mode: 'attack' }, targetIds: [] }), alice, 'player'),
    ).toThrow(/no resolvable|statblock/i);
  });
});
