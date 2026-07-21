import { BadRequestException } from '@nestjs/common';
import type { RuleEntryType } from '@campfire/schema';

/**
 * Importer for open-licensed Starfinder 1e content (issue #297), mirroring the Open5e
 * importer's structure (paginated fetch → per-section mappers → (pack,slug) de-dupe →
 * OGL license/attribution stamping). Starfinder's own open content lives under the OGL:
 * the community-maintained **Starjammer SRD** (https://www.starjammersrd.com) and the
 * **Archives of Nethys — Starfinder** (https://www.aonsrd.com) publish the Starfinder
 * Core Rulebook rules text as open content. Per the #275 sourcing rule we import from the
 * game's OWN open SRD, never from Foundry packages.
 *
 * Neither SRD ships a first-party JSON API the way Open5e v2 does, so this importer targets
 * a JSON mirror of the SRD shaped like Open5e's DRF pagination ({count,next,previous,
 * results:[...]}) — the same shape a scrape-to-JSON job (issue #20 install-job path) or a
 * community JSON dump exposes. `STARFINDER_DEFAULT_BASE_URL` points at that mirror; the
 * install job supplies the concrete base URL. The mapping is proved against a small REAL
 * Starfinder sample (real EAC/KAC/SP/HP values — see test/fake-starfinder.ts), and a full
 * bulk ingest runs through the same `fetch*Section` path a section at a time.
 *
 * Starfinder-specific shape notes (folded into `dataJson` to avoid schema churn, per #297):
 *   - Creatures carry TWO armor classes — `eac` (Energy) and `kac` (Kinetic) — plus a
 *     Stamina/HP split (`stamina` + `hit_points`). All four ride in the monster dataJson;
 *     the StarfinderAdapter maps KAC→armorClass and SP+HP→effective max HP at combat time.
 *   - Starships and vehicles are folded into ruleEntry.type 'item' with a `category` of
 *     'starship'/'vehicle' in dataJson (no new entry types — #297 prefers this).
 *   - Spells use spell LEVELS by class list; equipment carries item level + credits cost.
 */

export const STARFINDER_DEFAULT_BASE_URL = 'https://api.starjammersrd.com/v1';
export const MAX_ENTRIES_PER_SECTION = 2000;
const PAGE_LIMIT = 500;
const MAX_PAGES_PER_SECTION = 50;
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_RETRY_BACKOFFS_MS = [1_000, 3_000];

export type StarfinderSection =
  | 'spells'
  | 'monsters'
  | 'equipment'
  | 'conditions'
  | 'classes'
  | 'races'
  | 'feats'
  | 'starships'
  | 'vehicles';

const SECTION_TO_PATH: Record<StarfinderSection, string> = {
  spells: 'spells',
  monsters: 'aliens', // Starfinder's bestiary is the "Alien Archive" — served from /aliens/.
  equipment: 'equipment',
  conditions: 'conditions',
  classes: 'classes',
  races: 'races',
  feats: 'feats',
  starships: 'starships',
  vehicles: 'vehicles',
};

// Starships and vehicles fold into 'item' (no new entry types — issue #297); the dataJson
// `category` disambiguates them for any sci-fi-aware surface.
const SECTION_TO_ENTRY_TYPE: Record<StarfinderSection, RuleEntryType> = {
  spells: 'spell',
  monsters: 'monster',
  equipment: 'item',
  conditions: 'condition',
  classes: 'class',
  races: 'race',
  feats: 'feat',
  starships: 'item',
  vehicles: 'item',
};

export interface ImportedEntry {
  slug: string;
  name: string;
  type: RuleEntryType;
  summary: string;
  body: string;
  dataJson: string | null;
  license: string;
  /** Human-readable source/document label (e.g. "Starfinder Core Rulebook" via Starjammer SRD). */
  source: string;
}

export interface StarfinderImportLogger {
  warn(message: string): void;
  info(message: string): void;
}

const consoleLogger: StarfinderImportLogger = {
  // eslint-disable-next-line no-console
  warn: (message: string) => console.warn(message),
  // eslint-disable-next-line no-console
  info: (message: string) => console.info(message),
};

export interface StarfinderSectionResult {
  entries: ImportedEntry[];
  /** Rows present in a fetched page but skipped (malformed row, or a cross-origin `next` link refused). */
  skippedCount: number;
  /** Same-name rows collapsed to one canonical entry per (name,type) across documents. */
  dedupedCount: number;
}

interface StarfinderPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: Array<Record<string, unknown>>;
}

function asString(v: unknown): string {
  if (typeof v !== 'string') return '';
  // Some SRD dumps carry LITERAL escape sequences (backslash-n/t) instead of real
  // whitespace, which breaks markdown tables/paragraphs in the reader. Normalise.
  return v.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
}

