import {
  CharacterAction,
  deriveEquippedItemAction,
  Dnd5eAdapter,
  DND5E_DAMAGE_TYPES,
  equippedActionHasContent,
  isResolvableSpec,
  Pf2eAdapter,
  rebuildEditedActionSpec,
  StarfinderAdapter,
  type ItemActionAdapter,
} from '@campfire/schema';

/**
 * Issue #2097 — deriving an equipped item's attack from its compendium data.
 *
 * The interesting cases are all about restraint: what the derivation refuses to do. A wrong
 * to-hit is invisible at the table until someone notices a fight has been running on bad
 * numbers, so every input it cannot read confidently has to produce a row that says so
 * instead of a plausible one.
 */
// The REAL adapters, not hand-rolled doubles (issue #2144). What a system's derivation does
// now depends on which optional hooks its adapter declares, so a double is exactly the wrong
// thing here: it would let the production adapter drop `weaponProficiencyBonus` — silently
// turning every weapon in that system text-only — while this suite went on proving the maths
// against a stand-in that still had it.
const dnd5e: ItemActionAdapter = Dnd5eAdapter;
const pf2e: ItemActionAdapter = Pf2eAdapter;
// Starfinder 1e computes to-hit from a per-class BAB table and `Character.className` is free
// text, so its adapter declares no proficiency curve — the standing example of a system that
// gets an action with a real damage line and no derived to-hit.
const noAttackMath: ItemActionAdapter = StarfinderAdapter;

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

