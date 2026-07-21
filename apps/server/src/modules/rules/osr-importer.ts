import { BadRequestException } from '@nestjs/common';
import type { RuleEntryType } from '@campfire/schema';
import type { ImportedEntry, Open5eImportLogger } from './open5e-importer';

/**
 * Importer for the OSR (Old-School Renaissance) retroclone family — issue #300, the
 * companion to the shared `OsrAdapter` in @campfire/schema. It mirrors the Open5e
 * importer (`open5e-importer.ts`): fetch-at-install, per-section paginated fetch with
 * timeout/retry/cross-origin hardening, de-dupe, and per-source license/attribution
 * stamping — but targets the B/X-style source docs instead of Open5e's v2 API.
 *
 * Sourcing & license (issue #143 — stamp the CORRECT per-source license, never mislabel):
 *   - Basic Fantasy RPG is imported FIRST — its content is released under **CC-BY-SA 4.0**
 *     with free, machine-readable release docs, the cleanest OSR source.
 *   - The OGL retroclones (OSRIC, Swords & Wizardry, Labyrinth Lord, Old-School
 *     Essentials) publish their own SRDs under the **OGL 1.0a** and use the SAME importer
 *     and the SAME adapter; each carries its own license string and attribution so a
 *     mixed install never labels OGL content as CC-BY-SA (or vice-versa).
 * The legal basis is always the game content's OWN open license, obtained from the
 * content's open source — never a Foundry/VTT package (whose packaging license forbids
 * reuse outside that VTT).
 *
 * Source shape: OSR docs have no single canonical API like Open5e, so this importer
 * targets a small, stable JSON contract that the free source docs are published/mirrored
 * as — one endpoint per section (`<base>/monsters`, `/spells`, `/items`, `/conditions`),
 * each returning EITHER a bare array of rows OR a `{ next, results: [...] }` page (both
 * are accepted, so a static mirror and a paginated host both work). Field names use the
 * native OSR vocabulary (hit dice, descending AND/OR ascending AC, saves, morale). A full
 * bulk ingest of every clone's corpus runs through the existing non-blocking install-job
 * path (issue #20) exactly as the Open5e importer does; this module provides the fetch +
 * mapping, proven against a small real Basic Fantasy sample in the tests.
 */

export const OSR_MAX_ENTRIES_PER_SECTION = 5000;
const PAGE_LIMIT = 500;
const MAX_PAGES_PER_SECTION = 50;
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_RETRY_BACKOFFS_MS = [1_000, 3_000];

export type OsrSection = 'monsters' | 'spells' | 'items' | 'conditions';

export const ALL_OSR_SECTIONS: OsrSection[] = ['monsters', 'spells', 'items', 'conditions'];

const SECTION_TO_PATH: Record<OsrSection, string> = {
  monsters: 'monsters',
  spells: 'spells',
  items: 'items',
  conditions: 'conditions',
};

const SECTION_TO_ENTRY_TYPE: Record<OsrSection, RuleEntryType> = {
  monsters: 'monster',
  spells: 'spell',
  items: 'item',
  conditions: 'condition',
};

/**
 * Per-source metadata for an OSR system. The `license` and `attribution` are stamped onto
 * every imported entry so provenance is never lost or mislabeled (issue #143), and
 * `systemSlug` is BOTH the installed rule-pack slug AND the key the shared `OsrAdapter` is
 * registered under (see OSR_RULE_SYSTEM_SLUGS in @campfire/schema) — so a campaign on this
 * pack automatically gets OSR combat behavior.
 */
export interface OsrSource {
  systemSlug: string;
  name: string;
  license: string;
  attribution: string;
  sourceUrl: string;
}

export const OSR_SOURCES: Record<string, OsrSource> = {
  'basic-fantasy': {
    systemSlug: 'basic-fantasy',
    name: 'Basic Fantasy RPG',
    // Basic Fantasy's 4th-printing content is released under CC-BY-SA 4.0.
    license: 'Creative Commons Attribution-ShareAlike 4.0 (CC-BY-SA-4.0)',
    attribution: 'Basic Fantasy Role-Playing Game, © Chris Gonnerman, licensed under CC-BY-SA 4.0.',
    sourceUrl: 'https://basicfantasy.org',
  },
  osric: {
    systemSlug: 'osric',
    name: 'OSRIC',
    license: 'Open Game License v1.0a (OGL)',
    attribution: 'OSRIC™ (Old-School Reference and Index Compilation), Open Game Content under the OGL v1.0a.',
    sourceUrl: 'https://osricrpg.com',
  },
  'swords-wizardry': {
    systemSlug: 'swords-wizardry',
    name: 'Swords & Wizardry',
    license: 'Open Game License v1.0a (OGL)',
    attribution: 'Swords & Wizardry, Open Game Content under the OGL v1.0a.',
    sourceUrl: 'https://www.mythmeregames.com',
  },
  'labyrinth-lord': {
    systemSlug: 'labyrinth-lord',
    name: 'Labyrinth Lord',
    license: 'Open Game License v1.0a (OGL)',
    attribution: 'Labyrinth Lord™, Open Game Content under the OGL v1.0a.',
    sourceUrl: 'https://www.goblinoidgames.com',
  },
  'old-school-essentials': {
    systemSlug: 'old-school-essentials',
    name: 'Old-School Essentials',
    license: 'Open Game License v1.0a (OGL)',
    attribution: 'Old-School Essentials SRD, Open Game Content under the OGL v1.0a.',
    sourceUrl: 'https://necroticgnome.com',
  },
};

