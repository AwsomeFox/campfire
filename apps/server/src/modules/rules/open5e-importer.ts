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
 *   - Likewise there is no `/v2/races/` route — that list lives at
 *     `/v2/species/` (verified live 2026-07-19; `/v2/races/` returns the
 *     Open5e SPA's HTML, not JSON). Exposed as ruleEntry.type 'race'.
 *   - Classes (`/v2/classes/`) usually have an EMPTY `desc`; the real prose
 *     lives in `features[]` ({name, desc, gained_at}), which we render into
 *     the markdown body. Subclasses appear in the same list with a non-null
 *     `subclass_of` sub-object. Species text similarly lives in `traits[]`
 *     ({name, desc}) alongside a short top-level `desc`. Feats carry `desc`
 *     plus a `benefits[]` array of {desc} bullets and a flat `prerequisite`
 *     string.
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
// Live sections are large: creatures ~3.5k, magicitems ~2.3k, spells ~2k entries
// (verified against api.open5e.com 2026-07). Open5e's DRF pagination honours large
// `limit` values and returns them in a SINGLE response (verified: `?limit=500` and
// `?limit=1000` both return that many rows in one page), so pulling a section in
// ~500-row pages needs only a handful of round-trips instead of 20-36. The old
// PAGE_LIMIT of 100 forced 20+ serial fetches per large section; with seven sections
// imported concurrently a full install ran for minutes and reliably exceeded client/
// gateway timeouts, so only tiny single-page sections (conditions) ever landed — the
// root cause of issue #53 (shipped pack had only the 21 conditions, no monsters/
// spells/items). 500 keeps each capped section to <=4 pages while staying well under
// any server-side page-size ceiling.
const PAGE_LIMIT = 500;
// Hard upper bound on how many pages we'll follow for one section, independent of the
// entry cap. At PAGE_LIMIT=500 a capped section needs <=4 pages; even an upstream that
// silently ignored `limit` and served 100/page would need ~20. 50 leaves generous head-
// room for legitimate growth while guaranteeing the loop terminates if a misbehaving
// upstream ever returns a `next` cycle or perpetually tiny pages.
const MAX_PAGES_PER_SECTION = 50;
// Real Open5e pages have been observed taking 6-11s to respond (large spell/creature
// pages especially) — 10s was too tight and produced spurious timeouts. 30s gives
// enough headroom while still bounding a truly hung request.
const FETCH_TIMEOUT_MS = 30_000;
// Retries are for transient failures only (timeout or 5xx) — a 4xx or malformed-JSON
// response is a real problem with the request/upstream shape and retrying won't help.
const PAGE_RETRY_BACKOFFS_MS = [1_000, 3_000];

export type Open5eSection = 'spells' | 'monsters' | 'items' | 'conditions' | 'classes' | 'races' | 'feats';

const SECTION_TO_PATH: Record<Open5eSection, string> = {
  spells: 'spells',
  monsters: 'creatures', // v2 has no /monsters/ route — see file header note.
  items: 'magicitems',
  conditions: 'conditions',
  classes: 'classes',
  races: 'species', // v2 has no /races/ route either — see file header note.
  feats: 'feats',
};

const SECTION_TO_ENTRY_TYPE: Record<Open5eSection, RuleEntryType> = {
  spells: 'spell',
  monsters: 'monster',
  items: 'item',
  conditions: 'condition',
  classes: 'class',
  races: 'race',
  feats: 'feat',
};

export interface ImportedEntry {
  slug: string;
  name: string;
  type: RuleEntryType;
  summary: string;
  body: string;
  dataJson: string | null;
  license: string;
  /** Human-readable source/document label (Open5e `document.name`), e.g. "System Reference Document 5.1". */
  source: string;
  /**
   * Per-entry provenance (issue #734). Optional because most importers only know the
   * license + document label; the service layer fills these from pack metadata when the
   * importer leaves them unset ('' → inherit the pack's value). OSR populates
   * `attribution` from its OsrSource.attribution credit line.
   */
  attribution?: string;
  /** Creator/rights-holder to credit, when separable from `attribution`. */
  author?: string;
  /** Deep link back to the entry on its origin site. */
  sourceUrl?: string;
  /** Optional bundled game-icons.net slug to seed the entry's icon override (issue #305). Open5e imports leave this unset — the web app derives a default from type/dataJson. */
  iconSlug?: string;
}

/** Minimal structured logger so a summary can be asserted on in tests without console spying. */
export interface Open5eImportLogger {
  warn(message: string): void;
  /** Informational, non-problem events (e.g. the per-section import-count summary). */
  info(message: string): void;
}

const consoleLogger: Open5eImportLogger = {
  // eslint-disable-next-line no-console
  warn: (message: string) => console.warn(message),
  // eslint-disable-next-line no-console
  info: (message: string) => console.info(message),
};

export interface Open5eSectionResult {
  entries: ImportedEntry[];
  /** Rows present in a fetched page but skipped (malformed row, or a cross-origin `next` link refused). */
  skippedCount: number;
  /** Same-name rows collapsed to one canonical entry per (name,type) across documents (issue #143). */
  dedupedCount: number;
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

/**
 * The Open5e document slug an entry came from. `row.document` is usually a sub-object
 * ({key, name, licenses}), but some rows carry `document` as a bare slug string, so we
 * handle both. Falls back to the slug prefix before the first '_' (Open5e keys are shaped
 * `<document-slug>_<name-slug>`, e.g. "srd_fireball" / "a5e-ag_fireball"), which is how the
 * same-named triplicates are told apart (issue #143).
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

/** Human-readable source/document label for an entry — `document.name`, else the slug. */
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
  return '';
}

/**
 * Canonicality rank for de-duplicating same-name entries across Open5e documents
 * (issue #143): a fresh install returns e.g. `srd_fireball`, `srd-2024_fireball`, and
 * `a5e-ag_fireball` — three identical-looking "Fireball" rows. We keep exactly one,
 * preferring the most-canonical source:
 *   0 — SRD 5.1 (`srd`), the OGL 5e baseline everyone shares
 *   1 — any other official SRD document (`srd-2024` = SRD 5.2 / CC-BY, etc.)
 *   2 — everything else (Advanced 5e `a5e-*`, third-party books)
 * Lower wins; ties keep the first-seen row (stable).
 */
function documentRank(row: Record<string, unknown>): number {
  const key = documentKeyOf(row);
  if (key === 'srd') return 0;
  if (key.startsWith('srd')) return 1;
  return 2;
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
    source: sourceOf(row),
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function nameOrString(v: unknown): string {
  return nestedName(v) || asString(v);
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function diceExpression(count: unknown, die: unknown, bonus: unknown): string | null {
  const n = numberOrNull(count);
  const rawDie = asString(die).toLowerCase();
  if (n === null || !/^d\d+$/.test(rawDie)) return null;
  const base = `${n}${rawDie}`;
  const b = numberOrNull(bonus);
  if (b === null || b === 0) return base;
  return `${base} ${b > 0 ? '+' : '-'} ${Math.abs(b)}`;
}

function directDamageExpression(action: Record<string, unknown>): string | null {
  const dice = asString(action.damage_dice);
  if (!dice) return null;
  const bonus = numberOrNull(action.damage_bonus);
  if (bonus === null || bonus === 0 || /[+-]\s*\d+/.test(dice)) return dice;
  return `${dice} ${bonus > 0 ? '+' : '-'} ${Math.abs(bonus)}`;
}

interface NormalizedDamage {
  expression: string;
  type: string | null;
}

function normalizedAttack(raw: unknown): Record<string, unknown> | null {
  const attack = asRecord(raw);
  if (!attack) return null;

  const damage: NormalizedDamage[] = [];
  const primary = diceExpression(attack.damage_die_count, attack.damage_die_type, attack.damage_bonus);
  if (primary) damage.push({ expression: primary, type: nameOrString(attack.damage_type) || null });
  const extra = diceExpression(attack.extra_damage_die_count, attack.extra_damage_die_type, attack.extra_damage_bonus);
  if (extra) damage.push({ expression: extra, type: nameOrString(attack.extra_damage_type) || null });

  return {
    ...attack,
    attackBonus: numberOrNull(attack.to_hit_mod ?? attack.attack_bonus),
    damage,
  };
}

function savingThrowFrom(action: Record<string, unknown>, desc: string): { dc: number; ability: string | null } | null {
  const directDc = numberOrNull(action.save_dc ?? action.dc);
  const directAbility = nameOrString(action.save_ability ?? action.saving_throw_ability);
  if (directDc !== null) return { dc: directDc, ability: directAbility || null };

  // Open5e v2 currently leaves saves embedded in `desc`, rather than exposing a
  // structured save field. Capture the first DC/ability pair for at-a-glance UI while
  // retaining the complete description below as the rules-text source of truth.
  const match = desc.match(/\bDC\s+(\d+)\s+(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma|STR|DEX|CON|INT|WIS|CHA)\b/i);
  if (!match) return null;
  return { dc: Number(match[1]), ability: match[2] };
}

function usageFrom(action: Record<string, unknown>): Record<string, unknown> | null {
  const raw = asRecord(action.usage_limits ?? action.usage);
  const type = asString(raw?.type).toUpperCase();
  const param = numberOrNull(raw?.param ?? raw?.uses);
  if (type === 'RECHARGE_ON_ROLL' && param !== null) {
    return { ...raw, type: 'recharge', min: param, max: 6, label: `Recharge ${param}\u20136` };
  }
  if (type === 'PER_DAY' && param !== null) {
    return { ...raw, type: 'perDay', uses: param, label: `${param}/Day` };
  }
  if (raw) {
    const label = asString(raw.label);
    return { ...raw, ...(label ? { label } : {}) };
  }

  const recharge = `${asString(action.name)} ${asString(action.desc)}`.match(/\bRecharge\s+(\d+)(?:\s*[-\u2013]\s*(\d+))?/i);
  if (!recharge) return null;
  const min = Number(recharge[1]);
  const max = recharge[2] ? Number(recharge[2]) : 6;
  return { type: 'recharge', min, max, label: `Recharge ${min}\u2013${max}` };
}

/**
 * Keep every Open5e action object's source fields, then add a small canonical layer for
 * shared Campfire consumers. In particular, `desc` is copied verbatim (apart from the
 * importer's existing literal-newline cleanup), so imperfect upstream structured fields
 * can never erase or rewrite rules text.
 */
function normalizeCreatureAction(raw: unknown): Record<string, unknown> | null {
  const action = asRecord(raw);
  if (!action) return null;
  const name = asString(action.name);
  const desc = asString(action.desc ?? action.description);
  const attacks = Array.isArray(action.attacks) ? action.attacks.map(normalizedAttack).filter((v): v is Record<string, unknown> => v !== null) : [];
  const attackBonus = numberOrNull(action.attack_bonus) ?? attacks.map((a) => numberOrNull(a.attackBonus)).find((v) => v !== null) ?? null;
  const directDamage = directDamageExpression(action);
  const damage = directDamage
    ? [{ expression: directDamage, type: nameOrString(action.damage_type) || null }]
    : attacks.flatMap((attack) => (Array.isArray(attack.damage) ? (attack.damage as NormalizedDamage[]) : []));

  return {
    ...action,
    name,
    desc,
    actionType: asString(action.action_type) || null,
    attackBonus,
    damage,
    savingThrow: savingThrowFrom(action, desc),
    usage: usageFrom(action),
    legendaryActionCost: numberOrNull(action.legendary_action_cost),
    attacks,
  };
}

function normalizedCreatureActions(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v
    .map(normalizeCreatureAction)
    .filter((action): action is Record<string, unknown> => action !== null && Boolean(action.name || action.desc))
    .sort((a, b) => (numberOrNull(a.order_in_statblock) ?? Number.MAX_SAFE_INTEGER) - (numberOrNull(b.order_in_statblock) ?? Number.MAX_SAFE_INTEGER));
}

function mapCreature(row: Record<string, unknown>): ImportedEntry {
  const type = nestedName(row.type);
  const size = nestedName(row.size);
  const cr = row.challenge_rating;
  // Open5e v2 puts every active ability in one `actions[]` array and distinguishes
  // regular/reaction/legendary entries with `action_type`; passive abilities live in
  // `traits[]`. Older Open5e-compatible mirrors expose the four arrays separately.
  // Support both shapes at the adapter boundary and store one stable camelCase shape.
  const combinedActions = normalizedCreatureActions(row.actions);
  const regularActions = combinedActions.filter((action) => !['LEGENDARY_ACTION', 'REACTION'].includes(asString(action.actionType).toUpperCase()));
  const legendaryActions = [
    ...combinedActions.filter((action) => asString(action.actionType).toUpperCase() === 'LEGENDARY_ACTION'),
    ...normalizedCreatureActions(row.legendary_actions),
  ];
  const reactions = [
    ...combinedActions.filter((action) => asString(action.actionType).toUpperCase() === 'REACTION'),
    ...normalizedCreatureActions(row.reactions),
  ];
  const specialAbilities = [
    ...normalizedCreatureActions(row.special_abilities),
    ...normalizedCreatureActions(row.traits),
  ];
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
      specialAbilities,
      actions: regularActions,
      legendaryActions,
      reactions,
    }),
    license: licenseOf(row),
    source: sourceOf(row),
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
    source: sourceOf(row),
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
    source: sourceOf(row),
  };
}

