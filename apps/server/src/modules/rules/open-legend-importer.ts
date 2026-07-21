import { BadRequestException } from '@nestjs/common';
import { load as loadYaml } from 'js-yaml';
import type { RuleEntryType } from '@campfire/schema';

/**
 * Importer for the Open Legend SRD (issue #299; live source wired for #346).
 *
 * SOURCE (validated live 2026-07-21): the OFFICIAL Open Legend `core-rules` repository,
 * https://github.com/openlegend/core-rules — the same content published to
 * openlegendrpg.com. The former default (`https://openlegendrpg.com/api`) was a placeholder:
 * that host serves no JSON API (its root 404s). The real machine-readable open data is the
 * repo's YAML files, fetched over GitHub's raw CDN (permanent, first-party, no third-party
 * hobby host to go dark). Content is redistributable under the **Open Legend Community
 * License** (LICENSE.mdx in that repo), stamped on every imported entry.
 *
 * What the open source actually contains (and what it does NOT):
 *   - `boons/boons.yml`  — Open Legend boons (buff/utility effects)  → ruleEntry.type 'condition'
 *   - `banes/banes.yml`  — Open Legend banes (debuff/status effects) → ruleEntry.type 'condition'
 *   - `feats/feats.yml`  — Open Legend feats                          → ruleEntry.type 'feat'
 * There is NO open, structured creature/bestiary or item dataset in the repo (the `core/`
 * folder is prose rules text, not a data file), so — being honest about coverage per #346 —
 * this importer imports exactly the three sections that exist as data. Open Legend creatures
 * are attribute-based statblocks the `OpenLegendAdapter` still knows how to read; a table
 * that wants them can `POST /rules/packs/upload` a JSON pack.
 *
 * Format handling: the source files are YAML (each a top-level list; items carry a YAML
 * non-specific `!` tag js-yaml parses fine). The fetch layer is content-agnostic — it reads
 * the body as text and parses YAML OR JSON — so the `url` override (mainly for tests, but
 * also a self-hosted mirror) can serve either a `.yml` file or a JSON array / `{results}`
 * page. Retry/timeout, the same-origin pagination guard (for a paginated JSON override), the
 * per-section cap, and (name)-dedup mirror the Open5e importer's hardening.
 */

export const OPEN_LEGEND_DEFAULT_BASE_URL = 'https://raw.githubusercontent.com/openlegend/core-rules/master';
export const OL_MAX_ENTRIES_PER_SECTION = 2000;
const MAX_PAGES_PER_SECTION = 50;
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_RETRY_BACKOFFS_MS = [1_000, 3_000];

export type OpenLegendSection = 'boons' | 'banes' | 'feats';

/** The three sections that exist as open data in the core-rules repo (see file header). */
export const ALL_OPEN_LEGEND_SECTIONS: OpenLegendSection[] = ['boons', 'banes', 'feats'];

/** Path (relative to the base) of each section's data file in the core-rules repo. */
const SECTION_TO_PATH: Record<OpenLegendSection, string> = {
  boons: 'boons/boons.yml',
  banes: 'banes/banes.yml',
  feats: 'feats/feats.yml',
};

