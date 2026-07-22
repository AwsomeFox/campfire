import { BadRequestException } from '@nestjs/common';
import type { RuleEntryType } from '@campfire/schema';

/**
 * Importer for open-licensed Pathfinder 2e content (issue #295). It mirrors the Open5e
 * importer's shape exactly — fetch-at-install from a real open source, paginate under a
 * cap, map rows to Campfire rule-entry types, de-dupe on (name, type), and stamp a
 * per-entry license + source label — so the install-job machinery (issue #20) and the
 * (pack, type, slug) persistence path are reused unchanged.
 *
 * Source: the Archives of Nethys 2e (https://2e.aonprd.com) Elasticsearch index, the same
 * public JSON backend the AoN site itself queries (base https://elasticsearch.aonprd.com,
 * index `aon`). AoN publishes the game's own OGL (legacy) / ORC (remaster) open game
 * content — the license basis is the CONTENT's own OGL/ORC license, NOT a Foundry package
 * (Foundry's package license forbids that reuse; see the issue's sourcing rule). This
 * importer therefore takes the mechanical fields + rules text (open game content) and
 * DROPS art/image fields and non-OGC flavor, and records the reported license per entry.
 *
 * Response shape (captured from the AoN ES `_search` contract):
 *   GET {base}/{index}/_search?q=type:<t>&size=<N>&from=<M>
 *   -> { hits: { total: { value: <int> }, hits: [ { _id, _source: { … } } ] } }
 * `_source` is the flat document: `name`, `type` ("creature"/"spell"/"equipment"/…),
 * `level`, `ac`, `hp`, `perception`, ability modifiers (`strength` … `charisma` as signed
 * mods, PF2e statblocks list mods not scores), `fortitude_save`/`reflex_save`/`will_save`,
 * `speed`, `size`, `rarity`, `trait` (array), `source` (book label), `text`/`markdown`
 * (rules prose), and a `license` string. Pagination is `from`/`size` against `total.value`.
 *
 * NOTE ON LIVE INGEST: a full AoN pull is thousands of documents per section and runs via
 * the normal install-job path (issue #20), exactly like the Open5e importer's bulk pull —
 * it is intentionally NOT bundled into the repo. Tests prove the mapping against a small
 * real-shape fixture (test/fake-pf2e.ts), the same strategy the Open5e importer uses.
 */

export const PF2E_DEFAULT_BASE_URL = 'https://elasticsearch.aonprd.com';
export const PF2E_INDEX = 'aon';
export const PF2E_PACK_NAME = 'Pathfinder 2e (Archives of Nethys)';
/** Fallback pack-level license when an entry doesn't report its own (AoN OGC is OGL/ORC). */
export const PF2E_DEFAULT_LICENSE = 'OGL / ORC';

// Mirrors the Open5e importer's caps/timeouts (see open5e-importer.ts for the rationale):
// large sections (creatures/spells/equipment run into the thousands) are page-fetched under
// a hard per-section entry cap and a page cap so one install can't pull unbounded data.
export const MAX_ENTRIES_PER_SECTION = 3000;
const PAGE_SIZE = 500;
const MAX_PAGES_PER_SECTION = 50;
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_RETRY_BACKOFFS_MS = [1_000, 3_000];

// Campfire's importer "sections" map 1:1 onto an AoN document `type` and a Campfire
// rule-entry type. Ancestries -> race, backgrounds -> feat (per issue #2's class/race/feat
// vocabulary; a background is a feat-like package of proficiencies), classes -> class.
export type Pf2eSection = 'creatures' | 'spells' | 'equipment' | 'feats' | 'ancestries' | 'classes' | 'backgrounds' | 'conditions';

/** AoN `_source.type` value queried for each section. */
const SECTION_TO_AON_TYPE: Record<Pf2eSection, string> = {
  creatures: 'creature',
  spells: 'spell',
  // AoN has no 'equipment' type — gear lives under type 'Item' (verified live:
  // q=type:equipment → 0 hits, q=type:item → 10k+). 'equipment' silently imported
  // nothing since #326.
  equipment: 'item',
  feats: 'feat',
  ancestries: 'ancestry',
  classes: 'class',
  backgrounds: 'background',
  conditions: 'condition',
};

const SECTION_TO_ENTRY_TYPE: Record<Pf2eSection, RuleEntryType> = {
  creatures: 'monster',
  spells: 'spell',
  equipment: 'item',
  feats: 'feat',
  ancestries: 'race',
  classes: 'class',
  backgrounds: 'feat',
  conditions: 'condition',
};

export const ALL_PF2E_SECTIONS: Pf2eSection[] = [
  'creatures',
  'spells',
  'equipment',
  'feats',
  'ancestries',
  'classes',
  'backgrounds',
  'conditions',
];

