import { BadRequestException } from '@nestjs/common';
import type { RuleEntryType } from '@campfire/schema';
import type { ImportedEntry, Open5eImportLogger } from './open5e-importer';

/**
 * Importer for the Cepheus Engine SRD (issue #406) — the 2D6 Classic-Era science-fiction
 * Open Gaming System published by Samardan Press. Unlike Open5e (a paginated JSON REST API)
 * or the OSR importer (a JSON contract), the Cepheus SRD is published as an mdBook: one raw
 * Markdown file per chapter under `src/` in the `orffen/cepheus-srd` GitHub repository
 * (mdbook branch). This importer FETCHES that raw Markdown over GitHub's raw CDN and maps
 * each chapter into a `section`-typed rule entry — the "section-level rules text" the issue
 * calls for — mirroring the sibling importers' contract (fetch-at-install → ImportedEntry[],
 * de-dupe, license/attribution stamping, timeout/retry hardening) with a Markdown front end.
 *
 * SOURCE (validated live 2026): the first-party mdBook conversion at
 * https://github.com/orffen/cepheus-srd (mdbook branch). The chapter manifest below mirrors
 * that book's `src/SUMMARY.md` table of contents — a stable, hardcoded map exactly like the
 * SECTION_TO_PATH maps in the OSR / 13th Age importers, so the importer never depends on
 * parsing SUMMARY.md at runtime. The interactive JavaScript generator pages under `src/tools`
 * (subsector / space-encounter generators) are DELIBERATELY excluded: they are embedded web
 * apps (<div>/<script>/<input> scaffolding), not rules prose, so importing them would add
 * placeholder-shaped entries rather than reference text.
 *
 * LICENSE & TRADEMARKS (from `src/legal.md`, per the issue): all SRD text is designated Open
 * Game Content under the **Open Game License v1.0a**, EXCEPT the trademarks "Cepheus Engine"
 * and "Samardan Press" and the titles of Samardan Press products. Every imported entry is
 * therefore stamped with the OGL 1.0a license and an attribution line that reproduces the
 * SRD's own OGL §15 copyright notice AND the trademark notice from legal.md, and explicitly
 * disclaims affiliation/endorsement — so the compendium never misrepresents a trademark or
 * claims a Samardan Press affiliation. Only Open Game Content is imported.
 *
 * SECTIONS: the Cepheus SRD has no per-statblock section vocabulary like Open5e's
 * spells/monsters/…; its content is organized as the mdBook's "books" (parts). This importer
 * imports the whole SRD — the same "import the full set" shape the PF2e/SF2e importers use —
 * and reports per-book progress. Chapters are grouped into the five parts of ALL_CEPHEUS_SECTIONS
 * purely for progress reporting; there is no meaningful per-section install filter (a passed
 * `sections` array is rejected server-side, see RulesService.SECTIONS_BY_SOURCE['cepheus']).
 *
 * OVERSIZED CHAPTERS: three chapters (Character Creation, Equipment, Vehicle Design) exceed
 * the 50,000-char RuleEntry.body cap. Rather than truncate (which would drop rules text), the
 * importer splits an oversized chapter into one entry per top-level (`##`) heading — the
 * "chapters/headings into section entries" the issue anticipates — each with a stable slug
 * derived from the chapter + heading. Chapters that fit the cap stay a single chapter-level
 * entry.
 */

/** Raw-Markdown base for the mdbook branch's `src/` directory (GitHub raw CDN — first-party, permanent). */
export const CEPHEUS_DEFAULT_BASE_URL = 'https://raw.githubusercontent.com/orffen/cepheus-srd/mdbook/src';
/** Human-facing repository URL, recorded as each entry's `sourceUrl` provenance. */
export const CEPHEUS_SOURCE_URL = 'https://github.com/orffen/cepheus-srd';
export const CEPHEUS_PACK_SLUG = 'cepheus-srd';
export const CEPHEUS_PACK_NAME = 'Cepheus Engine SRD';
export const CEPHEUS_LICENSE = 'Open Game License v1.0a';
/** Document label surfaced on each entry (RuleEntry.source), distinguishing entries by rulebook. */
export const CEPHEUS_SOURCE = 'Cepheus Engine System Reference Document';
/**
 * Attribution line stamped on every entry (issue #143 / #734). Reproduces the SRD's own OGL
 * §15 copyright notice and the `legal.md` trademark notice, and disclaims affiliation — so the
 * compendium credits the Open Game Content correctly and never misrepresents the "Cepheus
 * Engine"/"Samardan Press" trademarks as ours or implies endorsement.
 */
