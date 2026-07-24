import {
  fetchDataswornDocument,
  mapDataswornSection,
  entryTypeForDataswornSection,
  ALL_DATASWORN_SECTIONS,
  DATASWORN_LICENSE,
  type DataswornDocument,
} from '../../src/modules/rules/datasworn-importer';
import { isOpenLicense } from '@campfire/schema';
import { startFakeDatasworn, type FakeDatasworn } from '../fake-datasworn';

/**
 * Proves the datasworn Starforged importer (issue #405) against a small REAL Starforged
 * sample served by an in-process fake server (test/fake-datasworn.ts → the fixture extracted
 * verbatim from the canonical rsek/datasworn file). Focus: the whole-document fetch/validate,
 * the honest section mapping (npcs→monster, assets→item, moves/oracles/truths→section), the
 * RECURSIVE oracle flattening (collections-of-collections), and per-entry CC-BY-4.0
 * attribution. A silent logger keeps test output clean.
 */
const silentLogger = { warn: () => {}, info: () => {} };

describe('datasworn-importer — real-sample mapping (#405)', () => {
  let fake: FakeDatasworn;
  let doc: DataswornDocument;

  beforeAll(async () => {
    fake = await startFakeDatasworn();
    doc = await fetchDataswornDocument(fake.documentUrl, silentLogger);
  });

  afterAll(async () => {
    await fake.close();
  });

  it('fetches + validates the whole document once', () => {
    expect(doc.title).toBe('Ironsworn: Starforged Rulebook');
    expect(doc.license).toBe('https://creativecommons.org/licenses/by/4.0');
  });

  it('maps NPCs to monster statblocks with rank/nature and folds variants into the entry', () => {
    const { entries, skippedCount } = mapDataswornSection(doc, 'npcs', silentLogger);
    expect(skippedCount).toBe(0);
    expect(entryTypeForDataswornSection('npcs')).toBe('monster');
    const chiton = entries.find((e) => e.name === 'Chiton');
    expect(chiton).toBeDefined();
    expect(chiton!.type).toBe('monster');
    expect(chiton!.summary).toContain('Rank 2');
    expect(chiton!.summary).toContain('Monster');
    // Variants are folded into the parent (kept as one creature, not exploded into rows).
    expect(chiton!.body).toContain('Chiton queen');
    const data = JSON.parse(chiton!.dataJson!);
    expect(data.rank).toBe('2');
    expect(data.features.length).toBeGreaterThan(0);
    expect(Array.isArray(data.variants)).toBe(true);
    expect(data.variants.length).toBe(2);
    // Stable, collision-free slug derived from the datasworn _id path.
    expect(chiton!.slug).toBe('npcs-sample-npcs-chiton');
  });

  it('maps assets to items with category + abilities', () => {
    const { entries } = mapDataswornSection(doc, 'assets', silentLogger);
    expect(entryTypeForDataswornSection('assets')).toBe('item');
    const starship = entries.find((e) => e.name === 'Starship');
    expect(starship).toBeDefined();
    expect(starship!.type).toBe('item');
    expect(starship!.summary).toBe('Command Vehicle');
    const data = JSON.parse(starship!.dataJson!);
    expect(data.category).toBe('Command Vehicle');
    expect(data.abilities.length).toBeGreaterThan(0);
    expect(starship!.body.length).toBeGreaterThan(0);
  });

  it('maps moves to reference sections with trigger + text', () => {
    const { entries } = mapDataswornSection(doc, 'moves', silentLogger);
    expect(entryTypeForDataswornSection('moves')).toBe('section');
    const begin = entries.find((e) => e.name === 'Begin a Session');
    expect(begin).toBeDefined();
    expect(begin!.type).toBe('section');
    expect(begin!.summary).toContain('Session Moves');
    expect(begin!.body).toContain('When you begin a significant session');
    const data = JSON.parse(begin!.dataJson!);
    expect(data.category).toBe('Session Moves');
    expect(data.rollType).toBe('no_roll');
  });

  it('RECURSIVELY flattens oracle collections-of-collections into leaf-table sections', () => {
    const { entries } = mapDataswornSection(doc, 'oracles', silentLogger);
    expect(entryTypeForDataswornSection('oracles')).toBe('section');
    // A leaf table directly under the top collection...
    const topLeaf = entries.find((e) => e.name === 'First Look');
    expect(topLeaf).toBeDefined();
    expect(topLeaf!.type).toBe('section');
    expect(topLeaf!.summary).toContain('Character Oracles');
    // ...and a leaf table nested one collection deeper (proves recursion).
    const nested = entries.find((e) => e.name === 'Given Name');
    expect(nested).toBeDefined();
    // The collection path records BOTH ancestor collection names.
    expect(nested!.summary).toContain('Character Oracles');
    expect(nested!.summary).toContain('Names');
    const data = JSON.parse(nested!.dataJson!);
    expect(data.collectionPath).toEqual(['Character Oracles', 'Names']);
    // Rows render into a markdown table body.
    expect(nested!.body).toContain('|');
    expect(data.dice).toBeTruthy();
  });

  it('maps truths to reference sections rendering their options', () => {
    const { entries } = mapDataswornSection(doc, 'truths', silentLogger);
    expect(entryTypeForDataswornSection('truths')).toBe('section');
    const cataclysm = entries.find((e) => e.name === 'Cataclysm');
    expect(cataclysm).toBeDefined();
    expect(cataclysm!.type).toBe('section');
    expect(cataclysm!.body).toContain('Sun Plague');
  });

  it('stamps CC-BY-4.0 licensing + attribution (with a license link) on every entry', () => {
    for (const section of ALL_DATASWORN_SECTIONS) {
      const { entries } = mapDataswornSection(doc, section, silentLogger);
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.type).toBe(entryTypeForDataswornSection(section));
        expect(e.name).not.toBe('');
        expect(e.license).toBe(DATASWORN_LICENSE);
        // The stamped license passes the shared open-license gate (the raw CC URL would not).
        expect(isOpenLicense(e.license)).toBe(true);
        // CC-BY obliges an attribution line with a link to the license.
        expect(e.attribution).toContain('CC BY 4.0');
        expect(e.attribution).toContain('https://creativecommons.org/licenses/by/4.0');
        expect(e.sourceUrl).toBeTruthy();
      }
    }
  });

  it('covers every declared section end-to-end', () => {
    for (const section of ALL_DATASWORN_SECTIONS) {
      const { entries } = mapDataswornSection(doc, section, silentLogger);
      expect(entries.every((e) => e.type === entryTypeForDataswornSection(section))).toBe(true);
    }
  });
});

describe('datasworn-importer — fetch validation guards (#405)', () => {
  let fake: FakeDatasworn;

  beforeAll(async () => {
    fake = await startFakeDatasworn();
  });

  afterAll(async () => {
    await fake.close();
  });

  it('rejects an HTTP error (404)', async () => {
    await expect(fetchDataswornDocument(`${fake.baseUrl}/missing.json`, silentLogger)).rejects.toThrow(/HTTP 404/);
  });

  it('rejects a non-JSON body', async () => {
    await expect(fetchDataswornDocument(`${fake.baseUrl}/not-json`, silentLogger)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a document missing all expected sections', async () => {
    await expect(fetchDataswornDocument(`${fake.baseUrl}/wrong-shape.json`, silentLogger)).rejects.toThrow(
      /none of the expected sections/,
    );
  });

  it('rejects a document declaring a non-open license', async () => {
    await expect(fetchDataswornDocument(`${fake.baseUrl}/non-open.json`, silentLogger)).rejects.toThrow(
      /non-open license/,
    );
  });
});
