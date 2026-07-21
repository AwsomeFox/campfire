import { BadRequestException } from '@nestjs/common';
import type { RuleEntryType } from '@campfire/schema';

/**
 * Importer for the Open Legend SRD / community codex (https://openlegendrpg.com — issue
 * #299). Open Legend is a fully-open OGL system whose game content (the SRD: attributes,
 * banes, boons, feats, and the community bestiary) is redistributable under the Open Game
 * License. This importer fetches at install-time from a JSON source exposing that content
 * and maps it to Campfire's rule-entry vocabulary — it does NOT bundle a dataset.
 *
 * How this differs from the Open5e importer (open5e-importer.ts), and why:
 *   - Open Legend has NO classes/races/spells. Its content sections are creatures,
 *     banes, boons, feats, and items. Banes and boons are Open Legend's status-effect
 *     vocabulary (≈ 5e conditions), so both map to ruleEntry.type 'condition'; creatures
 *     map to 'monster', feats to 'feat', items to 'item'.
 *   - A creature statblock is attribute-based: the eighteen Open Legend attributes drive
 *     everything (there are no 5e-style ability scores). The statblock's numbers we carry
 *     are the eighteen `attributes`, the three defences (Guard/Toughness/Resolve — Guard is
 *     the AC analogue), `hp`, `speed`, `level` (Open Legend's threat rating, not a CR), and
 *     the creature's known banes/boons. The RuleSystemAdapter (`OpenLegendAdapter`) knows how
 *     to read this shape back out (guard→armorClass, level→challengeRating, agility→initiative).
 *   - The source may serve a section as either a paginated `{count,next,previous,results}`
 *     page (like Open5e) OR a bare top-level JSON array — community exports appear as both, so
 *     `readPage` normalises either shape. Pagination, the same-origin `next` guard, transient-
 *     failure retry, the per-section entry cap, the page cap, and (name,type) de-duplication all
 *     mirror the Open5e importer so the two share operational behaviour and hardening.
 *
 * Field shapes below reflect the Open Legend Community Codex JSON export; where the live
 * source is unreachable at build time the importer is proven against a small real-shaped
 * sample (test/fake-open-legend.ts) that exercises the same mapping code a live install would.
 */

export const OPEN_LEGEND_DEFAULT_BASE_URL = 'https://openlegendrpg.com/api';
export const OL_MAX_ENTRIES_PER_SECTION = 2000;
const PAGE_LIMIT = 500;
const MAX_PAGES_PER_SECTION = 50;
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_RETRY_BACKOFFS_MS = [1_000, 3_000];

export type OpenLegendSection = 'creatures' | 'banes' | 'boons' | 'feats' | 'items';

const SECTION_TO_PATH: Record<OpenLegendSection, string> = {
  creatures: 'creatures',
  banes: 'banes',
  boons: 'boons',
  feats: 'feats',
  items: 'items',
};

// Banes AND boons are Open Legend's status-effect vocabulary, so both land as 'condition'
// (Campfire has no bane/boon entry type — see file header). The importer keeps them
// distinguishable via each entry's dataJson.kind ('bane' | 'boon').
const SECTION_TO_ENTRY_TYPE: Record<OpenLegendSection, RuleEntryType> = {
  creatures: 'monster',
  banes: 'condition',
  boons: 'condition',
  feats: 'feat',
  items: 'item',
};

export interface OlImportedEntry {
  slug: string;
  name: string;
  type: RuleEntryType;
  summary: string;
  body: string;
  dataJson: string | null;
  license: string;
  source: string;
}

export interface OpenLegendImportLogger {
  warn(message: string): void;
  info(message: string): void;
}

const consoleLogger: OpenLegendImportLogger = {
  // eslint-disable-next-line no-console
  warn: (message: string) => console.warn(message),
  // eslint-disable-next-line no-console
  info: (message: string) => console.info(message),
};

export interface OpenLegendSectionResult {
  entries: OlImportedEntry[];
  skippedCount: number;
  dedupedCount: number;
}

/** Default license/attribution stamped on an entry that doesn't carry its own (issue #143). */
const OPEN_LEGEND_DEFAULT_LICENSE = 'Open Game License v1.0a';
const OPEN_LEGEND_DEFAULT_SOURCE = 'Open Legend SRD (openlegendrpg.com)';

function asString(v: unknown): string {
  if (typeof v !== 'string') return '';
  // Mirror the Open5e importer's escape-normalisation: some community exports carry literal
  // backslash-n/t sequences in prose, which break markdown rendering in the reader.
  return v.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? asString(x) : asString((x as Record<string, unknown>)?.name))).filter(Boolean);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugOf(row: Record<string, unknown>): string {
  const slug = asString(row.slug) || asString(row.key);
  return slug || slugify(asString(row.name));
}

function licenseOf(row: Record<string, unknown>): string {
  const direct = asString(row.license);
  if (direct) return direct;
  const doc = row.document as Record<string, unknown> | undefined;
  const licenses = doc?.licenses as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(licenses) && licenses.length > 0) {
    const joined = licenses.map((l) => asString(l.name)).filter(Boolean).join(', ');
    if (joined) return joined;
  }
  return OPEN_LEGEND_DEFAULT_LICENSE;
}