export const CEPHEUS_ATTRIBUTION =
  'Cepheus Engine System Reference Document, Copyright © 2016 Samardan Press; Author Jason "Flynn" Kemp. ' +
  'Open Game Content used under the Open Game License v1.0a. "Cepheus Engine" and "Samardan Press" are ' +
  'trademarks of Jason "Flynn" Kemp; their use here indicates neither affiliation with nor endorsement by ' +
  'Jason "Flynn" Kemp or Samardan Press.';

// Body cap kept just under the RuleEntry.body schema limit (50,000) so a single chapter that
// fits is stored whole; an oversized chapter is split at `##` headings (see splitOversized).
const MAX_ENTRY_BODY = 48_000;
const FETCH_TIMEOUT_MS = 30_000;
// Retry transient failures only (timeout / 5xx); a 4xx or malformed body won't improve on retry.
const PAGE_RETRY_BACKOFFS_MS = [1_000, 3_000];

/**
 * The five mdBook "parts" (books) of the SRD — used to group chapters for per-section install
 * progress. These are progress labels, NOT a per-statblock section filter.
 */
export type CepheusSection = 'reference' | 'book1' | 'book2' | 'book3' | 'vehicle-design';

export const ALL_CEPHEUS_SECTIONS: CepheusSection[] = ['reference', 'book1', 'book2', 'book3', 'vehicle-design'];

/** Human labels for the parts, used in the chapter name prefix and progress logs. */
const SECTION_LABEL: Record<CepheusSection, string> = {
  reference: 'Reference',
  book1: 'Book 1: Characters',
  book2: 'Book 2: Starships and Interstellar Travel',
  book3: 'Book 3: Referees',
  'vehicle-design': 'Vehicle Design System',
};

/** One chapter of the SRD: its `src/`-relative Markdown path, display title, and owning part. */
interface CepheusChapter {
  /** Path relative to the base URL, e.g. `book1/skills.md`. */
  path: string;
  /** Display title (mirrors SUMMARY.md), used as the entry name (chapter-level). */
  title: string;
  section: CepheusSection;
}

/**
 * The chapter manifest — mirrors `src/SUMMARY.md` on the mdbook branch. Hardcoded (not parsed
 * at runtime) exactly like the SECTION_TO_PATH maps in the sibling importers, so a change to
 * the book's front-matter/formatting can't break the importer. The interactive `tools/`
 * generator pages are intentionally omitted (see file header).
 */
