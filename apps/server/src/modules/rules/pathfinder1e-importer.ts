import { BadRequestException } from '@nestjs/common';
import type { RuleEntryType } from '@campfire/schema';
import { PF1E_PACK_SLUG } from '@campfire/schema';
import type { ImportedEntry } from './open5e-importer';

/**
 * Importer for the Pathfinder 1e SRD (issue #296, part of the #275 open-ruleset program).
 *
 * SOURCE & LICENSE. Pathfinder 1e's game content is published under the Open Game License
 * (OGL v1.0a) — that OGL grant, NOT any Foundry/VTT package, is the legal basis for import
 * (per the #275 sourcing rule). The canonical open text lives at the PFSRD / d20pfsrd
 * (https://www.d20pfsrd.com) and Archives of Nethys 1e (https://www.aonprd.com). Those sites
 * publish the SRD as HTML; a production install points `baseUrl` at a structured-JSON mirror
 * of that OGL content shaped like the paginated collection this importer consumes
 * (`{count, next, previous, results:[...]}`), exactly as the Open5e importer consumes Open5e's
 * v2 JSON. This module owns the field mapping and the same install-time hardening as the
 * Open5e importer (timeout, transient-retry, same-origin pagination guard, page/entry caps);
 * bulk ingest runs through the normal background install-job path (issue #20), not at import
 * of this file. Field shapes below mirror the PFSRD statblock/stat vocabulary:
 *   - Monsters carry an ascending `ac`, `hp`, a fractional-or-integer `cr` ("1/3", "1/2", 3),
 *     `saves:{fort,ref,will}`, and an `ability_scores` object ({str,dex,con,int,wis,cha}).
 *     Exposed to Campfire as ruleEntry.type 'monster'.
 *   - Spells list per-class `levels` (e.g. { wizard: 3, sorcerer: 3 }) and a `school`.
 *   - Classes carry a `hit_die`, a `bab` track ('full'|'threeQuarter'|'half'), and a
 *     `good_saves` list — the 3.5e-family progressions the PF1e adapter models.
 *   - Every row may carry a `source` sub-object ({ name, key, license }); when present the
 *     per-entry license/attribution is recorded from it (issue #143), else the pack default.
 */

export const PF1E_DEFAULT_BASE_URL = 'https://pathfinder-1e-srd.example/api/v1';
/** Default pack-level license when a row carries no per-source license. PF1e SRD is OGL v1.0a. */
export const PF1E_DEFAULT_LICENSE = 'OGL v1.0a';
export const PF1E_PACK_NAME = 'Pathfinder 1e SRD';

export const MAX_ENTRIES_PER_SECTION = 2000;
const PAGE_LIMIT = 500;
const MAX_PAGES_PER_SECTION = 50;
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_RETRY_BACKOFFS_MS = [1_000, 3_000];

export type Pf1eSection = 'spells' | 'monsters' | 'items' | 'conditions' | 'classes' | 'races' | 'feats';

/** Collection path per section. PF1e uses conventional plural names (no Open5e-style quirks). */
const SECTION_TO_PATH: Record<Pf1eSection, string> = {
  spells: 'spells',
  monsters: 'monsters',
  items: 'items',
  conditions: 'conditions',
  classes: 'classes',
  races: 'races',
  feats: 'feats',
};

const SECTION_TO_ENTRY_TYPE: Record<Pf1eSection, RuleEntryType> = {
  spells: 'spell',
  monsters: 'monster',
  items: 'item',
  conditions: 'condition',
  classes: 'class',
  races: 'race',
  feats: 'feat',
};

export const ALL_PF1E_SECTIONS: Pf1eSection[] = ['spells', 'monsters', 'items', 'conditions', 'classes', 'races', 'feats'];

/** Minimal structured logger (mirrors the Open5e importer) so tests can assert on the summary. */
export interface Pf1eImportLogger {
  warn(message: string): void;
  info(message: string): void;
}

