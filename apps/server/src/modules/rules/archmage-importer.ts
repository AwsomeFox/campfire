import { BadRequestException } from '@nestjs/common';
import type { RuleEntryType } from '@campfire/schema';
import type { ImportedEntry } from './open5e-importer';

/**
 * Importer for the 13th Age (Archmage Engine) SRD — issue #298, part of the #275
 * open-ruleset program. Unlike Open5e (a paginated JSON REST API), the 13th Age SRD is
 * published as HTML (www.13thagesrd.com, a WordPress SRD site under the OGL 1.0a), so this
 * importer FETCHES HTML and CONVERTS it — mirroring the open5e-importer's contract
 * (fetch-at-install → ImportedEntry[] with `dataJson`, de-dupe, OGL license/attribution
 * stamping, issue #143) but with an HTML parsing front end instead of JSON mapping.
 *
 * Real structure this parser targets (verified against the live site 2026-07):
 *  - Monsters (`/monsters/`): each statblock is an `<h3><span id="Name">Name</span></h3>`
 *    heading followed by a 4-column `<table>`: [size/level/role/type] | [Initiative +
 *    attacks] | [AC/PD/MD/HP labels] | [values]. 13th Age monsters have a LEVEL (not a CR)
 *    and THREE defenses (AC, Physical Defense, Mental Defense) — the "simpler statblock,
 *    good structured fit" the issue calls out.
 *  - Conditions (`/combat-rules/`): inside the `<h3 id="Conditions">` section, each
 *    condition is an `<h4><span id="Name">Name</span></h4>` heading followed by `<p>` prose.
 *
 * Scope note (per the issue): monsters + conditions are implemented AND PROVEN against a
 * real HTML sample (test/fake-archmage.ts + test/unit/archmage-importer.spec.ts). Spells
 * and magic items live on many per-class HTML pages with heterogeneous markup; the
 * heading-based prose path here (`parseProseSection`) generalizes to them, but bulk ingest
 * of every class/spell page is left to the install-job path (issue #20) rather than
 * bundling a large dataset in this change.
 */

export const ARCHMAGE_DEFAULT_BASE_URL = 'https://www.13thagesrd.com';
export const ARCHMAGE_PACK_SLUG = 'archmage-srd';
export const ARCHMAGE_LICENSE = 'Open Game License v1.0a';
export const ARCHMAGE_SOURCE = '13th Age Archmage Engine SRD';

// Hard cap on entries pulled from one section (parity with the Open5e importer's size
// guard so a single install can't ingest an unbounded page into our DB).
export const MAX_ENTRIES_PER_SECTION = 2000;
const FETCH_TIMEOUT_MS = 30_000;
// Retry transient failures only (timeout / 5xx); a 4xx or malformed body won't improve on retry.
const PAGE_RETRY_BACKOFFS_MS = [1_000, 3_000];

export type ArchmageSection = 'monsters' | 'conditions';

const SECTION_TO_PATH: Record<ArchmageSection, string> = {
  monsters: '/monsters/',
  conditions: '/combat-rules/',
};

const SECTION_TO_ENTRY_TYPE: Record<ArchmageSection, RuleEntryType> = {
  monsters: 'monster',
  conditions: 'condition',
};

export const ALL_ARCHMAGE_SECTIONS: ArchmageSection[] = ['monsters', 'conditions'];

/** Minimal structured logger, matching the Open5e importer's shape so the service logs uniformly. */
export interface ArchmageImportLogger {
  warn(message: string): void;
  info(message: string): void;
}

const consoleLogger: ArchmageImportLogger = {
  // eslint-disable-next-line no-console
  warn: (message: string) => console.warn(message),
  // eslint-disable-next-line no-console
  info: (message: string) => console.info(message),
};

export interface ArchmageSectionResult {
  entries: ImportedEntry[];
  /** Heading blocks that looked like an entry but couldn't be parsed into one (skipped, not fatal). */
  skippedCount: number;
  /** Same-slug entries collapsed to one (first-seen wins). */
  dedupedCount: number;
}

