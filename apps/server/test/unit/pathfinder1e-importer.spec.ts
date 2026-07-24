import {
  fetchPathfinder1eSection,
  importPathfinder1e,
  entryTypeForSection,
  ALL_PF1E_SECTIONS,
  PF1E_PACK_NAME,
  type Pf1eImportLogger,
} from '../../src/modules/rules/pathfinder1e-importer';
import { Pathfinder1eAdapter, PF1E_PACK_SLUG } from '@campfire/schema';
import {
  startFakePathfinder1e,
  startFakePathfinder1eMultiSource,
  startFakePathfinder1eWithBadPagination,
  type FakePathfinder1e,
  type FakePathfinder1eWithBadPagination,
} from '../fake-pathfinder1e';

/** A logger that records messages so the summary/warnings can be asserted without console spying. */
function recordingLogger(): Pf1eImportLogger & { warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  return { warns, infos, warn: (m) => warns.push(m), info: (m) => infos.push(m) };
}

/**
 * Unit tests for the Pathfinder 1e importer (issue #296), proven against a small in-process
 * fake SRD server serving REAL PF1e OGL values (test/fake-pathfinder1e.ts) — the same style as
 * the Open5e importer's fake-server test. Covers per-section field mapping, pagination, the
 * (name,type) de-dupe with canonical-source preference (#143), OGL license/attribution
 * stamping, the cross-origin pagination guard, and malformed-row skip accounting. Bulk live
 * ingest runs via the normal background install-job path; these prove the mapping/hardening.
 */
