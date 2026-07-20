import { BadRequestException } from '@nestjs/common';
import type { RuleEntryType } from '@campfire/schema';

/**
 * Importer for the Open5e v2 API (https://api.open5e.com/v2/). Field shapes
 * below were captured by fetching the LIVE endpoints during development
 * (2026-07-18) — Open5e's v1 API used different names (e.g. a `/monsters/`
 * path, flat `hit_points`/`armor_class` at top level with no nesting) and is
 * NOT what this importer targets. v2 specifics that mattered:
 *   - There is no `/v2/monsters/` route — the monster/statblock list lives at
 *     `/v2/creatures/`. We still expose it to Campfire as ruleEntry.type
 *     'monster' (our vocabulary), just fetched from the creatures path.
 *   - Every list is paginated: {count, next, previous, results: [...]}. `next`
 *     is a full URL, so pagination just follows it rather than re-deriving
 *     page numbers.
 *   - Nearly every result nests display fields inside sub-objects instead of
 *     flat strings, e.g. spell `school.name`, creature `type.name` /
 *     `size.name`, magicitem `category.name` / `rarity.name`. We use `.name`
 *     with `?? ''` fallbacks throughout in case a field is null for a given
 *     entry (Open5e's data is community-maintained and not 100% uniform).
 *   - `desc` is the long-form text (spells, magicitems); `descriptions[].desc`
 *     is used instead for conditions (an array, since some conditions have
 *     multiple source-specific write-ups — we join them).
 *   - License isn't per-entry; it's derived from `document.licenses[].name`
 *     (documents endpoint) or, more simply, from the known SRD/CC-BY-4.0
 *     baseline license all `results[].document` entries carry via their own
 *     `licenses` list on GET /v2/documents/. We take the conservative route
 *     and record the license as reported by the entry's own `document`
 *     sub-object when present, else fall back to the pack-level default.
 */

export const OPEN5E_DEFAULT_BASE_URL = 'https://api.open5e.com/v2';
export const MAX_ENTRIES_PER_SECTION = 2000;
const PAGE_LIMIT = 100;
// Real Open5e pages have been observed taking 6-11s to respond (large spell/creature
// pages especially) — 10s was too tight and produced spurious timeouts. 30s gives
// enough headroom while still bounding a truly hung request.
const FETCH_TIMEOUT_MS = 30_000;
// Retries are for transient failures only (timeout or 5xx) — a 4xx or malformed-JSON
// response is a real problem with the request/upstream shape and retrying won't help.
const PAGE_RETRY_BACKOFFS_MS = [1_000, 3_000];

export type Open5eSection = 'spells' | 'monsters' | 'items' | 'conditions';

const SECTION_TO_PATH: Record<Open5eSection, string> = {
  spells: 'spells',
  monsters: 'creatures', // v2 has no /monsters/ route — see file header note.
  items: 'magicitems',
  conditions: 'conditions',
};

const SECTION_TO_ENTRY_TYPE: Record<Open5eSection, RuleEntryType> = {
  spells: 'spell',
  monsters: 'monster',
  items: 'item',
  conditions: 'condition',
};

export interface ImportedEntry {
  slug: string;
  name: string;
  type: RuleEntryType;
  summary: string;
  body: string;
  dataJson: string | null;
  license: string;
}

/** Minimal structured logger so a summary can be asserted on in tests without console spying. */
export interface Open5eImportLogger {
  warn(message: string): void;
}

const consoleLogger: Open5eImportLogger = {
  // eslint-disable-next-line no-console
  warn: (message: string) => console.warn(message),
};

export interface Open5eSectionResult {
  entries: ImportedEntry[];
  /** Rows present in a fetched page but skipped (malformed row, or a cross-origin `next` link refused). */
  skippedCount: number;
}

interface Open5ePage {
  count: number;
  next: string | null;
  previous: string | null;
  results: Array<Record<string, unknown>>;
}