/** Renders an array of {name, desc} sub-sections (class features, species traits) as markdown headings. */
function namedSectionsToMarkdown(v: unknown): string {
  if (!Array.isArray(v)) return '';
  return (v as Array<Record<string, unknown>>)
    .map((s) => {
      const name = asString(s?.name);
      const desc = asString(s?.desc);
      if (!name && !desc) return '';
      return name ? `### ${name}\n\n${desc}` : desc;
    })
    .filter(Boolean)
    .join('\n\n');
}

function mapClass(row: Record<string, unknown>): ImportedEntry {
  const hitDice = asString(row.hit_dice);
  const casterType = asString(row.caster_type);
  const subclassOf = nestedName(row.subclass_of);
  const savingThrows = Array.isArray(row.saving_throws)
    ? (row.saving_throws as Array<Record<string, unknown>>).map((s) => nestedName(s)).filter(Boolean)
    : [];
  const desc = asString(row.desc);
  // v2 classes usually have an empty `desc` — the real prose is the features list.
  const body = [desc, namedSectionsToMarkdown(row.features)].filter(Boolean).join('\n\n');
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'class',
    summary: truncate(
      [subclassOf ? `${subclassOf} subclass` : null, hitDice ? `hit dice ${hitDice}` : null, savingThrows.length ? `saves ${savingThrows.join('/')}` : null]
        .filter(Boolean)
        .join(' · ') || desc,
      300,
    ),
    body,
    dataJson: JSON.stringify({ hitDice: hitDice || null, casterType: casterType || null, subclassOf: subclassOf || null, savingThrows }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

function mapSpecies(row: Record<string, unknown>): ImportedEntry {
  const desc = asString(row.desc);
  const traits = Array.isArray(row.traits) ? (row.traits as Array<Record<string, unknown>>) : [];
  const traitNames = traits.map((t) => asString(t?.name)).filter(Boolean);
  const isSubspecies = row.is_subspecies === true;
  // `subspecies_of` is a flat key string (e.g. "srd_halfling"), not a nested object.
  const subspeciesOf = asString(row.subspecies_of);
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'race',
    summary: truncate(desc || traitNames.join(' · '), 300),
    body: [desc, namedSectionsToMarkdown(row.traits)].filter(Boolean).join('\n\n'),
    dataJson: JSON.stringify({ isSubspecies, subspeciesOf: subspeciesOf || null, traits: traitNames }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

function mapFeat(row: Record<string, unknown>): ImportedEntry {
  const desc = asString(row.desc);
  const prerequisite = asString(row.prerequisite);
  const benefits = Array.isArray(row.benefits)
    ? (row.benefits as Array<Record<string, unknown>>).map((b) => asString(b?.desc)).filter(Boolean)
    : [];
  const body = [desc, benefits.map((b) => `- ${b}`).join('\n')].filter(Boolean).join('\n\n');
  return {
    slug: asString(row.key) || asString(row.name),
    name: asString(row.name),
    type: 'feat',
    summary: truncate(prerequisite ? `Prerequisite: ${prerequisite}` : desc, 300),
    body,
    dataJson: JSON.stringify({ prerequisite: prerequisite || null, hasPrerequisite: row.has_prerequisite ?? null }),
    license: licenseOf(row),
    source: sourceOf(row),
  };
}

const SECTION_MAPPER: Record<Open5eSection, (row: Record<string, unknown>) => ImportedEntry> = {
  spells: mapSpell,
  monsters: mapCreature,
  items: mapMagicItem,
  conditions: mapCondition,
  classes: mapClass,
  races: mapSpecies,
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
 *  - **Page cap**: at most MAX_PAGES_PER_SECTION pages are followed regardless of the
 *    entry cap, so a `next`-link cycle or perpetually tiny pages can't loop unbounded.
 *  - **Per-section count log**: the number of entries (and pages) imported is logged for
 *    every section via `logger.info`, so an empty/short section is visible in the logs
 *    rather than silently absent (issue #53).
 */
export async function fetchOpen5eSection(
  baseUrl: string,
  section: Open5eSection,
  logger: Open5eImportLogger = consoleLogger,
): Promise<Open5eSectionResult> {
  const path = SECTION_TO_PATH[section];
  const mapper = SECTION_MAPPER[section];
  // De-dupe same-name rows across Open5e documents (issue #143): a section is a single
  // entry type, so keying by lowercased name is keying by (name,type). We keep the
  // most-canonical source per name (see documentRank) — first the SRD 5.1 baseline, then
  // other SRD documents, then third-party books — so one clean "Fireball"/"Goblin" lands
  // instead of a triplicate. Insertion order is preserved for stable search ranking.
  const byName = new Map<string, { entry: ImportedEntry; rank: number }>();
  let skippedCount = 0;
  let dedupedCount = 0;
  let pagesFetched = 0;
  let url: string | null = `${baseUrl.replace(/\/$/, '')}/${path}/?limit=${PAGE_LIMIT}`;

  while (url && byName.size < MAX_ENTRIES_PER_SECTION) {
    if (pagesFetched >= MAX_PAGES_PER_SECTION) {
      logger.warn(
        `[open5e-importer] section "${section}": hit page cap (${MAX_PAGES_PER_SECTION} pages) after ${byName.size} entries — stopping pagination`,
      );
      break;
    }
    pagesFetched += 1;
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
      let entry: ImportedEntry;
      let rank: number;
      try {
        entry = mapper(row);
        rank = documentRank(row);
      } catch {
        // Skip a single malformed row rather than failing the whole import.
        skippedCount += 1;
        continue;
      }
      const key = entry.name.trim().toLowerCase();
      const existing = byName.get(key);
      if (existing) {
        // A same-name row from another document — collapse it, keeping the better source.
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
        `[open5e-importer] section "${section}": refusing to follow cross-origin pagination link (base=${baseUrl}, next=${page.next}) — stopping pagination`,
      );
      url = null;
    } else {
      url = page.next;
    }
  }

  const entries = [...byName.values()].map((v) => v.entry);

  // Always report a per-section import count (issue #53: silent empty sections were the
  // symptom — an explicit count per section makes an empty/short section visible in logs).
  logger.info(
    `[open5e-importer] section "${section}": imported ${entries.length} entries across ${pagesFetched} page(s)` +
      (dedupedCount > 0 ? ` (de-duped ${dedupedCount} same-name row(s) from other documents)` : ''),
  );
  if (skippedCount > 0) {
    logger.warn(`[open5e-importer] section "${section}": imported ${entries.length} entries, skipped ${skippedCount} row(s)`);
  }

  return { entries, skippedCount, dedupedCount };
}

export function entryTypeForSection(section: Open5eSection): RuleEntryType {
  return SECTION_TO_ENTRY_TYPE[section];
}

export const ALL_OPEN5E_SECTIONS: Open5eSection[] = ['spells', 'monsters', 'items', 'conditions', 'classes', 'races', 'feats'];
