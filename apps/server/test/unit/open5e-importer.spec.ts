import { damageDefensesFromStatblock, DND5E_DAMAGE_TYPES } from '@campfire/schema';
import { mapCreature } from '../../src/modules/rules/open5e-importer';

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
