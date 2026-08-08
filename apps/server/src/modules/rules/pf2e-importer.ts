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
 * TWO SHAPE TRAPS THIS FILE EXISTS TO SURVIVE (both silently emptied imported entries):
 *   1. Printed mechanics are indexed TWICE — a sortable number (`price: 22500`,
 *      `range: 500`, `bulk: 1`) plus the printed string under `<field>_raw`
 *      (`price_raw: "225 gp"`). Read the number as a string and you get '' — which is
 *      exactly how every imported item lost its price. Always go through `displayOf`.
 *   2. Scalars are frequently single-element ARRAYS (`size: ['Gargantuan']`,
 *      `source: ['Player Core']`, `attribute: ['Intelligence']`). Always go through
 *      `asScalarString`/`asStringArray`, never bare `asString`.
 * The fake source in test/fake-pf2e.ts reproduces both shapes on purpose — it previously
 * used the convenient shape instead, which is why the unit suite stayed green while the
 * live import dropped price, range, duration, size, and every weapon/armor stat.
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

export const SF2E_DEFAULT_BASE_URL = 'https://elasticsearch.aonprd.com';
export const SF2E_INDEX = 'aonsf';
export const SF2E_PACK_NAME = 'Starfinder 2e (Archives of Nethys)';
export const SF2E_DEFAULT_LICENSE = 'ORC / OGL';

// Mirrors the Open5e importer's caps/timeouts (see open5e-importer.ts for the rationale):
// large sections (creatures/spells/equipment run into the thousands) are page-fetched under
// a hard per-section entry cap and a page cap so one install can't pull unbounded data.
// The cap sits above the largest live section (PF2e `type:item` is ~11.1k rows) so a normal
// install is COMPLETE: at the old 3000 it silently kept 27% of PF2e gear, which is why a
// player looking up a plain longsword found nothing.
export const MAX_ENTRIES_PER_SECTION = 15000;
const PAGE_SIZE = 500;
const MAX_PAGES_PER_SECTION = 60;
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_RETRY_BACKOFFS_MS = [1_000, 3_000];

// Campfire's importer "sections" map 1:1 onto an AoN document `type` and a Campfire
// rule-entry type. Ancestries -> race, backgrounds -> feat (per issue #2's class/race/feat
// vocabulary; a background is a feat-like package of proficiencies), classes -> class.
export type Pf2eSection =
  | 'creatures'
  | 'spells'
  | 'equipment'
  | 'feats'
  | 'ancestries'
  | 'classes'
  | 'backgrounds'
  | 'conditions'
  | 'vehicles'
  | 'hazards'
  | 'deities'
  | 'rituals'
  | 'planes'
  | 'curses'
  | 'diseases';

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
  vehicles: 'vehicle',
  hazards: 'hazard',
  deities: 'deity',
  rituals: 'ritual',
  planes: 'plane',
  curses: 'curse',
  diseases: 'disease',
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
  vehicles: 'item',
  hazards: 'hazard',
  deities: 'other',
  rituals: 'spell',
  planes: 'section',
  curses: 'condition',
  diseases: 'condition',
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
  'vehicles',
  'hazards',
  'deities',
  'rituals',
  'planes',
  'curses',
  'diseases',
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
  /** Per-entry provenance (issue #734); '' → inherit the pack's value via the service layer. */
  attribution?: string;
  author?: string;
  sourceUrl?: string;
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
  /**
   * True when pagination stopped EARLY at the per-section page cap rather than reaching the
   * end of the source. Deliberately separate from `skippedCount`: no row was dropped here, so
   * folding it into the skip count would tell an operator rows were discarded when none were.
   * rules.service's manifestIsComplete() consults both — a truncated fetch is not a provable
   * full manifest and must not authorise deleting installed rows.
   */
  truncated: boolean;
}

interface AonHit {
  _id?: unknown;
  _source?: Record<string, unknown>;
  /** Sort cursor echoed back per hit; the tail value drives `search_after` paging. */
  sort?: unknown[];
}
interface AonPage {
  hits?: { total?: { value?: number } | number; hits?: AonHit[] };
  /** Refreshed point-in-time id; a PIT search may hand back a new one to carry forward. */
  pit_id?: unknown;
}

function asString(v: unknown): string {
  if (typeof v !== 'string') return '';
  // AoN prose can carry literal escape sequences; normalise like the Open5e importer does.
  return v.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
}

function asStringArray(v: unknown): string[] {
  if (typeof v === 'string') return asString(v).trim() ? [asString(v).trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'number' ? String(x) : asString(x).trim())).filter(Boolean);
}

/**
 * A scalar AoN field that may arrive wrapped in a single-element array. `size`, `source`,
 * `attribute`, `domain` and friends are all list-typed in the live index even when they
 * hold one value — reading them with asString() yields '' and silently drops the field
 * (this is why every imported creature had `size: null`).
 */