describe('pathfinder1e-importer — section mapping', () => {
  let fake: FakePathfinder1e;
  beforeAll(async () => {
    fake = await startFakePathfinder1e();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('maps a real Goblin statblock (ascending AC, CR fraction, saves, ability scores, native Init)', async () => {
    const { entries } = await fetchPathfinder1eSection(fake.baseUrl, 'monsters', recordingLogger());
    expect(entries).toHaveLength(2);
    const goblin = entries.find((e) => e.name === 'Goblin')!;
    expect(goblin.type).toBe('monster');
    expect(goblin.slug).toBe('goblin');
    expect(goblin.license).toBe('OGL v1.0a');
    expect(goblin.source).toBe('PFSRD Core Rulebook');
    const data = JSON.parse(goblin.dataJson!);
    expect(data.armorClass).toBe(16); // ascending AC preserved
    expect(data.challengeRating).toBe('1/3');
    expect(data.hitPoints).toBe(6);
    expect(data.initiative).toBe(6); // native Init (DEX+2 + Improved Initiative +4) — issue #764
    expect(data.saves).toEqual({ fort: 3, ref: 3, will: -1 });
    expect(data.abilityScores).toEqual({ str: 11, dex: 15, con: 12, int: 10, wis: 9, cha: 6 });
    expect(goblin.summary).toContain('CR 1/3');
  });

  it('maps Owlbear native Init (+1) and keeps both fixtures usable by the PF1e adapter (#764)', async () => {
    const { entries } = await fetchPathfinder1eSection(fake.baseUrl, 'monsters', recordingLogger());
    const goblin = JSON.parse(entries.find((e) => e.name === 'Goblin')!.dataJson!);
    const owlbear = JSON.parse(entries.find((e) => e.name === 'Owlbear')!.dataJson!);
    expect(owlbear.initiative).toBe(1);
    // Encounter path: adapter.mapStatblock(dataJson).abilityScores → initiativeModifier
    expect(Pathfinder1eAdapter.initiativeModifier(Pathfinder1eAdapter.mapStatblock(goblin).abilityScores)).toBe(6);
    expect(Pathfinder1eAdapter.initiativeModifier(Pathfinder1eAdapter.mapStatblock(owlbear).abilityScores)).toBe(1);
    // Characters (no native Init) still derive from DEX — same function, different input shape.
    expect(Pathfinder1eAdapter.initiativeModifier({ STR: 10, DEX: 14, CON: 12 })).toBe(2);
  });

  it('maps a spell with per-class levels and school, and follows pagination to page 2', async () => {
    const { entries } = await fetchPathfinder1eSection(fake.baseUrl, 'spells', recordingLogger());
    expect(entries.map((e) => e.name).sort()).toEqual(['Fireball', 'Mage Armor']); // page-2 entry landed
    const fireball = entries.find((e) => e.name === 'Fireball')!;
    expect(fireball.type).toBe('spell');
    const data = JSON.parse(fireball.dataJson!);
    expect(data.school).toBe('Evocation');
    expect(data.levels).toEqual({ sorcerer: 3, wizard: 3 });
    expect(data.savingThrow).toBe('Reflex half');
    expect(fireball.summary).toContain('Evocation');
    expect(fireball.summary).toContain('sorcerer 3');
  });

  it('maps a class with its 3.5e-family progressions (hit die / BAB track / good saves)', async () => {
    const { entries } = await fetchPathfinder1eSection(fake.baseUrl, 'classes', recordingLogger());
    const fighter = entries.find((e) => e.name === 'Fighter')!;
    const data = JSON.parse(fighter.dataJson!);
    expect(data).toEqual({ hitDie: 'd10', bab: 'full', goodSaves: ['Fort'] });
    expect(fighter.summary).toContain('BAB full');
  });

  it('maps items, conditions, races, and feats to the right entry types', async () => {
    const [items, conditions, races, feats] = await Promise.all([
      fetchPathfinder1eSection(fake.baseUrl, 'items', recordingLogger()),
      fetchPathfinder1eSection(fake.baseUrl, 'conditions', recordingLogger()),
      fetchPathfinder1eSection(fake.baseUrl, 'races', recordingLogger()),
      fetchPathfinder1eSection(fake.baseUrl, 'feats', recordingLogger()),
    ]);
    expect(items.entries[0].type).toBe('item');
    expect(conditions.entries.map((e) => e.name)).toEqual(['Prone', 'Shaken', 'Entangled']);
    expect(conditions.entries[0].type).toBe('condition');
    expect(races.entries[0].name).toBe('Dwarf');
    const feat = feats.entries[0];
    expect(feat.type).toBe('feat');
    expect(feat.summary).toContain('Prerequisite: Str 13');
  });

  it('exposes the section→entry-type map for all seven PF1e sections', () => {
    expect(ALL_PF1E_SECTIONS).toEqual(['spells', 'monsters', 'items', 'conditions', 'classes', 'races', 'feats']);
    expect(entryTypeForSection('monsters')).toBe('monster');
    expect(entryTypeForSection('races')).toBe('race');
  });
});

describe('pathfinder1e-importer — importPathfinder1e (persist-ready aggregate)', () => {
  let fake: FakePathfinder1e;
  beforeAll(async () => {
    fake = await startFakePathfinder1e();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('aggregates every section into a persist-ready pack under the PF1e slug + OGL license', async () => {
    const result = await importPathfinder1e(fake.baseUrl, ALL_PF1E_SECTIONS, recordingLogger());
    expect(result.slug).toBe(PF1E_PACK_SLUG);
    expect(result.slug).toBe('pathfinder-1e'); // matches the adapter registry key
    expect(result.name).toBe(PF1E_PACK_NAME);
    expect(result.license).toBe('OGL v1.0a');
    // 2 spells + 2 monsters + 1 item + 3 conditions + 2 classes + 1 race + 1 feat = 12
    expect(result.entries).toHaveLength(12);
    expect(result.totalSkipped).toBe(0);
    const types = new Set(result.entries.map((e) => e.type));
    expect([...types].sort()).toEqual(['class', 'condition', 'feat', 'item', 'monster', 'race', 'spell']);
  });
});

describe('pathfinder1e-importer — de-dupe across sources (issue #143)', () => {
  let fake: FakePathfinder1e;
  beforeAll(async () => {
    fake = await startFakePathfinder1eMultiSource();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('collapses a same-name monster to one canonical (PFSRD/Core) row', async () => {
    const logger = recordingLogger();
    const { entries, dedupedCount } = await fetchPathfinder1eSection(fake.baseUrl, 'monsters', logger);
    expect(entries).toHaveLength(1);
    expect(dedupedCount).toBe(1);
    const goblin = entries[0];
    expect(goblin.source).toBe('PFSRD Core Rulebook'); // Core preferred over the homebrew book
    expect(JSON.parse(goblin.dataJson!).armorClass).toBe(16); // the Core row's AC, not homebrew's 14
    expect(logger.infos.some((m) => m.includes('de-duped'))).toBe(true);
  });
});

describe('pathfinder1e-importer — hardening', () => {
  let fake: FakePathfinder1eWithBadPagination;
  beforeAll(async () => {
    fake = await startFakePathfinder1eWithBadPagination();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('refuses a cross-origin pagination link and skips a malformed row', async () => {
    const logger = recordingLogger();
    const { entries, skippedCount } = await fetchPathfinder1eSection(fake.baseUrl, 'monsters', logger);
    expect(entries.map((e) => e.name)).toEqual(['Goblin']); // only the well-formed same-origin row
    expect(fake.evilWasHit()).toBe(false); // cross-origin `next` was NOT followed
    expect(skippedCount).toBeGreaterThanOrEqual(2); // 1 malformed row + 1 refused cross-origin page
    expect(logger.warns.some((m) => m.includes('cross-origin'))).toBe(true);
  });

  it('wraps a dead endpoint as a BadRequestException (clean 400, not a raw fetch error)', async () => {
    await expect(fetchPathfinder1eSection('http://127.0.0.1:1/api/v1', 'spells', recordingLogger())).rejects.toMatchObject({
      status: 400,
    });
  });
});