/** Resolve a source by slug (defaults to Basic Fantasy — the cleanest CC-BY-SA source). */
export function osrSource(systemSlug?: string | null): OsrSource {
  return (systemSlug && OSR_SOURCES[systemSlug]) || OSR_SOURCES['basic-fantasy'];
}

export interface OsrSectionResult {
  entries: ImportedEntry[];
  /** Rows present in a fetched page but skipped (malformed row, or a cross-origin `next` refused). */
  skippedCount: number;
  /** Same-slug rows collapsed to one (issue #143 de-dupe, keyed by slug within a source). */
  dedupedCount: number;
}

interface OsrPage {
  next?: string | null;
  results: Array<Record<string, unknown>>;
}

const consoleLogger: Open5eImportLogger = {
  // eslint-disable-next-line no-console
  warn: (message: string) => console.warn(message),
  // eslint-disable-next-line no-console
  info: (message: string) => console.info(message),
};

function asString(v: unknown): string {
  if (typeof v !== 'string') return '';
  // Mirror the Open5e importer: some source docs carry literal escape sequences instead of
  // real whitespace, which breaks markdown rendering — normalize them.
  return v.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugOf(row: Record<string, unknown>): string {
  return asString(row.slug) || asString(row.key) || slugify(asString(row.name));
}

/**
 * Map an OSR monster row to a rule-entry. OSR statblocks are built around hit dice,
 * armor class in EITHER convention (we preserve whichever the source gives and record
 * both when possible), THAC0/attack bonus, movement, saves, morale, and number appearing.
 * Everything structured lands in `dataJson` for the adapter's `mapStatblock`.
 */
function mapMonster(row: Record<string, unknown>, source: OsrSource): ImportedEntry {
  const hitDice = asString(row.hitDice ?? row.hit_dice ?? row.hd);
  const acDescending = asNumberOrNull(row.armorClass ?? row.armor_class ?? row.ac);
  const acAscending = asNumberOrNull(row.armorClassAscending ?? row.ascending_armor_class ?? row.aac);
  const type = asString(row.type ?? row.category);
  const desc = asString(row.description ?? row.desc);
  return {
    slug: slugOf(row),
    name: asString(row.name),
    type: 'monster',
    summary: truncate([type, hitDice ? `HD ${hitDice}` : null].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({
      hitDice: hitDice || null,
      armorClass: acDescending,
      armorClassAscending: acAscending,
      thac0: asNumberOrNull(row.thac0),
      hitPoints: asNumberOrNull(row.hitPoints ?? row.hit_points ?? row.hp),
      movement: row.movement ?? row.speed ?? null,
      numberAppearing: row.numberAppearing ?? row.no_appearing ?? null,
      save: row.save ?? row.saveAs ?? null,
      morale: asNumberOrNull(row.morale),
      treasureType: row.treasureType ?? row.treasure ?? null,
      xp: asNumberOrNull(row.xp),
      attacks: row.attacks ?? row.actions ?? null,
    }),
    license: source.license,
    source: source.attribution,
  };
}

function mapSpell(row: Record<string, unknown>, source: OsrSource): ImportedEntry {
  const spellClass = asString(row.class ?? row.spellClass); // "magic-user" | "cleric"
  const level = asNumberOrNull(row.level);
  const desc = asString(row.description ?? row.desc);
  return {
    slug: slugOf(row),
    name: asString(row.name),
    type: 'spell',
    summary: truncate([spellClass, level !== null ? `level ${level}` : null].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({
      class: spellClass || null,
      level,
      range: row.range ?? null,
      duration: row.duration ?? null,
    }),
    license: source.license,
    source: source.attribution,
  };
}

function mapItem(row: Record<string, unknown>, source: OsrSource): ImportedEntry {
  const category = asString(row.category ?? row.type);
  const desc = asString(row.description ?? row.desc);
  return {
    slug: slugOf(row),
    name: asString(row.name),
    type: 'item',
    summary: truncate([category].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({
      category: category || null,
      cost: row.cost ?? null,
      weight: asNumberOrNull(row.weight),
    }),
    license: source.license,
    source: source.attribution,
  };
}

function mapCondition(row: Record<string, unknown>, source: OsrSource): ImportedEntry {
  const desc = asString(row.description ?? row.desc);
  return {
    slug: slugOf(row),
    name: asString(row.name),
    type: 'condition',
    summary: truncate(desc, 300),
    body: desc,
    dataJson: null,
    license: source.license,
    source: source.attribution,
  };
}

type OsrMapper = (row: Record<string, unknown>, source: OsrSource) => ImportedEntry;

const SECTION_MAPPER: Record<OsrSection, OsrMapper> = {
  monsters: mapMonster,
  spells: mapSpell,
  items: mapItem,
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

/** Retry a page fetch on transient failure (timeout / 5xx) only — same policy as Open5e. */
async function fetchPageWithRetry(url: string, section: OsrSection, logger: Open5eImportLogger): Promise<Response> {
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
        `[osr-importer] section "${section}": fetch of ${url} failed (${reason}), retrying in ${backoff}ms (attempt ${attempt + 1}/${PAGE_RETRY_BACKOFFS_MS.length})`,
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

/** Accept either a bare array of rows or a `{ next, results }` page — both shapes are valid. */
function normalizePage(body: unknown, section: OsrSection): OsrPage {
  if (Array.isArray(body)) return { next: null, results: body as Array<Record<string, unknown>> };
  if (body && typeof body === 'object' && Array.isArray((body as OsrPage).results)) {
    return body as OsrPage;
  }
  throw new BadRequestException(`OSR section "${section}" response was neither an array nor a { results } page`);
}

/**
 * Fetch and map one section for one OSR source, paginating (when the source hosts pages)
 * until the source runs out or the size cap is hit. De-dupes by slug within the source so
 * a duplicated row can't violate the (pack, type, slug) unique index. Every entry is
 * stamped with the source's own license + attribution (issue #143). Mirrors the Open5e
 * importer's hardening: same-origin pagination guard, transient-failure retry, page cap,
 * skip accounting, and a per-section count log.
 */
export async function fetchOsrSection(
  baseUrl: string,
  section: OsrSection,
  source: OsrSource,
  logger: Open5eImportLogger = consoleLogger,
): Promise<OsrSectionResult> {
  const path = SECTION_TO_PATH[section];
  const mapper = SECTION_MAPPER[section];
  const bySlug = new Map<string, ImportedEntry>();
  let skippedCount = 0;
  let dedupedCount = 0;
  let pagesFetched = 0;
  let url: string | null = `${baseUrl.replace(/\/$/, '')}/${path}?limit=${PAGE_LIMIT}`;

  while (url && bySlug.size < OSR_MAX_ENTRIES_PER_SECTION) {
    if (pagesFetched >= MAX_PAGES_PER_SECTION) {
      logger.warn(`[osr-importer] section "${section}": hit page cap (${MAX_PAGES_PER_SECTION}) after ${bySlug.size} entries — stopping`);
      break;
    }
    pagesFetched += 1;
    let res: Response;
    try {
      res = await fetchPageWithRetry(url, section, logger);
    } catch (err) {
      throw new BadRequestException(`Failed to fetch OSR section "${section}" from ${url}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new BadRequestException(`OSR section "${section}" returned HTTP ${res.status} for ${url}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new BadRequestException(`OSR section "${section}" returned invalid JSON: ${(err as Error).message}`);
    }
    const page = normalizePage(body, section);
    for (const row of page.results) {
      let entry: ImportedEntry;
      try {
        entry = mapper(row, source);
      } catch {
        skippedCount += 1;
        continue;
      }
      if (!entry.name || !entry.slug) {
        skippedCount += 1;
        continue;
      }
      if (bySlug.has(entry.slug)) {
        dedupedCount += 1;
        continue; // keep first-seen (stable)
      }
      if (bySlug.size >= OSR_MAX_ENTRIES_PER_SECTION) break;
      bySlug.set(entry.slug, entry);
    }

    if (page.next && !isSameOrigin(baseUrl, page.next)) {
      skippedCount += 1;
      logger.warn(`[osr-importer] section "${section}": refusing cross-origin pagination link (base=${baseUrl}, next=${page.next}) — stopping`);
      url = null;
    } else {
      url = page.next ?? null;
    }
  }

  const entries = [...bySlug.values()];
  logger.info(
    `[osr-importer] section "${section}" (${source.name}): imported ${entries.length} entries across ${pagesFetched} page(s)` +
      (dedupedCount > 0 ? ` (de-duped ${dedupedCount} same-slug row(s))` : ''),
  );
  if (skippedCount > 0) {
    logger.warn(`[osr-importer] section "${section}": imported ${entries.length} entries, skipped ${skippedCount} row(s)`);
  }
  return { entries, skippedCount, dedupedCount };
}

export function entryTypeForOsrSection(section: OsrSection): RuleEntryType {
  return SECTION_TO_ENTRY_TYPE[section];
}