export interface ImportedEntry {
  slug: string;
  name: string;
  type: RuleEntryType;
  summary: string;
  body: string;
  dataJson: string | null;
  license: string;
  /** Human-readable source/book label (AoN `_source.source`), e.g. "Pathfinder Monster Core". */
  source: string;
}

export interface Pf2eImportLogger {
  warn(message: string): void;
  info(message: string): void;
}

const consoleLogger: Pf2eImportLogger = {
  // eslint-disable-next-line no-console
  warn: (message: string) => console.warn(message),
  // eslint-disable-next-line no-console
  info: (message: string) => console.info(message),
};

export interface Pf2eSectionResult {
  entries: ImportedEntry[];
  /** Rows present in a fetched page but skipped (malformed row, or a cross-origin follow refused). */
  skippedCount: number;
  /** Same-name rows collapsed to one canonical entry per (name, type). */
  dedupedCount: number;
}

interface AonHit {
  _id?: unknown;
  _source?: Record<string, unknown>;
}
interface AonPage {
  hits?: { total?: { value?: number } | number; hits?: AonHit[] };
}

function asString(v: unknown): string {
  if (typeof v !== 'string') return '';
  // AoN prose can carry literal escape sequences; normalise like the Open5e importer does.
  return v.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x)).filter(Boolean);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Slugify a name to a stable per-pack key (AoN `_id` is used when present, else the name). */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugOf(src: Record<string, unknown>, name: string): string {
  const id = asString(src.id) || asString(src.slug);
  if (id) return id;
  return slugify(name) || name;
}

/** Rules prose, preferring the plain-text `text` over `markdown` (both are OGC); art/images ignored. */
function bodyOf(src: Record<string, unknown>): string {
  return asString(src.text) || asString(src.markdown) || asString(src.description) || asString(src.desc);
}

/** Reported license (OGL legacy / ORC remaster). Falls back to the pack default. */
function licenseOf(src: Record<string, unknown>): string {
  return asString(src.license) || PF2E_DEFAULT_LICENSE;
}

/** Source-book label for attribution (AoN `source`; array-valued on some rows). */
function sourceOf(src: Record<string, unknown>): string {
  if (Array.isArray(src.source)) return asStringArray(src.source).join(', ');
  return asString(src.source);
}

function traitsOf(src: Record<string, unknown>): string[] {
  return asStringArray(src.trait ?? src.traits);
}

function abilityModsOf(src: Record<string, unknown>): Record<string, number> | null {
  const keys = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'number') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function mapCreature(src: Record<string, unknown>): ImportedEntry {
  const name = asString(src.name);
  const traits = traitsOf(src);
  const level = num(src.level);
  const rarity = asString(src.rarity);
  return {
    slug: slugOf(src, name),
    name,
    type: 'monster',
    summary: truncate([level !== null ? `Level ${level}` : null, asString(src.size), rarity, traits.slice(0, 3).join(', ')].filter(Boolean).join(' · '), 300),
    body: bodyOf(src),
    dataJson: JSON.stringify({
      level,
      ac: num(src.ac),
      hp: num(src.hp),
      perception: num(src.perception),
      abilityMods: abilityModsOf(src),
      saves: { fortitude: num(src.fortitude_save), reflex: num(src.reflex_save), will: num(src.will_save) },
      speed: src.speed ?? null,
      size: asString(src.size) || null,
      rarity: rarity || null,
      traits,
    }),
    license: licenseOf(src),
    source: sourceOf(src),
  };
}

function mapSpell(src: Record<string, unknown>): ImportedEntry {
  const name = asString(src.name);
  const rank = num(src.level) ?? num(src.rank); // PF2e remaster: spell "rank"; legacy field is `level`
  const traditions = asStringArray(src.tradition);
  return {
    slug: slugOf(src, name),
    name,
    type: 'spell',
    summary: truncate([rank !== null ? `Rank ${rank}` : null, traditions.join('/'), traitsOf(src).slice(0, 3).join(', ')].filter(Boolean).join(' · '), 300),
    body: bodyOf(src),
    dataJson: JSON.stringify({
      rank,
      traditions,
      cast: src.cast ?? src.actions ?? null,
      range: asString(src.range) || null,
      duration: asString(src.duration) || null,
      traits: traitsOf(src),
    }),
    license: licenseOf(src),
    source: sourceOf(src),
  };
}