function asScalarString(v: unknown): string {
  if (Array.isArray(v)) return asStringArray(v)[0] ?? '';
  if (typeof v === 'number') return String(v);
  return asString(v).trim();
}

/**
 * AoN publishes most printed mechanics TWICE: a normalised number for sorting/filtering
 * (`price: 22500`, `range: 500`, `bulk: 1`) and the printed display string under
 * `<field>_raw` (`price_raw: "225 gp"`, `range_raw: "500 feet"`, `bulk_raw: "L"`). The
 * display string is the one a rules reader needs — and the numeric twin is what the
 * mappers used to read through asString(), which returns '' for a number, so price,
 * range, duration and area were dropped from EVERY imported row. Prefer `_raw`, fall back
 * to the plain field (stringifying a number) so rows that only carry one of the pair work.
 */
function displayOf(src: Record<string, unknown>, key: string): string | null {
  const raw = asScalarString(src[`${key}_raw`]);
  if (raw) return raw;
  return asScalarString(src[key]) || null;
}

/** Numeric map (`skill_mod: {athletics: 31}`, `resistance: {cold: 15}`), or null when empty. */
function numericMap(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = num(raw);
    if (n !== null) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Drop absent facts so `dataJson` carries only what the source actually published. The
 * compendium renders these as a fact list, and a wall of `null`s reads as broken data
 * rather than as "this row has no price".
 */
function facts(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    out[k] = v;
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Join the mechanical bits of a summary line, falling back through prose then body. */
function summaryLine(bits: Array<string | null>, src: Record<string, unknown>): string {
  return truncate(bits.filter(Boolean).join(' · ') || proseOf(src) || bodyOf(src), 300);
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

/**
 * AoN's flattened `text` keeps one piece of its own page markup: a `<title level="…"
 * right="Item 6+" …>` header (the only pseudo-tag that survives flattening — verified
 * across every indexed type). Rendered as markdown it shows up as literal angle-bracket
 * noise at the top of the entry, so strip it and collapse the blank lines it leaves.
 */
const AON_TITLE_TAG = /<\/?title\b[^>]*>/gi;

/** Rules prose, preferring the plain-text `text` over `markdown` (both are OGC); art/images ignored. */
function bodyOf(src: Record<string, unknown>): string {
  const raw = asString(src.text) || asString(src.markdown) || asString(src.description) || asString(src.desc);
  return raw.replace(AON_TITLE_TAG, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * AoN's own one-line blurb for the row. Much better reading than the flattened statblock
 * text when an entry has no mechanical summary bits — except on SF2e gear, where the
 * index fills the field with a placeholder note instead of leaving it empty.
 */
const AON_MISSING_DESCRIPTION = /nethys note: there is no description/i;

function proseOf(src: Record<string, unknown>): string {
  const summary = asString(src.summary).trim();
  return summary && !AON_MISSING_DESCRIPTION.test(summary) ? summary : '';
}

/** Reported license (OGL legacy / ORC remaster). Falls back to the pack default license. */
function licenseOf(src: Record<string, unknown>, defaultLicense: string = PF2E_DEFAULT_LICENSE): string {
  return asString(src.license) || defaultLicense;
}

/** Source-book label for attribution (AoN `source`; array-valued on some rows). */
function sourceOf(src: Record<string, unknown>): string {
  if (Array.isArray(src.source)) return asStringArray(src.source).join(', ');
  return asString(src.source);
}

/**
 * AoN indexes rules from many publications. Adventure/scenario/story books are not a
 * rules compendium source for this importer even when an individual row has mechanics:
 * importing them would cross the product-identity/story-content boundary. Fail closed on
 * the publication label and retain only rulebooks, setting books, and dedicated rules data.
 */
function isAdventureSource(src: Record<string, unknown>): boolean {
  const source = sourceOf(src);
  // Match Paizo adventure/scenario *publication-line* patterns rather than a bare
  // "adventure" substring, which would false-positive on rulebooks whose titles merely
  // contain the word (e.g. "…Book of Adventure"). We still fail closed on the genuine
  // product lines: Adventure Path, (Society) Scenario, Bounty, numbered Quest, One-Shot.
  return /\b(?:adventure path|society scenario|scenario|bounty|one[- ]shot)\b|\bquest\s+#/i.test(source);
}

function traitsOf(src: Record<string, unknown>): string[] {
  return asStringArray(src.trait ?? src.traits);
}

/** Rarity is a lowercase token in the index ('uncommon'); title-case it for display. */
function rarityOf(src: Record<string, unknown>): string | null {
  const rarity = asScalarString(src.rarity);
  return rarity ? rarity.charAt(0).toUpperCase() + rarity.slice(1) : null;
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
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // Some rows carry a numeric string ('2' for hands/reload); accept those too.
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseActionItem(item: unknown): Record<string, unknown> | null {
  if (typeof item === 'string' && item.trim()) {
    return { name: item.trim(), desc: item.trim() };
  }
  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : 'Action';
    const desc =
      typeof obj.desc === 'string'
        ? obj.desc
        : typeof obj.description === 'string'
          ? obj.description
          : typeof obj.text === 'string'
            ? obj.text
            : '';
    return { ...obj, name, desc };
  }
  return null;
}

function actionsOf(src: Record<string, unknown>): Record<string, unknown>[] {
  const sources = [
    src.actions,
    src.action,
    src.attacks,
    src.attack,
    src.strikes,
    src.strike,
    src.activities,
    src.activity,
    src.special_abilities,
    src.specialAbilities,
    src.special,
  ];
  const result: Record<string, unknown>[] = [];
  for (const s of sources) {
    if (!s) continue;
    const list = Array.isArray(s) ? s : [s];
    for (const item of list) {
      const parsed = parseActionItem(item);
      if (parsed) result.push(parsed);
    }
  }
  return result;
}

/**
 * AoN indexes a creature's named abilities and strikes as a flat list of NAMES only
 * (`creature_ability: ['Shortwave', 'fist +10']`) — the prose for each lives in the
 * statblock text, not in its own field. Surface the names as name-only statblock entries
 * so the combat card lists what the creature can do; the body still carries the rules text.
 */
function creatureAbilitiesOf(src: Record<string, unknown>): Record<string, unknown>[] {
  return asStringArray(src.creature_ability).map((name) => ({ name, desc: '' }));
}

/** Fortitude/Reflex/Will, shared by creatures, hazards, and vehicles. */
function savesOf(src: Record<string, unknown>): Record<string, number> | null {
  return numericMap({ fortitude: src.fortitude_save, reflex: src.reflex_save, will: src.will_save });
}

function mapCreature(src: Record<string, unknown>, defaultLicense?: string): ImportedEntry {
  const name = asString(src.name);
  const traits = traitsOf(src);
  const level = num(src.level);
  const rarity = rarityOf(src);
  const size = asScalarString(src.size);
  // Live AoN has no per-action documents for creatures; `actionsOf` still covers dumps
  // that DO carry structured actions, and `creature_ability` supplies the named list.
  const actions = actionsOf(src);
  return {
    slug: slugOf(src, name),
    name,
    type: 'monster',
    summary: summaryLine([level !== null ? `Level ${level}` : null, size || null, rarity, traits.slice(0, 3).join(', ') || null], src),
    body: bodyOf(src),
    dataJson: JSON.stringify(
      facts({
        level,
        ac: num(src.ac),
        hp: num(src.hp),
        hardness: num(src.hardness),
        perception: num(src.perception),
        abilityMods: abilityModsOf(src),
        saves: savesOf(src),
        skills: numericMap(src.skill_mod),
        speed: src.speed ?? null,
        size: size || null,
        rarity,
        alignment: asScalarString(src.alignment) || null,
        creatureFamily: asScalarString(src.creature_family) || null,
        languages: asStringArray(src.language),
        immunities: asStringArray(src.immunity),
        resistances: numericMap(src.resistance),
        weaknesses: numericMap(src.weakness),
        items: asStringArray(src.item),
        traits,
        specialAbilities: creatureAbilitiesOf(src),
        actions,
      }),
    ),
    license: licenseOf(src, defaultLicense),
    source: sourceOf(src),
  };
}

function mapSpell(src: Record<string, unknown>, defaultLicense?: string): ImportedEntry {
  const name = asString(src.name);
  const rank = num(src.level) ?? num(src.rank); // PF2e remaster: spell "rank"; legacy field is `level`
  const traditions = asStringArray(src.tradition);
  return {
    slug: slugOf(src, name),
    name,
    type: 'spell',
    summary: summaryLine([rank !== null ? `Rank ${rank}` : null, traditions.join('/') || null, traitsOf(src).slice(0, 3).join(', ') || null], src),
    body: bodyOf(src),
    dataJson: JSON.stringify(
      facts({
        rank,
        traditions,
        // `actions` on a spell row is the cast time label ('Two Actions'), not a list.
        cast: asScalarString(src.cast ?? src.actions) || null,
        components: asStringArray(src.component),
        range: displayOf(src, 'range'),
        area: displayOf(src, 'area'),
        duration: displayOf(src, 'duration'),
        targets: asScalarString(src.target) || null,
        savingThrow: asScalarString(src.saving_throw) || null,
        defense: asScalarString(src.defense) || null,
        cost: asScalarString(src.cost) || null,
        trigger: asScalarString(src.trigger) || null,
        requirement: asScalarString(src.requirement) || null,
        heightenLevels: asStringArray(src.heighten_level),
        school: asScalarString(src.school) || null,
        spellType: asScalarString(src.spell_type) || null,
        rarity: rarityOf(src),
        traits: traitsOf(src),
      }),
    ),
    license: licenseOf(src, defaultLicense),
    source: sourceOf(src),
  };
}

function mapEquipment(src: Record<string, unknown>, defaultLicense?: string): ImportedEntry {
  const name = asString(src.name);
  const level = num(src.level);
  const price = displayOf(src, 'price');
  // `item_category` is the printed shelf ('Weapons', 'Staves', 'Ammunition'); `category`
  // is the coarse index bucket ('weapon', 'equipment'). Prefer the printed one.
  const itemCategory = asScalarString(src.item_category);
  const category = asScalarString(src.category);
  return {
    slug: slugOf(src, name),
    name,
    type: 'item',
    summary: summaryLine([itemCategory || category || null, level !== null ? `Item ${level}` : null, price], src),
    body: bodyOf(src),
    dataJson: JSON.stringify(
      facts({
        level,
        price,
        bulk: displayOf(src, 'bulk'),
        category: category || null,
        itemCategory: itemCategory || null,
        itemSubcategory: asScalarString(src.item_subcategory) || null,
        rarity: rarityOf(src),
        usage: asScalarString(src.usage) || null,
        hands: asScalarString(src.hands) || null,
        activate: asScalarString(src.actions) || null,
        duration: displayOf(src, 'duration'),
        onset: displayOf(src, 'onset'),
        savingThrow: asScalarString(src.saving_throw) || null,
        access: asScalarString(src.access) || null,
        baseItem: asScalarString(src.base_item) || null,
        // Weapon block — the stats a player actually needs at the table.
        damage: asScalarString(src.damage) || null,
        damageType: asStringArray(src.damage_type),
        weaponCategory: asScalarString(src.weapon_category) || null,
        weaponGroup: asScalarString(src.weapon_group) || null,
        weaponType: asScalarString(src.weapon_type) || null,
        range: displayOf(src, 'range'),
        reload: displayOf(src, 'reload'),
        ammunition: asScalarString(src.ammunition) || null,
        expend: num(src.expend),
        upgrades: num(src.upgrades),
        grade: asScalarString(src.grade) || null,
        // Armor block.
        ac: num(src.ac),
        dexCap: num(src.dex_cap),
        checkPenalty: num(src.check_penalty),
        speedPenalty: num(src.speed_penalty),
        strength: num(src.strength),
        armorCategory: asScalarString(src.armor_category) || null,
        armorGroup: asScalarString(src.armor_group) || null,
        // Item bonuses (skill items, consumables).
        skill: asStringArray(src.skill),
        itemBonus: num(src.item_bonus_value),
        itemBonusNote: asScalarString(src.item_bonus_note) || null,
        traits: traitsOf(src),
      }),
    ),
    license: licenseOf(src, defaultLicense),
    source: sourceOf(src),
  };
}

function mapFeat(src: Record<string, unknown>, defaultLicense?: string): ImportedEntry {
  const name = asString(src.name);
  const level = num(src.level);
  const prereq = asScalarString(src.prerequisite);
  return {
    slug: slugOf(src, name),
    name,
    type: 'feat',
    summary: summaryLine([level !== null ? `Feat ${level}` : null, prereq ? `Prereq: ${prereq}` : null], src),
    body: bodyOf(src),
    dataJson: JSON.stringify(
      facts({
        level,
        prerequisite: prereq || null,
        activate: asScalarString(src.actions) || null,
        trigger: asScalarString(src.trigger) || null,
        requirement: asScalarString(src.requirement) || null,
        frequency: asScalarString(src.frequency) || null,
        cost: asScalarString(src.cost) || null,
        access: asScalarString(src.access) || null,
        archetype: asScalarString(src.archetype) || null,
        rarity: rarityOf(src),
        traits: traitsOf(src),
      }),
    ),
    license: licenseOf(src, defaultLicense),
    source: sourceOf(src),
  };
}

function mapAncestry(src: Record<string, unknown>, defaultLicense?: string): ImportedEntry {
  const name = asString(src.name);
  const hp = num(src.hp);
  const size = asScalarString(src.size);
  return {
    slug: slugOf(src, name),
    name,
    type: 'race',
    summary: summaryLine([hp !== null ? `HP ${hp}` : null, size || null, traitsOf(src).slice(0, 3).join(', ') || null], src),
    body: bodyOf(src),
    dataJson: JSON.stringify(
      facts({
        hp,
        size: size || null,
        speed: src.speed ?? null,
        // Remaster vocabulary: ancestries grant attribute boosts/flaws (legacy: ability).
        attributeBoosts: asStringArray(src.attribute ?? src.ability_boost),
        attributeFlaws: asStringArray(src.attribute_flaw ?? src.ability_flaw),
        languages: asStringArray(src.language),
        vision: asScalarString(src.vision) || null,
        rarity: rarityOf(src),
        traits: traitsOf(src),
      }),
    ),
    license: licenseOf(src, defaultLicense),
    source: sourceOf(src),
  };
}

function mapClass(src: Record<string, unknown>, defaultLicense?: string): ImportedEntry {
  const name = asString(src.name);
  const keyAbility = asStringArray(src.attribute ?? src.key_ability);
  const hp = num(src.hp);
  return {
    slug: slugOf(src, name),
    name,
    type: 'class',
    summary: summaryLine([hp !== null ? `HP ${hp}/level` : null, keyAbility.length ? `key ${keyAbility.join('/')}` : null], src),
    body: bodyOf(src),
    dataJson: JSON.stringify(
      facts({
        hpPerLevel: hp,
        keyAbility,
        perceptionProficiency: asScalarString(src.perception_proficiency) || null,
        fortitudeProficiency: asScalarString(src.fortitude_proficiency) || null,
        reflexProficiency: asScalarString(src.reflex_proficiency) || null,
        willProficiency: asScalarString(src.will_proficiency) || null,
        attackProficiency: asStringArray(src.attack_proficiency),
        defenseProficiency: asStringArray(src.defense_proficiency),
        skillProficiency: asStringArray(src.skill_proficiency),
        tradition: asStringArray(src.tradition),
        rarity: rarityOf(src),
        traits: traitsOf(src),
      }),
    ),
    license: licenseOf(src, defaultLicense),
    source: sourceOf(src),
  };
}

function mapBackground(src: Record<string, unknown>, defaultLicense?: string): ImportedEntry {
  const name = asString(src.name);
  const skills = asStringArray(src.skill);
  return {
    slug: slugOf(src, name),
    name,
    type: 'feat',
    summary: summaryLine([skills.length ? skills.join(', ') : null, ...asStringArray(src.feat).slice(0, 1)], src),
    body: bodyOf(src),
    dataJson: JSON.stringify(
      facts({
        kind: 'background',
        attributeBoosts: asStringArray(src.attribute ?? src.ability_boost),
        skills,
        feats: asStringArray(src.feat),
        region: asScalarString(src.region) || null,
        prerequisite: asScalarString(src.prerequisite) || null,
        rarity: rarityOf(src),
        traits: traitsOf(src),
      }),
    ),
    license: licenseOf(src, defaultLicense),
    source: sourceOf(src),
  };
}

function mapCondition(src: Record<string, unknown>, defaultLicense?: string): ImportedEntry {
  const name = asString(src.name);
  // No rarity here even though the index carries one: rarity gates what a character may
  // acquire, and a condition is not acquired. It would be a "Rarity: Common" row on every
  // condition page and nothing else.
  const data = facts({ traits: traitsOf(src) });
  return {
    slug: slugOf(src, name),
    name,
    type: 'condition',
    summary: summaryLine([], src),
    body: bodyOf(src),
    dataJson: Object.keys(data).length > 0 ? JSON.stringify(data) : null,
    license: licenseOf(src, defaultLicense),
    source: sourceOf(src),
  };
}

function mapVehicle(src: Record<string, unknown>, defaultLicense?: string): ImportedEntry {
  const name = asString(src.name);
  const level = num(src.level);
  const price = displayOf(src, 'price');
  const size = asScalarString(src.size);
  return {
    slug: slugOf(src, name),
    name,
    type: 'item',
    summary: summaryLine(['Vehicle', level !== null ? `Level ${level}` : null, price], src),
    body: bodyOf(src),
    dataJson: JSON.stringify(
      facts({
        category: 'vehicle',
        level,
        price,
        size: size || null,
        vehicleType: asScalarString(src.vehicle_type) || null,
        ac: num(src.ac),
        hp: num(src.hp),
        hardness: num(src.hardness),
        saves: savesOf(src),
        speed: src.speed ?? null,
        space: asScalarString(src.space) || null,
        crew: asScalarString(src.crew) || null,
        passengers: displayOf(src, 'passengers'),
        pilotingCheck: asScalarString(src.piloting_check) || null,
        collision: asScalarString(src.collision) || null,
        immunities: asStringArray(src.immunity),
        rarity: rarityOf(src),
        traits: traitsOf(src),
      }),
    ),
    license: licenseOf(src, defaultLicense),
    source: sourceOf(src),
  };
}

function mapHazard(src: Record<string, unknown>, defaultLicense?: string): ImportedEntry {
  const name = asString(src.name);
  const level = num(src.level);
  const complexity = asScalarString(src.complexity);
  const traits = traitsOf(src);
  return {
    slug: slugOf(src, name),
    name,
    type: 'hazard',
    summary: summaryLine([level !== null ? `Level ${level}` : null, complexity || null, traits.slice(0, 3).join(', ') || null], src),
    body: bodyOf(src),
    dataJson: JSON.stringify(
      facts({
        level,
        ac: num(src.ac),
        hp: num(src.hp),
        hardness: num(src.hardness),
        // `stealth` is printed prose ('DC 18 (or 0 if the trapdoor is disabled)'), not a number.
        stealth: displayOf(src, 'stealth'),
        complexity: complexity || null,
        hazardType: asScalarString(src.hazard_type) || null,
        saves: savesOf(src),
        disable: asScalarString(src.disable) || null,
        reset: asScalarString(src.reset) || null,
        routine: asScalarString(src.routine) || null,
        immunities: asStringArray(src.immunity),
        rarity: rarityOf(src),
        traits,
      }),
    ),
    license: licenseOf(src, defaultLicense),
    source: sourceOf(src),
  };
}

/**
 * Per-kind mechanical facts for the reference sections (deity/ritual/plane/curse/disease).
 * These share one mapper because they share a shape — a name, prose, and a handful of
 * kind-specific fields — but each kind's fields are its own, and dropping them left the
 * imported rows as bare prose with no mechanics at all.
 */
function referenceFacts(kind: string, src: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'Deity') {
    return {
      alignment: asScalarString(src.alignment) || null,
      edicts: asScalarString(src.edict) || null,
      anathema: asScalarString(src.anathema) || null,
      areaOfConcern: displayOf(src, 'area_of_concern'),
      domains: asStringArray(src.domain),
      favoredWeapons: asStringArray(src.favored_weapon),
      divineFont: asStringArray(src.divine_font),
      divineSkills: asStringArray(src.skill),
      sanctification: displayOf(src, 'sanctification'),
      pantheon: asStringArray(src.pantheon),
      clericSpells: asStringArray(src.cleric_spell),
    };
  }
  if (kind === 'Ritual') {
    return {
      cast: asScalarString(src.cast ?? src.actions) || null,
      cost: asScalarString(src.cost) || null,
      primaryCheck: asScalarString(src.primary_check) || null,
      secondaryCheck: asScalarString(src.secondary_check) || null,
      secondaryCasters: displayOf(src, 'secondary_casters'),
      range: displayOf(src, 'range'),
      area: displayOf(src, 'area'),
      duration: displayOf(src, 'duration'),
      targets: asScalarString(src.target) || null,
      heightenLevels: asStringArray(src.heighten_level),
    };
  }
  // Curses and diseases are afflictions: onset/stages/saving throw carry the mechanics.
  return {
    onset: displayOf(src, 'onset'),
    savingThrow: asScalarString(src.saving_throw) || null,
    duration: displayOf(src, 'duration'),
  };
}

function mapReference(
  type: RuleEntryType,
  kind: string,
  src: Record<string, unknown>,
  defaultLicense?: string,
): ImportedEntry {
  const name = asString(src.name);
  const level = num(src.level) ?? num(src.rank);
  const traits = traitsOf(src);
  return {
    slug: slugOf(src, name),
    name,
    type,
    summary: summaryLine([level !== null ? `${kind} ${level}` : kind, traits.slice(0, 3).join(', ') || null], src),
    body: bodyOf(src),
    dataJson: JSON.stringify(
      facts({ kind: kind.toLowerCase(), level, rarity: rarityOf(src), traits, ...referenceFacts(kind, src) }),
    ),
    license: licenseOf(src, defaultLicense),
    source: sourceOf(src),
  };
}

const SECTION_MAPPER: Record<Pf2eSection, (src: Record<string, unknown>, defaultLicense?: string) => ImportedEntry> = {
  creatures: mapCreature,
  spells: mapSpell,
  equipment: mapEquipment,
  feats: mapFeat,
  ancestries: mapAncestry,
  classes: mapClass,
  backgrounds: mapBackground,
  conditions: mapCondition,
  vehicles: mapVehicle,
  hazards: mapHazard,
  deities: (src, license) => mapReference('other', 'Deity', src, license),
  rituals: (src, license) => mapReference('spell', 'Ritual', src, license),
  planes: (src, license) => mapReference('section', 'Plane', src, license),
  curses: (src, license) => mapReference('condition', 'Curse', src, license),
  diseases: (src, license) => mapReference('condition', 'Disease', src, license),
};

async function fetchWithTimeout(url: string, body: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body,
    });
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
async function fetchPageWithRetry(
  url: string,
  body: string,
  section: Pf2eSection,
  logger: Pf2eImportLogger,
  systemLabel: string = 'PF2e',
): Promise<Response> {
  let lastErr: Error | null = null;
  let lastRes: Response | null = null;

  for (let attempt = 0; attempt <= PAGE_RETRY_BACKOFFS_MS.length; attempt++) {
    try {
      const res = await fetchWithTimeout(url, body);
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
        `[${systemLabel.toLowerCase()}-importer] section "${section}": fetch of ${url} failed (${reason}), retrying in ${backoff}ms (attempt ${attempt + 1}/${PAGE_RETRY_BACKOFFS_MS.length})`,
      );
      await sleep(backoff);
    }
  }

  if (lastRes) return lastRes;
  throw lastErr ?? new Error('unknown fetch failure');
}

/** How long AoN should hold the paging snapshot open between our page requests. */
const PIT_KEEP_ALIVE = '2m';

/**
 * Opens a point-in-time snapshot to page against, or null if the endpoint does not offer
 * one (a mirror, or an older Elasticsearch).
 *
 * WHY A SNAPSHOT AND NOT JUST `search_after`. `_doc` is an internal Lucene position, stable
 * only within one searcher: if AoN refreshes or merges segments between two of our page
 * requests, a cursor from the previous request no longer denotes the same position, and the
 * scan can silently skip rows. That is not merely lossy — a scan that loses rows still ends
 * on a short page with `truncated === false` and `skippedCount === 0`, which is exactly the
 * shape `manifestIsComplete` in rules.service reads as "this fetch is the whole pack", and
 * removal would then delete the skipped-over entries and sever their combatant references.
 *
 * A PIT pins one searcher for the whole scan, so `_shard_doc` cursors stay meaningful.
 * `verifyScanWasComplete` below is the independent second line of defence for the case
 * where no PIT is available.
 */
async function openPit(
  base: string,
  index: string,
  section: Pf2eSection,
  logger: Pf2eImportLogger,
  logPrefix: string,
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`${base}/${index}/_pit?keep_alive=${PIT_KEEP_ALIVE}`, '');
    if (!res.ok) {
      logger.warn(
        `${logPrefix} section "${section}": point-in-time snapshot unavailable (HTTP ${res.status}) — paging without one; a mid-scan index refresh will be caught by the row-count check instead`,
      );
      return null;
    }
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === 'string' && body.id ? body.id : null;
  } catch (err) {
    logger.warn(`${logPrefix} section "${section}": could not open a point-in-time snapshot (${(err as Error).message}) — paging without one`);
    return null;
  }
}