// ---------- HTML → text/markdown helpers (dependency-free) ----------

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&times;': '×',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&rdquo;': '”',
  '&ldquo;': '“',
};

/** Decode the handful of HTML entities the SRD actually uses, plus numeric (&#8217;, &#x2019;) forms. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (m) => NAMED_ENTITIES[m.toLowerCase()] ?? m);
}

/** Strip all tags to plain text, decode entities, and collapse runs of whitespace. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * Light HTML → markdown conversion: headings, bold/italic, list items, line/paragraph
 * breaks. Deliberately small — enough to keep a statblock or condition readable in the
 * compendium reader, not a general HTML engine.
 */
export function htmlToMarkdown(html: string): string {
  let s = html;
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|tr|div|li)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<\/(h[1-6])>/gi, '\n');
  s = s.replace(/<h[1-6][^>]*>/gi, '### ');
  s = s.replace(/<(b|strong)>/gi, '**').replace(/<\/(b|strong)>/gi, '**');
  s = s.replace(/<(i|em)>/gi, '*').replace(/<\/(i|em)>/gi, '*');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  // Tidy: collapse spaces, drop empty bold/italic artifacts, limit blank-line runs.
  s = s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\*\*\s*\*\*/g, '')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

export function slugify(name: string): string {
  return decodeEntities(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------- heading-delimited entry extraction ----------

interface HeadingBlock {
  name: string;
  html: string;
}

/**
 * Split an HTML fragment into entry blocks delimited by `<hN>` headings (each block is the
 * heading plus everything up to the next heading of level <= `level`). The SRD wraps entry
 * names in `<span id="…">Name</span>` inside the heading, so the name is the heading's text.
 */
function splitByHeading(html: string, level: number): HeadingBlock[] {
  const openTag = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, 'gi');
  const marks: Array<{ index: number; end: number; name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = openTag.exec(html)) !== null) {
    marks.push({ index: m.index, end: openTag.lastIndex, name: stripTags(m[1]) });
  }
  const blocks: HeadingBlock[] = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].end;
    const stop = i + 1 < marks.length ? marks[i + 1].index : html.length;
    blocks.push({ name: marks[i].name, html: html.slice(start, stop) });
  }
  return blocks;
}

/** Extract the raw inner HTML of each `<td>` cell of a statblock table. */
function tableCellsHtml(tableHtml: string): string[] {
  const cells: string[] = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tableHtml)) !== null) cells.push(m[1]);
  return cells;
}

/** Split a cell's HTML into text lines on `<p>`/`<br>`/`<li>` block boundaries, each stripped. */
function cellLines(cellHtml: string): string[] {
  return cellHtml
    .split(/<\/p>|<br\s*\/?>|<\/li>|<p[^>]*>/i)
    .map((chunk) => stripTags(chunk))
    .filter(Boolean);
}

function firstTable(html: string): string | null {
  const m = /<table\b[\s\S]*?<\/table>/i.exec(html);
  return m ? m[0] : null;
}

/** Zip parallel label lines (["AC","PD","MD","HP"]) to value lines (["17","16","12","45"]). */
function pairDefenses(labelLines: string[], valueLines: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const wanted: Record<string, string> = { AC: 'ac', PD: 'pd', MD: 'md', HP: 'hp' };
  const values = valueLines.map((v) => Number((v.match(/-?\d+/) ?? [])[0])).filter((n) => Number.isFinite(n));
  let vi = 0;
  for (const lbl of labelLines) {
    const key = wanted[lbl.trim().toUpperCase()];
    if (key && vi < values.length) {
      out[key] = values[vi];
      vi += 1;
    }
  }
  return out;
}

// Level is written "2<sup>nd</sup> level", which flattens to "2 nd level" — tolerate the space.
const LEVEL_RE = /(\d+)\s*(?:st|nd|rd|th)\b\s*level/i;
const INIT_RE = /Initiative:?\s*([+-]?\d+)/i;

