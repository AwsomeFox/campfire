import {
  fetchStarfinderSection,
  entryTypeForSection,
  ALL_STARFINDER_SECTIONS,
} from '../../src/modules/rules/starfinder-importer';
import { startFakeStarfinder, type FakeStarfinder } from '../fake-starfinder';

/**
 * Proves the Starfinder importer (issue #297) against a small REAL Starfinder sample served
 * by an in-process fake SRD JSON API (test/fake-starfinder.ts) — the same fetch→map→dataJson
 * path a full install-job run exercises a section at a time. Focus is the sci-fi mapping:
 * EAC/KAC + Stamina/HP folded into monster dataJson, and starships/vehicles folded into
 * ruleEntry.type 'item' with a category tag. A silent logger keeps test output clean.
 */
const silentLogger = { warn: () => {}, info: () => {} };

describe('starfinder-importer — real-sample mapping', () => {
  let fake: FakeStarfinder;

  beforeAll(async () => {
    fake = await startFakeStarfinder();
  });

  afterAll(async () => {
    await fake.close();
  });

  it('maps an alien statblock with EAC/KAC + Stamina/HP into dataJson', async () => {
    const { entries, skippedCount } = await fetchStarfinderSection(fake.baseUrl, 'monsters', silentLogger);
    expect(skippedCount).toBe(0);
    const goblin = entries.find((e) => e.name === 'Space Goblin Zaperator');
    expect(goblin).toBeDefined();
    expect(goblin!.type).toBe('monster');
    expect(goblin!.summary).toContain('CR 1/3');
    const data = JSON.parse(goblin!.dataJson!);
    expect(data.eac).toBe(10);
    expect(data.kac).toBe(12);
    expect(data.hitPoints).toBe(6);
    expect(data.challengeRating).toBe('1/3');
    // Real OGL attribution is stamped per-entry.
    expect(goblin!.license).toContain('Open Game License');
    expect(goblin!.source).toBe('Starfinder Core Rulebook');
  });

  it('maps a spell with level + class list', async () => {
    const { entries } = await fetchStarfinderSection(fake.baseUrl, 'spells', silentLogger);
    const mm = entries.find((e) => e.name === 'Magic Missile');
    expect(mm).toBeDefined();
    expect(mm!.type).toBe('spell');
    const data = JSON.parse(mm!.dataJson!);
    expect(data.level).toBe(1);
    expect(data.classes).toEqual(['Mystic', 'Technomancer']);
  });

  it('maps equipment with item level + credits cost', async () => {
    const { entries } = await fetchStarfinderSection(fake.baseUrl, 'equipment', silentLogger);
    const pistol = entries.find((e) => e.name === 'Laser Pistol, Azimuth');
    expect(pistol).toBeDefined();
    expect(pistol!.type).toBe('item');
    const data = JSON.parse(pistol!.dataJson!);
    expect(data.level).toBe(1);
    expect(data.cost).toBe(350);
    expect(data.damage).toBe('1d4 F');
  });

  it('maps a class with Stamina/HP per level + key ability', async () => {
    const { entries } = await fetchStarfinderSection(fake.baseUrl, 'classes', silentLogger);
    const soldier = entries.find((e) => e.name === 'Soldier');
    expect(soldier).toBeDefined();
    const data = JSON.parse(soldier!.dataJson!);
    expect(data.staminaPerLevel).toBe(7);
    expect(data.hpPerLevel).toBe(7);
    expect(data.keyAbility).toBe('Strength or Dexterity');
    // Class prose comes from features[] (top-level desc is empty).
    expect(soldier!.body).toContain('Primary Fighting Style');
  });

  it('folds starships into ruleEntry.type item with a starship category', async () => {
    const { entries } = await fetchStarfinderSection(fake.baseUrl, 'starships', silentLogger);
    expect(entryTypeForSection('starships')).toBe('item');
    const pegasus = entries.find((e) => e.name === 'Pegasus');
    expect(pegasus).toBeDefined();
    expect(pegasus!.type).toBe('item');
    const data = JSON.parse(pegasus!.dataJson!);
    expect(data.category).toBe('starship');
    expect(data.tier).toBe(3);
    expect(data.ac).toBe(15);
  });

  it('folds vehicles into ruleEntry.type item with a vehicle category + EAC/KAC', async () => {
    const { entries } = await fetchStarfinderSection(fake.baseUrl, 'vehicles', silentLogger);
    expect(entryTypeForSection('vehicles')).toBe('item');
    const cycle = entries.find((e) => e.name === 'Enercycle');
    expect(cycle).toBeDefined();
    const data = JSON.parse(cycle!.dataJson!);
    expect(data.category).toBe('vehicle');
    expect(data.eac).toBe(10);
    expect(data.kac).toBe(12);
  });

  it('maps conditions (body from descriptions[], no dataJson)', async () => {
    const { entries } = await fetchStarfinderSection(fake.baseUrl, 'conditions', silentLogger);
    const ff = entries.find((e) => e.name === 'Flat-Footed');
    expect(ff).toBeDefined();
    expect(ff!.type).toBe('condition');
    expect(ff!.dataJson).toBeNull();
    expect(ff!.body).toContain('-2 penalty to AC');
  });

  it('covers every declared section end-to-end', async () => {
    for (const section of ALL_STARFINDER_SECTIONS) {
      const { entries } = await fetchStarfinderSection(fake.baseUrl, section, silentLogger);
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.type).toBe(entryTypeForSection(section));
        expect(e.name).not.toBe('');
        expect(e.license).toContain('Open Game License');
      }
    }
  });
});
