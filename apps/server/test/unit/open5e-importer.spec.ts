import { damageDefensesFromStatblock, DND5E_DAMAGE_TYPES } from '@campfire/schema';
import { mapArmor, mapCreature, mapWeapon } from '../../src/modules/rules/open5e-importer';

describe('Open5e creature importer', () => {
  it('preserves damage defences for encounter damage resolution (issue #605)', () => {
    const entry = mapCreature({
      key: 'defended-target',
      name: 'Defended target',
      resistances_and_immunities: {
        damage_resistances_display: 'fire, lightning',
        damage_resistances: [{ name: 'Fire', key: 'fire' }, { name: 'Lightning', key: 'lightning' }],
        damage_vulnerabilities_display: 'cold',
        damage_vulnerabilities: [{ name: 'Cold', key: 'cold' }],
        damage_immunities_display: 'poison',
        damage_immunities: [{ name: 'Poison', key: 'poison' }],
      },
    });

    const data = JSON.parse(entry.dataJson!);
    expect(data).toMatchObject({
      resistances_and_immunities: {
        damage_resistances: [{ name: 'Fire', key: 'fire' }, { name: 'Lightning', key: 'lightning' }],
        damage_vulnerabilities: [{ name: 'Cold', key: 'cold' }],
        damage_immunities: [{ name: 'Poison', key: 'poison' }],
      },
      damage_resistances: [{ name: 'Fire', key: 'fire' }, { name: 'Lightning', key: 'lightning' }],
    });
    expect(damageDefensesFromStatblock(data, DND5E_DAMAGE_TYPES)).toEqual({
      resistances: ['fire', 'lightning'],
      vulnerabilities: ['cold'],
      immunities: ['poison'],
    });
  });

  it('keeps unconditional structured entries and excludes qualified ones without erasing metadata', () => {
    const data = {
      resistances_and_immunities: {
        damage_resistances: [
          { name: 'Fire', key: 'fire' },
          {
            damage_type: { name: 'Slashing', key: 'slashing' },
            qualifier: 'from nonmagical attacks',
            exceptions: ['silvered'],
          },
        ],
      },
    };
    const entry = mapCreature({ key: 'mixed', name: 'Mixed', ...data });
    expect(JSON.parse(entry.dataJson!).resistances_and_immunities.damage_resistances[1]).toEqual(
      expect.objectContaining({ qualifier: 'from nonmagical attacks', exceptions: ['silvered'] }),
    );
    expect(damageDefensesFromStatblock(JSON.parse(entry.dataJson!), DND5E_DAMAGE_TYPES).resistances).toEqual(['fire']);
  });

  it.each([
    {
      creature: 'Air Elemental',
      display: 'lightning, thunder; damage from nonmagical weapons',
      expected: ['lightning', 'thunder'],
    },
    {
      creature: 'Balor',
      display: 'cold, lightning; damage from nonmagical weapons',
      expected: ['cold', 'lightning'],
    },
    {
      creature: 'Barbed Devil',
      display: 'cold; damage from nonmagical, non-silvered weapons',
      expected: ['cold'],
    },
  ])('retains unconditional clauses from the live Open5e v2 $creature shape', ({ display, expected }) => {
    const data = {
      resistances_and_immunities: {
        damage_resistances_display: display,
        damage_resistances: [
          { name: 'Cold', key: 'cold' },
          { name: 'Lightning', key: 'lightning' },
          { name: 'Thunder', key: 'thunder' },
          { name: 'Bludgeoning', key: 'bludgeoning' },
          { name: 'Piercing', key: 'piercing' },
          { name: 'Slashing', key: 'slashing' },
        ],
      },
    };
    expect(damageDefensesFromStatblock(data, DND5E_DAMAGE_TYPES).resistances).toEqual(expected);
  });

  it('conservatively excludes a wholly qualified Open5e v2 display group', () => {
    const data = {
      resistances_and_immunities: {
        damage_resistances_display: 'damage from nonmagical weapons',
        damage_resistances: [
          { name: 'Bludgeoning', key: 'bludgeoning' },
          { name: 'Piercing', key: 'piercing' },
          { name: 'Slashing', key: 'slashing' },
        ],
      },
    };
    expect(damageDefensesFromStatblock(data, DND5E_DAMAGE_TYPES).resistances).toEqual([]);
  });

  it('treats an empty adapter vocabulary as best-effort parsing', () => {
    expect(damageDefensesFromStatblock(
      { damage_resistances: ['fire', 'cold'] },
      [],
    ).resistances).toEqual(['fire', 'cold']);
  });

  it('rejects malformed array-shaped aggregate defenses and keeps direct fallbacks', () => {
    const entry = mapCreature({
      key: 'malformed-defenses',
      name: 'Malformed defenses',
      resistances_and_immunities: [{ damage_resistances: ['cold'] }],
      damage_resistances: ['fire'],
    });
    const data = JSON.parse(entry.dataJson!);
    expect(data.resistances_and_immunities).toBeNull();
    expect(data.damage_resistances).toEqual(['fire']);
    expect(damageDefensesFromStatblock(data, DND5E_DAMAGE_TYPES).resistances).toEqual(['fire']);
  });
});

/**
 * Issue #2096 — mundane gear. `/v2/magicitems/` never contained a Longsword, so these two
 * mappers are what makes an ordinary weapon reachable at all. What matters here is faithful
 * ingestion: the fields a consumer needs to build an attack survive, and the shapes that are
 * NOT clean (a non-dice `damage_dice`, a melee weapon reporting a thrown range) are passed
 * through untouched rather than "corrected" or dropped.
 */
