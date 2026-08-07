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
import { createServer, type Server as HttpServer } from 'node:http';

const BODY_CAP = 50_000; // RuleEntry.body schema cap (packages/schema); no entry may exceed it.

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
    const entries = buildChapterEntries(chapter, big, { warn() {}, info() {} });

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

  it('keeps every slug unique even when MANY headings share the same slug base (no data loss)', () => {
    // Regression for the reserveSlug dedupe bug: after MAX_SLUG_DEDUPE_ATTEMPTS (1000) bounded
    // suffix tries, the old code appended the final candidate unconditionally, which could hand
    // back a slug already in use — a duplicate the later same-slug de-dupe would silently drop.
    // Here EVERY `##` heading is identical ("Dup"), so all blocks share the base
    // `book1-dup--dup`. With well over 1000 such blocks we force the fallback path; every
    // resulting slug must still be unique and every unique token must survive.
    const chapter = { path: 'book1/dup.md', title: 'Dup', section: 'book1' as const };
    const blockCount = 1100; // > MAX_SLUG_DEDUPE_ATTEMPTS, so the bounded loop is exhausted
    // Each block is small enough to stay a single entry (well under the cap), but there are
    // enough of them that the chapter as a whole is oversized and fans out one entry per `##`.
    const filler = 'filler words to pad the block body while staying under the entry cap. ';
    const blocks = Array.from({ length: blockCount }, (_, i) => `## Dup\n\n[UNIQTOK_${i}] ${filler}`);
    const md = `# Dup\n\nChapter intro.\n\n${blocks.join('\n\n')}`;
    expect(md.length).toBeGreaterThan(BODY_CAP); // precondition: oversized, so it fans out per heading

    const entries = buildChapterEntries(chapter, md, { warn() {}, info() {} });

    // One entry per identical-heading block (plus the chapter-intro lead).
    expect(entries.length).toBeGreaterThanOrEqual(blockCount);
    // The core guarantee: NO two entries share a slug, despite the shared base.
    const slugs = entries.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    // NO content lost: every unique token appears in exactly one entry body.
    const perToken = new Array(blockCount).fill(0);
    for (const e of entries) {
      for (let i = 0; i < blockCount; i++) {
        if (e.body.includes(`[UNIQTOK_${i}]`)) perToken[i] += 1;
      }
    }
    for (let i = 0; i < blockCount; i++) {
      expect(perToken[i]).toBe(1);
    }
  });

  it('returns no entries for an empty chapter body', () => {
    const chapter = { path: 'book1/skills.md', title: 'Skills', section: 'book1' as const };
    expect(buildChapterEntries(chapter, '   \n\n')).toEqual([]);
  });

  it('splits an oversized `##` block (bigger than the cap on its own) at `###`/paragraphs WITHOUT losing content', () => {
    const chapter = { path: 'book1/character-creation.md', title: 'Character Creation', section: 'book1' as const };
    // One `##` block whose body alone far exceeds the cap, built from many `###` sub-sections,
    // each carrying a UNIQUE token so we can prove every piece survives the split.
    const subCount = 24;
    const subs = Array.from(
      { length: subCount },
      (_, i) => `### Sub Section ${i}\n\nTOKEN_${i} ${'careerword '.repeat(1800)}`,
    );
    const md = `# Character Creation\n\nChapter intro paragraph.\n\n## Careers\n\n${subs.join('\n\n')}`;
    expect(md.length).toBeGreaterThan(BODY_CAP); // precondition: the `##` block is genuinely oversized

    const entries = buildChapterEntries(chapter, md, { warn() {}, info() {} });

    // Fans out into multiple entries, none over the body cap.
    expect(entries.length).toBeGreaterThan(1);
    for (const e of entries) {
      expect(e.body.length).toBeLessThanOrEqual(BODY_CAP);
      expect(e.type).toBe('section');
      expect(e.license).toBe(CEPHEUS_LICENSE);
    }
    // Slugs are unique and derive from the chapter + heading, with numbered continuations.
    const slugs = entries.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain('book1-character-creation'); // chapter-intro lead entry
    expect(slugs.some((s) => s.startsWith('book1-character-creation--careers'))).toBe(true);
    // NO content lost: every unique token appears in exactly one entry body.
    const combined = entries.map((e) => e.body).join('\n');
    for (let i = 0; i < subCount; i++) {
      expect(combined).toContain(`TOKEN_${i}`);
    }
  });

  it('splits an oversized chapter with NO `##` headings at paragraph boundaries WITHOUT losing content', () => {
    const chapter = { path: 'book3/worlds.md', title: 'Worlds', section: 'book3' as const };
    const paraCount = 40;
    const paras = Array.from({ length: paraCount }, (_, i) => `NOHEAD_${i} ${'worldword '.repeat(1600)}`);
    const md = `# Worlds\n\n${paras.join('\n\n')}`; // a single `#` title, then many big paragraphs, no `##`
    expect(md.length).toBeGreaterThan(BODY_CAP);

    const entries = buildChapterEntries(chapter, md, { warn() {}, info() {} });

    expect(entries.length).toBeGreaterThan(1);
    for (const e of entries) expect(e.body.length).toBeLessThanOrEqual(BODY_CAP);
    // First entry keeps the chapter slug; overflow spills into `…-part-N` continuations.
    expect(entries[0].slug).toBe('book3-worlds');
    expect(entries.slice(1).every((e) => e.slug.startsWith('book3-worlds-part-'))).toBe(true);
    const combined = entries.map((e) => e.body).join('\n');
    for (let i = 0; i < paraCount; i++) {
      expect(combined).toContain(`NOHEAD_${i}`);
    }
  });

  it('hard-chunks a single indivisible over-cap unit on char boundaries (lossless) and warns', () => {
    const chapter = { path: 'book1/equipment.md', title: 'Equipment', section: 'book1' as const };
    const solid = 'X'.repeat(BODY_CAP + 10_000); // one unbroken run — no heading/paragraph boundary
    const md = `# Equipment\n\n${solid}`;
    const warns: string[] = [];

    const entries = buildChapterEntries(chapter, md, { warn: (m) => warns.push(m), info() {} });

    expect(entries.length).toBeGreaterThan(1);
    for (const e of entries) expect(e.body.length).toBeLessThanOrEqual(BODY_CAP);
    // A warning was logged for the indivisible unit, but the text was preserved, not truncated:
    // every 'X' survives across the continuation entries.
    expect(warns.some((w) => /hard-chunk/i.test(w))).toBe(true);
    const totalX = entries.reduce((sum, e) => sum + (e.body.match(/X/g)?.length ?? 0), 0);
    expect(totalX).toBe(solid.length);
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

describe('cepheus-importer — HTTP 429 retry (Retry-After honored)', () => {
  let server: HttpServer;
  let baseUrl: string;
  const hits = new Map<string, number>();

  beforeAll(async () => {
    // Serve HTTP 429 (with Retry-After: 0) on the FIRST hit of each path, then a real chapter
    // on the retry — proving 429 is treated as transient and the backoff respects Retry-After.
    server = createServer((req, res) => {
      const key = req.url ?? '';
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      if (n === 1) {
        res.statusCode = 429;
        res.setHeader('Retry-After', '0'); // retry immediately
        res.end('rate limited');
        return;
      }
      res.setHeader('content-type', 'text/markdown');
      res.end(`# Chapter ${key}\n\nOpen game content body for ${key}.`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to bind fake 429 server');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('retries a 429 and completes the book once the rate limit clears', async () => {
    const warns: string[] = [];
    const { entries, skippedCount } = await fetchCepheusSection(baseUrl, 'reference', {
      warn: (m) => warns.push(m),
      info() {},
    });

    // reference = about + introduction + legal → all 3 fetched (each after one 429 retry).
    expect(entries.map((e) => e.slug).sort()).toEqual(['about', 'introduction', 'legal'].sort());
    expect(skippedCount).toBe(0);
    // Each chapter was hit twice (429, then 200) and the retry logged a 429 reason.
    for (const [, count] of hits) expect(count).toBe(2);
    expect(warns.some((w) => /HTTP 429/.test(w))).toBe(true);
  });
});