/** Best-effort release of the snapshot. Never fails the import — PITs also expire on their own. */
async function closePit(base: string, pitId: string, logger: Pf2eImportLogger, logPrefix: string): Promise<void> {
  try {
    await fetch(`${base}/_pit`, {
      method: 'DELETE',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ id: pitId }),
    });
  } catch (err) {
    logger.warn(`${logPrefix}: failed to release the point-in-time snapshot (${(err as Error).message}) — it will expire on its own`);
  }
}

/**
 * One `_search` request body. The deliberate choices, all learned from the live index:
 *
 *  - `search_after` instead of `from`/`size`. AoN enforces the Elasticsearch default
 *    `max_result_window` of 10 000, so `from` paging simply 400s past that — and PF2e's
 *    `type:item` holds ~11.1k rows. Worse, the default relevance order is not a total
 *    order, so deep `from` paging over tied scores can repeat and skip rows.
 *  - a POST body rather than the `q=` URL param, because `search_after` is body-only.
 *  - `_shard_doc` when paging inside a PIT (it exists only there), `_doc` otherwise.
 *  - `track_total_hits` so the reported total is exact rather than capped at 10 000;
 *    {@link verifyScanWasComplete} compares against it.
 */
function searchBody(aonType: string, searchAfter: unknown[] | null, pitId: string | null): string {
  return JSON.stringify({
    size: PAGE_SIZE,
    sort: [pitId ? { _shard_doc: 'asc' } : { _doc: 'asc' }],
    query: { query_string: { query: `type:${aonType}` } },
    track_total_hits: true,
    ...(pitId ? { pit: { id: pitId, keep_alive: PIT_KEEP_ALIVE } } : {}),
    ...(searchAfter ? { search_after: searchAfter } : {}),
  });
}