const consoleLogger: Pf1eImportLogger = {
  // eslint-disable-next-line no-console
  warn: (message: string) => console.warn(message),
  // eslint-disable-next-line no-console
  info: (message: string) => console.info(message),
};

export interface Pf1eSectionResult {
  entries: ImportedEntry[];
  skippedCount: number;
  dedupedCount: number;
}

interface Pf1ePage {
  count: number;
  next: string | null;
  previous: string | null;
  results: Array<Record<string, unknown>>;
}

function asString(v: unknown): string {
  if (typeof v !== 'string') return '';
  // Normalise literal escape sequences (backslash-n/t) to real whitespace so markdown renders.
  return v.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
}

function nestedName(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in v) return asString((v as Record<string, unknown>).name);
  if (typeof v === 'string') return asString(v);
  return '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A slugified name, used when a row carries no explicit slug/key. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** Per-entry license from the row's `source`/`document` sub-object, else '' (issue #143). */
function licenseOf(row: Record<string, unknown>): string {
  const src = (row.source ?? row.document) as Record<string, unknown> | string | undefined;
  if (src && typeof src === 'object') {
    const lic = asString(src.license);
    if (lic) return lic;
  }
  return asString(row.license);
}

/** Human-readable source/attribution label (`source.name`/`document.name`, else a bare string). */
function sourceOf(row: Record<string, unknown>): string {
  const src = row.source ?? row.document;
  if (src && typeof src === 'object') {
    const name = asString((src as Record<string, unknown>).name);
    if (name) return name;
    const key = asString((src as Record<string, unknown>).key);
    if (key) return key;
  } else if (typeof src === 'string' && src) {
    return src;
  }
  return '';
}

/** The source document key an entry came from (for de-dupe ranking). */
function sourceKeyOf(row: Record<string, unknown>): string {
  const src = row.source ?? row.document;
  if (src && typeof src === 'object') {
    const key = asString((src as Record<string, unknown>).key);
    if (key) return key.toLowerCase();
    const name = asString((src as Record<string, unknown>).name);
    if (name) return name.toLowerCase();
  } else if (typeof src === 'string' && src) {
    return src.toLowerCase();
  }
  return '';
}

/**
 * Canonicality rank for de-duplicating same-name entries across PF1e OGL documents (issue
 * #143): the same "Goblin"/"Fireball" appears in the Core Rulebook, Bestiary, and various
 * supplements. Keep exactly one, preferring the most-canonical source:
 *   0 — PFSRD / Core Rulebook baseline (`pfsrd`, `core`, `crb`)
 *   1 — any other first-party SRD document (bestiary, APG, …)
 *   2 — everything else (third-party / community)
 * Lower wins; ties keep the first-seen row (stable insertion order).
 */
function sourceRank(row: Record<string, unknown>): number {
  const key = sourceKeyOf(row);
  if (key === 'pfsrd' || key === 'core' || key === 'crb' || key.includes('core rulebook')) return 0;
  if (key.startsWith('pfsrd') || key.startsWith('srd') || key.includes('bestiary') || key.includes('advanced')) return 1;
  return 2;
}

function baseEntry(row: Record<string, unknown>, type: RuleEntryType): Pick<ImportedEntry, 'slug' | 'name' | 'type' | 'license' | 'source'> {
  const name = asString(row.name);
  return {
    slug: asString(row.key) || asString(row.slug) || slugify(name),
    name,
    type,
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

/** Render per-class spell levels ({ wizard: 3, sorcerer: 3 }) as "wizard 3 · sorcerer 3". */
function spellLevelsSummary(levels: unknown): string {
  if (levels && typeof levels === 'object' && !Array.isArray(levels)) {
    return Object.entries(levels as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([cls, lvl]) => `${cls} ${lvl}`)
      .join(' · ');
  }
  if (typeof levels === 'number' || typeof levels === 'string') return `level ${levels}`;
  return '';
}

function mapSpell(row: Record<string, unknown>): ImportedEntry {
  const school = nestedName(row.school);
  const levels = spellLevelsSummary(row.levels ?? row.level);
  const desc = asString(row.description ?? row.desc);
  return {
    ...baseEntry(row, 'spell'),
    summary: truncate([school, levels].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({
      school: school || null,
      levels: row.levels ?? row.level ?? null,
      castingTime: row.casting_time ?? row.castingTime ?? null,
      range: row.range ?? null,
      duration: row.duration ?? null,
      savingThrow: row.saving_throw ?? row.savingThrow ?? null,
      spellResistance: row.spell_resistance ?? row.spellResistance ?? null,
    }),
  };
}

function mapMonster(row: Record<string, unknown>): ImportedEntry {
  const type = nestedName(row.type);
  const size = nestedName(row.size);
  const cr = row.cr ?? row.challenge_rating ?? row.challengeRating;
  const saves = (row.saves ?? null) as Record<string, unknown> | null;
  return {
    ...baseEntry(row, 'monster'),
    summary: truncate([size, type, cr !== undefined && cr !== null ? `CR ${cr}` : null].filter(Boolean).join(' · '), 300),
    body: asString(row.description ?? row.desc), // usually empty — the statblock lives in dataJson
    dataJson: JSON.stringify({
      type: type || null,
      size: size || null,
      // Ascending AC (PF1e), kept as-is; `challengeRating` name matches the 5e statblock vocab
      // the adapter/encounter code reads.
      challengeRating: cr ?? null,
      armorClass: row.ac ?? row.armor_class ?? row.armorClass ?? null,
      hitPoints: row.hp ?? row.hit_points ?? row.hitPoints ?? null,
      speed: row.speed ?? null,
      initiative: row.init ?? row.initiative ?? null,
      saves: saves ? { fort: saves.fort ?? null, ref: saves.ref ?? null, will: saves.will ?? null } : null,
      abilityScores: row.ability_scores ?? row.abilityScores ?? null,
    }),
  };
}

function mapItem(row: Record<string, unknown>): ImportedEntry {
  const category = nestedName(row.category ?? row.type);
  const aura = asString(row.aura);
  const desc = asString(row.description ?? row.desc);
  return {
    ...baseEntry(row, 'item'),
    summary: truncate([category, row.price ? `price ${row.price}` : null].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({
      category: category || null,
      aura: aura || null,
      price: row.price ?? null,
      slot: row.slot ?? null,
      casterLevel: row.caster_level ?? row.casterLevel ?? null,
    }),
  };
}

function mapCondition(row: Record<string, unknown>): ImportedEntry {
  const desc = asString(row.description ?? row.desc);
  return {
    ...baseEntry(row, 'condition'),
    summary: truncate(desc, 300),
    body: desc,
    dataJson: null,
  };
}

function mapClass(row: Record<string, unknown>): ImportedEntry {
  const hitDie = asString(row.hit_die ?? row.hitDie);
  const bab = asString(row.bab ?? row.baseAttackBonus);
  const goodSaves = Array.isArray(row.good_saves ?? row.goodSaves)
    ? ((row.good_saves ?? row.goodSaves) as unknown[]).map((s) => asString(s)).filter(Boolean)
    : [];
  const desc = asString(row.description ?? row.desc);
  return {
    ...baseEntry(row, 'class'),
    summary: truncate(
      [hitDie ? `hit die ${hitDie}` : null, bab ? `BAB ${bab}` : null, goodSaves.length ? `good saves ${goodSaves.join('/')}` : null]
        .filter(Boolean)
        .join(' · ') || desc,
      300,
    ),
    body: desc,
    dataJson: JSON.stringify({ hitDie: hitDie || null, bab: bab || null, goodSaves }),
  };
}

function mapRace(row: Record<string, unknown>): ImportedEntry {
  const desc = asString(row.description ?? row.desc);
  const traits = Array.isArray(row.traits)
    ? (row.traits as Array<Record<string, unknown>>)
        .map((t) => (typeof t === 'string' ? asString(t) : asString(t?.name)))
        .filter(Boolean)
    : [];
  return {
    ...baseEntry(row, 'race'),
    summary: truncate(desc || traits.join(' · '), 300),
    body: desc,
    dataJson: JSON.stringify({ traits, abilityModifiers: row.ability_modifiers ?? row.abilityModifiers ?? null }),
  };
}

function mapFeat(row: Record<string, unknown>): ImportedEntry {
  const prerequisites = asString(row.prerequisites ?? row.prerequisite);
  const desc = asString(row.benefit ?? row.description ?? row.desc);
  return {
    ...baseEntry(row, 'feat'),
    summary: truncate(prerequisites ? `Prerequisite: ${prerequisites}` : desc, 300),
    body: [desc, prerequisites ? `**Prerequisites:** ${prerequisites}` : ''].filter(Boolean).join('\n\n'),
    dataJson: JSON.stringify({ prerequisites: prerequisites || null, featType: asString(row.type) || null }),
  };
}

const SECTION_MAPPER: Record<Pf1eSection, (row: Record<string, unknown>) => ImportedEntry> = {
  spells: mapSpell,
  monsters: mapMonster,
  items: mapItem,
  conditions: mapCondition,
  classes: mapClass,
  races: mapRace,
  feats: mapFeat,
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
 * Fetch one page with retry on transient failures (request timeout / HTTP 5xx). A 4xx or a
 * non-timeout network error is not retried — those are real request/upstream problems.
 * Mirrors the Open5e importer's retry policy (2 retries, 1s then 3s backoff).
 */
async function fetchPageWithRetry(url: string, section: Pf1eSection, logger: Pf1eImportLogger): Promise<Response> {
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
        return res; // non-transient, fail immediately
      }
    } catch (err) {
      lastErr = err as Error;
      lastRes = null;
    }

    if (attempt < PAGE_RETRY_BACKOFFS_MS.length) {
      const backoff = PAGE_RETRY_BACKOFFS_MS[attempt];
      const reason = lastErr ? lastErr.message : `HTTP ${lastRes?.status}`;
      logger.warn(
        `[pathfinder1e-importer] section "${section}": fetch of ${url} failed (${reason}), retrying in ${backoff}ms (attempt ${attempt + 1}/${PAGE_RETRY_BACKOFFS_MS.length})`,
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
 * Fetch and map one section's entries, paginating until the API runs out of pages or
 * MAX_ENTRIES_PER_SECTION is hit. Hardening mirrors the Open5e importer:
 *  - same-origin pagination guard (won't follow a cross-origin `next` link),
 *  - malformed-row skip accounting, transient-failure retry, page cap, per-section count log,
 *  - (name,type) de-dupe keeping the most-canonical source (see sourceRank), issue #143.
 * Network/parse failures surface as BadRequestException so the caller gets a clean 400.
 */
export async function fetchPathfinder1eSection(
  baseUrl: string,
  section: Pf1eSection,
  logger: Pf1eImportLogger = consoleLogger,
): Promise<Pf1eSectionResult> {
  const path = SECTION_TO_PATH[section];
  const mapper = SECTION_MAPPER[section];
  const byName = new Map<string, { entry: ImportedEntry; rank: number }>();
  let skippedCount = 0;
  let dedupedCount = 0;
  let pagesFetched = 0;
  let url: string | null = `${baseUrl.replace(/\/$/, '')}/${path}/?limit=${PAGE_LIMIT}`;

  while (url && byName.size < MAX_ENTRIES_PER_SECTION) {
    if (pagesFetched >= MAX_PAGES_PER_SECTION) {
      logger.warn(
        `[pathfinder1e-importer] section "${section}": hit page cap (${MAX_PAGES_PER_SECTION} pages) after ${byName.size} entries — stopping pagination`,
      );
      break;
    }
    pagesFetched += 1;
    let res: Response;
    try {
      res = await fetchPageWithRetry(url, section, logger);
    } catch (err) {
      throw new BadRequestException(`Failed to fetch Pathfinder 1e section "${section}" from ${url}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new BadRequestException(`Pathfinder 1e section "${section}" returned HTTP ${res.status} for ${url}`);
    }
    let page: Pf1ePage;
    try {
      page = (await res.json()) as Pf1ePage;
    } catch (err) {
      throw new BadRequestException(`Pathfinder 1e section "${section}" returned invalid JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(page.results)) {
      throw new BadRequestException(`Pathfinder 1e section "${section}" response missing "results" array (unexpected shape)`);
    }
    for (const row of page.results) {
      let entry: ImportedEntry;
      let rank: number;
      try {
        entry = mapper(row);
        rank = sourceRank(row);
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
        if (byName.size >= MAX_ENTRIES_PER_SECTION) break;
        byName.set(key, { entry, rank });
      }
    }

    if (page.next && !isSameOrigin(baseUrl, page.next)) {
      skippedCount += 1;
      logger.warn(
        `[pathfinder1e-importer] section "${section}": refusing to follow cross-origin pagination link (base=${baseUrl}, next=${page.next}) — stopping pagination`,
      );
      url = null;
    } else {
      url = page.next;
    }
  }

  const entries = [...byName.values()].map((v) => v.entry);
  logger.info(
    `[pathfinder1e-importer] section "${section}": imported ${entries.length} entries across ${pagesFetched} page(s)` +
      (dedupedCount > 0 ? ` (de-duped ${dedupedCount} same-name row(s) from other sources)` : ''),
  );
  if (skippedCount > 0) {
    logger.warn(`[pathfinder1e-importer] section "${section}": imported ${entries.length} entries, skipped ${skippedCount} row(s)`);
  }

  return { entries, skippedCount, dedupedCount };
}

export function entryTypeForSection(section: Pf1eSection): RuleEntryType {
  return SECTION_TO_ENTRY_TYPE[section];
}

export interface Pf1eImportResult {
  slug: string;
  name: string;
  license: string;
  entries: ImportedEntry[];
  totalSkipped: number;
  totalDeduped: number;
}

/**
 * Fetch every requested PF1e section and aggregate them into a persist-ready result — the
 * exact `{ slug, name, license, entries }` shape the rules service's shared `persistPack`
 * path (and the generic install-job path, issue #20) consumes, identically to how
 * `installFromOpen5e` assembles its pack. Deliberately does NOT touch the DB or Nest so it
 * stays a pure, unit-testable importer; wiring it to a background job is a thin call site.
 * The pack-level license aggregates the distinct per-entry licenses (each carrying its own
 * OGL/source attribution, issue #143), defaulting to OGL v1.0a when a source omits one.
 */
export async function importPathfinder1e(
  baseUrl: string = PF1E_DEFAULT_BASE_URL,
  sections: Pf1eSection[] = ALL_PF1E_SECTIONS,
  logger: Pf1eImportLogger = consoleLogger,
): Promise<Pf1eImportResult> {
  const results = await Promise.all(sections.map((s) => fetchPathfinder1eSection(baseUrl, s, logger)));
  const entries = results.flatMap((r) => r.entries);
  const totalSkipped = results.reduce((sum, r) => sum + r.skippedCount, 0);
  const totalDeduped = results.reduce((sum, r) => sum + r.dedupedCount, 0);

  const licenses = new Set(entries.map((e) => e.license).filter(Boolean));
  const license = licenses.size > 0 ? [...licenses].join(', ') : PF1E_DEFAULT_LICENSE;

  return { slug: PF1E_PACK_SLUG, name: PF1E_PACK_NAME, license, entries, totalSkipped, totalDeduped };
}