export const CEPHEUS_CHAPTERS: CepheusChapter[] = [
  // Reference / front matter (about + introduction) and the legal notice (OGL text). Reproducing
  // the OGL text as a readable entry also satisfies OGL §10 ("include a copy of this License").
  { path: 'about.md', title: 'About', section: 'reference' },
  { path: 'introduction.md', title: 'Introduction', section: 'reference' },
  { path: 'legal.md', title: 'Legal & Open Game License', section: 'reference' },
  // Book 1: Characters
  { path: 'book1/character-creation.md', title: 'Character Creation', section: 'book1' },
  { path: 'book1/skills.md', title: 'Skills', section: 'book1' },
  { path: 'book1/psionics.md', title: 'Psionics', section: 'book1' },
  { path: 'book1/equipment.md', title: 'Equipment', section: 'book1' },
  { path: 'book1/personal-combat.md', title: 'Personal Combat', section: 'book1' },
  // Book 2: Starships and Interstellar Travel
  { path: 'book2/off-world-travel.md', title: 'Off-World Travel', section: 'book2' },
  { path: 'book2/trade-and-commerce.md', title: 'Trade and Commerce', section: 'book2' },
  { path: 'book2/ship-design-and-construction.md', title: 'Ship Design and Construction', section: 'book2' },
  { path: 'book2/common-vessels.md', title: 'Common Vessels', section: 'book2' },
  { path: 'book2/space-combat.md', title: 'Space Combat', section: 'book2' },
  // Book 3: Referees
  { path: 'book3/environments-and-hazards.md', title: 'Environments and Hazards', section: 'book3' },
  { path: 'book3/worlds.md', title: 'Worlds', section: 'book3' },
  { path: 'book3/planetary-wilderness-encounters.md', title: 'Planetary Wilderness Encounters', section: 'book3' },
  { path: 'book3/social-encounters.md', title: 'Social Encounters', section: 'book3' },
  { path: 'book3/starship-encounters.md', title: 'Starship Encounters', section: 'book3' },
  { path: 'book3/refereeing-the-game.md', title: 'Refereeing the Game', section: 'book3' },
  { path: 'book3/adventures.md', title: 'Adventures', section: 'book3' },
  // Vehicle Design System (a distinct supplement in the same book)
  { path: 'vds/introduction.md', title: 'Vehicle Design System: Introduction', section: 'vehicle-design' },
  { path: 'vds/vehicle-design.md', title: 'Vehicle Design', section: 'vehicle-design' },
  { path: 'vds/common-aircraft.md', title: 'Common Aircraft', section: 'vehicle-design' },
  { path: 'vds/common-grav-vehicles.md', title: 'Common Grav Vehicles', section: 'vehicle-design' },
  { path: 'vds/common-ground-vehicles.md', title: 'Common Ground Vehicles', section: 'vehicle-design' },
  { path: 'vds/common-watercraft.md', title: 'Common Watercraft', section: 'vehicle-design' },
  { path: 'vds/uncommon-vehicles.md', title: 'Uncommon Vehicles', section: 'vehicle-design' },
  { path: 'vds/updated-common-vehicles-table.md', title: 'Appendix A: Updated Common Vehicles Table', section: 'vehicle-design' },
];

export interface CepheusSectionResult {
  entries: ImportedEntry[];
  /** Chapters that returned no usable content (empty body) — skipped, not fatal. */
  skippedCount: number;
  /** Same-slug entries collapsed to one (defensive; the manifest slugs are already unique). */
  dedupedCount: number;
}

const consoleLogger: Open5eImportLogger = {
  warn: (message: string) => console.warn(message),
  info: (message: string) => console.info(message),
};

// ---------- Markdown helpers ----------

