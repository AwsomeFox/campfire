import { mapCreature } from '../../src/modules/rules/open5e-importer';

describe('Open5e creature importer', () => {
  it('preserves damage defences for encounter damage resolution (issue #605)', () => {
    const entry = mapCreature({
      key: 'defended-target',
      name: 'Defended target',
      damage_resistances: 'fire, lightning',
      damage_vulnerabilities: ['cold'],
      damage_immunities: ['poison'],
    });

    expect(JSON.parse(entry.dataJson!)).toMatchObject({
      damage_resistances: 'fire, lightning',
      damage_vulnerabilities: ['cold'],
      damage_immunities: ['poison'],
    });
  });
});
