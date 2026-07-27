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

  it('conservatively excludes a qualified Open5e v2 display group', () => {
    const data = {
      resistances_and_immunities: {
        damage_resistances_display: 'bludgeoning, piercing, and slashing from nonmagical attacks',
        damage_resistances: [
          { name: 'Bludgeoning', key: 'bludgeoning' },
          { name: 'Piercing', key: 'piercing' },
          { name: 'Slashing', key: 'slashing' },
        ],
      },
    };
    expect(damageDefensesFromStatblock(data, DND5E_DAMAGE_TYPES).resistances).toEqual([]);
  });
});