// Weapon training is now READ from the sheet rather than assumed (issue #2144), so these
// fixtures record it. `martial` covers every open5eWeapon() below (`isSimple: false`); the
// untrained cases get their own fixture rather than being the accidental default.
const TRAINED_IN_EVERYTHING = { simple: 'proficient', martial: 'proficient' } as const;
const fighter = { stats: { STR: 16, DEX: 12 }, level: 5, weaponProficiencies: TRAINED_IN_EVERYTHING }; // STR +3, DEX +1, proficiency +3
const rogue = { stats: { STR: 8, DEX: 18 }, level: 1, weaponProficiencies: TRAINED_IN_EVERYTHING }; // STR -1, DEX +4, proficiency +2
/** Same fighter, no training recorded — the case the old assumed-proficiency default hid. */
const untrainedFighter = { stats: { STR: 16, DEX: 12 }, level: 5 };

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

    it('shows the rank it read, and its whole breakdown', () => {
      // The breakdown has to be visible to whoever reads the row: it is the only way to tell a
      // to-hit that is wrong because the sheet is wrong from one that is wrong because the
      // derivation is. Issue #2144 replaced the old "assumes proficiency" wording with the
      // rank actually read off the sheet.
      const action = deriveEquippedItemAction({ itemName: 'Longsword', data: open5eWeapon(), character: fighter, adapter: dnd5e });
      expect(action!.notes).toContain('STR +3');
      expect(action!.notes).toContain('trained +3');
      expect(action!.notes.toLowerCase()).not.toContain('assumes proficiency');
    });

    it('adds NO proficiency for a weapon the sheet records no training in', () => {
      // The case the old assumption was silently wrong about, and the whole reason
      // `Character.weaponProficiencies` exists (issue #2144). STR +3 and nothing else.
      const action = deriveEquippedItemAction({
        itemName: 'Longsword',
        data: open5eWeapon(),
        character: untrainedFighter,
        adapter: dnd5e,
      })!;
      expect(action.toHit).toBe('+3');
      // …and it says so, because a missing proficiency term reads as a bug unless explained.
      expect(action.notes).toContain('untrained +0');
      expect(action.notes.toLowerCase()).toContain('no training with this weapon is recorded');
    });

    it('matches training by the weapon name as well as by category', () => {
      // An Elf trained with the longsword specifically, and nothing else — the by-name half of
      // the lookup. Categories and names compose; neither shadows the other.
      const action = deriveEquippedItemAction({
        itemName: 'Longsword',
        data: open5eWeapon(),
        character: { stats: { STR: 16, DEX: 12 }, level: 5, weaponProficiencies: { Longsword: 'proficient' } },
        adapter: dnd5e,
      })!;
      expect(action.toHit).toBe('+6');
    });

    it("takes the BEST of the weapon's own rank and its category's", () => {
      const action = deriveEquippedItemAction({
        itemName: 'Longsword',
        data: open5eWeapon(),
        character: { stats: { STR: 16, DEX: 12 }, level: 5, weaponProficiencies: { martial: 'trained', longsword: 'master' } },
        adapter: dnd5e,
      })!;
      // 5e prices every trained rung the same (+3 here), so the assertion that bites is the
      // note: the higher rank is the one that was read.
      expect(action.notes).toContain('master +3');
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
      const noVocab: ItemActionAdapter = {
        id: 'dnd5e',
        abilityModifier: (s2) => Math.floor((s2 - 10) / 2),
        weaponProficiencyBonus: Dnd5eAdapter.weaponProficiencyBonus,
      };
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
      // Gated on the ADAPTER declaring a proficiency curve, not on its id (issue #2144).
      // Starfinder 1e computes from a per-class BAB table there is nothing on the sheet to
      // look up, so it declares none and its weapons stay honestly unfinished.
      const action = deriveEquippedItemAction({
        itemName: 'Pulsecaster',
        data: { damage: '1d6', damageType: 'Electricity', range: 30, category: 'Weapon' },
        character: fighter,
        adapter: noAttackMath,
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
        // A bare `category: 'weapon'` names no trainable category — it says "this is a weapon",
        // which is what got it an action row at all, not what KIND of weapon it is. Training
        // for a row like that has to be recorded against the weapon itself.
        character: { stats: { STR: 16, DEX: 12 }, level: 5, weaponProficiencies: { 'pulsecaster pistol': 'trained' } },
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
      // A system with no declared proficiency curve — PF2e used to be one, and got its own
      // maths in #2144, so the standing example is now Starfinder 1e.
      adapter: noAttackMath,
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

/**
 * Issue #2144 — an item that its own compendium data calls a weapon always grants an attack
 * row, even when the numbers are missing.
 *
 * #2097 derived nothing at all from such an item, which on a character sheet is
 * indistinguishable from the feature not existing. The three sources this covers all reach
 * that state honestly: an Open5e magic weapon whose base weapon the SRD does not name, a
 * PF2e/SF2e weapon acquired before its importer learned to keep `damage`, and any item
 * acquired before #2144 whose accepted snapshot therefore has no stats in it.
 */
describe('deriveEquippedItemAction: an item that declares itself a weapon (#2144)', () => {
  it('derives a real attack from a magic weapon carrying its base weapon', () => {
    const action = deriveEquippedItemAction({
      itemName: 'Longsword (+1)',
      // As mapMagicItem now stores it: the magic-item shelf plus the nested base weapon.
      data: { category: 'Weapon', rarity: 'Uncommon', requiresAttunement: false, ...open5eWeapon() },
      character: fighter,
      adapter: dnd5e,
    })!;
    expect(action.toHit).toBe('+6');
    expect(action.damage).toBe('1d8+3 slashing');
    expect(isResolvableSpec(action.spec)).toBe(true);
  });

  it('still grants a text-only attack when the weapon carries no numbers', () => {
    const action = deriveEquippedItemAction({
      itemName: '+1 Weapon',
      data: { category: 'Weapon', rarity: 'Uncommon', requiresAttunement: false },
      character: fighter,
      adapter: dnd5e,
    })!;
    expect(action).not.toBeNull();
    expect(action.kind).toBe('attack');
    expect(action.notes).toMatch(/fill it in/i);
    // The point of the row is that it is visibly unfinished, never plausibly wrong.
    expect(isResolvableSpec(action.spec)).toBe(false);
    expect(action.toHit).toBe('');
  });

  it("reads PF2e/SF2e's own vocabulary for a weapon with no numbers", () => {
    // An Archives of Nethys weapon acquired before #2103 taught the importer to keep
    // `damage`: the shelf and the weapon-only fields are all that survived, and they are
    // enough to know an attack row belongs here.
    const stale = deriveEquippedItemAction({
      itemName: 'Pulsecaster Pistol',
      data: { level: 0, bulk: 1, category: 'weapon', rarity: 'common', weaponCategory: 'Simple', weaponGroup: 'Shock' },
      character: fighter,
      adapter: pf2e,
    })!;
    expect(stale).not.toBeNull();
    expect(stale.kind).toBe('attack');
    expect(stale.toHit).toBe('');
  });

  it('derives nothing from armor or from an ordinary object', () => {
    // The common case, and it has to stay silent: an attack row on every backpack would be
    // worse than the missing row this whole change is about.
    for (const data of [
      { itemKind: 'armor', armorCategory: 'heavy', acBase: 16 },
      { category: 'Armor', rarity: 'Uncommon' },
      { category: 'Wondrous Item', rarity: 'Uncommon' },
      { level: 1, bulk: 'L', category: 'equipment' },
      {},
    ]) {
      expect(deriveEquippedItemAction({ itemName: 'Thing', data, character: fighter, adapter: dnd5e })).toBeNull();
    }
  });
});

/**
 * Issue #2144 — the editor's blank draft is not an authored action.
 *
 * `CharacterAction` needs only a name, so "open the action editor, save without typing"
 * produced a valid row that showed nothing, rolled nothing, and suppressed the derived attack
 * the weapon had been granting — the one thing worse than no editor.
 */
describe('equippedActionHasContent (#2144)', () => {
  it('rejects an action that says nothing beyond its own name', () => {
    expect(equippedActionHasContent(CharacterAction.parse({ name: 'Longsword' }))).toBe(false);
    expect(equippedActionHasContent(CharacterAction.parse({ name: 'Longsword', toHit: '   ', notes: '  ' }))).toBe(false);
    expect(equippedActionHasContent(null)).toBe(false);
    expect(equippedActionHasContent(undefined)).toBe(false);
  });

  it('accepts anything a human actually filled in', () => {
    expect(equippedActionHasContent(CharacterAction.parse({ name: 'Longsword', toHit: '+6' }))).toBe(true);
    expect(equippedActionHasContent(CharacterAction.parse({ name: 'Longsword', damage: '1d8+3 slashing' }))).toBe(true);
    expect(equippedActionHasContent(CharacterAction.parse({ name: 'Shove', notes: 'Athletics contest' }))).toBe(true);
    // A rich MCP-authored action can legitimately carry only a spec and a name.
    const spec = rebuildEditedActionSpec(
      CharacterAction.parse({ name: 'Longsword', toHit: '+6', damage: '1d8+3 slashing' }),
      'dnd5e',
      DND5E_DAMAGE_TYPES,
    ).spec;
    expect(equippedActionHasContent(CharacterAction.parse({ name: 'Longsword', spec }))).toBe(true);
  });
});

/**
 * Issue #2144 — PF2e gets a derived to-hit.
 *
 * It always could have: `pf2eProficiencyBonus` has been in the adapter since #415. What kept
 * Pathfinder weapons showing a damage line and a blank attack bonus was an `adapter.id !==
 * 'dnd5e'` gate plus a sheet with nowhere to record which weapons the character is trained in.
 *
 * Three things here are PF2e's and NOT 5e's, and each is a way this could have been silently
 * wrong: proficiency adds your LEVEL, the rank spans +2 to +8, and a ranged Strike adds no
 * ability modifier to damage at all.
 */
describe('PF2e derived attacks (#2144)', () => {
  /** An AoN longsword as the importer stores it: martial, melee, damage packed as "1d8 S". */
  const pf2eLongsword = {
    level: 0,
    category: 'weapon',
    itemCategory: 'Weapons',
    damage: '1d8 S',
    damageType: ['Slashing'],
    weaponCategory: 'Martial',
    weaponGroup: 'Sword',
    weaponType: 'Melee',
    traits: ['Versatile P'],
  };

  const pf2eFighter = { stats: { STR: 16, DEX: 12 }, level: 5, weaponProficiencies: { martial: 'expert', simple: 'trained' } };

  it('adds level plus the rank bonus, not a fixed proficiency', () => {
    const action = deriveEquippedItemAction({ itemName: 'Longsword', data: pf2eLongsword, character: pf2eFighter, adapter: pf2e })!;
    // STR +3, plus expert at level 5 = 5 + 4. 5e would have said +6 for the same sheet.
    expect(action.toHit).toBe('+12');
    expect(action.notes).toContain('expert +9');
    expect(isResolvableSpec(action.spec)).toBe(true);
  });

  it("strips AoN's damage-type abbreviation out of the dice string", () => {
    // `"1d8 S"` is dice + the type's initial. Left in, it fails every rollable-dice check and
    // the weapon degrades to a text-only row — which is what happened even once #2103 kept
    // the stats. The type comes from `damage_type`, which is unambiguous.
    const action = deriveEquippedItemAction({ itemName: 'Longsword', data: pf2eLongsword, character: pf2eFighter, adapter: pf2e })!;
    expect(action.damage).toBe('1d8+3 slashing');
  });

  it('adds no ability modifier to a ranged Strike\'s damage', () => {
    // Player Core, "Damage": a ranged Strike adds nothing unless Propulsive or Thrown. 5e's
    // rule — the same modifier that hit also adds to damage — would hand every bow in the
    // game its wielder's Dexterity, on every hit, and the number would look plausible.
    const pistol = { ...pf2eLongsword, damage: '1d6 E', damageType: ['Electricity'], weaponCategory: 'Simple', weaponType: 'Ranged', traits: [] };
    const action = deriveEquippedItemAction({ itemName: 'Pulsecaster Pistol', data: pistol, character: pf2eFighter, adapter: pf2e })!;
    // DEX +1 plus trained at level 5 (5 + 2) on the attack…
    expect(action.toHit).toBe('+8');
    // …and a bare die for damage.
    expect(action.damage).toBe('1d6 electricity');
  });

  it('gives a Thrown weapon full Strength on damage and a Propulsive one half', () => {
    const thrown = { ...pf2eLongsword, damage: '1d6 P', damageType: ['Piercing'], weaponType: 'Ranged', traits: ['Thrown'] };
    expect(deriveEquippedItemAction({ itemName: 'Javelin', data: thrown, character: pf2eFighter, adapter: pf2e })!.damage).toBe('1d6+3 piercing');

    const propulsive = { ...thrown, traits: ['Propulsive'] };
    // Half of STR +3, rounded down.
    expect(deriveEquippedItemAction({ itemName: 'Shortbow', data: propulsive, character: pf2eFighter, adapter: pf2e })!.damage).toBe('1d6+1 piercing');

    // …and a Propulsive weapon never punishes a weak archer: a negative Strength adds nothing.
    const weak = { stats: { STR: 6, DEX: 18 }, level: 5, weaponProficiencies: { martial: 'trained' } };
    expect(deriveEquippedItemAction({ itemName: 'Shortbow', data: propulsive, character: weak, adapter: pf2e })!.damage).toBe('1d6 piercing');
  });

  it('now gains the same closed-vocabulary damage-type check 5e has (#2150)', () => {
    // `Pf2eAdapter` declares its `damageTypes` vocabulary (#2150), so the derivation gates a
    // resolvable spec's damage type exactly the way 5e does — a "Slashing damage" the length
    // bound once waved through now degrades to text-only, because defenses match by EXACT
    // lowercased type and this token would sail past a slashing resistance untouched.
    const odd = { ...pf2eLongsword, damageType: ['Slashing damage'] };
    const oddAction = deriveEquippedItemAction({ itemName: 'Longsword', data: odd, character: pf2eFighter, adapter: pf2e })!;
    expect(isResolvableSpec(oddAction.spec)).toBe(false);
    // A canonical PF2e type still resolves case-insensitively.
    const clean = deriveEquippedItemAction({ itemName: 'Longsword', data: pf2eLongsword, character: pf2eFighter, adapter: pf2e })!;
    expect(isResolvableSpec(clean.spec)).toBe(true);
    expect(clean.damage).toContain('slashing');
  });

  it('adds nothing for a weapon the PF2e sheet records no training in', () => {
    const untrained = { stats: { STR: 16, DEX: 12 }, level: 5 };
    const action = deriveEquippedItemAction({ itemName: 'Longsword', data: pf2eLongsword, character: untrained, adapter: pf2e })!;
    // PF2e untrained is a flat +0 — you do not even add your level (Player Core,
    // "Proficiency"), so this is STR alone and the level term is absent entirely.
    expect(action.toHit).toBe('+3');
    expect(action.notes).toContain('untrained +0');
  });
});

/**
 * Issue #2144 review — the two ways a real proficiency entry failed to match the weapon it
 * was written for. Both were invisible: the attack still derived, just without its bonus.
 */
describe('proficiency matching against the weapon (#2144 review)', () => {
  it("matches a magic weapon by the BASE weapon it is built on", () => {
    // chatgpt-codex-connector P2: a magic weapon's inventory name is never its base weapon's,
    // so a character trained in `Longsword` by name read as untrained with a Longsword (+1) —
    // the very weapon they specialise in. Open5e embeds the base item; PF2e names it.
    const magic = { ...open5eWeapon(), baseItem: 'Longsword' };
    const byName = { stats: { STR: 16, DEX: 12 }, level: 5, weaponProficiencies: { Longsword: 'proficient' } };
    const action = deriveEquippedItemAction({ itemName: 'Longsword (+1)', data: magic, character: byName, adapter: dnd5e })!;
    expect(action.toHit).toBe('+6');

    // …and the base name is a NAME, not a free pass: an unrelated weapon still gets nothing.
    const other = deriveEquippedItemAction({ itemName: 'Greatsword', data: open5eWeapon(), character: byName, adapter: dnd5e })!;
    expect(other.toHit).toBe('+3');
  });

  it("matches D&D Beyond's split martial-melee / martial-ranged categories", () => {
    // chatgpt-codex-connector P2: DDB grants `martial-melee-weapons`, stored as `martial
    // melee`, and no weapon used to emit that key — so the proficiency matched nothing at all.
    const melee = { stats: { STR: 16, DEX: 12 }, level: 5, weaponProficiencies: { 'martial melee': 'proficient' } };
    const longsword = deriveEquippedItemAction({ itemName: 'Longsword', data: open5eWeapon(), character: melee, adapter: dnd5e })!;
    expect(longsword.toHit).toBe('+6');

    // …and it stays a SPLIT grant: a martial RANGED weapon is not covered by it. Collapsing
    // the split to a bare `martial` would have over-granted exactly here.
    const longbow = open5eWeapon({
      damageType: 'Piercing',
      properties: [{ name: 'Ammunition', type: null, detail: null }],
    });
    const bow = deriveEquippedItemAction({ itemName: 'Longbow', data: longbow, character: melee, adapter: dnd5e })!;
    expect(bow.toHit).toBe('+1'); // DEX +1, no proficiency

    // The broad category still covers both halves.
    const broad = { stats: { STR: 16, DEX: 12 }, level: 5, weaponProficiencies: { martial: 'proficient' } };
    expect(deriveEquippedItemAction({ itemName: 'Longbow', data: longbow, character: broad, adapter: dnd5e })!.toHit).toBe('+4');
  });
});
