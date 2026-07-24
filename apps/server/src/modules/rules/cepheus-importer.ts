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
 * the 50,000-char RuleEntry.body cap. Rather than truncate (which would silently drop rules
 * text), the importer RECURSIVELY splits an oversized chapter so NO rules prose is ever lost:
 * first at top-level (`##`) headings — the "chapters/headings into section entries" the issue
 * anticipates — then, for any `##` block that is still too large, at `###` sub-headings, then
 * at paragraph/blank-line boundaries. Each resulting piece gets a stable slug derived from the
 * chapter + heading, with over-cap pieces spilling into numbered continuation entries
 * (`…-part-2`, `…-part-3`). Only a single indivisible unit (e.g. one gigantic paragraph or a
 * table with no internal boundary) that STILL exceeds the cap is hard-chunked on character
 * boundaries — logged as a warning, but still stored in full across continuation entries
 * rather than truncated. Chapters that fit the cap stay a single chapter-level entry.
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

// Single source of truth for the per-entry body cap. `@campfire/schema` enforces the limit
// inline (RuleEntry.body = z.string().max(50_000)) and exposes no numeric constant to import,
// so we mirror it here with headroom: 48,000 leaves ~2,000 chars of slack for any downstream
// wrapping/escaping so a whole chapter that fits is stored intact, while an oversized chapter
// is recursively split (see buildChapterEntries) so nothing exceeds the schema's 50,000 cap.
// If the schema ever exports the limit, derive MAX_ENTRY_BODY from it instead of this literal.
const MAX_ENTRY_BODY = 48_000;
const FETCH_TIMEOUT_MS = 30_000;
// Retry transient failures only — network/timeout errors, HTTP 429 (rate limited), and 5xx.
// A non-429 4xx or a malformed body won't improve on retry, so those fail fast.
const PAGE_RETRY_BACKOFFS_MS = [1_000, 3_000];
// Upper bound on a server-provided Retry-After delay, so a hostile/absurd header can't hang an
// install; beyond this we still retry, just sooner.
const RETRY_AFTER_MAX_MS = 60_000;
// Max concurrent in-flight fetches against raw.githubusercontent.com across the WHOLE install
// (all books share one limiter), keeping the burst bounded while staying fast. See createFetchLimiter.
export const CEPHEUS_FETCH_CONCURRENCY = 4;
// Hard cap on the sub-slug de-dupe loop so a pathological chapter can never spin unbounded.
const MAX_SLUG_DEDUPE_ATTEMPTS = 1_000;

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
 * Split Markdown into blocks delimited by headings at exactly `level` (2 → `##`, 3 → `###`).
 * The content before the first heading (the intro, including any higher-level `#` title) is
 * returned as the `lead`. Fenced code blocks are respected so a heading marker inside a code
 * fence isn't treated as a heading (the OGL text in legal.md lives in a fenced block).
 */
