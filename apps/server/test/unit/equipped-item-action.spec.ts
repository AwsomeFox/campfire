import { CharacterAction, deriveEquippedItemAction, DND5E_DAMAGE_TYPES, isResolvableSpec, rebuildEditedActionSpec, type ItemActionAdapter } from '@campfire/schema';

/**
 * Issue #2097 — deriving an equipped item's attack from its compendium data.
 *
 * The interesting cases are all about restraint: what the derivation refuses to do. A wrong
 * to-hit is invisible at the table until someone notices a fight has been running on bad
 * numbers, so every input it cannot read confidently has to produce a row that says so
 * instead of a plausible one.
 */
const dnd5e: ItemActionAdapter = {
  id: 'dnd5e',
  abilityModifier: (score) => Math.floor((score - 10) / 2),
  damageTypes: DND5E_DAMAGE_TYPES,
};
const pf2e: ItemActionAdapter = { id: 'pf2e', abilityModifier: (score) => Math.floor((score - 10) / 2) };

/** An Open5e weapon row as the #2096 importer stores it. */
function open5eWeapon(over: Record<string, unknown> = {}) {
  return {
    itemKind: 'weapon',
    damageDice: '1d8',
    damageType: 'Slashing',
    range: 0,
    longRange: 0,
    isSimple: false,
    properties: [],
    ...over,
  };
}

const fighter = { stats: { STR: 16, DEX: 12 }, level: 5 }; // STR +3, DEX +1, proficiency +3
const rogue = { stats: { STR: 8, DEX: 18 }, level: 1 }; // STR -1, DEX +4, proficiency +2