/** Stable slug for a chapter, derived from its path (dir separators → dashes). Unique per manifest. */
export function chapterSlug(path: string): string {
  return path
    .replace(/\.md$/i, '')
    .replace(/\//g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Slugify a heading for a sub-section slug (chapterSlug + '--' + headingSlug). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Normalize fetched Markdown defensively: strip a UTF-8 BOM, drop mdBook preprocessor
 * directives ({{#include …}} / {{#playground …}}) and any embedded <script>/<style> blocks
 * (the content chapters carry none, but the tool pages do — belt-and-braces so no script
 * markup is ever stored), and collapse 3+ blank lines. Deliberately light: it preserves the
 * Markdown (headings, GFM tables, bold/italic) so the compendium reader renders it faithfully.
 */
export function normalizeMarkdown(md: string): string {
  return md
    .replace(/^\uFEFF/, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/\{\{#[^}]*\}\}/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The first prose paragraph (skipping the leading H1/H2 heading and blank lines), for the summary. */
export function firstParagraph(md: string): string {
  const lines = md.split('\n');
  const buf: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (buf.length) break; // end of the first paragraph
      continue; // skip leading blanks
    }
    if (/^#{1,6}\s/.test(t)) {
      if (buf.length) break;
      continue; // skip heading lines before the first paragraph
    }
    if (/^[->|]/.test(t) || /^\d+\.\s/.test(t)) {
      // A list/table/blockquote before any paragraph — use it as-is rather than skipping prose.
      buf.push(t);
      break;
    }
    buf.push(t);
  }
  // Strip inline markdown emphasis/link syntax for a clean one-line summary.
  return buf
    .join(' ')
    .replace(/\*\*|\*|__|_|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

interface SubBlock {
  heading: string;
  body: string;
}

/**
 * Split a chapter's Markdown into blocks delimited by top-level `##` headings. The content
 * before the first `##` (the chapter intro, including its `#` title) is returned as the lead
 * block with an empty heading. Fenced code blocks are respected so a `##` inside a code fence
 * isn't treated as a heading (the OGL text in legal.md lives in a fenced block).
 */
function splitByH2(md: string): { lead: string; blocks: SubBlock[] } {
  const lines = md.split('\n');
  const lead: string[] = [];
  const blocks: SubBlock[] = [];
  let current: SubBlock | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h2 = !inFence ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (h2) {
      if (current) blocks.push(current);
      current = { heading: h2[1].replace(/\*\*|\*|__|_|`/g, '').trim(), body: line + '\n' };
    } else if (current) {
      current.body += line + '\n';
    } else {
      lead.push(line);
    }
  }
  if (current) blocks.push(current);
  return { lead: lead.join('\n').trim(), blocks };
}

/**
 * Build the ImportedEntry (or entries, for an oversized chapter) for one chapter's Markdown.
 * A chapter that fits MAX_ENTRY_BODY becomes a single `section` entry; an oversized one is
 * split into one entry per `##` heading (plus a lead entry for the chapter intro), each with a
 * stable slug. Returns [] when the chapter has no usable content.
 */
export function buildChapterEntries(chapter: CepheusChapter, rawMarkdown: string): ImportedEntry[] {
  const body = normalizeMarkdown(rawMarkdown);
  if (!body) return [];

  const baseSlug = chapterSlug(chapter.path);
  const sourceUrl = `${CEPHEUS_SOURCE_URL}/blob/mdbook/src/${chapter.path}`;
  const bookLabel = SECTION_LABEL[chapter.section];

  const makeEntry = (slug: string, name: string, entryBody: string, heading: string | null): ImportedEntry => ({
    slug,
    name: truncate(name, 200),
    type: 'section',
    summary: truncate(firstParagraph(entryBody) || name, 300),
    body: truncate(entryBody, MAX_ENTRY_BODY),
    dataJson: JSON.stringify({
      book: bookLabel,
      chapter: chapter.title,
      chapterPath: chapter.path,
      ...(heading ? { heading } : {}),
    }),
    license: CEPHEUS_LICENSE,
    source: CEPHEUS_SOURCE,
    attribution: CEPHEUS_ATTRIBUTION,
    sourceUrl,
  });

  if (body.length <= MAX_ENTRY_BODY) {
    return [makeEntry(baseSlug, chapter.title, body, null)];
  }

  // Oversized: split at `##` headings so no entry exceeds the body cap and each heading is a
  // searchable, navigable section (issue #406 "chapters/headings into section entries").
  const { lead, blocks } = splitByH2(body);
  const entries: ImportedEntry[] = [];
  if (lead) {
    entries.push(makeEntry(baseSlug, chapter.title, lead, null));
  }
  const usedSlugs = new Set<string>(entries.map((e) => e.slug));
  for (const block of blocks) {
    if (!block.heading) continue;
    let sub = `${baseSlug}--${slugify(block.heading)}`;
    // Guard against two `##` headings slugifying identically within one chapter.
    let n = 2;
    while (usedSlugs.has(sub)) sub = `${baseSlug}--${slugify(block.heading)}-${n++}`;
    usedSlugs.add(sub);
    entries.push(makeEntry(sub, `${chapter.title}: ${block.heading}`, block.body.trim(), block.heading));
  }
  // Fallback: a huge chapter with no `##` headings at all — keep the (truncated) whole.
  return entries.length ? entries : [makeEntry(baseSlug, chapter.title, body, null)];
}

// ---------- fetch (mirrors the open5e/archmage importer hardening: timeout + transient retry) ----------

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'campfire-rules-importer' } });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry a chapter fetch on transient failure (timeout / 5xx) only — same policy as the sibling importers. */
async function fetchChapterWithRetry(url: string, section: CepheusSection, logger: Open5eImportLogger): Promise<Response> {
  let lastErr: Error | null = null;
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= PAGE_RETRY_BACKOFFS_MS.length; attempt++) {
    try {
      const res = await fetchWithTimeout(url);
      if (res.ok) return res;
      if (res.status >= 500 && res.status < 600) {
        lastRes = res;
        lastErr = null;
      } else {
        return res; // 4xx — not transient, fail fast.
      }
    } catch (err) {
      lastErr = err as Error;
      lastRes = null;
    }
    if (attempt < PAGE_RETRY_BACKOFFS_MS.length) {
      const backoff = PAGE_RETRY_BACKOFFS_MS[attempt];
      const reason = lastErr ? lastErr.message : `HTTP ${lastRes?.status}`;
      logger.warn(
        `[cepheus-importer] section "${section}": fetch of ${url} failed (${reason}), retrying in ${backoff}ms (attempt ${attempt + 1}/${PAGE_RETRY_BACKOFFS_MS.length})`,
      );
      await sleep(backoff);
    }
  }
  if (lastRes) return lastRes;
  throw lastErr ?? new Error('unknown fetch failure');
}

/**
 * Fetch and map every chapter of one Cepheus "book" (part) into `section` rule entries. Each
 * chapter's raw Markdown is fetched (with timeout + transient retry), normalized, and turned
 * into one entry — or several, for an oversized chapter (see buildChapterEntries). A hard
 * fetch/read failure surfaces as a clean BadRequestException (400) rather than a raw fetch
 * error, matching the sibling importers, so the background install job records a clear reason.
 */
export async function fetchCepheusSection(
  baseUrl: string,
  section: CepheusSection,
  logger: Open5eImportLogger = consoleLogger,
): Promise<CepheusSectionResult> {
  const chapters = CEPHEUS_CHAPTERS.filter((c) => c.section === section);
  const bySlug = new Map<string, ImportedEntry>();
  let skippedCount = 0;
  let dedupedCount = 0;

  for (const chapter of chapters) {
    const url = `${baseUrl.replace(/\/$/, '')}/${chapter.path}`;
    let res: Response;
    try {
      res = await fetchChapterWithRetry(url, section, logger);
    } catch (err) {
      throw new BadRequestException(
        `Failed to fetch Cepheus chapter "${chapter.path}" from ${url}: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new BadRequestException(`Cepheus chapter "${chapter.path}" returned HTTP ${res.status} for ${url}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new BadRequestException(`Cepheus chapter "${chapter.path}" body was unreadable: ${(err as Error).message}`);
    }

    const entries = buildChapterEntries(chapter, text);
    if (entries.length === 0) {
      skippedCount += 1;
      logger.warn(`[cepheus-importer] section "${section}": chapter "${chapter.path}" had no usable content — skipped`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.name || !entry.slug) {
        skippedCount += 1;
        continue;
      }
      if (bySlug.has(entry.slug)) {
        dedupedCount += 1;
        continue; // keep first-seen (stable)
      }
      bySlug.set(entry.slug, entry);
    }
  }

  const entries = [...bySlug.values()];
  logger.info(
    `[cepheus-importer] section "${section}" (${SECTION_LABEL[section]}): imported ${entries.length} entries from ${chapters.length} chapter(s)` +
      (dedupedCount > 0 ? ` (de-duped ${dedupedCount} same-slug)` : ''),
  );
  if (skippedCount > 0) {
    logger.warn(`[cepheus-importer] section "${section}": skipped ${skippedCount} chapter(s)/block(s) with no content`);
  }
  return { entries, skippedCount, dedupedCount };
}

/** Every Cepheus entry is section-level rules text. */
export function entryTypeForCepheusSection(_section: CepheusSection): RuleEntryType {
  return 'section';
}