// Boons AND banes are Open Legend's status-effect vocabulary, so both land as 'condition'
// (Campfire has no boon/bane entry type). The importer keeps them distinguishable via each
// entry's dataJson.kind ('boon' | 'bane').
const SECTION_TO_ENTRY_TYPE: Record<OpenLegendSection, RuleEntryType> = {
  boons: 'condition',
  banes: 'condition',
  feats: 'feat',
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

/** License/attribution stamped on entries that don't carry their own (the repo's files don't). */
export const OPEN_LEGEND_DEFAULT_LICENSE = 'Open Legend Community License';
const OPEN_LEGEND_DEFAULT_SOURCE = 'Open Legend Core Rules (openlegend/core-rules)';

function asString(v: unknown): string {
  if (typeof v !== 'string') return '';
  // Mirror the Open5e importer's escape-normalisation: some exports carry literal
  // backslash-n/t sequences in prose, which break markdown rendering in the reader.
  return v.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
}

/** Flatten a value that may be a string, a number, or an array of either, into a joined label. */
function asLabelList(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map((x) => (typeof x === 'string' ? asString(x) : typeof x === 'number' ? String(x) : ''))
    .filter(Boolean);
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
  return asString(row.license) || OPEN_LEGEND_DEFAULT_LICENSE;
}

function sourceOf(row: Record<string, unknown>): string {
  return asString(row.source) || OPEN_LEGEND_DEFAULT_SOURCE;
}

/** description + effect + special, in order, joined as markdown paragraphs. */
function proseBody(row: Record<string, unknown>): string {
  return [asString(row.description) || asString(row.desc), asString(row.effect), asString(row.special)]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Boons and banes share a mapper — `kind` records which, and both become 'condition' entries.
 * Real Open Legend fields: `power` (a list of power thresholds), `attribute`/`attackAttributes`
 * (the invoking attribute(s)), `invocationTime`, `duration`. All are preserved in dataJson so
 * the reader can show the full effect while the condition list stays simple.
 */
function makeStatusMapper(kind: 'boon' | 'bane') {
  return (row: Record<string, unknown>): OlImportedEntry => {
    const power = asLabelList(row.power);
    // boons carry `attribute`; banes carry `attackAttributes` (the older single `attribute`
    // and `resist`/`resisted_by` fields are accepted too, for JSON overrides).
    const attribute = asLabelList(row.attribute).length ? asLabelList(row.attribute) : asLabelList(row.attackAttributes);
    const duration = asString(row.duration);
    const invocationTime = asString(row.invocationTime);
    const resist = asString(row.resist) || asString(row.resisted_by);
    return {
      slug: slugOf(row),
      name: asString(row.name),
      type: 'condition',
      summary: truncate(
        [kind === 'boon' ? 'Boon' : 'Bane', power.length ? `power ${power.join('/')}` : null, attribute.length ? attribute.join('/') : null]
          .filter(Boolean)
          .join(' · ') || proseBody(row),
        300,
      ),
      body: proseBody(row),
      dataJson: JSON.stringify({
        kind,
        power: power.length ? power : null,
        attribute: attribute.length ? attribute : null,
        invocationTime: invocationTime || null,
        duration: duration || null,
        resist: resist || null,
      }),
      license: licenseOf(row),
      source: sourceOf(row),
    };
  };
}

function mapFeat(row: Record<string, unknown>): OlImportedEntry {
  const tags = asLabelList(row.tags);
  const cost = asLabelList(row.cost);
  const tier = asString(row.tier);
  // Real feats carry a structured `prerequisites` object; JSON overrides may pass a flat string.
  const prereqRaw = row.prerequisites ?? row.prerequisite;
  const prerequisite = typeof prereqRaw === 'string' ? asString(prereqRaw) : '';
  return {
    slug: slugOf(row),
    name: asString(row.name),
    type: 'feat',
    summary: truncate(
      [tier ? `${tier} feat` : null, cost.length ? `cost ${cost.join('/')}` : null, prerequisite ? `Prerequisite: ${prerequisite}` : null]
        .filter(Boolean)
        .join(' · ') || proseBody(row),
      300,
    ),
    body: proseBody(row),
    dataJson: JSON.stringify({
      tier: tier || null,
      cost: cost.length ? cost : null,
      tags: tags.length ? tags : null,
      prerequisites: prereqRaw ?? null,
    }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

const SECTION_MAPPER: Record<OpenLegendSection, (row: Record<string, unknown>) => OlImportedEntry> = {
  boons: makeStatusMapper('boon'),
  banes: makeStatusMapper('bane'),
  feats: mapFeat,
};

interface NormalizedPage {
  results: Array<Record<string, unknown>>;
  next: string | null;
}

/**
 * Parse a section response body (text) into rows. Accepts, in order:
 *   - a YAML or JSON top-level list (the real `.yml` files, and single-file JSON exports)
 *   - a JSON `{count,next,previous,results}` page (a paginated JSON override / mirror)
 * YAML is a superset of JSON, so `loadYaml` handles both; we still special-case an object
 * with a `results` array to preserve the `next` pagination link for JSON-API overrides.
 */
function parseBody(text: string): NormalizedPage {
  let doc: unknown;
  try {
    doc = loadYaml(text);
  } catch (err) {
    throw new Error(`not valid YAML/JSON: ${(err as Error).message}`);
  }
  if (Array.isArray(doc)) return { results: doc as Array<Record<string, unknown>>, next: null };
  if (doc && typeof doc === 'object') {
    const obj = doc as Record<string, unknown>;
    if (Array.isArray(obj.results)) {
      return { results: obj.results as Array<Record<string, unknown>>, next: typeof obj.next === 'string' ? obj.next : null };
    }
  }
  throw new Error('response is neither a list nor a {results:[…]} page');
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

/** First URL to fetch for a section — the section's data file relative to the base. */
function sectionUrl(baseUrl: string, section: OpenLegendSection): string {
  return `${baseUrl.replace(/\/$/, '')}/${SECTION_TO_PATH[section]}`;
}

/**
 * Fetch and map one section's entries. The real source is a single YAML file per section
 * (no pagination), but a JSON override may paginate via `next` — the loop follows same-origin
 * `next` links only (cross-origin is refused, not followed), caps pages, de-dups by name, and
 * logs a per-section count so an empty section is visible. Mirrors fetchOpen5eSection.
 */
export async function fetchOpenLegendSection(
  baseUrl: string,
  section: OpenLegendSection,
  logger: OpenLegendImportLogger = consoleLogger,
): Promise<OpenLegendSectionResult> {
  const mapper = SECTION_MAPPER[section];
  const byName = new Map<string, OlImportedEntry>();
  let skippedCount = 0;
  let dedupedCount = 0;
  let pagesFetched = 0;
  let url: string | null = sectionUrl(baseUrl, section);

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
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new BadRequestException(`Open Legend section "${section}" body could not be read: ${(err as Error).message}`);
    }
    let page: NormalizedPage;
    try {
      page = parseBody(text);
    } catch (err) {
      throw new BadRequestException(`Open Legend section "${section}" has an unexpected shape: ${(err as Error).message}`);
    }
    for (const row of page.results) {
      let entry: OlImportedEntry;
      try {
        if (!row || typeof row !== 'object') throw new Error('non-object row');
        entry = mapper(row);
      } catch {
        skippedCount += 1;
        continue;
      }
      const key = entry.name.trim().toLowerCase();
      if (!key) {
        skippedCount += 1;
        continue;
      }
      if (byName.has(key)) {
        dedupedCount += 1; // keep first-seen (stable)
        continue;
      }
      if (byName.size >= OL_MAX_ENTRIES_PER_SECTION) break;
      byName.set(key, entry);
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

  const entries = [...byName.values()];
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
