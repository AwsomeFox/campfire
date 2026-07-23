import { fetchPf2eSection, fetchSf2eSection, entryTypeForSection, ALL_PF2E_SECTIONS, PF2E_DEFAULT_LICENSE } from '../../src/modules/rules/pf2e-importer';
import { startFakePf2e, startFakePf2eDuplicates, startFakePf2eMixed, type FakePf2e } from '../fake-pf2e';

/**
 * Unit tests for the PF2e importer (issue #295) against the fake AoN Elasticsearch source
 * (test/fake-pf2e.ts) — the same fake-source strategy the Open5e importer uses. They pin
 * the section->rule-entry-type mapping, the PF2e-specific statblock/dataJson shaping, art
 * stripping, license/source stamping, and (name,type) de-duplication.
 */
const silentLogger = { warn: () => {}, info: () => {} };

describe('pf2e-importer — section fetch + mapping', () => {
  let fake: FakePf2e;
  beforeAll(async () => {
    fake = await startFakePf2e();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('maps AoN creatures -> monster with a PF2e statblock in dataJson (level, ac, hp, perception, ability MODS, saves)', async () => {
    const { entries } = await fetchPf2eSection(fake.baseUrl, 'creatures', silentLogger);
    const goblin = entries.find((e) => e.name === 'Goblin Warrior');
    expect(goblin).toBeDefined();
    expect(goblin!.type).toBe('monster');
    expect(goblin!.slug).toBe('goblin-warrior');
    const data = JSON.parse(goblin!.dataJson!);
    expect(data.level).toBe(-1);
    expect(data.ac).toBe(16);
    expect(data.hp).toBe(6);
    expect(data.perception).toBe(2);
    expect(data.abilityMods).toEqual({ strength: 0, dexterity: 3, constitution: 1, intelligence: 0, wisdom: -1, charisma: 1 });
    expect(data.saves).toEqual({ fortitude: 5, reflex: 7, will: 3 });
    expect(data.traits).toEqual(['Goblin', 'Humanoid']);

    // Adult Red Dragon covers a positive double-digit-adjacent mod set (str 9) + perception.
    const dragon = entries.find((e) => e.name === 'Adult Red Dragon');
    expect(dragon).toBeDefined();
    const dragonData = JSON.parse(dragon!.dataJson!);
    expect(dragonData.abilityMods.strength).toBe(9);
    expect(dragonData.abilityMods.dexterity).toBe(4);
    expect(dragonData.perception).toBe(27);
  });

  it('fetches sf2e section using fetchSf2eSection and maps vehicles -> item', async () => {
    const { entries } = await fetchSf2eSection(fake.baseUrl, 'vehicles', silentLogger);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].name).toBe('Hover Skimmer');
    expect(entries[0].type).toBe('item');
    const data = JSON.parse(entries[0].dataJson!);
    expect(data.category).toBe('vehicle');
    expect(data.level).toBe(2);
  });

  it('strips art (image fields never make it into dataJson or body)', async () => {
    const { entries } = await fetchPf2eSection(fake.baseUrl, 'creatures', silentLogger);
    const goblin = entries.find((e) => e.name === 'Goblin Warrior')!;
    expect(goblin.dataJson).not.toContain('image');
    expect(goblin.dataJson).not.toContain('.png');
    expect(goblin.body).not.toContain('.png');
  });

  it('stamps the per-entry open license and source book for attribution', async () => {
    const { entries } = await fetchPf2eSection(fake.baseUrl, 'creatures', silentLogger);
    const goblin = entries.find((e) => e.name === 'Goblin Warrior')!;
    expect(goblin.license).toBe('ORC');
    expect(goblin.source).toBe('Pathfinder Monster Core');
  });

  it('maps spells (rank/traditions) -> spell', async () => {
    const { entries } = await fetchPf2eSection(fake.baseUrl, 'spells', silentLogger);
    const fireball = entries.find((e) => e.name === 'Fireball')!;
    expect(fireball.type).toBe('spell');
    const data = JSON.parse(fireball.dataJson!);
    expect(data.rank).toBe(3);
    expect(data.traditions).toEqual(['arcane', 'primal']);
  });

  it('maps equipment -> item, ancestries -> race, classes -> class, backgrounds -> feat, conditions -> condition', async () => {
    const [equipment, ancestries, classes, backgrounds, conditions] = await Promise.all([
      fetchPf2eSection(fake.baseUrl, 'equipment', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'ancestries', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'classes', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'backgrounds', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'conditions', silentLogger),
    ]);
    expect(equipment.entries[0].type).toBe('item');
    expect(ancestries.entries[0].type).toBe('race');
    expect(classes.entries[0].type).toBe('class');
    expect(backgrounds.entries[0].type).toBe('feat');
    expect(conditions.entries.map((e) => e.name).sort()).toEqual(['Frightened', 'Off-Guard']);
    expect(conditions.entries[0].type).toBe('condition');
  });

  it('exposes the section -> rule-entry-type mapping and a complete section list', () => {
    expect(entryTypeForSection('creatures')).toBe('monster');
    expect(entryTypeForSection('ancestries')).toBe('race');
    expect(entryTypeForSection('backgrounds')).toBe('feat');
    expect(entryTypeForSection('vehicles')).toBe('item');
    expect(ALL_PF2E_SECTIONS).toHaveLength(9);
  });
});

describe('pf2e-importer — de-duplication + malformed rows', () => {
  let fake: FakePf2e;
  beforeAll(async () => {
    fake = await startFakePf2eDuplicates();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('collapses a same-name creature from two source books to one entry, skips the malformed hit', async () => {
    const { entries, dedupedCount, skippedCount } = await fetchPf2eSection(fake.baseUrl, 'creatures', silentLogger);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Goblin Warrior');
    expect(dedupedCount).toBe(1); // second same-name book collapsed
    expect(skippedCount).toBe(1); // the _source-less hit
  });
});

describe('pf2e-importer — mixed-row source-type guard (issue #326)', () => {
  let fake: FakePf2e;
  beforeAll(async () => {
    fake = await startFakePf2eMixed();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('skips a stray row whose SOURCE type does not match the section AoN type', async () => {
    // The `backgrounds` section maps to entry type `feat`, so a stray `feat` source row
    // would slip past the old `entry.type !== entryType` guard (feat === feat). The
    // corrected guard compares src.type against the AoN type (`background`) and drops it.
    const { entries, skippedCount } = await fetchPf2eSection(fake.baseUrl, 'backgrounds', silentLogger);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Acolyte');
    expect(entries.some((e) => e.name === 'Power Attack')).toBe(false);
    expect(skippedCount).toBe(1); // the stray feat row
  });
});

describe('pf2e-importer — license fallback', () => {
  it('exports a sane OGL/ORC default license', () => {
    expect(PF2E_DEFAULT_LICENSE).toMatch(/OGL|ORC/);
  });
});