function mapEquipment(src: Record<string, unknown>): ImportedEntry {
  const name = asString(src.name);
  const price = asString(src.price);
  return {
    slug: slugOf(src, name),
    name,
    type: 'item',
    summary: truncate([asString(src.category), src.level !== undefined ? `Item ${num(src.level)}` : null, price].filter(Boolean).join(' · '), 300),
    body: bodyOf(src),
    dataJson: JSON.stringify({
      level: num(src.level),
      price: price || null,
      bulk: src.bulk ?? null,
      category: asString(src.category) || null,
      rarity: asString(src.rarity) || null,
      traits: traitsOf(src),
    }),
    license: licenseOf(src),
    source: sourceOf(src),
  };
}

function mapFeat(src: Record<string, unknown>): ImportedEntry {
  const name = asString(src.name);
  const level = num(src.level);
  const prereq = asString(src.prerequisite);
  return {
    slug: slugOf(src, name),
    name,
    type: 'feat',
    summary: truncate([level !== null ? `Feat ${level}` : null, prereq ? `Prereq: ${prereq}` : null].filter(Boolean).join(' · ') || bodyOf(src), 300),
    body: bodyOf(src),
    dataJson: JSON.stringify({ level, prerequisite: prereq || null, traits: traitsOf(src) }),
    license: licenseOf(src),
    source: sourceOf(src),
  };
}

function mapAncestry(src: Record<string, unknown>): ImportedEntry {
  const name = asString(src.name);
  return {
    slug: slugOf(src, name),
    name,
    type: 'race',
    summary: truncate([src.hp !== undefined ? `HP ${num(src.hp)}` : null, asString(src.size), traitsOf(src).slice(0, 3).join(', ')].filter(Boolean).join(' · ') || bodyOf(src), 300),
    body: bodyOf(src),
    dataJson: JSON.stringify({ hp: num(src.hp), size: asString(src.size) || null, speed: src.speed ?? null, traits: traitsOf(src) }),
    license: licenseOf(src),
    source: sourceOf(src),
  };
}

function mapClass(src: Record<string, unknown>): ImportedEntry {
  const name = asString(src.name);
  const keyAbility = asStringArray(src.attribute ?? src.key_ability);
  return {
    slug: slugOf(src, name),
    name,
    type: 'class',
    summary: truncate([src.hp !== undefined ? `HP ${num(src.hp)}/level` : null, keyAbility.length ? `key ${keyAbility.join('/')}` : null].filter(Boolean).join(' · ') || bodyOf(src), 300),
    body: bodyOf(src),
    dataJson: JSON.stringify({ hpPerLevel: num(src.hp), keyAbility, traits: traitsOf(src) }),
    license: licenseOf(src),
    source: sourceOf(src),
  };
}

function mapBackground(src: Record<string, unknown>): ImportedEntry {
  const name = asString(src.name);
  return {
    slug: slugOf(src, name),
    name,
    type: 'feat',
    summary: truncate(bodyOf(src), 300),
    body: bodyOf(src),
    dataJson: JSON.stringify({ kind: 'background', traits: traitsOf(src) }),
    license: licenseOf(src),
    source: sourceOf(src),
  };
}

function mapCondition(src: Record<string, unknown>): ImportedEntry {
  const name = asString(src.name);
  return {
    slug: slugOf(src, name),
    name,
    type: 'condition',
    summary: truncate(bodyOf(src), 300),
    body: bodyOf(src),
    dataJson: null,
    license: licenseOf(src),
    source: sourceOf(src),
  };
}

const SECTION_MAPPER: Record<Pf2eSection, (src: Record<string, unknown>) => ImportedEntry> = {
  creatures: mapCreature,
  spells: mapSpell,
  equipment: mapEquipment,
  feats: mapFeat,
  ancestries: mapAncestry,
  classes: mapClass,
  backgrounds: mapBackground,
  conditions: mapCondition,
};

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches one page with retry on transient failures (request timeout or HTTP 5xx), 2
 * retries with 1s/3s backoff — identical policy to the Open5e importer. A 4xx or a
 * network error that isn't a timeout is not retried.
 */
async function fetchPageWithRetry(url: string, section: Pf2eSection, logger: Pf2eImportLogger): Promise<Response> {
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
        return res;
      }
    } catch (err) {
      lastErr = err as Error;
      lastRes = null;
    }

    if (attempt < PAGE_RETRY_BACKOFFS_MS.length) {
      const backoff = PAGE_RETRY_BACKOFFS_MS[attempt];
      const reason = lastErr ? lastErr.message : `HTTP ${lastRes?.status}`;
      logger.warn(
        `[pf2e-importer] section "${section}": fetch of ${url} failed (${reason}), retrying in ${backoff}ms (attempt ${attempt + 1}/${PAGE_RETRY_BACKOFFS_MS.length})`,
      );
      await sleep(backoff);
    }
  }

  if (lastRes) return lastRes;
  throw lastErr ?? new Error('unknown fetch failure');
}