describe('deriveEquippedItemAction (#2097)', () => {
  describe('5e attack math', () => {
    it('derives to-hit and damage from the wielder, not just the weapon', () => {
      const action = deriveEquippedItemAction({
        itemName: 'Longsword',
        data: open5eWeapon(),
        character: fighter,
        adapter: dnd5e,
      });
      expect(action).not.toBeNull();
      expect(action!.name).toBe('Longsword');
      // STR +3 + proficiency +3
      expect(action!.toHit).toBe('+6');
      expect(action!.damage).toContain('1d8+3');
      expect(action!.damage).toContain('slashing');
      expect(isResolvableSpec(action!.spec)).toBe(true);
    });

    it('uses DEX for a ranged weapon', () => {
      const action = deriveEquippedItemAction({
        itemName: 'Longbow',
        data: open5eWeapon({
          damageDice: '1d8',
          damageType: 'Piercing',
          range: 150,
          longRange: 600,
          properties: [{ name: 'Ammunition', type: null, detail: 'Range 150/600' }, { name: 'Two-Handed', type: null, detail: null }],
        }),
        character: rogue,
        adapter: dnd5e,
      });
      // DEX +4 + proficiency +2, NOT STR -1
      expect(action!.toHit).toBe('+6');
      expect(action!.damage).toContain('1d8+4');
    });

    it('takes the better of STR and DEX for a finesse weapon', () => {
      const rapier = open5eWeapon({ damageType: 'Piercing', properties: [{ name: 'Finesse', type: null, detail: null }] });
      // A rogue is better with DEX...
      expect(deriveEquippedItemAction({ itemName: 'Rapier', data: rapier, character: rogue, adapter: dnd5e })!.toHit).toBe('+6');
      // ...a STR fighter is not, and finesse must never make an attack WORSE than the plain one.
      expect(deriveEquippedItemAction({ itemName: 'Rapier', data: rapier, character: fighter, adapter: dnd5e })!.toHit).toBe('+6');
      expect(
        deriveEquippedItemAction({ itemName: 'Rapier', data: rapier, character: fighter, adapter: dnd5e })!.damage,
      ).toContain('1d8+3');
    });

    it('treats a thrown melee weapon as melee even though it reports a range', () => {
      // The Dagger's 20/60 is its throwing range; it is still a melee weapon. Reading "has a
      // range" as "is ranged" would silently switch the ability used for the attack.
      const action = deriveEquippedItemAction({
        itemName: 'Dagger',
        data: open5eWeapon({
          damageDice: '1d4',
          damageType: 'Piercing',
          range: 20,
          longRange: 60,
          properties: [{ name: 'Thrown', type: null, detail: 'Range 20/60' }],
        }),
        character: fighter,
        adapter: dnd5e,
      });
      // STR +3, not DEX +1.
      expect(action!.damage).toContain('1d4+3');
    });

    it('flags a thrown finesse weapon whose melee/ranged reading changed the ability', () => {
      // Open5e publishes no melee/ranged discriminator: the Dagger (simple MELEE) and the Dart
      // (simple RANGED) are byte-identical in its payload. Finesse takes the better of STR and
      // DEX, so the readings only diverge for a STR-dominant wielder — correct for a Dagger,
      // too high for a Dart. The action says so rather than guessing either way.
      const thrownFinesse = open5eWeapon({
        damageDice: '1d4',
        damageType: 'Piercing',
        range: 20,
        longRange: 60,
        properties: [{ name: 'Finesse', type: null, detail: null }, { name: 'Thrown', type: null, detail: 'Range 20/60' }],
      });
      const strWielder = deriveEquippedItemAction({ itemName: 'Dart', data: thrownFinesse, character: fighter, adapter: dnd5e })!;
      expect(strWielder.notes).toContain('melee or a thrown ranged weapon');

      // A DEX-dominant wielder gets DEX under BOTH readings, so there is nothing to warn about.
      const dexWielder = deriveEquippedItemAction({ itemName: 'Dart', data: thrownFinesse, character: rogue, adapter: dnd5e })!;
      expect(dexWielder.notes).not.toContain('melee or a thrown ranged weapon');

      // An unambiguous weapon stays quiet: a bow is Ammunition-marked, a longsword neither
      // thrown nor finesse.
      for (const [label, data] of [
        ['Longbow', open5eWeapon({ damageType: 'Piercing', properties: [{ name: 'Ammunition', type: null, detail: null }] })],
        ['Longsword', open5eWeapon()],
      ] as const) {
        const action = deriveEquippedItemAction({ itemName: label, data, character: fighter, adapter: dnd5e })!;
        expect(action.notes).not.toContain('melee or a thrown ranged weapon');
      }
    });

    it('states the proficiency assumption in the action itself', () => {
      // Campfire's Character carries no weapon-proficiency data, so proficiency is an assumed
      // default. It has to be visible to whoever reads the row, not buried in a commit message.
      const action = deriveEquippedItemAction({ itemName: 'Longsword', data: open5eWeapon(), character: fighter, adapter: dnd5e });
      expect(action!.notes.toLowerCase()).toContain('assumes proficiency');
      expect(action!.notes).toContain('STR +3');
      expect(action!.notes).toContain('proficiency +3');
    });

    it('omits the modifier from the damage expression when it is zero', () => {
      const action = deriveEquippedItemAction({
        itemName: 'Club',
        data: open5eWeapon({ damageDice: '1d4', damageType: 'Bludgeoning' }),
        character: { stats: { STR: 10, DEX: 10 }, level: 1 },
        adapter: dnd5e,
      });
      expect(action!.damage).toContain('1d4');
      expect(action!.damage).not.toContain('1d4+0');
    });

    it("folds a weapon's own flat modifier into the ability modifier, not after it", () => {
      // Review (chatgpt-codex-connector P2): a homebrew `1d8+1` plus a +3 wielder must be
      // `1d8+4`, not `1d8+1+3`. `damagePartsFrom` only splits ONE modifier, so the compound
      // string would land whole in `formula` with `flat: 0` — and 5e's double-dice crit rule
      // would then roll both flats twice instead of adding them once.
      const action = deriveEquippedItemAction({
        itemName: 'Homebrew Blade +1',
        data: open5eWeapon({ damageDice: '1d8+1', damageType: 'Slashing' }),
        character: fighter,
        adapter: dnd5e,
      })!;
      expect(action.spec?.outcomes?.hit?.damage?.[0]).toMatchObject({ formula: '1d8', flat: 4, type: 'slashing' });
      expect(action.damage).toContain('1d8+4');
      expect(action.damage).not.toContain('1d8+1+3');
    });

    it("cancels a weapon's penalty against the wielder's bonus", () => {
      const action = deriveEquippedItemAction({
        itemName: 'Cursed Blade',
        data: open5eWeapon({ damageDice: '1d8-3', damageType: 'Slashing' }),
        character: fighter, // STR +3
        adapter: dnd5e,
      })!;
      // Net zero — the modifier drops out of the expression entirely.
      expect(action.spec?.outcomes?.hit?.damage?.[0]).toMatchObject({ formula: '1d8', flat: 0 });
    });

    it('keeps a negative modifier out of the dice formula so a crit cannot double it', () => {
      const action = deriveEquippedItemAction({
        itemName: 'Greatclub',
        data: open5eWeapon({ damageDice: '1d8', damageType: 'Bludgeoning' }),
        character: { stats: { STR: 8, DEX: 8 }, level: 1 },
        adapter: dnd5e,
      });
      const part = action!.spec?.outcomes?.hit?.damage?.[0];
      expect(part?.formula).toBe('1d8');
      expect(part?.flat).toBe(-1);
    });
  });

  describe('refusing to invent numbers', () => {
    it('produces a text-only action for dice the ROLLER would reject, not just malformed ones', () => {
      // Review (chatgpt-codex-connector P2): `21d6` and `1d3` both look like dice and both
      // throw in apps/server/src/common/dice.ts — over the 20-die cap, and a non-polyhedral
      // face. A spec built on either degrades to an error mid-combat rather than to the
      // text-only action this module promises, which is strictly worse than not deriving.
      for (const dice of ['21d6', '1d3', '1d7', '0d6', '2d6+1000']) {
        const action = deriveEquippedItemAction({
          itemName: 'Homebrew Blade',
          data: open5eWeapon({ damageDice: dice, damageType: 'Slashing' }),
          character: fighter,
          adapter: dnd5e,
        });
        expect(isResolvableSpec(action!.spec)).toBe(false);
        expect(action!.toHit).toBe('');
      }
      // The bound is a real bound, not a blanket refusal: 20d6 is fine.
      const ok = deriveEquippedItemAction({
        itemName: 'Big Blade',
        data: open5eWeapon({ damageDice: '20d6', damageType: 'Slashing' }),
        character: fighter,
        adapter: dnd5e,
      });
      expect(isResolvableSpec(ok!.spec)).toBe(true);
    });

    it('accepts a bare `d6`, which the roller reads as one die', () => {
      // Review (chatgpt-codex-connector P2): `DiceExprPattern` and `parseCompoundDiceExpr`
      // both treat an omitted count as 1, so requiring it degraded perfectly rollable
      // compendium and homebrew damage to a text-only action.
      const action = deriveEquippedItemAction({
        itemName: 'Homebrew Dirk',
        data: open5eWeapon({ damageDice: 'd6', damageType: 'Piercing' }),
        character: fighter,
        adapter: dnd5e,
      })!;
      expect(isResolvableSpec(action.spec)).toBe(true);
      // Folded with the wielder's +3 exactly as `1d6` would be — and normalized to an
      // explicit count, so the expander splits dice from modifier and a crit cannot re-roll
      // the +3.
      expect(action.spec?.outcomes?.hit?.damage?.[0]).toMatchObject({ formula: '1d6', flat: 3, type: 'piercing' });
    });

    it('produces a text-only action when the damage dice are not a dice expression', () => {
      // Open5e serves the SRD Net's damage_dice as the string "0".
      const action = deriveEquippedItemAction({
        itemName: 'Net',
        data: open5eWeapon({ damageDice: '0', damageType: 'Bludgeoning' }),
        character: fighter,
        adapter: dnd5e,
      });
      expect(action).not.toBeNull();
      expect(action!.name).toBe('Net');
      expect(action!.toHit).toBe('');
      expect(isResolvableSpec(action!.spec)).toBe(false);
      expect(action!.notes).toContain('check it');
    });

    it('rejects a damage type outside the system vocabulary, not just an empty one', () => {
      // Review (chatgpt-codex-connector P2): defenses are matched by EXACT lowercased type, so
      // "slashing damage" is short enough to pass a length check and then sails straight past
      // a target's slashing immunity — the same silent bypass the empty-type rule below
      // prevents, reached by a different door.
      for (const damageType of ['slashing damage', 'sword', 'slash']) {
        const action = deriveEquippedItemAction({
          itemName: 'Odd Blade',
          data: open5eWeapon({ damageType }),
          character: fighter,
          adapter: dnd5e,
        });
        expect(isResolvableSpec(action!.spec)).toBe(false);
      }
      // Canonical types still resolve, case-insensitively.
      expect(
        isResolvableSpec(
          deriveEquippedItemAction({ itemName: 'Blade', data: open5eWeapon({ damageType: 'SLASHING' }), character: fighter, adapter: dnd5e })!.spec,
        ),
      ).toBe(true);
    });

    it('still derives for an adapter that declares no damage vocabulary', () => {
      // Nothing to check against, so the length bound stays the only gate — a system that has
      // not declared its vocabulary must not be silently downgraded to text-only.
      const noVocab: ItemActionAdapter = { id: 'dnd5e', abilityModifier: (s2) => Math.floor((s2 - 10) / 2) };
      const action = deriveEquippedItemAction({
        itemName: 'Homebrew Blade',
        data: open5eWeapon({ damageType: 'ichor' }),
        character: fighter,
        adapter: noVocab,
      });
      expect(isResolvableSpec(action!.spec)).toBe(true);
    });

    it('produces a text-only action when the damage type is missing', () => {
      // The resolver treats an empty damage type as untyped and applies no resistance or
      // immunity — so a resolvable spec here would let the damage quietly bypass defenses.
      const action = deriveEquippedItemAction({
        itemName: 'Mystery Blade',
        data: open5eWeapon({ damageType: '' }),
        character: fighter,
        adapter: dnd5e,
      });
      expect(isResolvableSpec(action!.spec)).toBe(false);
      expect(action!.toHit).toBe('');
    });

    it('does not compute a to-hit for a rule system it has no attack math for', () => {
      const action = deriveEquippedItemAction({
        itemName: 'Longsword',
        data: open5eWeapon(),
        character: fighter,
        adapter: pf2e,
      });
      expect(action).not.toBeNull();
      expect(action!.toHit).toBe('');
      expect(action!.notes).toContain('not derived for this rule system');
    });

    it('derives nothing at all from an item that is not a weapon', () => {
      // The common case, and the one that must stay silent: a backpack should not sprout an
      // attack, and neither should a magic item whose effect is prose.
      expect(deriveEquippedItemAction({ itemName: 'Bedroll', data: null, character: fighter, adapter: dnd5e })).toBeNull();
      expect(
        deriveEquippedItemAction({
          itemName: 'Bag of Holding',
          data: { category: 'Wondrous Item', rarity: 'Uncommon', requiresAttunement: false },
          character: fighter,
          adapter: dnd5e,
        }),
      ).toBeNull();
    });

    it('never throws on malformed compendium data', () => {
      const junk = [
        { itemKind: 'weapon', damageDice: 12, damageType: {}, properties: 'nope' },
        { itemKind: 'weapon' },
        { damage: '1d6', damageType: 'x'.repeat(200) },
        [],
        'a string',
        42,
      ];
      for (const data of junk) {
        expect(() => deriveEquippedItemAction({ itemName: 'Thing', data, character: fighter, adapter: dnd5e })).not.toThrow();
      }
    });

    it('derives nothing from an unnamed item', () => {
      expect(deriveEquippedItemAction({ itemName: '   ', data: open5eWeapon(), character: fighter, adapter: dnd5e })).toBeNull();
    });
  });

  describe('other sources', () => {
    it('reads a Starfinder-shaped item, which carries flat damage keys', () => {
      const action = deriveEquippedItemAction({
        itemName: 'Pulsecaster Pistol',
        data: { category: 'weapon', damage: '1d4', damageType: 'fire', range: 30 },
        character: fighter,
        adapter: dnd5e,
      });
      expect(action).not.toBeNull();
      // range > 0 with no melee signal → DEX +1, proficiency +3
      expect(action!.toHit).toBe('+4');
      expect(action!.damage).toContain('fire');
    });

    it('reads a damage type published as a list, the way PF2e items carry it', () => {
      // Archives of Nethys models damage type as a list (`['Slashing']`); Open5e and
      // Starfinder publish a plain string. Reading only strings lost the type for a whole
      // rule system, leaving an untyped damage line — which the resolver treats as bypassing
      // every resistance and immunity.
      const action = deriveEquippedItemAction({
        itemName: 'PF2e Longsword',
        data: { itemKind: 'weapon', damageDice: '1d8', damageType: ['Slashing'], properties: [] },
        character: fighter,
        adapter: dnd5e,
      });
      expect(isResolvableSpec(action!.spec)).toBe(true);
      expect(action!.damage).toContain('slashing');
      // An empty list is no type at all, not an untyped resolvable action.
      const empty = deriveEquippedItemAction({
        itemName: 'Typeless',
        data: { itemKind: 'weapon', damageDice: '1d8', damageType: [], properties: [] },
        character: fighter,
        adapter: dnd5e,
      });
      expect(isResolvableSpec(empty!.spec)).toBe(false);
    });

    it("degrades a foreign system's damage type under a vocabulary that lacks it", () => {
      // Starfinder's `electricity` has no 5e equivalent, and 5e defenses are matched by exact
      // type — so deriving a resolvable spec here would produce damage no 5e resistance or
      // immunity can ever apply to. Text-only is the honest answer, not a silent bypass.
      const action = deriveEquippedItemAction({
        itemName: 'Pulsecaster Pistol',
        data: { category: 'weapon', damage: '1d4', damageType: 'electricity', range: 30 },
        character: fighter,
        adapter: dnd5e,
      });
      expect(isResolvableSpec(action!.spec)).toBe(false);
      expect(action!.damage).toBe('1d4 electricity');
    });
  });
});