function totalOf(page: AonPage): number {
  const total = page.hits?.total;
  if (typeof total === 'number') return total;
  if (total && typeof total === 'object' && typeof total.value === 'number') return total.value;
  return 0;
}

/**
 * Fetches and maps one section, paginating the AoN `_search` with `search_after` until the
 * index is exhausted, MAX_ENTRIES_PER_SECTION is hit, or the page cap is reached. Malformed
 * rows are skipped (counted), same-name rows collapse to one canonical entry, and the
 * import count is logged. Network/parse failures surface as a clean BadRequestException.
 */
export async function fetchPf2eSection(
  baseUrl: string,
  section: Pf2eSection,
  logger: Pf2eImportLogger = consoleLogger,
  index: string = PF2E_INDEX,
  systemLabel: string = 'PF2e',
): Promise<Pf2eSectionResult> {
  const aonType = SECTION_TO_AON_TYPE[section];
  const mapper = SECTION_MAPPER[section];
  const base = baseUrl.replace(/\/$/, '');
  const logPrefix = `[${systemLabel.toLowerCase()}-importer]`;
  // De-dupe same-name rows to one canonical entry per (name, type): a section is a single
  // type, so a lowercased name is the (name, type) key. First-seen wins (stable order).
  const byName = new Map<string, ImportedEntry>();
  let skippedCount = 0;
  let truncated = false;
  let dedupedCount = 0;
  let searchAfter: unknown[] | null = null;
  let pagesFetched = 0;
  // Rows the source actually handed us, counted BEFORE de-duping/skipping so it can be
  // compared against the reported total to prove nothing was paged over.
  let rowsSeen = 0;
  let reportedTotal = 0;

  // A PIT pins one searcher for the whole scan; without it a mid-scan refresh can move the
  // cursor's meaning underneath us. Searching a PIT takes no index in the path.
  let pitId = await openPit(base, index, section, logger, logPrefix);
  const url = pitId ? `${base}/_search` : `${base}/${index}/_search`;

  try {
    for (;;) {
      if (byName.size >= MAX_ENTRIES_PER_SECTION) {
        logger.warn(`${logPrefix} section "${section}": hit entry cap (${MAX_ENTRIES_PER_SECTION}) — stopping`);
        // Truncation, NOT a dropped row: tracked on its own flag so the skip count keeps meaning
        // "rows discarded" while rules.service's manifestIsComplete() still sees that this fetch
        // may have left entries behind and must not authorise deletion. The entry cap used to
        // exit the loop silently, so a capped section was reported as a COMPLETE manifest.
        truncated = true;
        break;
      }
      if (pagesFetched >= MAX_PAGES_PER_SECTION) {
        logger.warn(`${logPrefix} section "${section}": hit page cap (${MAX_PAGES_PER_SECTION} pages) after ${byName.size} entries — stopping`);
        truncated = true;
        break;
      }
      pagesFetched += 1;
      let res: Response;
      try {
        res = await fetchPageWithRetry(url, searchBody(aonType, searchAfter, pitId), section, logger, systemLabel);
      } catch (err) {
        throw new BadRequestException(`Failed to fetch ${systemLabel} section "${section}" from ${url}: ${(err as Error).message}`);
      }
      if (!res.ok) {
        throw new BadRequestException(`${systemLabel} section "${section}" returned HTTP ${res.status} for ${url}`);
      }
      let page: AonPage;
      try {
        page = (await res.json()) as AonPage;
      } catch (err) {
        throw new BadRequestException(`${systemLabel} section "${section}" returned invalid JSON: ${(err as Error).message}`);
      }
      const hits = page.hits?.hits;
      if (!Array.isArray(hits)) {
        throw new BadRequestException(`${systemLabel} section "${section}" response missing "hits.hits" array (unexpected shape)`);
      }
      // Carry forward the refreshed snapshot id when the search hands one back.
      if (typeof page.pit_id === 'string' && page.pit_id) pitId = page.pit_id;
      if (pagesFetched === 1) reportedTotal = totalOf(page);
      if (hits.length === 0) break; // exhausted
      rowsSeen += hits.length;

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
          // Preserve the open-rules boundary: never ingest adventure/scenario/story books.
          if (isAdventureSource(src as Record<string, unknown>)) {
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

      // Advance the cursor to the last hit of this page. A page whose final hit carries no
      // `sort` array cannot be paged past — stop rather than re-request page one forever.
      const cursor = hits[hits.length - 1]?.sort;
      if (!Array.isArray(cursor) || cursor.length === 0) {
        if (hits.length >= PAGE_SIZE) {
          logger.warn(`${logPrefix} section "${section}": response carries no sort cursor — stopping after ${byName.size} entries`);
          truncated = true;
        }
        break;
      }
      searchAfter = cursor;
      // A short page means the index is exhausted.
      if (hits.length < PAGE_SIZE) break;
    }
  } finally {
    if (pitId) await closePit(base, pitId, logger, logPrefix);
  }

  // Independent proof that the scan saw every row, whatever the paging mechanism did. A
  // scan that silently paged over rows otherwise ends looking IDENTICAL to a complete one
  // — short final page, nothing skipped, not truncated — and that is precisely the shape
  // rules.service's manifestIsComplete() reads as authority to DELETE installed entries
  // that are missing from the fetch. Fail closed: fewer rows than the source reported
  // means this fetch cannot prove it is the whole pack.
  if (!truncated && reportedTotal > 0 && rowsSeen < reportedTotal) {
    logger.warn(
      `${logPrefix} section "${section}": saw ${rowsSeen} of ${reportedTotal} reported rows — the scan lost rows (index refreshed mid-scan?); marking the manifest incomplete so nothing is removed`,
    );
    truncated = true;
  }

  const entries = [...byName.values()];
  logger.info(
    `${logPrefix} section "${section}": imported ${entries.length} entries across ${pagesFetched} page(s)` +
      (dedupedCount > 0 ? ` (de-duped ${dedupedCount} same-name row(s))` : ''),
  );
  if (skippedCount > 0) {
    logger.warn(`${logPrefix} section "${section}": imported ${entries.length} entries, skipped ${skippedCount} row(s)`);
  }

  return { entries, skippedCount, dedupedCount, truncated };
}

export function entryTypeForSection(section: Pf2eSection): RuleEntryType {
  return SECTION_TO_ENTRY_TYPE[section];
}

export async function fetchSf2eSection(
  baseUrl: string,
  section: Pf2eSection,
  logger: Pf2eImportLogger = consoleLogger,
): Promise<Pf2eSectionResult> {
  return fetchPf2eSection(baseUrl, section, logger, SF2E_INDEX, 'SF2e');
}