function nestedName(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in v) return asString((v as Record<string, unknown>).name);
  return '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A number if the value is numeric or a numeric string, else null (for clean dataJson). */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function licenseOf(row: Record<string, unknown>): string {
  const doc = row.document as Record<string, unknown> | undefined;
  const licenses = doc?.licenses as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(licenses) && licenses.length > 0) {
    return licenses.map((l) => asString(l.name)).filter(Boolean).join(', ');
  }
  // Starfinder open content is OGL 1.0a across the board; fall back to it when a row's
  // document sub-object omits an explicit license list (the pack-level default still applies).
  return asString(row.license) || 'Open Game License v1.0a';
}

/**
 * The document slug an entry came from, for de-duping same-named rows across sources.
 * `row.document` is usually a {key,name,licenses} sub-object; some dumps carry it as a bare
 * slug string. Falls back to the slug prefix before the first '_' (keys are shaped
 * `<document>_<name>`, e.g. "crb_laser-pistol").
 */
function documentKeyOf(row: Record<string, unknown>): string {
  const doc = row.document;
  if (doc && typeof doc === 'object') {
    const key = asString((doc as Record<string, unknown>).key);
    if (key) return key.toLowerCase();
  } else if (typeof doc === 'string' && doc) {
    return doc.toLowerCase();
  }
  const key = asString(row.key);
  const underscore = key.indexOf('_');
  return underscore > 0 ? key.slice(0, underscore).toLowerCase() : '';
}

function sourceOf(row: Record<string, unknown>): string {
  const doc = row.document;
  if (doc && typeof doc === 'object') {
    const name = asString((doc as Record<string, unknown>).name);
    if (name) return name;
    const key = asString((doc as Record<string, unknown>).key);
    if (key) return key;
  } else if (typeof doc === 'string' && doc) {
    return doc;
  }
  return asString(row.source);
}

/**
 * Canonicality rank for de-duplicating same-name entries across documents. The Starfinder
 * Core Rulebook (`crb`) is the baseline everyone shares, so it wins; other first-party
 * books rank next, third-party/community content last. Lower wins; ties keep first-seen.
 */
function documentRank(row: Record<string, unknown>): number {
  const key = documentKeyOf(row);
  if (key === 'crb' || key === 'sf-crb') return 0;
  if (key.startsWith('sf') || key.startsWith('crb')) return 1;
  return 2;
}