function splitByHeadingLevel(md: string, level: 2 | 3): { lead: string; blocks: SubBlock[] } {
  const marker = '#'.repeat(level);
  // Exactly `level` hashes followed by whitespace — `##` won't match a `###` line and vice-versa.
  const headingRe = new RegExp(`^${marker}\\s+(.+?)\\s*$`);
  const deeperOrSame = new RegExp(`^#{${level + 1},}\\s`);
  const lines = md.split('\n');
  const lead: string[] = [];
  const blocks: SubBlock[] = [];
  let current: SubBlock | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    // A deeper heading (e.g. `###` while splitting on `##`) is body, not a delimiter.
    const isHeading = !inFence && !deeperOrSame.test(line);
    const h = isHeading ? headingRe.exec(line) : null;
    if (h) {
      if (current) blocks.push(current);
      current = { heading: h[1].replace(/\*\*|\*|__|_|`/g, '').trim(), body: line + '\n' };
    } else if (current) {
      current.body += line + '\n';
    } else {
      lead.push(line);
    }
  }
  if (current) blocks.push(current);
  return { lead: lead.join('\n').trim(), blocks };
}

/** Split text at blank-line (paragraph) boundaries; empty paragraphs are dropped. */
function splitByParagraph(md: string): string[] {
  return md
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Greedily merge consecutive pieces (joined by a blank line) into as few chunks <= max as possible. */
function packPieces(pieces: string[], max: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (!current) {
      current = piece;
    } else if (current.length + 2 + piece.length <= max) {
      current += '\n\n' + piece;
    } else {
      out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Hard-split a single indivisible unit on character boundaries into chunks <= max (lossless). */
function hardChunk(text: string, max: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks;
}

/**
 * Recursively split `text` into chunks each <= `max`, losing NO content: the chunks reassemble
 * to the original prose. Tries progressively finer boundaries — `###` sub-headings, then
 * paragraph/blank-line boundaries — and, only when a single unit is STILL over the cap with no
 * internal boundary left, hard-splits it on character boundaries (calling `onHardChunk` so the
 * caller can warn). Chunks are re-packed so we emit as few entries as the cap allows.
 */
function splitMarkdownToFit(text: string, max: number, onHardChunk: (unit: string) => void): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed ? [trimmed] : [];

  // 1) `###` sub-headings (keep the lead intro before the first `###` as its own piece).
  const byH3 = splitByHeadingLevel(trimmed, 3);
  if (byH3.blocks.length > 0) {
    const pieces = [byH3.lead, ...byH3.blocks.map((b) => b.body.trim())].filter((p) => p.length > 0);
    const fitted = pieces.flatMap((p) => (p.length <= max ? [p] : splitMarkdownToFit(p, max, onHardChunk)));
    return packPieces(fitted, max);
  }

  // 2) Paragraph / blank-line boundaries.
  const paragraphs = splitByParagraph(trimmed);
  if (paragraphs.length > 1) {
    const fitted = paragraphs.flatMap((p) => (p.length <= max ? [p] : splitMarkdownToFit(p, max, onHardChunk)));
    return packPieces(fitted, max);
  }

  // 3) A single indivisible unit still over the cap (one huge paragraph or an unbroken table):
  //    hard-chunk on character boundaries so the text is preserved in full, never truncated.
  onHardChunk(trimmed);
  return hardChunk(trimmed, max);
}

/**
 * Build the ImportedEntry (or entries, for an oversized chapter) for one chapter's Markdown.
 * A chapter that fits MAX_ENTRY_BODY becomes a single `section` entry. An oversized one is
 * split recursively (see splitMarkdownToFit) so NO rules text is ever dropped: first at `##`
 * headings (a lead entry for the intro plus one per heading), then — for any piece still over
 * the cap — at `###` sub-headings and paragraph boundaries, and finally, for a truly
 * indivisible unit, hard-chunked on character boundaries. Over-cap pieces spill into numbered
 * continuation entries (`…-part-2`) with stable slugs. Returns [] for empty content.
 */
export function buildChapterEntries(
  chapter: CepheusChapter,
  rawMarkdown: string,
  logger: Open5eImportLogger = consoleLogger,
): ImportedEntry[] {
  const body = normalizeMarkdown(rawMarkdown);
  if (!body) return [];

  const baseSlug = chapterSlug(chapter.path);
  const sourceUrl = `${CEPHEUS_SOURCE_URL}/blob/mdbook/src/${chapter.path}`;
  const bookLabel = SECTION_LABEL[chapter.section];

  const makeEntry = (
    slug: string,
    name: string,
    entryBody: string,
    heading: string | null,
    part: number | null,
  ): ImportedEntry => ({
    slug,
    name: truncate(name, 200),
    type: 'section',
    summary: truncate(firstParagraph(entryBody) || name, 300),
    // No truncation: the caller guarantees entryBody <= MAX_ENTRY_BODY via splitMarkdownToFit.
    body: entryBody,
    dataJson: JSON.stringify({
      book: bookLabel,
      chapter: chapter.title,
      chapterPath: chapter.path,
      ...(heading ? { heading } : {}),
      ...(part ? { part } : {}),
    }),
    license: CEPHEUS_LICENSE,
    source: CEPHEUS_SOURCE,
    attribution: CEPHEUS_ATTRIBUTION,
    sourceUrl,
  });

  if (body.length <= MAX_ENTRY_BODY) {
    return [makeEntry(baseSlug, chapter.title, body, null, null)];
  }

  const entries: ImportedEntry[] = [];
  const usedSlugs = new Set<string>();
  // Reserve a slug, disambiguating collisions. First try a bounded `-N` suffix loop (the common
  // case: a handful of same-base chapters). If that bound is exhausted WITHOUT finding a free
  // slug, fall back to a monotonically increasing counter and keep incrementing until the
  // candidate is genuinely unused. This ALWAYS returns a slug not already in `usedSlugs`, so a
  // pathological run of same-base collisions can never make us hand back a duplicate that the
  // later same-slug de-dupe would silently drop (data loss). The loop always terminates: each
  // increment produces a distinct string and only a finite number are already reserved.
  const reserveSlug = (base: string): string => {
    if (!usedSlugs.has(base)) {
      usedSlugs.add(base);
      return base;
    }
    let n = 2;
    let candidate = `${base}-${n}`;
    while (usedSlugs.has(candidate) && n <= MAX_SLUG_DEDUPE_ATTEMPTS) {
      candidate = `${base}-${++n}`;
    }
    // Guarantee uniqueness: if the bounded loop ended on a still-colliding candidate, keep
    // incrementing past the cap until we find a free slug. Never return a colliding slug.
    while (usedSlugs.has(candidate)) {
      candidate = `${base}-${++n}`;
    }
    usedSlugs.add(candidate);
    return candidate;
  };

  // Emit one segment (chapter lead or a `##` block) as one or more entries, splitting further
  // if the segment itself exceeds the cap. The first chunk keeps the segment's slug/name;
  // overflow chunks become numbered `…-part-N` continuation entries so nothing is lost.
  const emitSegment = (slugBase: string, name: string, segmentBody: string, heading: string | null): void => {
    const chunks = splitMarkdownToFit(segmentBody, MAX_ENTRY_BODY, (unit) => {
      logger.warn(
        `[cepheus-importer] chapter "${chapter.path}" section "${heading ?? name}" has an indivisible ` +
          `${unit.length}-char unit over the ${MAX_ENTRY_BODY}-char body cap; hard-chunking into continuation ` +
          `entries to avoid data loss`,
      );
    });
    chunks.forEach((chunkBody, i) => {
      if (i === 0) {
        entries.push(makeEntry(reserveSlug(slugBase), name, chunkBody, heading, null));
      } else {
        const partNo = i + 1;
        entries.push(
          makeEntry(reserveSlug(`${slugBase}-part-${partNo}`), `${name} (part ${partNo})`, chunkBody, heading, partNo),
        );
      }
    });
  };

  // Oversized: split at `##` headings so each heading is a searchable, navigable section
  // (issue #406 "chapters/headings into section entries"). A chapter with no `##` headings at
  // all leaves `lead` = the whole body, which emitSegment then splits at `###`/paragraphs.
  const { lead, blocks } = splitByHeadingLevel(body, 2);
  if (lead) {
    emitSegment(baseSlug, chapter.title, lead, null);
  }
  for (const block of blocks) {
    if (!block.heading) continue;
    emitSegment(`${baseSlug}--${slugify(block.heading)}`, `${chapter.title}: ${block.heading}`, block.body.trim(), block.heading);
  }

  // Defensive: if splitting somehow yielded nothing (shouldn't happen for non-empty body),
  // fall back to a lossless hard-chunk of the whole body rather than dropping it.
  if (entries.length === 0) {
    emitSegment(baseSlug, chapter.title, body, null);
  }
  return entries;
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

/**
 * A tiny bounded-concurrency runner: caps in-flight async tasks at `limit`, queueing the rest
 * and starting them (in submission order) as slots free up. Sharing one limiter across all the
 * books keeps the total number of concurrent raw.githubusercontent.com fetches bounded for the
 * whole install, so we never burst books × chapters requests at the CDN at once. Ordering is
 * deterministic: tasks begin in the order run() was called, subject to the concurrency cap.
 */
export interface FetchLimiter {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createFetchLimiter(limit: number): FetchLimiter {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<() => void> = [];
  const pump = (): void => {
    while (active < max && queue.length > 0) {
      const start = queue.shift()!;
      active += 1;
      start();
    }
  };
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = (): void => {
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              pump();
            });
        };
        queue.push(start);
        pump();
      });
    },
  };
}