function asString(v: unknown): string {
  if (typeof v !== 'string') return '';
  // Some Open5e entries carry LITERAL escape sequences (a backslash followed by
  // "n"/"t") in their text instead of real whitespace, which breaks markdown
  // tables and paragraph breaks in the reader. Normalise to real characters.
  return v.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
}

function nestedName(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in v) return asString((v as Record<string, unknown>).name);
  return '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function licenseOf(row: Record<string, unknown>): string {
  const doc = row.document as Record<string, unknown> | undefined;
  const licenses = doc?.licenses as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(licenses) && licenses.length > 0) {
    return licenses.map((l) => asString(l.name)).filter(Boolean).join(', ');
  }
  return '';
}

function mapSpell(row: Record<string, unknown>): ImportedEntry {
  const school = nestedName(row.school);
  const level = typeof row.level === 'number' ? row.level : null;
  const desc = asString(row.desc);
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'spell',
    summary: truncate([school, level !== null ? `level ${level}` : null].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({ school, level, castingTime: row.casting_time ?? null, range: row.range_text ?? null, duration: row.duration ?? null, concentration: row.concentration ?? null, ritual: row.ritual ?? null }),
    license: licenseOf(row),
  };
}

function mapCreature(row: Record<string, unknown>): ImportedEntry {
  const type = nestedName(row.type);
  const size = nestedName(row.size);
  const cr = row.challenge_rating;
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'monster',
    summary: truncate([size, type, cr !== undefined && cr !== null ? `CR ${cr}` : null].filter(Boolean).join(' · '), 300),
    body: '', // creatures don't have a single desc field in v2 — statblock lives in dataJson
    dataJson: JSON.stringify({
      type,
      size,
      challengeRating: cr ?? null,
      armorClass: row.armor_class ?? null,
      hitPoints: row.hit_points ?? null,
      speed: row.speed ?? null,
      abilityScores: row.ability_scores ?? null,
    }),
    license: licenseOf(row),
  };
}

function mapMagicItem(row: Record<string, unknown>): ImportedEntry {
  const category = nestedName(row.category);
  const rarity = nestedName(row.rarity);
  const desc = asString(row.desc);
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'item',
    summary: truncate([category, rarity].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({ category, rarity, requiresAttunement: row.requires_attunement ?? null }),
    license: licenseOf(row),
  };
}

function mapCondition(row: Record<string, unknown>): ImportedEntry {
  const descriptions = row.descriptions as Array<Record<string, unknown>> | undefined;
  const desc = Array.isArray(descriptions) ? descriptions.map((d) => asString(d.desc)).filter(Boolean).join('\n\n') : asString(row.desc);
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'condition',
    summary: truncate(desc, 300),
    body: desc,
    dataJson: null,
    license: licenseOf(row),
  };
}

const SECTION_MAPPER: Record<Open5eSection, (row: Record<string, unknown>) => ImportedEntry> = {
  spells: mapSpell,
  monsters: mapCreature,
  items: mapMagicItem,
  conditions: mapCondition,
};

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

/**
 * Fetches one page with retry on transient failures: a request timeout (AbortError) or
 * an HTTP 5xx response. Retries PAGE_RETRY_BACKOFFS_MS.length times with the configured
 * backoff between attempts (1s, then 3s). A 4xx response or a network error that isn't a
 * timeout is NOT retried — those indicate a real problem with the request itself, not a
 * transient blip, and retrying would just waste time before failing anyway.
 */
async function fetchPageWithRetry(url: string, section: Open5eSection, logger: Open5eImportLogger): Promise<Response> {
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
        // 4xx or other non-ok, non-5xx status — not transient, fail immediately.
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
        `[open5e-importer] section "${section}": fetch of ${url} failed (${reason}), retrying in ${backoff}ms (attempt ${attempt + 1}/${PAGE_RETRY_BACKOFFS_MS.length})`,
      );
      await sleep(backoff);
    }
  }

  if (lastRes) return lastRes;
  throw lastErr ?? new Error('unknown fetch failure');
}

