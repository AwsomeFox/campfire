import {
  fetchArchmageSection,
  decodeEntities,
  htmlToMarkdown,
  slugify,
  ARCHMAGE_LICENSE,
  ARCHMAGE_SOURCE,
} from '../../src/modules/rules/archmage-importer';
import { startFakeArchmage, type FakeArchmage } from '../fake-archmage';

/**
 * Sample test for the 13th Age (Archmage Engine) importer (issue #298), the HTML analogue
 * of the Open5e importer's fake-server test. It runs the real HTML-parsing code path against
 * TRIMMED-BUT-REAL SRD markup (test/fake-archmage.ts: actual Bear / Dire Bear statblocks and
 * the real Conditions section), proving the fetch → convert → ImportedEntry mapping without
 * network access. Bulk ingest of every SRD page is left to the install-job path.
 */
describe('archmage-importer — HTML helpers', () => {
  it('decodes the entities the SRD actually uses', () => {
    expect(decodeEntities('don&#8217;t &#8211; a&#8212;b &amp; c&nbsp;d')).toBe('don’t – a—b & c d');
  });

  it('slugifies entry names', () => {
    expect(slugify('Dire Bear')).toBe('dire-bear');
    expect(slugify('Coup de Grace')).toBe('coup-de-grace');
  });

  it('converts light HTML to markdown (headings, bold, breaks)', () => {
    const md = htmlToMarkdown('<p><b>Bite +7 vs. AC</b> &#8212; 6 damage<br /><i>Natural even hit:</i> more</p>');
    expect(md).toContain('**Bite +7 vs. AC**');
    expect(md).toContain('*Natural even hit:*');
    expect(md).toContain('6 damage');
  });
});

describe('archmage-importer — section fetch/parse', () => {
  let fake: FakeArchmage;

  beforeAll(async () => {
    fake = await startFakeArchmage();
  });

  afterAll(async () => {
    await fake.close();
  });

  it('parses monster statblocks (level, AC/PD/MD/HP, initiative, role/type) and skips prose headings', async () => {
    const { entries, skippedCount } = await fetchArchmageSection(fake.baseUrl, 'monsters', { warn() {}, info() {} });

    // "Building Combats" is a prose <h3> with no statblock — it must not become an entry.
    expect(entries.map((e) => e.name).sort()).toEqual(['Bear', 'Dire Bear']);
    expect(skippedCount).toBe(0);

    const bear = entries.find((e) => e.slug === 'bear')!;
    expect(bear.type).toBe('monster');
    expect(bear.license).toBe(ARCHMAGE_LICENSE);
    expect(bear.source).toBe(ARCHMAGE_SOURCE);
    const bearData = JSON.parse(bear.dataJson!);
    expect(bearData).toMatchObject({
      level: 2,
      size: 'Normal',
      role: 'Troop',
      creatureType: 'Beast',
      initiative: 4,
      ac: 17,
      pd: 16,
      md: 12,
      hp: 45,
    });
    expect(bear.summary).toContain('level 2');
    expect(bear.body).toContain('17'); // statblock rendered into the body

    const dire = entries.find((e) => e.slug === 'dire-bear')!;
    const direData = JSON.parse(dire.dataJson!);
    expect(direData).toMatchObject({ level: 4, size: 'Large', ac: 19, pd: 19, md: 14, hp: 130, initiative: 7 });
  });

  it('parses the Conditions section (scoped to <h4> entries, excluding sibling <h3> prose)', async () => {
    const { entries } = await fetchArchmageSection(fake.baseUrl, 'conditions', { warn() {}, info() {} });

    // Only the conditions inside the "Conditions" <h3> scope — not the escalation-die or
    // coup-de-grace sibling <h3> sections.
    expect(entries.map((e) => e.name).sort()).toEqual(['Confused', 'Dazed', 'Fear']);
    for (const e of entries) {
      expect(e.type).toBe('condition');
      expect(e.license).toBe(ARCHMAGE_LICENSE);
      expect(e.dataJson).toBeNull();
    }
    const fear = entries.find((e) => e.slug === 'fear')!;
    expect(fear.body).toContain('escalation die');
  });
});