/**
 * Parse an HTTP `Retry-After` header into a delay in ms. Supports the two RFC forms — a bare
 * number of seconds ("120") and an HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT") — returning the
 * delay from now (clamped to [0, RETRY_AFTER_MAX_MS]). Returns null when absent/unparseable so
 * the caller falls back to the fixed backoff schedule.
 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, RETRY_AFTER_MAX_MS);
  }
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) {
    const delta = when - Date.now();
    return Math.min(Math.max(delta, 0), RETRY_AFTER_MAX_MS);
  }
  return null;
}

/**
 * Retry a chapter fetch on transient failure only: network/timeout errors, HTTP 429 (rate
 * limited), and 5xx. A non-429 4xx or a readable-but-wrong body won't improve on retry, so it
 * fails fast. On a 429 the server's `Retry-After` header (seconds or HTTP-date) sets the
 * backoff when present, otherwise the fixed PAGE_RETRY_BACKOFFS_MS schedule is used.
 */
async function fetchChapterWithRetry(url: string, section: CepheusSection, logger: Open5eImportLogger): Promise<Response> {
  let lastErr: Error | null = null;
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= PAGE_RETRY_BACKOFFS_MS.length; attempt++) {
    let retryAfterMs: number | null = null;
    try {
      const res = await fetchWithTimeout(url);
      if (res.ok) return res;
      const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (isRetryable) {
        lastRes = res;
        lastErr = null;
        if (res.status === 429) retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      } else {
        return res; // non-429 4xx — not transient, fail fast.
      }
    } catch (err) {
      lastErr = err as Error;
      lastRes = null;
    }
    if (attempt < PAGE_RETRY_BACKOFFS_MS.length) {
      // Respect Retry-After (429) when present; otherwise fall back to the fixed schedule.
      const backoff = retryAfterMs != null ? retryAfterMs : PAGE_RETRY_BACKOFFS_MS[attempt];
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
 *
 * Chapter fetches go through the shared `limiter` (default: a fresh cap-CEPHEUS_FETCH_CONCURRENCY
 * limiter), so passing ONE limiter to every book — as installFromCepheus does — bounds the
 * total in-flight requests across the whole install. Fetches are dispatched concurrently but
 * results are consumed in manifest order, keeping entry ordering and de-dupe deterministic.
 */
export async function fetchCepheusSection(
  baseUrl: string,
  section: CepheusSection,
  logger: Open5eImportLogger = consoleLogger,
  limiter: FetchLimiter = createFetchLimiter(CEPHEUS_FETCH_CONCURRENCY),
): Promise<CepheusSectionResult> {
  const chapters = CEPHEUS_CHAPTERS.filter((c) => c.section === section);
  const bySlug = new Map<string, ImportedEntry>();
  let skippedCount = 0;
  let dedupedCount = 0;

  // Dispatch every chapter fetch through the shared limiter (bounded concurrency), settling each
  // to an ok/err result so a single failure doesn't leave sibling fetches as unhandled
  // rejections. Results are then processed in manifest order for deterministic output.
  type FetchOutcome =
    | { ok: true; chapter: CepheusChapter; text: string }
    | { ok: false; chapter: CepheusChapter; error: Error };
  const settled = await Promise.all(
    chapters.map((chapter): Promise<FetchOutcome> => {
      const url = `${baseUrl.replace(/\/$/, '')}/${chapter.path}`;
      return limiter
        .run(async () => {
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
          try {
            return await res.text();
          } catch (err) {
            throw new BadRequestException(
              `Cepheus chapter "${chapter.path}" body was unreadable: ${(err as Error).message}`,
            );
          }
        })
        .then(
          (text): FetchOutcome => ({ ok: true, chapter, text }),
          (error): FetchOutcome => ({ ok: false, chapter, error: error as Error }),
        );
    }),
  );

  for (const outcome of settled) {
    if (!outcome.ok) throw outcome.error; // first failure (in manifest order) aborts the book
    const { chapter, text } = outcome;
    const chapterEntries = buildChapterEntries(chapter, text, logger);
    if (chapterEntries.length === 0) {
      skippedCount += 1;
      logger.warn(`[cepheus-importer] section "${section}": chapter "${chapter.path}" had no usable content — skipped`);
      continue;
    }
    for (const entry of chapterEntries) {
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