/** True if `candidate` has the same scheme+host+port as `origin` (both parsed as URLs). */
function isSameOrigin(origin: string, candidate: string): boolean {
  try {
    return new URL(origin).origin === new URL(candidate).origin;
  } catch {
    return false;
  }
}

/**
 * Fetches and maps one section's entries, paginating until either the API
 * runs out of pages or MAX_ENTRIES_PER_SECTION is hit (size cap so a single
 * install can't pull unbounded data from a third-party API into our DB).
 * Network/parse failures are wrapped as BadRequestException so the caller
 * gets a clean 400 instead of a raw fetch error leaking through.
 *
 * Hardening measures beyond the original implementation:
 *  - **Pagination guard**: `page.next` is only followed if it's same-origin as the
 *    configured `baseUrl`. A misbehaving or compromised upstream returning a
 *    cross-origin `next` link (accidentally or maliciously) can't redirect this
 *    server into fetching from an arbitrary third party using our request budget/timeout.
 *    Pagination just stops (not an error — whatever was collected so far is returned).
 *  - **Skip accounting**: malformed rows (mapper throw) and any refused cross-origin
 *    `next` page are counted and reported via `logger.warn` once at the end of the
 *    section, instead of disappearing silently.
 *  - **Retry on transient failure**: each page fetch gets up to 2 retries (1s, then 3s
 *    backoff) on a request timeout or HTTP 5xx before giving up — real Open5e pages have
 *    been observed taking 6-11s, and occasional 5xx blips shouldn't fail an entire import.
 */
export async function fetchOpen5eSection(
  baseUrl: string,
  section: Open5eSection,
  logger: Open5eImportLogger = consoleLogger,
): Promise<Open5eSectionResult> {
  const path = SECTION_TO_PATH[section];
  const mapper = SECTION_MAPPER[section];
  const entries: ImportedEntry[] = [];
  let skippedCount = 0;
  let url: string | null = `${baseUrl.replace(/\/$/, '')}/${path}/?limit=${PAGE_LIMIT}`;

  while (url && entries.length < MAX_ENTRIES_PER_SECTION) {
    let res: Response;
    try {
      res = await fetchPageWithRetry(url, section, logger);
    } catch (err) {
      throw new BadRequestException(`Failed to fetch Open5e section "${section}" from ${url}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new BadRequestException(`Open5e section "${section}" returned HTTP ${res.status} for ${url}`);
    }
    let page: Open5ePage;
    try {
      page = (await res.json()) as Open5ePage;
    } catch (err) {
      throw new BadRequestException(`Open5e section "${section}" returned invalid JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(page.results)) {
      throw new BadRequestException(`Open5e section "${section}" response missing "results" array (unexpected shape)`);
    }
    for (const row of page.results) {
      if (entries.length >= MAX_ENTRIES_PER_SECTION) break;
      try {
        entries.push(mapper(row));
      } catch {
        // Skip a single malformed row rather than failing the whole import.
        skippedCount += 1;
      }
    }

    if (page.next && !isSameOrigin(baseUrl, page.next)) {
      skippedCount += 1;
      logger.warn(
        `[open5e-importer] section "${section}": refusing to follow cross-origin pagination link (base=${baseUrl}, next=${page.next}) — stopping pagination`,
      );
      url = null;
    } else {
      url = page.next;
    }
  }

  if (skippedCount > 0) {
    logger.warn(`[open5e-importer] section "${section}": imported ${entries.length} entries, skipped ${skippedCount} row(s)`);
  }

  return { entries, skippedCount };
}

export function entryTypeForSection(section: Open5eSection): RuleEntryType {
  return SECTION_TO_ENTRY_TYPE[section];
}

export const ALL_OPEN5E_SECTIONS: Open5eSection[] = ['spells', 'monsters', 'items', 'conditions'];