describe('Open5e weapon importer (#2096)', () => {
  const longsword = {
    key: 'srd-2024_longsword',
    name: 'Longsword',
    damage_dice: '1d8',
    damage_type: { name: 'Slashing', key: 'slashing' },
    distance_unit: 'feet',
    range: 0,
    long_range: 0,
    is_simple: false,
    is_improvised: false,
    properties: [
      { property: { name: 'Versatile', type: null, desc: 'One or two hands.' }, detail: '1d10' },
      { property: { name: 'Sap', type: 'Mastery', desc: 'Disadvantage on the next attack.' }, detail: null },
    ],
  };

  it('maps a weapon to an item entry carrying the stats an attack needs', () => {
    const entry = mapWeapon(longsword);
    expect(entry.type).toBe('item');
    expect(entry.name).toBe('Longsword');
    expect(entry.slug).toBe('srd-2024_longsword');
    expect(JSON.parse(entry.dataJson!)).toMatchObject({
      itemKind: 'weapon',
      damageDice: '1d8',
      damageType: 'Slashing',
      range: 0,
      longRange: 0,
      isSimple: false,
    });
  });

  it("preserves a property's per-weapon detail, which is where Versatile's two-handed die lives", () => {
    const data = JSON.parse(mapWeapon(longsword).dataJson!);
    expect(data.properties).toContainEqual({ name: 'Versatile', type: null, detail: '1d10' });
  });

  it('keeps a 2024 weapon mastery distinguishable from a physical property', () => {
    const data = JSON.parse(mapWeapon(longsword).dataJson!);
    expect(data.properties).toContainEqual({ name: 'Sap', type: 'Mastery', detail: null });
    // The summary describes what the weapon IS, so it lists physical properties only —
    // a mastery is a choice the wielder makes, not a trait of the object.
    expect(mapWeapon(longsword).summary).toContain('Versatile');
    expect(mapWeapon(longsword).summary).not.toContain('Sap');
  });

  it('passes a non-dice damage_dice through verbatim instead of dropping the weapon', () => {
    // The live SRD serves the Net exactly like this. Deciding it is unusable belongs to
    // whoever builds an action from it; silently discarding it here would hide the row.
    const entry = mapWeapon({
      key: 'srd-2024_net',
      name: 'Net',
      damage_dice: '0',
      damage_type: { name: 'Bludgeoning', key: 'bludgeoning' },
      range: 5,
      long_range: 15,
      is_simple: false,
      properties: [],
    });
    expect(entry.name).toBe('Net');
    expect(JSON.parse(entry.dataJson!).damageDice).toBe('0');
  });

  it('does not treat a thrown melee weapon as ranged just because it reports a range', () => {
    const data = JSON.parse(
      mapWeapon({
        key: 'srd-2024_dagger',
        name: 'Dagger',
        damage_dice: '1d4',
        damage_type: { name: 'Piercing', key: 'piercing' },
        range: 20,
        long_range: 60,
        is_simple: true,
        properties: [
          { property: { name: 'Finesse', type: null }, detail: null },
          { property: { name: 'Thrown', type: null }, detail: 'Range 20/60' },
        ],
      }).dataJson!,
    );
    // Both facts are recorded side by side; neither is collapsed into a melee/ranged verdict.
    expect(data.range).toBe(20);
    expect(data.properties.map((p: { name: string }) => p.name)).toEqual(['Finesse', 'Thrown']);
  });

  it('renders a body from the stats, since these rows carry no desc at all', () => {
    const body = mapWeapon(longsword).body;
    expect(body).toContain('1d8 slashing');
    expect(body).toContain('Versatile (1d10)');
    expect(mapWeapon(longsword).body.length).toBeGreaterThan(0);
  });

  it('tolerates a row with no properties array and no booleans', () => {
    const entry = mapWeapon({ key: 'homebrew_stick', name: 'Stick' });
    expect(entry.name).toBe('Stick');
    expect(JSON.parse(entry.dataJson!)).toMatchObject({ itemKind: 'weapon', damageDice: null, isSimple: null, properties: [] });
  });
});

describe('Open5e armor importer (#2096)', () => {
  it('maps armor to an item entry with the AC fields and its wearer requirements', () => {
    const entry = mapArmor({
      key: 'srd-2024_chain-mail',
      name: 'Chain Mail',
      category: 'heavy',
      ac_display: '16',
      ac_base: 16,
      ac_add_dexmod: false,
      ac_cap_dexmod: null,
      grants_stealth_disadvantage: true,
      strength_score_required: 13,
    });
    expect(entry.type).toBe('item');
    expect(JSON.parse(entry.dataJson!)).toMatchObject({
      itemKind: 'armor',
      armorCategory: 'heavy',
      acDisplay: '16',
      acBase: 16,
      acAddDex: false,
      grantsStealthDisadvantage: true,
      strengthScoreRequired: 13,
    });
    expect(entry.body).toContain('disadvantage');
  });

  it('keeps a capped Dex bonus distinguishable from no Dex bonus at all', () => {
    const capped = JSON.parse(
      mapArmor({ key: 'a', name: 'Breastplate', category: 'medium', ac_display: '14 + Dex modifier (max 2)', ac_base: 14, ac_add_dexmod: true, ac_cap_dexmod: 2 }).dataJson!,
    );
    expect(capped).toMatchObject({ acAddDex: true, acCapDex: 2 });
    const none = JSON.parse(
      mapArmor({ key: 'b', name: 'Chain Mail', category: 'heavy', ac_display: '16', ac_base: 16, ac_add_dexmod: false, ac_cap_dexmod: null }).dataJson!,
    );
    expect(none).toMatchObject({ acAddDex: false, acCapDex: null });
  });
});
