import {
  buildChapterEntries,
  chapterSlug,
  fetchCepheusSection,
  firstParagraph,
  normalizeMarkdown,
  slugify,
  CEPHEUS_CHAPTERS,
  CEPHEUS_LICENSE,
  CEPHEUS_SOURCE,
  CEPHEUS_ATTRIBUTION,
  ALL_CEPHEUS_SECTIONS,
} from '../../src/modules/rules/cepheus-importer';
import { startFakeCepheus, type FakeCepheus } from '../fake-cepheus';

/**
 * Unit tests for the Cepheus Engine SRD importer (issue #406), the Markdown analogue of the
 * Open5e importer's fake-server test. Pure helpers are tested directly; the fetch/parse path
 * runs against an in-process fake mdBook server (test/fake-cepheus.ts), so no network is used.
 */

describe('cepheus-importer — helpers', () => {
  it('derives a stable, unique slug from a chapter path', () => {
    expect(chapterSlug('book1/skills.md')).toBe('book1-skills');
    expect(chapterSlug('introduction.md')).toBe('introduction');
    // The two "introduction" chapters (root vs vds) never collide.
    expect(chapterSlug('vds/introduction.md')).toBe('vds-introduction');
  });

  it('slugifies headings for sub-section slugs', () => {
    expect(slugify('Career Tables')).toBe('career-tables');
    expect(slugify('On Alien Species')).toBe('on-alien-species');
  });

  it('normalizes markdown: strips scripts/BOM/mdBook directives, collapses blank runs', () => {
    const md = '\uFEFF# Title\n\n{{#include foo.md}}\n<script>evil()</script>\n\n\n\nBody text.';
    const out = normalizeMarkdown(md);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('{{#include');
    expect(out.startsWith('# Title')).toBe(true);
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('extracts the first prose paragraph for the summary (skipping the heading)', () => {
    const md = '# Skills\n\nCharacters use skills to overcome challenges.\n\n## Skill Checks\n\nRoll 2D6.';
    expect(firstParagraph(md)).toBe('Characters use skills to overcome challenges.');
  });
});

describe('cepheus-importer — chapter → section entries', () => {
  it('maps a normal chapter to a single section entry with OGL license + attribution', () => {
    const chapter = { path: 'book1/skills.md', title: 'Skills', section: 'book1' as const };
    const md = '# Chapter 2: Skills\n\nCharacters use their skills to overcome challenges.\n\n## Skill Checks\n\nRoll 2D6 + DM.';
    const entries = buildChapterEntries(chapter, md);

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.type).toBe('section');
    expect(entry.slug).toBe('book1-skills');
    expect(entry.name).toBe('Skills');
    expect(entry.license).toBe(CEPHEUS_LICENSE);
    expect(entry.source).toBe(CEPHEUS_SOURCE);
    expect(entry.attribution).toBe(CEPHEUS_ATTRIBUTION);
    expect(entry.sourceUrl).toContain('orffen/cepheus-srd');
    expect(entry.body).toContain('Roll 2D6');
    expect(entry.summary).toContain('overcome challenges');
    const data = JSON.parse(entry.dataJson!);
    expect(data).toMatchObject({ book: 'Book 1: Characters', chapter: 'Skills', chapterPath: 'book1/skills.md' });
  });

  it('splits an oversized chapter at ## headings into multiple capped entries with stable slugs', () => {
    const chapter = { path: 'book1/equipment.md', title: 'Equipment', section: 'book1' as const };
    const big =
      '# Equipment\n\nIntro paragraph.\n\n' +
      ['Armor', 'Weapons', 'Computers'].map((h) => `## ${h}\n\n${'word '.repeat(12000)}`).join('\n\n');
    const entries = buildChapterEntries(chapter, big);

    // A lead entry (chapter intro) plus one per ## heading.
    expect(entries.length).toBeGreaterThan(1);
    // Every entry stays under the RuleEntry.body cap (50,000).
    for (const e of entries) {
      expect(e.body.length).toBeLessThanOrEqual(50_000);
      expect(e.type).toBe('section');
      expect(e.license).toBe(CEPHEUS_LICENSE);
    }
    // Slugs are unique and derived from the chapter + heading.
    const slugs = entries.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain('book1-equipment'); // the lead entry
    expect(slugs).toContain('book1-equipment--weapons');
    const weapons = entries.find((e) => e.slug === 'book1-equipment--weapons')!;
    expect(weapons.name).toBe('Equipment: Weapons');
    expect(JSON.parse(weapons.dataJson!).heading).toBe('Weapons');
  });

  it('returns no entries for an empty chapter body', () => {
    const chapter = { path: 'book1/skills.md', title: 'Skills', section: 'book1' as const };
    expect(buildChapterEntries(chapter, '   \n\n')).toEqual([]);
  });

  it('the chapter manifest mirrors the mdBook books and excludes interactive tool pages', () => {
    // ~28 chapters across the five books (tools deliberately excluded).
    expect(CEPHEUS_CHAPTERS.length).toBeGreaterThanOrEqual(25);
    expect(CEPHEUS_CHAPTERS.some((c) => c.path.startsWith('tools/'))).toBe(false);
    expect(new Set(CEPHEUS_CHAPTERS.map((c) => c.section))).toEqual(new Set(ALL_CEPHEUS_SECTIONS));
    // Every chapter slug is unique (the (pack,type,slug) index depends on it).
    const slugs = CEPHEUS_CHAPTERS.map((c) => chapterSlug(c.path));
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('cepheus-importer — section fetch/parse (fake mdBook server)', () => {
  let fake: FakeCepheus;

  beforeAll(async () => {
    fake = await startFakeCepheus();
  });

  afterAll(async () => {
    await fake.close();
  });

  it('fetches every chapter of the "reference" book and maps them to section entries', async () => {
    const { entries, skippedCount } = await fetchCepheusSection(fake.baseUrl, 'reference', { warn() {}, info() {} });

    // reference = about + introduction + legal (3 chapters, all under the body cap).
    expect(entries.map((e) => e.slug).sort()).toEqual(['about', 'introduction', 'legal'].sort());
    expect(skippedCount).toBe(0);
    for (const e of entries) {
      expect(e.type).toBe('section');
      expect(e.license).toBe(CEPHEUS_LICENSE);
      expect(e.attribution).toBe(CEPHEUS_ATTRIBUTION);
      expect(e.body.length).toBeGreaterThan(0);
    }
  });

  it('splits the oversized Equipment chapter into several capped entries within book1', async () => {
    const { entries } = await fetchCepheusSection(fake.baseUrl, 'book1', { warn() {}, info() {} });

    // The oversized equipment chapter fans out into a lead + per-heading entries.
    const equip = entries.filter((e) => e.slug === 'book1-equipment' || e.slug.startsWith('book1-equipment--'));
    expect(equip.length).toBeGreaterThan(1);
    for (const e of entries) expect(e.body.length).toBeLessThanOrEqual(50_000);
    // The non-oversized chapters remain a single entry each.
    expect(entries.some((e) => e.slug === 'book1-skills')).toBe(true);
  });
});