/**
 * Parse a single 13th Age monster statblock block (heading text = name, block html holds the
 * table) into an ImportedEntry, or null if it carries no recognizable statblock (a prose
 * `<h3>` that isn't a monster).
 */
function parseMonster(name: string, blockHtml: string): ImportedEntry | null {
  const table = firstTable(blockHtml);
  if (!table) return null;
  const flat = stripTags(table);
  const levelMatch = LEVEL_RE.exec(flat);
  // Require the level + defense signature so non-monster headings are skipped, not mis-imported.
  if (!levelMatch || !/\bAC\b\s+PD\s+MD\s+HP/i.test(flat)) return null;

  const cells = tableCellsHtml(table);
  const headerLines = cellLines(cells[0] ?? '');
  const attacksCellRaw = cells[1] ?? '';
  const labelsIdx = cells.findIndex((c) => /\bAC\b[\s\S]*PD[\s\S]*MD[\s\S]*HP/i.test(c));
  const labelLines = labelsIdx >= 0 ? cellLines(cells[labelsIdx]) : [];
  const valueLines = labelsIdx >= 0 ? cellLines(cells[labelsIdx + 1] ?? '') : [];

  const level = Number(levelMatch[1]);
  // Header lines, e.g. ["Normal", "2 nd level", "Troop", "Beast"] → size/role/type around the level.
  const levelLineIdx = headerLines.findIndex((t) => LEVEL_RE.test(t));
  const size = levelLineIdx > 0 ? headerLines[0] : '';
  const role = levelLineIdx >= 0 ? headerLines[levelLineIdx + 1] ?? '' : '';
  const creatureType = levelLineIdx >= 0 ? headerLines[levelLineIdx + 2] ?? '' : '';

  const initMatch = INIT_RE.exec(stripTags(attacksCellRaw)) ?? INIT_RE.exec(flat);
  const initiative = initMatch ? Number(initMatch[1]) : null;
  const defenses = pairDefenses(labelLines, valueLines);
  const attacks = htmlToMarkdown(attacksCellRaw);

  return {
    slug: slugify(name),
    name: decodeEntities(name),
    type: 'monster',
    summary: truncate(
      [size, `level ${level}`, [role, creatureType].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
      300,
    ),
    body: htmlToMarkdown(table),
    dataJson: JSON.stringify({
      level,
      size: size || null,
      role: role || null,
      creatureType: creatureType || null,
      initiative,
      ac: defenses.ac ?? null,
      pd: defenses.pd ?? null,
      md: defenses.md ?? null,
      hp: defenses.hp ?? null,
      attacks: attacks || null,
    }),
    license: ARCHMAGE_LICENSE,
    source: ARCHMAGE_SOURCE,
  };
}

function parseMonsterSection(html: string, logger: ArchmageImportLogger): ArchmageSectionResult {
  return collect(
    splitByHeading(html, 3).map((b) => ({ block: b, entry: safeParse(() => parseMonster(b.name, b.html)) })),
    'monsters',
    logger,
  );
}

/**
 * Conditions live inside the `<h3 id="Conditions">` section as `<h4>` sub-entries. Slice
 * that section out first, then split its `<h4>` blocks into condition entries.
 */
function parseConditionSection(html: string, logger: ArchmageImportLogger): ArchmageSectionResult {
  const h3blocks = splitByHeading(html, 3);
  const conditions = h3blocks.find((b) => /^conditions$/i.test(b.name.trim()));
  const scope = conditions ? conditions.html : html;
  const entries = splitByHeading(scope, 4)
    .filter((b) => b.name.trim().length > 0)
    .map((b) => ({
      block: b,
      entry: safeParse(() => {
        const body = htmlToMarkdown(b.html);
        if (!body) return null;
        return {
          slug: slugify(b.name),
          name: decodeEntities(b.name),
          type: 'condition' as RuleEntryType,
          summary: truncate(body, 300),
          body,
          dataJson: null,
          license: ARCHMAGE_LICENSE,
          source: ARCHMAGE_SOURCE,
        };
      }),
    }));
  return collect(entries, 'conditions', logger);
}

function safeParse(fn: () => ImportedEntry | null): ImportedEntry | null | 'error' {
  try {
    return fn();
  } catch {
    return 'error';
  }
}

/** De-dupe on slug (first-seen wins), count skips (unparseable) and dedupes, cap the section. */
function collect(
  parsed: Array<{ block: HeadingBlock; entry: ImportedEntry | null | 'error' }>,
  section: ArchmageSection,
  logger: ArchmageImportLogger,
): ArchmageSectionResult {
  const bySlug = new Map<string, ImportedEntry>();
  let skippedCount = 0;
  let dedupedCount = 0;
  for (const { entry } of parsed) {
    if (entry === 'error') {
      skippedCount += 1;
      continue;
    }
    if (!entry || !entry.slug || !entry.name) continue; // non-entry heading (prose) — silently ignored
    if (bySlug.size >= MAX_ENTRIES_PER_SECTION) break;
    if (bySlug.has(entry.slug)) {
      dedupedCount += 1;
      continue;
    }
    bySlug.set(entry.slug, entry);
  }
  const entries = [...bySlug.values()];
  logger.info(
    `[archmage-importer] section "${section}": imported ${entries.length} entries` +
      (dedupedCount > 0 ? ` (de-duped ${dedupedCount} same-slug)` : ''),
  );
  if (skippedCount > 0) {
    logger.warn(`[archmage-importer] section "${section}": skipped ${skippedCount} unparseable block(s)`);
  }
  return { entries, skippedCount, dedupedCount };
}

const SECTION_PARSER: Record<ArchmageSection, (html: string, logger: ArchmageImportLogger) => ArchmageSectionResult> = {
  monsters: parseMonsterSection,
  conditions: parseConditionSection,
};

// ---------- fetch (mirrors open5e-importer hardening: timeout + transient retry) ----------

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

async function fetchPageWithRetry(url: string, section: ArchmageSection, logger: ArchmageImportLogger): Promise<Response> {
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
        return res; // 4xx — not transient
      }
    } catch (err) {
      lastErr = err as Error;
      lastRes = null;
    }
    if (attempt < PAGE_RETRY_BACKOFFS_MS.length) {
      const backoff = PAGE_RETRY_BACKOFFS_MS[attempt];
      const reason = lastErr ? lastErr.message : `HTTP ${lastRes?.status}`;
      logger.warn(
        `[archmage-importer] section "${section}": fetch of ${url} failed (${reason}), retrying in ${backoff}ms (attempt ${attempt + 1}/${PAGE_RETRY_BACKOFFS_MS.length})`,
      );
      await sleep(backoff);
    }
  }
  if (lastRes) return lastRes;
  throw lastErr ?? new Error('unknown fetch failure');
}

/**
 * Fetch one SRD section's HTML page and parse it into ImportedEntry[]. Network/parse
 * failures surface as BadRequestException (a clean 400) rather than a raw fetch error,
 * matching the Open5e importer.
 */
export async function fetchArchmageSection(
  baseUrl: string,
  section: ArchmageSection,
  logger: ArchmageImportLogger = consoleLogger,
): Promise<ArchmageSectionResult> {
  const url = `${baseUrl.replace(/\/$/, '')}${SECTION_TO_PATH[section]}`;
  let res: Response;
  try {
    res = await fetchPageWithRetry(url, section, logger);
  } catch (err) {
    throw new BadRequestException(`Failed to fetch 13th Age section "${section}" from ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new BadRequestException(`13th Age section "${section}" returned HTTP ${res.status} for ${url}`);
  }
  let html: string;
  try {
    html = await res.text();
  } catch (err) {
    throw new BadRequestException(`13th Age section "${section}" body was unreadable: ${(err as Error).message}`);
  }
  return SECTION_PARSER[section](html, logger);
}

export function entryTypeForSection(section: ArchmageSection): RuleEntryType {
  return SECTION_TO_ENTRY_TYPE[section];
}
