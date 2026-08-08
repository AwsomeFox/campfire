import { deriveEquippedItemAction, isResolvableSpec, type ItemActionAdapter } from '@campfire/schema';

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
        data: { category: 'weapon', damage: '1d4', damageType: 'electricity', range: 30 },
        character: fighter,
        adapter: dnd5e,
      });
      expect(action).not.toBeNull();
      // range > 0 with no melee signal → DEX +1, proficiency +3
      expect(action!.toHit).toBe('+4');
      expect(action!.damage).toContain('electricity');
    });
  });
});