function mapSpell(row: Record<string, unknown>): ImportedEntry {
  const school = nestedName(row.school) || asString(row.school);
  const level = num(row.level);
  const desc = asString(row.desc ?? row.description);
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'spell',
    summary: truncate([school, level !== null ? `level ${level}` : null].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({
      school: school || null,
      level,
      // Starfinder spells list which classes can cast them at what level.
      classes: row.classes ?? row.spell_lists ?? null,
      castingTime: row.casting_time ?? null,
      range: row.range ?? row.range_text ?? null,
      duration: row.duration ?? null,
      area: row.area ?? null,
    }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

function mapAlien(row: Record<string, unknown>): ImportedEntry {
  const type = nestedName(row.type) || asString(row.type) || asString(row.creature_type);
  const size = nestedName(row.size) || asString(row.size);
  const cr = row.cr ?? row.challenge_rating;
  const eac = num(row.eac ?? row.energy_armor_class);
  const kac = num(row.kac ?? row.kinetic_armor_class);
  const stamina = num(row.stamina ?? row.stamina_points ?? row.sp);
  const hitPoints = num(row.hit_points ?? row.hp);
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'monster',
    summary: truncate(
      [size, type, cr !== undefined && cr !== null ? `CR ${cr}` : null].filter(Boolean).join(' · '),
      300,
    ),
    body: '', // statblock lives in dataJson (mirrors Open5e creatures)
    dataJson: JSON.stringify({
      type: type || null,
      size: size || null,
      challengeRating: cr ?? null,
      // The two Armor Classes + the Stamina/HP split — the Starfinder wrinkles (#297). The
      // StarfinderAdapter reads these to map KAC→armorClass and SP+HP→effective max HP.
      eac,
      kac,
      stamina,
      hitPoints,
      speed: row.speed ?? null,
      abilityScores: row.ability_scores ?? row.abilities ?? null,
      specialAbilities: row.special_abilities ?? null,
      actions: row.attacks ?? row.actions ?? null,
    }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

function mapEquipment(row: Record<string, unknown>): ImportedEntry {
  const category = nestedName(row.category) || asString(row.category) || asString(row.type);
  const level = num(row.level ?? row.item_level);
  const cost = num(row.cost ?? row.price);
  const desc = asString(row.desc ?? row.description);
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'item',
    summary: truncate(
      [category, level !== null ? `item level ${level}` : null, cost !== null ? `${cost} credits` : null]
        .filter(Boolean)
        .join(' · ') || desc,
      300,
    ),
    body: desc,
    dataJson: JSON.stringify({
      category: category || null,
      level,
      cost,
      bulk: row.bulk ?? null,
      // Weapon-specific fields when present (Starfinder weapons: damage + damage type + range).
      damage: row.damage ?? null,
      damageType: row.damage_type ?? null,
      range: row.range ?? null,
    }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

function mapCondition(row: Record<string, unknown>): ImportedEntry {
  const descriptions = row.descriptions as Array<Record<string, unknown>> | undefined;
  const desc = Array.isArray(descriptions)
    ? descriptions.map((d) => asString(d.desc)).filter(Boolean).join('\n\n')
    : asString(row.desc ?? row.description);
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'condition',
    summary: truncate(desc, 300),
    body: desc,
    dataJson: null,
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

/** Renders an array of {name, desc} sub-sections (class features, race traits) as markdown headings. */
function namedSectionsToMarkdown(v: unknown): string {
  if (!Array.isArray(v)) return '';
  return (v as Array<Record<string, unknown>>)
    .map((s) => {
      const name = asString(s?.name);
      const desc = asString(s?.desc ?? s?.description);
      if (!name && !desc) return '';
      return name ? `### ${name}\n\n${desc}` : desc;
    })
    .filter(Boolean)
    .join('\n\n');
}

function mapClass(row: Record<string, unknown>): ImportedEntry {
  // Starfinder classes have Stamina Points per level (SP) + Hit Points per level (HP) +
  // Key Ability Score — all sci-fi-flavoured d20 class chassis fields.
  const staminaPerLevel = num(row.stamina ?? row.stamina_points ?? row.sp);
  const hpPerLevel = num(row.hit_points ?? row.hp);
  const keyAbility = asString(row.key_ability ?? row.key_ability_score);
  const desc = asString(row.desc ?? row.description);
  const body = [desc, namedSectionsToMarkdown(row.features)].filter(Boolean).join('\n\n');
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'class',
    summary: truncate(
      [
        keyAbility ? `key ability ${keyAbility}` : null,
        staminaPerLevel !== null ? `SP ${staminaPerLevel}/lvl` : null,
        hpPerLevel !== null ? `HP ${hpPerLevel}/lvl` : null,
      ]
        .filter(Boolean)
        .join(' · ') || desc,
      300,
    ),
    body,
    dataJson: JSON.stringify({ staminaPerLevel, hpPerLevel, keyAbility: keyAbility || null }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

function mapRace(row: Record<string, unknown>): ImportedEntry {
  const desc = asString(row.desc ?? row.description);
  const traits = Array.isArray(row.traits) ? (row.traits as Array<Record<string, unknown>>) : [];
  const traitNames = traits.map((t) => asString(t?.name)).filter(Boolean);
  const hp = num(row.hit_points ?? row.hp);
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'race',
    summary: truncate(desc || traitNames.join(' · '), 300),
    body: [desc, namedSectionsToMarkdown(row.traits)].filter(Boolean).join('\n\n'),
    // Starfinder races grant a flat racial HP bonus (e.g. Human 4, Android 4, Vesk 8).
    dataJson: JSON.stringify({ hitPoints: hp, traits: traitNames }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

function mapFeat(row: Record<string, unknown>): ImportedEntry {
  const desc = asString(row.desc ?? row.description);
  const prerequisite = asString(row.prerequisite ?? row.prerequisites);
  const benefits = Array.isArray(row.benefits)
    ? (row.benefits as Array<Record<string, unknown>>).map((b) => asString(b?.desc ?? b)).filter(Boolean)
    : [];
  const body = [desc, benefits.map((b) => `- ${b}`).join('\n')].filter(Boolean).join('\n\n');
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'feat',
    summary: truncate(prerequisite ? `Prerequisite: ${prerequisite}` : desc, 300),
    body,
    dataJson: JSON.stringify({ prerequisite: prerequisite || null, combatFeat: row.combat_feat ?? null }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

/** Starships and vehicles: folded into ruleEntry.type 'item' with a `category` tag (#297). */
function mapStarship(row: Record<string, unknown>): ImportedEntry {
  const frame = asString(row.frame) || nestedName(row.frame);
  const tier = row.tier ?? null;
  const desc = asString(row.desc ?? row.description);
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'item',
    summary: truncate([frame, tier !== null ? `tier ${tier}` : null].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({
      category: 'starship',
      frame: frame || null,
      tier,
      speed: row.speed ?? null,
      // Starship AC/TL are distinct from creature EAC/KAC — kept under their own keys.
      ac: num(row.ac),
      targetLock: num(row.tl ?? row.target_lock),
      shields: row.shields ?? null,
      weapons: row.weapons ?? null,
    }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

function mapVehicle(row: Record<string, unknown>): ImportedEntry {
  const level = num(row.level);
  const desc = asString(row.desc ?? row.description);
  const eac = num(row.eac ?? row.energy_armor_class);
  const kac = num(row.kac ?? row.kinetic_armor_class);
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'item',
    summary: truncate([level !== null ? `level ${level}` : null].filter(Boolean).join(' · ') || desc, 300),
    body: desc,
    dataJson: JSON.stringify({
      category: 'vehicle',
      level,
      // Vehicles use the same EAC/KAC pair as creatures, plus Stamina/HP.
      eac,
      kac,
      stamina: num(row.stamina ?? row.sp),
      hitPoints: num(row.hit_points ?? row.hp),
      speed: row.speed ?? null,
      passengers: row.passengers ?? null,
    }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

const SECTION_MAPPER: Record<StarfinderSection, (row: Record<string, unknown>) => ImportedEntry> = {
  spells: mapSpell,
  monsters: mapAlien,
  equipment: mapEquipment,
  conditions: mapCondition,
  classes: mapClass,
  races: mapRace,
  feats: mapFeat,
  starships: mapStarship,
  vehicles: mapVehicle,
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
 * Fetches one page with retry on transient failures (request timeout / HTTP 5xx). A 4xx or
 * network error that isn't a timeout is NOT retried — those indicate a real request problem.
 */
async function fetchPageWithRetry(
  url: string,
  section: StarfinderSection,
  logger: StarfinderImportLogger,
): Promise<Response> {
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
        `[starfinder-importer] section "${section}": fetch of ${url} failed (${reason}), retrying in ${backoff}ms (attempt ${attempt + 1}/${PAGE_RETRY_BACKOFFS_MS.length})`,
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
 * Fetches and maps one section's entries, paginating until the API runs out of pages or
 * MAX_ENTRIES_PER_SECTION is hit. Same hardening as the Open5e importer: same-origin
 * pagination guard, per-row skip accounting, transient-failure retry, page cap, and a
 * per-section count log. Same-name rows are collapsed to one canonical entry per (name,type)
 * across documents, keeping the most-canonical source (see documentRank).
 */
export async function fetchStarfinderSection(
  baseUrl: string,
  section: StarfinderSection,
  logger: StarfinderImportLogger = consoleLogger,
): Promise<StarfinderSectionResult> {
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
        `[starfinder-importer] section "${section}": hit page cap (${MAX_PAGES_PER_SECTION} pages) after ${byName.size} entries — stopping pagination`,
      );
      break;
    }
    pagesFetched += 1;
    let res: Response;
    try {
      res = await fetchPageWithRetry(url, section, logger);
    } catch (err) {
      throw new BadRequestException(
        `Failed to fetch Starfinder section "${section}" from ${url}: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new BadRequestException(`Starfinder section "${section}" returned HTTP ${res.status} for ${url}`);
    }
    let page: StarfinderPage;
    try {
      page = (await res.json()) as StarfinderPage;
    } catch (err) {
      throw new BadRequestException(`Starfinder section "${section}" returned invalid JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(page.results)) {
      throw new BadRequestException(`Starfinder section "${section}" response missing "results" array (unexpected shape)`);
    }
    for (const row of page.results) {
      let entry: ImportedEntry;
      let rank: number;
      try {
        entry = mapper(row);
        rank = documentRank(row);
      } catch {
        skippedCount += 1;
        continue;
      }
      const key = entry.name.trim().toLowerCase();
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
        `[starfinder-importer] section "${section}": refusing to follow cross-origin pagination link (base=${baseUrl}, next=${page.next}) — stopping pagination`,
      );
      url = null;
    } else {
      url = page.next;
    }
  }

  const entries = [...byName.values()].map((v) => v.entry);

  logger.info(
    `[starfinder-importer] section "${section}": imported ${entries.length} entries across ${pagesFetched} page(s)` +
      (dedupedCount > 0 ? ` (de-duped ${dedupedCount} same-name row(s) from other documents)` : ''),
  );
  if (skippedCount > 0) {
    logger.warn(`[starfinder-importer] section "${section}": imported ${entries.length} entries, skipped ${skippedCount} row(s)`);
  }

  return { entries, skippedCount, dedupedCount };
}

export function entryTypeForSection(section: StarfinderSection): RuleEntryType {
  return SECTION_TO_ENTRY_TYPE[section];
}

export const ALL_STARFINDER_SECTIONS: StarfinderSection[] = [
  'spells',
  'monsters',
  'equipment',
  'conditions',
  'classes',
  'races',
  'feats',
  'starships',
  'vehicles',
];