/**
 * Issue #2097 review (chatgpt-codex-connector P1, Copilot). The resolver rolls the structured
 * `spec`, not the display strings — so an edit that carried the old spec through showed the
 * corrected numbers and kept rolling the original ones. Invisible at the table, and it defeats
 * the only reason the editor exists.
 */
describe('rebuildEditedActionSpec (#2097 review)', () => {
  const derived = deriveEquippedItemAction({
    itemName: 'Longsword',
    data: { itemKind: 'weapon', damageDice: '1d8', damageType: 'Slashing', properties: [] },
    character: { stats: { STR: 16, DEX: 12 }, level: 5 },
    adapter: dnd5e,
  })!;

  it('rebuilds the spec from edited numbers so the roll matches what is displayed', () => {
    // The advertised edit: a +1 weapon. Both fields corrected, old spec dropped by the caller.
    const edited = CharacterAction.parse({ ...derived, toHit: '+7', damage: '1d8+4 slashing', spec: undefined });
    const out = rebuildEditedActionSpec(edited, 'dnd5e');
    expect(isResolvableSpec(out.spec)).toBe(true);
    expect(out.spec?.attack?.bonus).toBe('+7');
    const part = out.spec?.outcomes?.hit?.damage?.[0];
    expect(part).toMatchObject({ formula: '1d8', flat: 4, type: 'slashing' });
    // What the human typed stays exactly as typed.
    expect(out.toHit).toBe('+7');
    expect(out.damage).toBe('1d8+4 slashing');
  });

  it('rebuilds a carried spec that contradicts the numbers it arrived with', () => {
    // The round trip: a REST/MCP client reads the whole action, edits toHit/damage, and posts
    // it back still carrying the spec it was given. Trusting it would display the correction
    // and keep rolling the original.
    const roundTripped = CharacterAction.parse({ ...derived, toHit: '+7', damage: '1d8+4 slashing' });
    const out = rebuildEditedActionSpec(roundTripped, 'dnd5e', DND5E_DAMAGE_TYPES);
    expect(out.spec?.attack?.bonus).toBe('+7');
    expect(out.spec?.outcomes?.hit?.damage?.[0]).toMatchObject({ formula: '1d8', flat: 4 });
  });

  it('needs no baseline, so a spec read before a concurrent edit is still caught', () => {
    // Review (chatgpt-codex-connector P1, second round): the first fix identified a round trip
    // by comparing against the row's CURRENT action. That asks a third party, and the third
    // party moves — client A reads spec X, client B commits spec Y, A submits its edit still
    // carrying X, the comparison against Y fails, and X is stored as "deliberate" while the
    // display shows A's edited numbers. Judging the request against ITSELF has no such window:
    // whatever else has been written in the meantime, this spec still contradicts these fields.
    const staleFromAnEarlierRead = CharacterAction.parse({ ...derived, toHit: '+12', damage: '2d6+5 slashing' });
    const out = rebuildEditedActionSpec(staleFromAnEarlierRead, 'dnd5e', DND5E_DAMAGE_TYPES);
    expect(out.spec?.attack?.bonus).toBe('+12');
    expect(out.spec?.outcomes?.hit?.damage?.[0]).toMatchObject({ formula: '2d6', flat: 5 });
  });

  it('trusts a spec whose numbers ARE the displayed numbers', () => {
    // The deliberate edit: the caller changed the spec and the fields together. Nothing
    // contradicts, so their structure survives untouched.
    const authored = CharacterAction.parse({
      ...derived,
      toHit: '+11',
      spec: { ...derived.spec, attack: { ...derived.spec!.attack, bonus: '+11' } },
    });
    expect(rebuildEditedActionSpec(authored, 'dnd5e', DND5E_DAMAGE_TYPES)).toEqual(authored);
  });

  it('rebuilds when a fixed spec bonus is left beside a CLEARED to-hit field', () => {
    // Review (chatgpt-codex-connector P1): requiring both sides to be numeric before comparing
    // let a client clear `toHit` (or replace it with prose) while round-tripping the spec —
    // and the saved action then displayed no attack bonus while combat went on rolling the
    // old fixed one. A cleared field is not "unknown", it is a different claim.
    for (const toHit of ['', '   ', 'see notes']) {
      const out = rebuildEditedActionSpec(CharacterAction.parse({ ...derived, toHit }), 'dnd5e', DND5E_DAMAGE_TYPES);
      expect(out.spec).toBeUndefined();
      expect(out.toHit).toBe(toHit);
    }
  });

  it('rebuilds whenever a damage-dealing spec is left beside a CLEARED damage field', () => {
    // Review (chatgpt-codex-connector P1): a cleared field is unambiguous whatever the spec's
    // attack bonus looks like — it asserts there is nothing to show while combat goes on
    // rolling. The prose carve-out below does NOT extend to it.
    const out = rebuildEditedActionSpec(CharacterAction.parse({ ...derived, damage: '' }), 'dnd5e', DND5E_DAMAGE_TYPES);
    expect(out.spec).toBeUndefined();

    // ...including an ability-derived spec, which states no fixed bonus to compare.
    const abilityDerived = CharacterAction.parse({
      ...derived,
      toHit: '',
      damage: '   ',
      spec: { ...derived.spec, attack: { bonus: '', ability: 'STR', proficient: true, vs: 'ac' } },
    });
    expect(rebuildEditedActionSpec(abilityDerived, 'dnd5e', DND5E_DAMAGE_TYPES).spec).toBeUndefined();
  });

  it('rebuilds when the display ADDS damage a spec that rolls none never had', () => {
    // Review (chatgpt-codex-connector P1): the consistency check only compared a spec that
    // already declared damage. Adding "1d6 bludgeoning" to a previously non-damaging attack
    // and round-tripping its spec therefore displayed the new damage while the apply path
    // rolled none — the same lie, reached from zero parts instead of one.
    const noDamage = CharacterAction.parse({
      ...derived,
      damage: '1d6 bludgeoning',
      spec: { ...derived.spec, outcomes: { hit: { damage: [] } } },
    });
    const out = rebuildEditedActionSpec(noDamage, 'dnd5e', DND5E_DAMAGE_TYPES);
    expect(out.spec?.outcomes?.hit?.damage?.[0]).toMatchObject({ formula: '1d6', flat: 0, type: 'bludgeoning' });
  });

  it("rebuilds when a save-based action's display damage is edited away from its spec", () => {
    // Review (chatgpt-codex-connector P1, second round): the previous fix scanned every outcome
    // branch to decide whether the spec rolls damage, but then COMPARED against `outcomes.hit`
    // alone — so a save action storing its damage under `failure` had its display line edited
    // to 8d6 while combat kept rolling 2d6. One list of parts, one rule, whatever the branch.
    const edited = CharacterAction.parse({
      ...derived,
      toHit: '',
      damage: '8d6 fire',
      spec: {
        ...derived.spec,
        attack: { bonus: '', ability: 'DEX', proficient: true, vs: 'ac' },
        outcomes: { failure: { damage: [{ formula: '2d6', flat: 0, type: 'fire' }] } },
      },
    });
    const out = rebuildEditedActionSpec(edited, 'dnd5e', DND5E_DAMAGE_TYPES);
    // `toHit` is not a bonus, so there is nothing to rebuild an attack from — text-only is the
    // honest outcome, rather than displaying 8d6 while rolling 2d6.
    expect(out.spec).toBeUndefined();
    expect(out.damage).toBe('8d6 fire');
  });

  it('trusts a save-based spec whose damage lives under `failure`, not `hit`', () => {
    // The reason the check above looks across EVERY outcome branch: `expandRawStatblockAction`
    // puts a save action's damage under `failure`, so demanding a `hit` branch would call a
    // legitimately authored spec a contradiction and rebuild it away.
    const saveAction = CharacterAction.parse({
      ...derived,
      toHit: '',
      damage: '2d6 fire',
      spec: {
        ...derived.spec,
        attack: { bonus: '', ability: 'DEX', proficient: true, vs: 'ac' },
        outcomes: { failure: { damage: [{ formula: '2d6', flat: 0, type: 'fire' }] } },
      },
    });
    expect(rebuildEditedActionSpec(saveAction, 'dnd5e', DND5E_DAMAGE_TYPES)).toEqual(saveAction);
  });

  it('still trusts a single-part spec with no fixed bonus beside an unreadable line', () => {
    // A save-based action legitimately carries one damage part beside a line no attack parser
    // can read; rebuilding would throw its structure away. Only the WEAPON shape — a spec
    // stating a fixed attack bonus — has to match its display line.
    const saveAction = CharacterAction.parse({
      ...derived,
      toHit: '',
      damage: 'DC 15 DEX, 2d6 fire',
      spec: {
        ...derived.spec,
        attack: { bonus: '', ability: 'DEX', proficient: true, vs: 'ac' },
        outcomes: { hit: { damage: [{ formula: '2d6', flat: 0, type: 'fire' }] } },
      },
    });
    expect(rebuildEditedActionSpec(saveAction, 'dnd5e', DND5E_DAMAGE_TYPES)).toEqual(saveAction);
  });

  it('trusts a spec the display line could never describe — the MCP path for a richer action', () => {
    // A save-based action carries no attack bonus and two damage parts. There is nothing in
    // `toHit`/`damage` that could contradict it, and rebuilding would throw the structure away.
    const richer = CharacterAction.parse({
      ...derived,
      toHit: '',
      damage: '2d6 fire plus 1d6 radiant',
      spec: {
        ...derived.spec,
        attack: { bonus: '', ability: 'STR', proficient: true, vs: 'ac' },
        outcomes: {
          hit: {
            damage: [
              { formula: '2d6', flat: 0, type: 'fire' },
              { formula: '1d6', flat: 0, type: 'radiant' },
            ],
          },
        },
      },
    });
    expect(rebuildEditedActionSpec(richer, 'dnd5e', DND5E_DAMAGE_TYPES)).toEqual(richer);
  });

  it('rebuilds a single-part spec sitting beside a damage line nobody can roll', () => {
    // The round trip again, with the edit landing on text the parser cannot represent.
    // Text-only is honest about being unfinished; rolling 1d8+3 while showing "nonsense" is not.
    const out = rebuildEditedActionSpec(
      CharacterAction.parse({ ...derived, damage: 'nonsense' }),
      'dnd5e',
      DND5E_DAMAGE_TYPES,
    );
    expect(out.spec).toBeUndefined();
    expect(out.damage).toBe('nonsense');
  });

  it('rejects a zero-padded count the roller grammar forbids', () => {
    // Review (chatgpt-codex-connector P2): `001d6` parses to count 1, but DiceExprPattern
    // allows at most two count digits — so bounding only the NUMBERS produced a resolvable
    // spec that threw at roll time, recreating the exact failure this check exists to stop.
    const out = rebuildEditedActionSpec(
      CharacterAction.parse({ ...derived, toHit: '+7', damage: '001d6 slashing', spec: undefined }),
      'dnd5e',
      DND5E_DAMAGE_TYPES,
    );
    expect(out.spec).toBeUndefined();
  });

  it('rejects an edited damage type outside the system vocabulary', () => {
    const out = rebuildEditedActionSpec(
      CharacterAction.parse({ ...derived, toHit: '+7', damage: '1d8+4 slashing damage', spec: undefined }),
      'dnd5e',
      DND5E_DAMAGE_TYPES,
    );
    expect(out.spec).toBeUndefined();
  });

  it('degrades an unrepresentable attack bonus instead of throwing', () => {
    // Review (chatgpt-codex-connector P2): `AttackSpec.bonus` is a 20-char string, and a
    // schema-valid 20-digit toHit rounds through Number into exponent form that blows that
    // cap — throwing a ZodError out of the expander, so SAVING the action 500s rather than
    // degrading to the text-only row this module promises.
    // 20 chars is the ceiling `CharacterAction.toHit` itself allows, so this is the largest
    // value that can actually reach the function — a 21-char one is rejected before it does.
    for (const toHit of ['99999999999999999999', '-9999999999999999999', '1000', '-1000']) {
      const out = rebuildEditedActionSpec(
        CharacterAction.parse({ ...derived, toHit, damage: '1d8+4 slashing', spec: undefined }),
        'dnd5e',
        DND5E_DAMAGE_TYPES,
      );
      expect(out.spec).toBeUndefined();
      expect(out.toHit).toBe(toHit);
    }
    // A tabletop-plausible bonus at the bound still resolves.
    expect(
      rebuildEditedActionSpec(
        CharacterAction.parse({ ...derived, toHit: '+999', damage: '1d8+4 slashing', spec: undefined }),
        'dnd5e',
        DND5E_DAMAGE_TYPES,
      ).spec,
    ).toBeDefined();
  });

  it('never throws, whatever the edited fields contain', () => {
    // The function is TOTAL: every escape hatch leads to a text-only action rather than out
    // of the function, matching `deriveEquippedItemAction`'s own guard.
    for (const patch of [
      { toHit: '+'.repeat(19), damage: '1d8 slashing' },
      { toHit: '+5', damage: 'x'.repeat(79) },
      { toHit: '', damage: '' },
      { toHit: '+0', damage: '1d8+0 slashing' },
    ]) {
      expect(() =>
        rebuildEditedActionSpec(CharacterAction.parse({ ...derived, ...patch, spec: undefined }), 'dnd5e', DND5E_DAMAGE_TYPES),
      ).not.toThrow();
    }
  });

  it('accepts an edited bare `d6 slashing`', () => {
    const out = rebuildEditedActionSpec(
      CharacterAction.parse({ ...derived, toHit: '+4', damage: 'd6 slashing', spec: undefined }),
      'dnd5e',
      DND5E_DAMAGE_TYPES,
    );
    expect(out.spec).toBeDefined();
    expect(out.spec?.attack?.bonus).toBe('+4');
  });

  it('refuses to build a spec from edited dice the roller would reject', () => {
    // Same bound as the derivation — a hand-typed "21d6 slashing" must not be marked
    // resolvable and then throw the first time someone attacks with it.
    for (const damage of ['21d6 slashing', '1d3 piercing', '2d6+1000 fire']) {
      const out = rebuildEditedActionSpec(CharacterAction.parse({ ...derived, toHit: '+7', damage, spec: undefined }), 'dnd5e');
      expect(out.spec).toBeUndefined();
      expect(out.damage).toBe(damage);
    }
  });

  it('produces a text-only action when the edited fields cannot be read', () => {
    // Never a stale spec, and never an invented one.
    for (const bad of [
      { toHit: 'lots', damage: '1d8+4 slashing' },
      { toHit: '+7', damage: 'a big hit' },
      { toHit: '+7', damage: '1d8+4' }, // no damage type -> resolver would treat it as untyped
      { toHit: '', damage: '' },
    ]) {
      const out = rebuildEditedActionSpec(CharacterAction.parse({ ...derived, ...bad, spec: undefined }), 'dnd5e');
      expect(out.spec).toBeUndefined();
      expect(out.name).toBe('Longsword');
    }
  });

  it('keeps a negative modifier out of the rebuilt dice formula', () => {
    const out = rebuildEditedActionSpec(
      CharacterAction.parse({ ...derived, toHit: '+1', damage: '1d8-1 slashing', spec: undefined }),
      'dnd5e',
    );
    expect(out.spec?.outcomes?.hit?.damage?.[0]).toMatchObject({ formula: '1d8', flat: -1 });
  });
});

describe('text-only actions still carry their damage line (#2097 review, Copilot)', () => {
  it('shows the known damage on a non-5e system rather than burying it in notes', () => {
    const action = deriveEquippedItemAction({
      itemName: 'Longsword',
      data: { itemKind: 'weapon', damageDice: '1d8', damageType: 'Slashing', properties: [] },
      character: fighter,
      adapter: pf2e,
    })!;
    // Action lists render `damage` prominently; leaving it empty hid real, sourced data.
    expect(action.damage).toBe('1d8 slashing');
    expect(action.toHit).toBe('');
    expect(isResolvableSpec(action.spec)).toBe(false);
  });

  it('shows whatever is known even when the dice are unusable', () => {
    const action = deriveEquippedItemAction({
      itemName: 'Net',
      data: { itemKind: 'weapon', damageDice: '0', damageType: 'Bludgeoning', properties: [] },
      character: fighter,
      adapter: dnd5e,
    })!;
    expect(action.damage).toBe('0 bludgeoning');
    expect(isResolvableSpec(action.spec)).toBe(false);
  });
});