function totalOf(page: AonPage): number {
  const total = page.hits?.total;
  if (typeof total === 'number') return total;
  if (total && typeof total === 'object' && typeof total.value === 'number') return total.value;
  return 0;
}

/**
 * Fetches and maps one section, paginating the AoN `_search` (`from`/`size`) until the
 * index is exhausted, MAX_ENTRIES_PER_SECTION is hit, or the page cap is reached. Malformed
 * rows are skipped (counted), same-name rows collapse to one canonical entry, and the
 * import count is logged. Network/parse failures surface as a clean BadRequestException.
 */
export async function fetchPf2eSection(
  baseUrl: string,
  section: Pf2eSection,
  logger: Pf2eImportLogger = consoleLogger,
): Promise<Pf2eSectionResult> {
  const aonType = SECTION_TO_AON_TYPE[section];
  const mapper = SECTION_MAPPER[section];
  const base = baseUrl.replace(/\/$/, '');
  // De-dupe same-name rows to one canonical entry per (name, type): a section is a single
  // type, so a lowercased name is the (name, type) key. First-seen wins (stable order).
  const byName = new Map<string, ImportedEntry>();
  let skippedCount = 0;
  let dedupedCount = 0;
  let from = 0;
  let pagesFetched = 0;

  while (byName.size < MAX_ENTRIES_PER_SECTION) {
    if (pagesFetched >= MAX_PAGES_PER_SECTION) {
      logger.warn(`[pf2e-importer] section "${section}": hit page cap (${MAX_PAGES_PER_SECTION} pages) after ${byName.size} entries — stopping`);
      break;
    }
    pagesFetched += 1;
    const url = `${base}/${PF2E_INDEX}/_search?q=${encodeURIComponent(`type:${aonType}`)}&size=${PAGE_SIZE}&from=${from}`;
    let res: Response;
    try {
      res = await fetchPageWithRetry(url, section, logger);
    } catch (err) {
      throw new BadRequestException(`Failed to fetch PF2e section "${section}" from ${url}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new BadRequestException(`PF2e section "${section}" returned HTTP ${res.status} for ${url}`);
    }
    let page: AonPage;
    try {
      page = (await res.json()) as AonPage;
    } catch (err) {
      throw new BadRequestException(`PF2e section "${section}" returned invalid JSON: ${(err as Error).message}`);
    }
    const hits = page.hits?.hits;
    if (!Array.isArray(hits)) {
      throw new BadRequestException(`PF2e section "${section}" response missing "hits.hits" array (unexpected shape)`);
    }
    if (hits.length === 0) break; // exhausted

    for (const hit of hits) {
      let entry: ImportedEntry;
      try {
        const src = hit?._source;
        if (!src || typeof src !== 'object') throw new Error('missing _source');
        // Guard the AoN `type` filter: some indices return mixed rows for a broad `q`.
        // Compare the SOURCE row's declared type against the section's AoN type — the
        // mapped entry.type is a per-section constant, so comparing it to the
        // section's own entry type (also derived from the section) never fires.
        // CASE-INSENSITIVE: live AoN `_source.type` is capitalized ('Spell', 'Item', …)
        // while the q=type:x match works on the lowercased analyzed token — a
        // case-sensitive compare here skipped EVERY row (0-entry imports).
        if (asString((src as Record<string, unknown>).type).toLowerCase() !== aonType.toLowerCase()) {
          skippedCount += 1;
          continue;
        }
        entry = mapper(src as Record<string, unknown>);
        if (!entry.name) throw new Error('missing name');
      } catch {
        skippedCount += 1;
        continue;
      }
      const key = entry.name.trim().toLowerCase();
      if (byName.has(key)) {
        dedupedCount += 1;
        continue;
      }
      if (byName.size >= MAX_ENTRIES_PER_SECTION) break;
      byName.set(key, entry);
    }

    const total = totalOf(page);
    from += hits.length;
    // Stop once we've paged past the reported total (or the server stopped returning rows).
    if (total > 0 && from >= total) break;
  }

  const entries = [...byName.values()];
  logger.info(
    `[pf2e-importer] section "${section}": imported ${entries.length} entries across ${pagesFetched} page(s)` +
      (dedupedCount > 0 ? ` (de-duped ${dedupedCount} same-name row(s))` : ''),
  );
  if (skippedCount > 0) {
    logger.warn(`[pf2e-importer] section "${section}": imported ${entries.length} entries, skipped ${skippedCount} row(s)`);
  }

  return { entries, skippedCount, dedupedCount };
}

export function entryTypeForSection(section: Pf2eSection): RuleEntryType {
  return SECTION_TO_ENTRY_TYPE[section];
}
