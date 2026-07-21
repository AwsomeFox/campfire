import {
  fetchOsrSection,
  osrSource,
  OSR_SOURCES,
  entryTypeForOsrSection,
  ALL_OSR_SECTIONS,
  type OsrSectionResult,
} from '../../src/modules/rules/osr-importer';
import type { Open5eImportLogger } from '../../src/modules/rules/open5e-importer';
import { startFakeOsr, type FakeOsr } from '../fake-osr';

/**
 * Proves the OSR importer (issue #300) against a small SAMPLE of real Basic Fantasy RPG
 * content served by an in-process fake source (test/fake-osr.ts). Covers the mapping for
 * every section, the correct per-source license/attribution stamping (CC-BY-SA 4.0 for
 * Basic Fantasy, OGL for the retroclones — issue #143), pagination, bare-array vs page
 * shapes, and slug de-dupe. Bulk ingest of a full corpus runs through the existing
 * install-job path; this exercises the same fetch + mapping code that path uses.
 */

const silentLogger: Open5eImportLogger = { warn: () => {}, info: () => {} };

describe('OSR importer — Basic Fantasy sample', () => {
  let fake: FakeOsr;
  const bfrpg = osrSource('basic-fantasy');

  beforeAll(async () => {
    fake = await startFakeOsr();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('imports monsters across two pages, mapping HD/AC/THAC0 and stamping CC-BY-SA', async () => {
    const result = await fetchOsrSection(fake.baseUrl, 'monsters', bfrpg, silentLogger);
    const names = result.entries.map((e) => e.name).sort();
    // Goblin (page 1) + Skeleton (page 2) — proves the pagination loop pulled page 2.
    expect(names).toEqual(['Goblin', 'Skeleton']);

    const goblin = result.entries.find((e) => e.name === 'Goblin')!;
    expect(goblin.type).toBe('monster');
    expect(goblin.slug).toBe('goblin');
    const data = JSON.parse(goblin.dataJson!);
    expect(data.hitDice).toBe('1-1');
    expect(data.armorClass).toBe(13); // descending, preserved
    expect(data.armorClassAscending).toBe(6);
    expect(data.thac0).toBe(19);
    expect(data.morale).toBe(7);

    // Correct per-source license + attribution on every entry (issue #143).
    for (const e of result.entries) {
      expect(e.license).toContain('CC-BY-SA-4.0');
      expect(e.source).toContain('Basic Fantasy');
    }
  });

  it('imports spells (bare page) and collapses a duplicate slug', async () => {
    const result: OsrSectionResult = await fetchOsrSection(fake.baseUrl, 'spells', bfrpg, silentLogger);
    // Two unique slugs despite three rows (magic-missile appears twice).
    expect(result.entries.map((e) => e.slug).sort()).toEqual(['cure-light-wounds', 'magic-missile']);
    expect(result.dedupedCount).toBe(1);
    // First-seen wins: the canonical "Magic Missile", not the reprint.
    const mm = result.entries.find((e) => e.slug === 'magic-missile')!;
    expect(mm.name).toBe('Magic Missile');
    expect(JSON.parse(mm.dataJson!)).toMatchObject({ class: 'magic-user', level: 1 });
  });

  it('imports items and conditions from bare-array responses', async () => {
    const items = await fetchOsrSection(fake.baseUrl, 'items', bfrpg, silentLogger);
    expect(items.entries.map((e) => e.name).sort()).toEqual(['Leather Armor', 'Sword']);
    expect(items.entries.every((e) => e.type === 'item')).toBe(true);

    const conditions = await fetchOsrSection(fake.baseUrl, 'conditions', bfrpg, silentLogger);
    expect(conditions.entries.map((e) => e.name).sort()).toEqual(['Paralyzed', 'Petrified']);
    expect(conditions.entries.every((e) => e.type === 'condition' && e.dataJson === null)).toBe(true);
  });

  it('maps each section to the right rule-entry type', () => {
    expect(ALL_OSR_SECTIONS).toEqual(['monsters', 'spells', 'items', 'conditions']);
    expect(entryTypeForOsrSection('monsters')).toBe('monster');
    expect(entryTypeForOsrSection('spells')).toBe('spell');
    expect(entryTypeForOsrSection('items')).toBe('item');
    expect(entryTypeForOsrSection('conditions')).toBe('condition');
  });
});

describe('OSR importer — per-source license stamping (issue #143)', () => {
  it('stamps CC-BY-SA for Basic Fantasy and OGL for the retroclones — never mislabeled', () => {
    expect(osrSource('basic-fantasy').license).toContain('CC-BY-SA-4.0');
    for (const slug of ['osric', 'swords-wizardry', 'labyrinth-lord', 'old-school-essentials']) {
      expect(OSR_SOURCES[slug].license).toContain('OGL');
      expect(OSR_SOURCES[slug].license).not.toContain('CC-BY-SA');
    }
  });
  it('defaults an unknown/empty source to Basic Fantasy (the cleanest CC-BY-SA source)', () => {
    expect(osrSource(undefined).systemSlug).toBe('basic-fantasy');
    expect(osrSource('nonesuch').systemSlug).toBe('basic-fantasy');
  });
});