function sourceOf(row: Record<string, unknown>): string {
  const direct = asString(row.source);
  if (direct) return direct;
  const doc = row.document;
  if (doc && typeof doc === 'object') {
    const name = asString((doc as Record<string, unknown>).name);
    if (name) return name;
  } else if (typeof doc === 'string' && doc) {
    return doc;
  }
  return OPEN_LEGEND_DEFAULT_SOURCE;
}

/**
 * De-dup canonicality rank (issue #143): prefer an entry from the core SRD over a
 * community/third-party document when the same (name,type) shows up twice. Lower wins; the
 * default 1 keeps first-seen order stable when nothing distinguishes two rows.
 */
function documentRank(row: Record<string, unknown>): number {
  const doc = row.document;
  const key = (doc && typeof doc === 'object' ? asString((doc as Record<string, unknown>).key) : asString(doc)).toLowerCase();
  const src = asString(row.source).toLowerCase();
  if (key.includes('srd') || key === 'core' || src.includes('srd')) return 0;
  return 1;
}

function mapCreature(row: Record<string, unknown>): OlImportedEntry {
  const descriptor = asString(row.descriptor) || asString(row.type);
  const level = row.level ?? null;
  const defenses = (row.defenses ?? row.defense) as Record<string, unknown> | undefined;
  const attributes = (row.attributes ?? row.abilityScores) as Record<string, unknown> | undefined;
  const banes = asStringArray(row.banes);
  const boons = asStringArray(row.boons);
  const desc = asString(row.description) || asString(row.desc);
  return {
    slug: slugOf(row),
    name: asString(row.name),
    type: 'monster',
    summary: truncate([descriptor, level !== null && level !== undefined ? `level ${level}` : null].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({
      descriptor: descriptor || null,
      level: level ?? null,
      hp: row.hp ?? row.hitPoints ?? null,
      speed: row.speed ?? null,
      defenses: defenses && typeof defenses === 'object' ? defenses : null,
      attributes: attributes && typeof attributes === 'object' ? attributes : null,
      banes,
      boons,
      actions: row.actions ?? null,
    }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

/** Banes and boons share a mapper — `kind` records which, and both become 'condition' entries. */
function makeStatusMapper(kind: 'bane' | 'boon') {
  return (row: Record<string, unknown>): OlImportedEntry => {
    const desc = asString(row.description) || asString(row.desc);
    const power = row.power ?? row.powerLevel ?? null;
    const attribute = asString(row.attribute);
    const resist = asString(row.resist) || asString(row.resisted_by);
    const duration = asString(row.duration);
    return {
      slug: slugOf(row),
      name: asString(row.name),
      type: 'condition',
      summary: truncate(
        [kind === 'bane' ? 'Bane' : 'Boon', power !== null && power !== undefined ? `power ${power}` : null, attribute || null]
          .filter(Boolean)
          .join(' · ') || desc,
        300,
      ),
      body: desc,
      dataJson: JSON.stringify({
        kind,
        power: power ?? null,
        attribute: attribute || null,
        resist: resist || null,
        duration: duration || null,
      }),
      license: licenseOf(row),
      source: sourceOf(row),
    };
  };
}

function mapFeat(row: Record<string, unknown>): OlImportedEntry {
  const desc = asString(row.description) || asString(row.desc);
  const tier = asString(row.tier);
  const prerequisite = asString(row.prerequisite) || asString(row.prerequisites);
  return {
    slug: slugOf(row),
    name: asString(row.name),
    type: 'feat',
    summary: truncate([tier ? `${tier} feat` : null, prerequisite ? `Prerequisite: ${prerequisite}` : null].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({ tier: tier || null, prerequisite: prerequisite || null }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

function mapItem(row: Record<string, unknown>): OlImportedEntry {
  const desc = asString(row.description) || asString(row.desc);
  const category = asString(row.category) || asString(row.type);
  const wealthLevel = row.wealthLevel ?? row.wealth_level ?? null;
  const properties = asStringArray(row.properties);
  return {
    slug: slugOf(row),
    name: asString(row.name),
    type: 'item',
    summary: truncate([category || null, wealthLevel !== null && wealthLevel !== undefined ? `wealth ${wealthLevel}` : null].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({ category: category || null, wealthLevel: wealthLevel ?? null, properties }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

const SECTION_MAPPER: Record<OpenLegendSection, (row: Record<string, unknown>) => OlImportedEntry> = {
  creatures: mapCreature,
  banes: makeStatusMapper('bane'),
  boons: makeStatusMapper('boon'),
  feats: mapFeat,
  items: mapItem,
};

interface NormalizedPage {
  results: Array<Record<string, unknown>>;
  next: string | null;
}

/**
 * Normalise a section response into {results, next}. The source may serve either a paginated
 * `{count,next,previous,results}` object (Open5e-style) or a bare top-level JSON array
 * (single-file export) — both appear in community data, so we accept either. A bare array has
 * no further pages (`next: null`).
 */
function readPage(body: unknown): NormalizedPage {
  if (Array.isArray(body)) return { results: body as Array<Record<string, unknown>>, next: null };
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.results)) {
      return { results: obj.results as Array<Record<string, unknown>>, next: typeof obj.next === 'string' ? obj.next : null };
    }
  }
  throw new Error('response is neither a JSON array nor a {results:[…]} page');
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch one page, retrying transient failures (request timeout / HTTP 5xx); a 4xx fails fast. */
async function fetchPageWithRetry(url: string, section: OpenLegendSection, logger: OpenLegendImportLogger): Promise<Response> {
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
        `[open-legend-importer] section "${section}": fetch of ${url} failed (${reason}), retrying in ${backoff}ms (attempt ${attempt + 1}/${PAGE_RETRY_BACKOFFS_MS.length})`,
      );
      await sleep(backoff);
    }
  }

  if (lastRes) return lastRes;
  throw lastErr ?? new Error('unknown fetch failure');
}

function isSameOrigin(origin: string, candidate: string): boolean {
  try {
    return new URL(origin).origin === new URL(candidate).origin;
  } catch {
    return false;
  }
}

/**
 * Fetch and map one section's entries, paginating until the source runs out of pages or the
 * per-section cap is hit. Mirrors fetchOpen5eSection's hardening: same-origin `next` guard,
 * transient-failure retry, page cap, (name,type) de-dup preferring the more-canonical source,
 * and a per-section import-count log so an empty/short section is visible.
 */
export async function fetchOpenLegendSection(
  baseUrl: string,
  section: OpenLegendSection,
  logger: OpenLegendImportLogger = consoleLogger,
): Promise<OpenLegendSectionResult> {
  const path = SECTION_TO_PATH[section];
  const mapper = SECTION_MAPPER[section];
  const byName = new Map<string, { entry: OlImportedEntry; rank: number }>();
  let skippedCount = 0;
  let dedupedCount = 0;
  let pagesFetched = 0;
  let url: string | null = `${baseUrl.replace(/\/$/, '')}/${path}/?limit=${PAGE_LIMIT}`;

  while (url && byName.size < OL_MAX_ENTRIES_PER_SECTION) {
    if (pagesFetched >= MAX_PAGES_PER_SECTION) {
      logger.warn(
        `[open-legend-importer] section "${section}": hit page cap (${MAX_PAGES_PER_SECTION} pages) after ${byName.size} entries — stopping pagination`,
      );
      break;
    }
    pagesFetched += 1;
    let res: Response;
    try {
      res = await fetchPageWithRetry(url, section, logger);
    } catch (err) {
      throw new BadRequestException(`Failed to fetch Open Legend section "${section}" from ${url}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new BadRequestException(`Open Legend section "${section}" returned HTTP ${res.status} for ${url}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new BadRequestException(`Open Legend section "${section}" returned invalid JSON: ${(err as Error).message}`);
    }
    let page: NormalizedPage;
    try {
      page = readPage(body);
    } catch (err) {
      throw new BadRequestException(`Open Legend section "${section}" has an unexpected shape: ${(err as Error).message}`);
    }
    for (const row of page.results) {
      let entry: OlImportedEntry;
      let rank: number;
      try {
        entry = mapper(row);
        rank = documentRank(row);
      } catch {
        skippedCount += 1;
        continue;
      }
      const key = entry.name.trim().toLowerCase();
      if (!key) {
        skippedCount += 1;
        continue;
      }
      const existing = byName.get(key);
      if (existing) {
        dedupedCount += 1;
        if (rank < existing.rank) byName.set(key, { entry, rank });
      } else {
        if (byName.size >= OL_MAX_ENTRIES_PER_SECTION) break;
        byName.set(key, { entry, rank });
      }
    }

    if (page.next && !isSameOrigin(baseUrl, page.next)) {
      skippedCount += 1;
      logger.warn(
        `[open-legend-importer] section "${section}": refusing to follow cross-origin pagination link (base=${baseUrl}, next=${page.next}) — stopping pagination`,
      );
      url = null;
    } else {
      url = page.next;
    }
  }

  const entries = [...byName.values()].map((v) => v.entry);
  logger.info(
    `[open-legend-importer] section "${section}": imported ${entries.length} entries across ${pagesFetched} page(s)` +
      (dedupedCount > 0 ? ` (de-duped ${dedupedCount} same-name row(s))` : ''),
  );
  if (skippedCount > 0) {
    logger.warn(`[open-legend-importer] section "${section}": imported ${entries.length} entries, skipped ${skippedCount} row(s)`);
  }

  return { entries, skippedCount, dedupedCount };
}

export function entryTypeForOpenLegendSection(section: OpenLegendSection): RuleEntryType {
  return SECTION_TO_ENTRY_TYPE[section];
}

export const ALL_OPEN_LEGEND_SECTIONS: OpenLegendSection[] = ['creatures', 'banes', 'boons', 'feats', 'items'];
