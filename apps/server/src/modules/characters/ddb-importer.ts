import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import type { CharacterCreate, CharacterAction as CharacterActionType, DdbImportSummary } from '@campfire/schema';
import { CharacterAction, DND5E_DAMAGE_TYPES, expandRawStatblockAction, isResolvableSpec } from '@campfire/schema';
import { parseDiceExpr } from '../../common/dice';

/**
 * Unofficial, READ-ONLY importer for PUBLIC D&D Beyond character sheets (issue #18).
 *
 * D&D Beyond exposes an undocumented character-service JSON endpoint that returns a
 * character's full sheet as JSON *when that character's privacy is set to Public*:
 *
 *     GET https://character-service.dndbeyond.com/character/v5/character/<id>
 *
 * The response is an envelope `{ id, success, message, data }`. For a public sheet
 * `success` is true and `data` holds the sheet; for a private/campaign-only sheet the
 * service answers 403 (or `success:false`), and for a non-existent id it 404s. We map
 * `data` into a Campfire `CharacterCreate`. This is unofficial (no WotC/DDB API contract),
 * so we NEVER authenticate, never scrape private data, and treat every field as optional —
 * the shape below was captured from representative public sheets and the mapper tolerates
 * missing/renamed fields rather than throwing.
 *
 * Field-shape notes (what mattered for the mapping):
 *  - `stats` / `bonusStats` / `overrideStats` are arrays of six `{ id, value }` rows keyed
 *    by DDB's ability id (1=STR 2=DEX 3=CON 4=INT 5=WIS 6=CHA). The *displayed* score is
 *    `override ?? base + bonus + racial/feat bonuses`, and those racial/feat bonuses live in
 *    `modifiers.*[]` as `{ type:'bonus', subType:'<ability>-score', value }` — DDB does not
 *    store the final score anywhere, so we recompute it the way the sheet does.
 *  - There is no flat armor-class field either; DDB computes AC from equipped armor. We do a
 *    best-effort computation (equipped body armor + Dex within the armor's cap, plus shields),
 *    falling back to unarmored `10 + Dex mod` so `ac` is always populated with a sensible value.
 *  - Max HP = `overrideHitPoints ?? baseHitPoints + bonusHitPoints + Con-mod * totalLevel`;
 *    current = max - `removedHitPoints`. `baseHitPoints` is stored WITHOUT the Con contribution.
 *  - `race.fullName` ("Hill Dwarf") is the display species; `classes[]` each carry a `level`
 *    and `definition.name` (+ optional `subclassDefinition.name`). Total level is the sum.
 *  - `background.definition.name`, or the custom background name when `hasCustomBackground`.
 *  - Saving-throw / skill proficiencies are also expressed as `modifiers.*[]` entries
 *    (`subType:'<ability>-saving-throws'`, `subType:'<skill>-skill'`, type `proficiency`
 *    or `expertise`).
 */

export const DDB_CHARACTER_SERVICE_BASE_URL = 'https://character-service.dndbeyond.com/character/v5/character';
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Defensive per-category ceiling on raw entries the MAPPING pass
 * (`computeWeaponActions`/`computeFeatureActions`/`computeSpellActions`) will build full
 * `CharacterAction` objects for (issue #1903 review) — NOT the real cap. The real cap is
 * `Character.actions`'s schema max(100), applied once at the end in `mapDdbCharacter` after
 * combining all categories, so a sheet with e.g. 45 features and 0 spells isn't truncated to
 * 30 features when there was room for all 45. This constant exists purely so a
 * pathological/malformed payload (an absurdly large array) can't make the importer build an
 * unbounded number of full action objects — it is far above any real character sheet's entry
 * count in any category. It intentionally does NOT bound `computeDdbActionEntryCount`'s
 * counting pass (see `COUNT_ENTRY_SAFETY_CAP` below) — an earlier version shared this cap
 * with the count, which meant a category with more raw entries than this constant was
 * undercounted by exactly the excess, contradicting the "always reported" overflow promise.
 */
const RAW_ENTRY_SAFETY_CAP = 300;

type CharacterCreateInput = z.infer<typeof CharacterCreate>;

/** DDB ability id (1..6) -> Campfire canonical ability key. */
const ABILITY_ID_TO_KEY: Record<number, 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA'> = {
  1: 'STR',
  2: 'DEX',
  3: 'CON',
  4: 'INT',
  5: 'WIS',
  6: 'CHA',
};

/** subType prefix ("strength") -> ability key, for reading ability-score/save modifiers. */
const ABILITY_NAME_TO_KEY: Record<string, 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA'> = {
  strength: 'STR',
  dexterity: 'DEX',
  constitution: 'CON',
  intelligence: 'INT',
  wisdom: 'WIS',
  charisma: 'CHA',
};

// ----- Loose types for the bits of the DDB sheet we read (everything optional) -----
interface DdbStat {
  id?: number;
  value?: number | null;
}
interface DdbModifier {
  type?: string; // 'bonus' | 'proficiency' | 'expertise' | 'set' | ...
  subType?: string; // 'strength-score' | 'perception-skill' | 'dexterity-saving-throws' | ...
  value?: number | null;
}
interface DdbClass {
  id?: number;
  characterClassId?: number;
  level?: number;
  definition?: { name?: string } | null;
  subclassDefinition?: { name?: string } | null;
}
interface DdbInventoryItem {
  equipped?: boolean;
  definition?: {
    name?: string | null;
    armorClass?: number | null;
    armorTypeId?: number | null; // 1 light, 2 medium, 3 heavy, 4 shield
    // Weapon fields (issue #1903) — present alongside the armor fields above on the same
    // polymorphic `definition` object; only weapons carry them.
    filterType?: string | null; // 'Weapon', 'Armor', 'Potion', ...
    type?: string | null; // secondary type hint some sheets use instead of filterType
    attackType?: number | null; // 1 melee, 2 ranged
    damage?: { diceString?: string | null } | null;
    damageType?: string | null; // 'Slashing', 'Piercing', ... (already a display string)
    properties?: Array<{ name?: string | null }> | null; // e.g. [{name:'Finesse'}]
    magic?: boolean | null;
  } | null;
}

/** One entry in a DDB `actions.<section>[]` list — a class/race/background/item/feat action or feature. */
interface DdbActionEntry {
  name?: string | null;
  snippet?: string | null;
  description?: string | null;
  dice?: { diceString?: string | null } | null;
  value?: number | null; // flat damage/bonus value alongside `dice`
  abilityModifierStatId?: number | null; // 1..6, governs an attack-shaped action's to-hit
  // Presence (not the value) is the signal that this entry is an attack roll, not a
  // passive feature — DDB sets this for "Unarmed Strike", martial-arts strikes, etc.
  attackTypeRange?: number | null; // 1 melee, 2 ranged
  fixedSaveDc?: number | null;
  saveStatId?: number | null; // 1..6, the ability the TARGET saves with
  // Action-economy source (issue #1903 review, PR #1950): DDB's activationType numbering —
  // 1 action, 2 no action, 3 bonus action, 4 reaction, 5 minute, 6 hour, 7 special,
  // 8 legendary. Only 3/4 change which turn resource this maps to below; every other value
  // (including missing/unrecognized) keeps the pre-existing 'action' behavior.
  activation?: { activationType?: number | null } | null;
  // Presence (any shape) signals a per-rest/per-day limited-use resource on this feature
  // (issue #1903 review, PR #1950 round 12) — e.g. a racial breath weapon usable a fixed
  // number of times per long rest. This importer has no mapping from a DDB limited-use pool
  // to a Campfire character resource, so a feature carrying this must not be presented as a
  // freely-resolvable action: `expandRawStatblockAction` has no way to represent the limit
  // either (it would default to unlimited), which would let encounter resolution permit
  // uses the source feature doesn't actually have. See hasUnmappedLimitedUse below.
  limitedUse?: unknown;
  // The feature's damage type, as a DDB damage-type ID rather than the display string an
  // ITEM definition carries (`DdbInventoryItem.definition.damageType`, "Slashing"). Mapped
  // through DDB_DAMAGE_TYPE_ID_TO_NAME below; see that constant for how the numbering was
  // verified. `null` on every non-damaging feature (DDB always sends the key).
  damageTypeId?: number | null;
}

/**
 * DDB damage-type ID -> Campfire's canonical 5e damage-type name (issue #1958).
 *
 * `computeFeatureActions` used to hardcode every feature's `DamagePart.type` to `''`, and
 * `applyDamageModifiers` (packages/schema/src/action-resolver.ts) skips resistance /
 * immunity / vulnerability lookups entirely when `type` is `''` — so an imported breath
 * weapon or smite dealt FULL damage to a creature that resists or is immune to it, silently
 * producing wrong combat math with nothing in `summary.textOnly` to flag it.
 *
 * PR #1950's review concluded no damage-type field existed on a class/race/background/item/
 * feat action entry. It does — DDB just spells it differently than it does for items. Verified
 * three ways rather than assumed, because a WRONG type is worse than the untyped default it
 * replaces (it would apply somebody's resistance, just not the right one):
 *
 *  1. Presence, against real public sheets: `damageTypeId` is sent on EVERY `actions.<section>[]`
 *     entry, beside the `dice`/`value`/`attackTypeRange`/`fixedSaveDc`/`saveStatId`/
 *     `abilityModifierStatId`/`activation`/`limitedUse` fields this importer already reads.
 *  2. Shape, against an independent third-party JSON Schema of the character-service payload
 *     (srsutherland/5ejson `schema/dndbeyond.schema`), which lists `damageTypeId` in the
 *     REQUIRED set for `data.actions.race[]` items.
 *  3. The numbering itself, pinned empirically against features whose damage type is fixed by
 *     the core rules, read out of real public sheets:
 *       - Monk "Unarmed Strike" / "Flurry of Blows" -> 1, and RAW those are bludgeoning;
 *       - Dhampir "Fanged Bite"                     -> 2, RAW piercing;
 *       - Way of Mercy Monk "Hand of Harm"          -> 4, RAW necrotic;
 *       - Circle of Stars Druid "Starry Form: Archer" -> 12, RAW radiant.
 *     Four non-adjacent IDs, all agreeing with the table below, which is itself the mapping
 *     MrPrimate/ddb-importer (the long-running Foundry VTT DDB importer) has shipped as
 *     `DICTIONARY.actions.damageType`.
 *
 * The values are members of `DND5E_DAMAGE_TYPES` (@campfire/schema) rather than free strings,
 * so the compiler rejects a typo that would silently never match a target's resistance list,
 * and every name is well inside `DamagePart.type`'s `z.string().max(24)` bound.
 *
 * An ID absent from this table (a homebrew or newly-introduced DDB type) is deliberately NOT
 * bounced back to `''`: an unrecognized type is treated exactly like a weapon's missing
 * `damageType`, forcing the whole entry text-only (see computeFeatureActions), because
 * resolving untyped is the very bug this map exists to fix.
 */
const DDB_DAMAGE_TYPE_ID_TO_NAME: Readonly<Record<number, (typeof DND5E_DAMAGE_TYPES)[number]>> = Object.freeze({
  1: 'bludgeoning',
  2: 'piercing',
  3: 'slashing',
  4: 'necrotic',
  5: 'acid',
  6: 'cold',
  7: 'fire',
  8: 'lightning',
  9: 'thunder',
  10: 'poison',
  11: 'psychic',
  12: 'radiant',
  13: 'force',
});

/**
 * A feature entry's damage type, or `''` when the sheet carries no recognizable one — the
 * caller treats `''` as "cannot resolve this entry", never as "untyped damage".
 */
function featureDamageTypeName(item: DdbActionEntry): string {
  const id = item.damageTypeId;
  if (typeof id !== 'number' || !Number.isInteger(id)) return '';
  return DDB_DAMAGE_TYPE_ID_TO_NAME[id] ?? '';
}

/** True when a feature entry carries a per-rest/per-day limited-use pool this importer
 * cannot map to a Campfire character resource (see the field's own doc comment). */
function hasUnmappedLimitedUse(item: DdbActionEntry): boolean {
  return item.limitedUse !== null && item.limitedUse !== undefined;
}

/** One entry in `classSpells[].spells[]` or `spells.<section>[]` — a known/prepared/granted spell. */
interface DdbSpellEntry {
  definition?: {
    name?: string | null;
    level?: number | null; // 0 = cantrip
    description?: string | null;
    concentration?: boolean | null;
    ritual?: boolean | null;
  } | null;
  // Prepared casters mark this explicitly; known casters (sorcerer, bard, warlock...) omit
  // it entirely — so only an EXPLICIT `false` excludes the spell, absence does not.
  prepared?: boolean | null;
}

export interface DdbCharacterData {
  id?: number;
  name?: string;
  race?: {
    fullName?: string;
    baseName?: string;
    weightSpeeds?: {
      normal?: {
        walk?: number | null;
        fly?: number | null;
        swim?: number | null;
        climb?: number | null;
        burrow?: number | null;
      } | null;
    } | null;
  } | null;
  customSpeeds?: Array<{ movementId?: number | null; distance?: number | null }> | null;
  classes?: DdbClass[] | null;
  stats?: DdbStat[] | null;
  bonusStats?: DdbStat[] | null;
  overrideStats?: DdbStat[] | null;
  baseHitPoints?: number | null;
  bonusHitPoints?: number | null;
  overrideHitPoints?: number | null;
  removedHitPoints?: number | null;
  temporaryHitPoints?: number | null;
  currentXp?: number | null;
  background?: {
    hasCustomBackground?: boolean;
    definition?: { name?: string | null } | null;
    customBackground?: { name?: string | null } | null;
  } | null;
  inventory?: DdbInventoryItem[] | null;
  modifiers?: Record<string, DdbModifier[]> | null;
  decorations?: { avatarUrl?: string | null } | null;
  avatarUrl?: string | null;
  notes?: { backstory?: string | null } | null;
  // Combat payload (issue #1903) — attacks/features grouped by source, and spells grouped
  // both per-class (the character's known/prepared list) and by non-class grant source
  // (a racial cantrip, a feat spell, an item-granted spell).
  actions?: {
    class?: DdbActionEntry[] | null;
    race?: DdbActionEntry[] | null;
    background?: DdbActionEntry[] | null;
    item?: DdbActionEntry[] | null;
    feat?: DdbActionEntry[] | null;
  } | null;
  classSpells?: Array<{ characterClassId?: number | null; spells?: DdbSpellEntry[] | null }> | null;
  spells?: {
    race?: DdbSpellEntry[] | null;
    class?: DdbSpellEntry[] | null;
    background?: DdbSpellEntry[] | null;
    item?: DdbSpellEntry[] | null;
    feat?: DdbSpellEntry[] | null;
  } | null;
  // Current slot expenditure (issue #1903 review) — separate from the class/level table
  // computeSpellSlots derives the MAX from; importing only the max and always zeroing
  // `used` would silently grant every imported mid-adventure caster a free long rest.
  spellSlots?: Array<{ level?: number | null; used?: number | null }> | null;
}
/** The `{ id, success, message, data }` envelope the character service returns. */
export interface DdbCharacterResponse {
  id?: number;
  success?: boolean;
  message?: string;
  data?: DdbCharacterData | null;
}

/** 5e ability modifier for a score. */
function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

/**
 * Extract the numeric D&D Beyond character id from a raw id or any character/share URL,
 * e.g. `https://www.dndbeyond.com/characters/12345678`, `.../profile/x/characters/12345678`,
 * or a bare `12345678`. Throws BadRequest if no id can be found.
 */
export function parseDdbId(idOrUrl: string): string {
  const raw = (idOrUrl ?? '').trim();
  if (!raw) throw new BadRequestException('No D&D Beyond character id or URL provided');
  // Bare numeric id.
  if (/^\d+$/.test(raw)) return raw;
  // URL form: the character id is the numeric path segment after `/characters/`, or the
  // last standalone run of digits in the path if the shape is unusual.
  const afterCharacters = raw.match(/characters\/(\d+)/i);
  if (afterCharacters) return afterCharacters[1];
  const anyDigits = raw.match(/(\d{3,})/);
  if (anyDigits) return anyDigits[1];
  throw new BadRequestException(`Could not find a D&D Beyond character id in "${idOrUrl}"`);
}

/** Flatten every modifier list (race/class/background/item/feat/condition) into one array. */
function allModifiers(data: DdbCharacterData): DdbModifier[] {
  const groups = data.modifiers;
  if (!groups || typeof groups !== 'object') return [];
  const out: DdbModifier[] = [];
  for (const list of Object.values(groups)) {
    if (Array.isArray(list)) out.push(...list.filter((m): m is DdbModifier => Boolean(m) && typeof m === 'object'));
  }
  return out;
}

/** Sum of `bonus` modifiers granting `<ability>-score` (racial/feat ASIs), per ability key. */
function abilityScoreBonuses(mods: DdbModifier[]): Record<string, number> {
  const bonuses: Record<string, number> = {};
  for (const m of mods) {
    if (m.type !== 'bonus' || typeof m.subType !== 'string' || typeof m.value !== 'number') continue;
    if (!m.subType.endsWith('-score')) continue;
    const key = ABILITY_NAME_TO_KEY[m.subType.slice(0, -'-score'.length)];
    if (key) bonuses[key] = (bonuses[key] ?? 0) + m.value;
  }
  return bonuses;
}

/** Look up a `{ id, value }` row's value in one of the stat arrays. */
function statValue(stats: DdbStat[] | null | undefined, id: number): number | null {
  if (!Array.isArray(stats)) return null;
  const row = stats.find((s) => s?.id === id);
  return row && typeof row.value === 'number' ? row.value : null;
}

/** Final displayed ability scores: `override ?? base + bonus + racial/feat bonuses`. */
export function computeAbilityScores(data: DdbCharacterData): Record<string, number> {
  const bonuses = abilityScoreBonuses(allModifiers(data));
  const out: Record<string, number> = {};
  for (let id = 1; id <= 6; id++) {
    const key = ABILITY_ID_TO_KEY[id];
    const override = statValue(data.overrideStats, id);
    if (override !== null) {
      out[key] = override;
      continue;
    }
    const base = statValue(data.stats, id);
    if (base === null) continue; // no base score for this ability — omit rather than guess 10
    const bonus = statValue(data.bonusStats, id) ?? 0;
    out[key] = base + bonus + (bonuses[key] ?? 0);
  }
  return out;
}

/** Total character level = sum of every class's level (min 1; a DDB sheet is 5e, so create() enforces the 5e adapter cap of 20). */
export function computeTotalLevel(classes: DdbClass[] | null | undefined): number {
  if (!Array.isArray(classes) || classes.length === 0) return 1;
  const total = classes.reduce((sum, c) => sum + (typeof c.level === 'number' ? c.level : 0), 0);
  return total > 0 ? total : 1;
}

/**
 * A readable class label. Single class: "Fighter (Champion)". Multiclass:
 * "Fighter 3 / Rogue 2" (level per class so the split is legible even though the
 * character's `level` field is the total).
 */
export function computeClassName(classes: DdbClass[] | null | undefined): string {
  if (!Array.isArray(classes) || classes.length === 0) return '';
  const parts = classes
    .map((c) => {
      const name = c.definition?.name?.trim();
      if (!name) return '';
      if (classes.length === 1) {
        const sub = c.subclassDefinition?.name?.trim();
        return sub ? `${name} (${sub})` : name;
      }
      return typeof c.level === 'number' && c.level > 0 ? `${name} ${c.level}` : name;
    })
    .filter(Boolean);
  return parts.join(' / ');
}

/** Max HP: `overrideHitPoints ?? base + bonus + Con-mod * totalLevel` (never below 1). */
export function computeHitPoints(data: DdbCharacterData, conScore: number | undefined, totalLevel: number): number {
  if (typeof data.overrideHitPoints === 'number') return Math.max(1, data.overrideHitPoints);
  const base = typeof data.baseHitPoints === 'number' ? data.baseHitPoints : 0;
  const bonus = typeof data.bonusHitPoints === 'number' ? data.bonusHitPoints : 0;
  const conContribution = conScore !== undefined ? abilityMod(conScore) * totalLevel : 0;
  return Math.max(1, base + bonus + conContribution);
}

/**
 * Best-effort AC. DDB doesn't expose a flat AC, so we compute it from equipped armor:
 * highest-AC equipped body armor (light: +full Dex, medium: +Dex capped at 2, heavy: +0),
 * plus any equipped shields, falling back to unarmored `10 + Dex mod`. This is an
 * approximation (it ignores magical/feat AC bonuses we can't reliably attribute), but it
 * gives a sensible starting AC the DM can adjust rather than leaving it blank.
 */
export function computeArmorClass(data: DdbCharacterData, dexScore: number | undefined): number {
  const dexMod = dexScore !== undefined ? abilityMod(dexScore) : 0;
  const items = Array.isArray(data.inventory) ? data.inventory : [];
  let bestBody: { ac: number; typeId: number } | null = null;
  let shieldBonus = 0;
  for (const item of items) {
    if (!item?.equipped) continue;
    const def = item.definition;
    const ac = def && typeof def.armorClass === 'number' ? def.armorClass : null;
    const typeId = def && typeof def.armorTypeId === 'number' ? def.armorTypeId : null;
    if (ac === null || typeId === null) continue;
    if (typeId === 4) {
      // Shield — additive.
      shieldBonus += ac;
    } else if (bestBody === null || ac > bestBody.ac) {
      bestBody = { ac, typeId };
    }
  }
  let base: number;
  if (bestBody) {
    let dexPart = dexMod;
    if (bestBody.typeId === 2) dexPart = Math.min(dexMod, 2); // medium: cap +2
    else if (bestBody.typeId === 3) dexPart = 0; // heavy: no Dex
    base = bestBody.ac + dexPart;
  } else {
    base = 10 + dexMod; // unarmored
  }
  return base + shieldBonus;
}

/**
 * Best-effort character movement speed (issue #1985).
 * Resolves base walking speed from DDB's `customSpeeds` override or `race.weightSpeeds.normal.walk`,
 * plus speed/unarmored-movement modifiers, falling back to 30 when unstated.
 */
export function computeSpeed(data: DdbCharacterData): number | null {
  const custom = Array.isArray(data.customSpeeds)
    ? data.customSpeeds.find((s) => typeof s?.distance === 'number' && s.distance >= 0 && (s.movementId === 1 || s.movementId === 0 || s.movementId == null))
    : null;
  if (custom && typeof custom.distance === 'number' && Number.isFinite(custom.distance)) {
    return Math.max(0, Math.floor(custom.distance));
  }

  let baseSpeed: number | null = null;
  const raceWalk = data.race?.weightSpeeds?.normal?.walk;
  if (typeof raceWalk === 'number' && Number.isFinite(raceWalk) && raceWalk >= 0) {
    baseSpeed = raceWalk;
  }

  const mods = allModifiers(data);
  let bonus = 0;
  for (const m of mods) {
    const subType = typeof m.subType === 'string' ? m.subType.toLowerCase() : '';
    if (subType === 'speed' || subType === 'unarmored-movement' || subType === 'walking-speed' || subType === 'innate-speed') {
      if (m.type === 'set' && typeof m.value === 'number' && Number.isFinite(m.value) && m.value >= 0) {
        baseSpeed = m.value;
      } else if (m.type === 'bonus' && typeof m.value === 'number' && Number.isFinite(m.value)) {
        bonus += m.value;
      }
    }
  }

  const resolved = (baseSpeed ?? 30) + bonus;
  return Math.max(0, Math.floor(resolved));
}

/** Species/race display name. */
function computeSpecies(data: DdbCharacterData): string {
  const race = data.race;
  if (!race) return '';
  return (race.fullName ?? race.baseName ?? '').trim();
}

/** Background name (custom background name when the sheet uses one). */
function computeBackground(data: DdbCharacterData): string {
  const bg = data.background;
  if (!bg) return '';
  if (bg.hasCustomBackground && bg.customBackground?.name) return bg.customBackground.name.trim();
  return (bg.definition?.name ?? '').trim();
}

/** Save proficiencies from `proficiency`-type `<ability>-saving-throws` modifiers. */
function computeSaveProficiencies(mods: DdbModifier[]): CharacterCreateInput['saveProficiencies'] {
  const keys = new Set<'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA'>();
  for (const m of mods) {
    if (m.type !== 'proficiency' || typeof m.subType !== 'string') continue;
    if (!m.subType.endsWith('-saving-throws')) continue;
    const key = ABILITY_NAME_TO_KEY[m.subType.slice(0, -'-saving-throws'.length)];
    if (key) keys.add(key);
  }
  return [...keys];
}

/**
 * Skill proficiencies from `<skill>-skill` modifiers. `expertise` outranks `proficiency`
 * for the same skill. The DDB subType is kebab-case ("animal-handling", "sleight-of-hand");
 * we title-case it back into the display name Campfire stores.
 */
function computeSkills(mods: DdbModifier[]): Record<string, 'proficient' | 'expertise'> {
  const skills: Record<string, 'proficient' | 'expertise'> = {};
  for (const m of mods) {
    if (typeof m.subType !== 'string' || !m.subType.endsWith('-skill')) continue;
    const rank: 'proficient' | 'expertise' | null =
      m.type === 'expertise' ? 'expertise' : m.type === 'proficiency' ? 'proficient' : null;
    if (!rank) continue;
    const name = m.subType
      .slice(0, -'-skill'.length)
      .split('-')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' ');
    if (!name) continue;
    if (skills[name] !== 'expertise') skills[name] = rank; // don't downgrade expertise->proficient
  }
  return skills;
}

/**
 * Weapon training from `proficiency`-type `*-weapons` modifiers (issue #2144).
 *
 * D&D Beyond expresses weapon proficiency the same way it expresses skills and saves — a
 * modifier whose subType names what the character is proficient with: `simple-weapons`,
 * `martial-weapons`, and the melee/ranged splits some subclasses grant. Those go straight onto
 * the sheet, so an imported Fighter's equipped longsword derives its +proficiency instead of
 * arriving untrained.
 *
 * Only CATEGORY proficiencies are read. DDB also grants named-weapon proficiencies (an Elf's
 * longsword, a Rogue's hand crossbow) as a bare subType with no distinguishing suffix —
 * `longsword` sits in the same list as `thieves-tools`, `vehicles-land` and `dwarvish` — so
 * collecting them means either an SRD weapon allowlist this importer does not have or
 * importing tool and language proficiencies as weapons. Categories cover how nearly every 5e
 * character is armed; a named exception is one entry a player adds on the sheet, and an entry
 * that is missing costs a visible +0 the action's own notes explain, not a silent wrong number.
 */
function computeWeaponProficiencies(mods: DdbModifier[]): Record<string, 'proficient'> {
  const out: Record<string, 'proficient'> = {};
  for (const m of mods) {
    if (m.type !== 'proficiency' || typeof m.subType !== 'string') continue;
    if (!m.subType.endsWith('-weapons')) continue;
    // `simple-weapons` -> "simple"; `martial-melee-weapons` -> "martial melee". Stored as the
    // spaced form the sheet's own control offers, and matched case-insensitively either way.
    const category = m.subType.slice(0, -'-weapons'.length).split('-').filter(Boolean).join(' ');
    if (category) out[category] = 'proficient';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Combat payload (issue #1903) — attacks, spells, spell slots.
//
// Attacks/features reuse the SAME inference the compendium statblock importer already
// trusts for monsters (`expandRawStatblockAction` in @campfire/schema): a DDB entry is
// normalized into the generic `{name, desc, attackBonus, damage:[{expression,type}],
// savingThrow}` shape that function reads, so a cleanly-parseable entry gets a resolvable
// `spec` the same way a compendium monster's does, and an entry we can't confidently
// resolve degrades to a text-only action (name + notes, no spec) rather than being
// dropped or guessed at.
// ---------------------------------------------------------------------------

/** Standard 5e proficiency bonus by total level. */
function proficiencyBonusForLevel(level: number): number {
  return Math.floor((Math.max(1, level) - 1) / 4) + 2;
}

/** Render a signed flat modifier suffix ("+3", "-1", "" for 0) appended to a dice string. */
function flatSuffix(flat: number): string {
  if (flat === 0) return '';
  return flat > 0 ? `+${flat}` : String(flat);
}

/** The handful of HTML entities that actually turn up in DDB description text. */
const DDB_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Strip HTML markup from a DDB spell/feature description (issue #1903 review) — DDB's
 * public payload returns these as rendered HTML (`<p>…</p>`, `<strong>`, etc.), not plain
 * text, and the character sheet renders `notes` as a plain-text React node, so leaving the
 * markup in place shows literal tags to the DM/player. This is a small, targeted strip (not
 * a full HTML parser): drop tags, decode the common entities above (falling back to a
 * numeric `&#NN;`/`&#xNN;` reference when present), and collapse runs of whitespace left
 * behind by block-level tags — sufficient for the plain-prose descriptions DDB returns,
 * without pulling in an HTML-parsing dependency for it.
 */
function stripDdbHtml(html: string): string {
  const noTags = html.replace(/<[^>]*>/g, ' ');
  const decoded = noTags.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      // A malformed/out-of-range numeric reference (e.g. &#9999999;) is finite but outside
      // Unicode's 0..0x10FFFF range, and String.fromCodePoint throws RangeError for that —
      // which, uncaught, would abort the whole import with a 500 over one bad character in
      // a description. A lone surrogate (0xD800-0xDFFF) is inside that range so
      // fromCodePoint would NOT throw for it, but it would produce an unpaired surrogate —
      // invalid UTF-16 that can break JSON/UTF-8 encoding downstream — so it's excluded too.
      // Leave any of these as the original text instead of guessing at what was meant.
      const isValidCodePoint = Number.isFinite(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return isValidCodePoint ? String.fromCodePoint(code) : match;
    }
    // Object.hasOwn (not `DDB_HTML_ENTITIES[ref] ?? match`) because DDB_HTML_ENTITIES is a
    // plain object literal that inherits Object.prototype, and the regex above accepts any
    // [a-zA-Z]+ — untrusted sheet text containing "&constructor;", "&toString;",
    // "&valueOf;", "&hasOwnProperty;", etc. would otherwise resolve to an INHERITED function
    // (truthy, so `??` never falls back to `match`), which String.prototype.replace then
    // stringifies into the imported note as garbled text (e.g. "function Object() { [native
    // code] }") instead of leaving the unrecognized entity as written (review finding on PR
    // #1950 round 8).
    // Object.hasOwn (not `DDB_HTML_ENTITIES[ref] ?? match`) because DDB_HTML_ENTITIES is a
    // plain object literal that inherits Object.prototype, and the regex above accepts any
    // [a-zA-Z]+ — untrusted sheet text containing "&constructor;", "&toString;",
    // "&valueOf;", "&hasOwnProperty;", etc. would otherwise resolve to an INHERITED function
    // (truthy, so `??` never falls back to `match`), which String.prototype.replace then
    // stringifies into the imported note as garbled text (e.g. "function Object() { [native
    // code] }") instead of leaving the unrecognized entity as written (review finding on PR
    // #1950 round 8).
    return Object.hasOwn(DDB_HTML_ENTITIES, ref) ? DDB_HTML_ENTITIES[ref] : match;
  });
  // Collapse whitespace, then drop a space a closing inline tag leaves immediately before
  // punctuation ("creature</strong>." -> "creature ." -> "creature.") — cosmetic, but this
  // pattern ("<strong>word</strong>.") is common enough in DDB's markup to be worth it.
  return decoded
    .replace(/\s+/g, ' ')
    .replace(/ ([.,;:!?])/g, '$1')
    .trim();
}

function isWeaponItem(item: DdbInventoryItem): boolean {
  const def = item.definition;
  if (!def) return false;
  const filterType = typeof def.filterType === 'string' ? def.filterType.toLowerCase() : '';
  const type = typeof def.type === 'string' ? def.type.toLowerCase() : '';
  return filterType === 'weapon' || type === 'weapon';
}

/** STR unless the weapon is ranged (DEX) or Finesse (better of STR/DEX). */
function weaponAbilityKey(def: NonNullable<DdbInventoryItem['definition']>, stats: Record<string, number>): 'STR' | 'DEX' {
  const finesse = Array.isArray(def.properties) && def.properties.some((p) => typeof p?.name === 'string' && p.name.toLowerCase() === 'finesse');
  const ranged = def.attackType === 2;
  if (finesse) {
    const str = stats.STR ?? 10;
    const dex = stats.DEX ?? 10;
    return dex > str ? 'DEX' : 'STR';
  }
  return ranged ? 'DEX' : 'STR';
}

/**
 * Classes with a well-documented core-rules feature letting them attack with a weapon
 * using an ability OTHER than the RAW default (issue #1903 review) — Monk (Martial Arts:
 * STR or DEX with monk weapons/unarmed), Warlock (Hex Warrior invocation: CHA with a
 * chosen weapon), Artificer (Battle Smith's Battle Ready: INT with any weapon while
 * holding their spellcasting focus). None of these are reliably detectable from the
 * simplified item/character shape read here (which monk weapons the sheet has, whether
 * Hex Warrior/Battle Smith was actually taken), so `weaponAbilityKey`'s STR default for a
 * non-finesse, non-ranged weapon is NOT trustworthy for these classes specifically — unlike
 * a generic Fighter/Barbarian/etc., where STR-by-default is the safe, RAW-correct read.
 */
const AMBIGUOUS_MELEE_ABILITY_CLASSES = new Set(['monk', 'warlock', 'artificer']);

function hasAmbiguousMeleeAbilityClass(classes: DdbClass[] | null | undefined): boolean {
  if (!Array.isArray(classes)) return false;
  return classes.some((c) => AMBIGUOUS_MELEE_ABILITY_CLASSES.has((c.definition?.name ?? '').trim().toLowerCase()));
}

/**
 * Classes with full simple + martial weapon proficiency (issue #1903 review, PR #1950 round
 * 8 finding) — the only classes for which "the character is proficient with whatever weapon
 * they equipped" is a safe RAW default. D&D Beyond's item builder does NOT restrict equipping
 * to weapons the character is proficient with (a Wizard can equip and show a longsword as
 * equipped), so unconditionally adding the proficiency bonus for every class — this
 * function's previous behavior — silently over-counted the to-hit for any class without
 * full martial proficiency. Every other class has partial (simple-weapons-only) or
 * specific-named-list (Rogue/Bard/Monk's short exception lists) proficiency that this
 * importer has no confirmed, reliably-shaped sheet field to verify per equipped weapon, so
 * for those classes a weapon goes text-only instead of guessing proficiency either way. A
 * multiclassed character keeps every proficiency any of their classes ever granted (5e
 * multiclassing never removes an earlier class's proficiencies), so this checks ALL of the
 * character's classes, not just the first/primary one.
 */
const FULL_MARTIAL_PROFICIENCY_CLASSES = new Set(['barbarian', 'fighter', 'paladin', 'ranger']);

function hasFullMartialWeaponProficiency(classes: DdbClass[] | null | undefined): boolean {
  if (!Array.isArray(classes)) return false;
  return classes.some((c) => FULL_MARTIAL_PROFICIENCY_CLASSES.has((c.definition?.name ?? '').trim().toLowerCase()));
}

/**
 * DDB `bonus`-type modifier subTypes that add to weapon attack rolls or damage which this
 * importer's ability-mod + proficiency math (below) has no way to read (issue #1903 review,
 * PR #1950 finding) — most commonly a Fighting Style (Archery: +2 to ranged attack rolls;
 * Dueling: +2 to melee damage) but also some feat/item bonuses phrased the same way in the
 * sheet's modifiers. Same "never fabricate a resolvable spec" principle as the magic-weapon,
 * missing-ability-score, and ambiguous-melee-ability cases: when one of these is present,
 * the affected weapon(s) go text-only instead of a resolvable-but-silently-incomplete
 * to-hit/damage number.
 */
const MELEE_WEAPON_BONUS_SUBTYPES = new Set(['melee-attacks', 'melee-damage', 'weapon-attacks', 'weapon-damage']);
const RANGED_WEAPON_BONUS_SUBTYPES = new Set(['ranged-attacks', 'ranged-damage', 'weapon-attacks', 'weapon-damage']);

/** Whether any `bonus` modifier grants an unmodeled melee and/or ranged weapon attack/damage bonus. */
function weaponBonusModifierFlags(mods: DdbModifier[]): { melee: boolean; ranged: boolean } {
  let melee = false;
  let ranged = false;
  for (const m of mods) {
    if (m.type !== 'bonus' || typeof m.subType !== 'string' || typeof m.value !== 'number' || m.value === 0) continue;
    if (MELEE_WEAPON_BONUS_SUBTYPES.has(m.subType)) melee = true;
    if (RANGED_WEAPON_BONUS_SUBTYPES.has(m.subType)) ranged = true;
  }
  return { melee, ranged };
}

/**
 * Equipped-weapon attacks (issue #1903). Reuses `expandRawStatblockAction` for the
 * attack/damage inference, mirroring how a compendium monster's weapon attacks are
 * expanded.
 *
 * Proficiency is only assumed for a class with full simple + martial proficiency (see
 * {@link hasFullMartialWeaponProficiency}) — D&D Beyond's item builder lets any class equip
 * any weapon regardless of proficiency (review finding on PR #1950 round 8, correcting an
 * earlier, incorrect assumption in this comment that equipping already implied
 * proficiency), so blanket-including the proficiency bonus for every class would over-count
 * the to-hit for e.g. a Wizard wielding a martial weapon they aren't trained with.
 *
 * A `magic:true` weapon (a +1/+2/+3 item, or one with a rarer nonstandard bonus) is
 * deliberately excluded from this to-hit/damage math: the simplified item shape read here
 * carries no reliable numeric bonus field (unlike `magic`'s boolean, DDB does not expose a
 * flat "+N" anywhere consistently shaped across sheets), so computing mundane numbers for
 * it would silently under-report a magic weapon's real bonus — the exact "silent fallback
 * math" this importer avoids elsewhere. It lands as a text-only action instead (never
 * dropped, flagged in the summary) so the DM adds the enchantment bonus by hand. A weapon
 * affected by an unmodeled Fighting-Style-shaped attack/damage bonus modifier (see
 * {@link weaponBonusModifierFlags}) degrades the same way, for the same reason.
 */
function computeWeaponActions(data: DdbCharacterData, stats: Record<string, number>, proficiencyBonus: number): CharacterActionType[] {
  const items = Array.isArray(data.inventory) ? data.inventory : [];
  const ambiguousMeleeAbility = hasAmbiguousMeleeAbilityClass(data.classes);
  const weaponBonusFlags = weaponBonusModifierFlags(allModifiers(data));
  const fullMartialProficiency = hasFullMartialWeaponProficiency(data.classes);
  const out: CharacterActionType[] = [];
  for (const item of items) {
    if (out.length >= RAW_ENTRY_SAFETY_CAP) break;
    if (!item?.equipped || !isWeaponItem(item)) continue;
    const def = item.definition;
    if (!def) continue;
    const name = typeof def.name === 'string' && def.name.trim() ? def.name.trim() : 'Weapon';
    if (def.magic === true) {
      out.push(
        expandRawStatblockAction(
          { name, desc: 'Magic weapon — add its enchantment bonus to attack and damage manually; not inferred from the import.', attackBonus: null },
          'attack',
          'dnd5e',
        ),
      );
      continue;
    }
    if (!fullMartialProficiency) {
      // Weapon proficiency can't be confirmed for this class from the sheet shape this
      // importer reads (see hasFullMartialWeaponProficiency) — do not assume proficiency
      // (which would over-count the to-hit for a non-proficient weapon) or assume its
      // absence (which would under-count for a weapon the character legitimately trained
      // with). Leave text-only rather than guessing either way.
      out.push(
        expandRawStatblockAction(
          { name, desc: "This class's proficiency with this weapon could not be confirmed — check whether the attack bonus should include proficiency.", attackBonus: null },
          'attack',
          'dnd5e',
        ),
      );
      continue;
    }
    if (def.attackType !== 1 && def.attackType !== 2) {
      // A weapon with no recognized melee/ranged `attackType` (a sparse or changed DDB
      // payload) must not silently default to melee — `weaponAbilityKey` (STR unless
      // `attackType === 2`) and the Fighting-Style bonus-flag check just below
      // (`isRangedWeapon = attackType === 2`) both treat any unrecognized value as melee, so
      // e.g. a bow with a missing `attackType` could import as a resolvable STR attack while
      // silently dropping an Archery-style ranged bonus (review finding on PR #1950 round
      // 16). Leave text-only rather than guessing the attack shape.
      out.push(
        expandRawStatblockAction(
          { name, desc: 'This weapon has no recognized melee/ranged attack type on the sheet — check attack bonus and damage manually.', attackBonus: null },
          'attack',
          'dnd5e',
        ),
      );
      continue;
    }
    const isRangedWeapon = def.attackType === 2;
    if (isRangedWeapon ? weaponBonusFlags.ranged : weaponBonusFlags.melee) {
      // A Fighting Style or similar bonus modifier applies to this weapon's attack/damage
      // (see MELEE_/RANGED_WEAPON_BONUS_SUBTYPES) but isn't incorporated into the math
      // below — leave it text-only rather than silently under-reporting to-hit/damage.
      out.push(
        expandRawStatblockAction(
          {
            name,
            desc: 'This character has a weapon attack or damage bonus (e.g. a Fighting Style) not applied here — check attack bonus and damage manually.',
            attackBonus: null,
          },
          'attack',
          'dnd5e',
        ),
      );
      continue;
    }
    const abilityKey = weaponAbilityKey(def, stats);
    const abilityScore = stats[abilityKey];
    const rawWeaponDiceString = def.damage && typeof def.damage.diceString === 'string' ? def.damage.diceString.trim() : '';
    // Validated the same way as `computeFeatureActions`' dice string (review finding on PR
    // #1950 round 15) — a non-standard/garbage `diceString` (e.g. "2d7") would otherwise still
    // build a resolvable-looking attack whose formula only fails when the resolver actually
    // rolls it, and an over-60-char string would make `ActionSpec.parse` throw an uncaught
    // ZodError, aborting the whole import (`DamagePart.formula` is `z.string().max(60)`).
    let diceString = '';
    if (rawWeaponDiceString) {
      try {
        parseDiceExpr(rawWeaponDiceString);
        diceString = rawWeaponDiceString;
      } catch {
        diceString = '';
      }
    }
    // `DamagePart.type` is `z.string().max(24)` — an implausibly long `damageType` string
    // would also throw at `ActionSpec.parse` (same review finding). Real DDB damage types are
    // short English words ("Slashing", "Piercing", …), so the length bound is defensive
    // rather than an expected real-world case. A MISSING or over-long damage type is treated
    // as unusable, not merely bounded to `''` (review finding on PR #1950 round 16): the
    // resolver treats an empty `DamagePart.type` as untyped and never applies target
    // resistance/immunity, so a resolvable spec with `type: ''` would let an imported sword's
    // damage silently bypass slashing (etc.) defenses while never being flagged in
    // `summary.textOnly`.
    const rawDamageType = typeof def.damageType === 'string' ? def.damageType.trim().toLowerCase() : '';
    const damageTypeValid = rawDamageType.length > 0 && rawDamageType.length <= 24;
    const damageType = damageTypeValid ? rawDamageType : '';
    if (typeof abilityScore !== 'number') {
      // Same "never fabricate a resolvable spec" principle as the magic-weapon and
      // feature-action cases: a missing governing ability score must not silently default
      // to modifier 0 and stay resolvable — that's a guessed to-hit presented as real.
      out.push(
        expandRawStatblockAction(
          { name, desc: 'Missing ability score data — check attack bonus and damage manually.', attackBonus: null },
          'attack',
          'dnd5e',
        ),
      );
      continue;
    }
    if (abilityKey === 'STR' && ambiguousMeleeAbility) {
      // weaponAbilityKey only returns 'STR' here because the weapon is neither Finesse nor
      // ranged — the RAW default. For Monk/Warlock/Artificer specifically that default is
      // not safe to assume (see AMBIGUOUS_MELEE_ABILITY_CLASSES) — leave text-only rather
      // than presenting a plausibly-wrong ability as a confident number.
      out.push(
        expandRawStatblockAction(
          { name, desc: 'This class can attack with an alternate ability for some weapons — check attack bonus and damage manually.', attackBonus: null },
          'attack',
          'dnd5e',
        ),
      );
      continue;
    }
    if (!diceString || !damageTypeValid) {
      // A weapon with no damage dice at all (issue #1903 review, round 11) — most notably the
      // net, or any weapon whose sheet omits `definition.damage` — would otherwise still get a
      // resolvable attack spec with an empty `outcomes` object: rolling it hits but applies no
      // damage, silently losing whatever non-damage effect the real weapon has (the net
      // restrains on a hit). Leave it text-only instead of presenting a to-hit-only action as
      // a confident, complete resolution of the weapon's real effect. An invalid die notation
      // (round 15, `rawWeaponDiceString` was non-empty but failed `parseDiceExpr`) reaches
      // this same branch (`diceString` is reset to `''` above), covering both cases. A
      // missing or over-long damage type (round 16, see the `damageTypeValid` comment above)
      // reaches this same branch too — resolving with an untyped damage part would silently
      // skip resistance/immunity, which is no more trustworthy than resolving with no damage.
      out.push(
        expandRawStatblockAction(
          {
            name,
            desc: !diceString
              ? 'This weapon has no usable damage dice on the sheet — check its real effect and resolve manually.'
              : 'This weapon has no usable damage type on the sheet — check its real effect and resolve manually (damage-based resistance/immunity would otherwise be skipped).',
            attackBonus: null,
          },
          'attack',
          'dnd5e',
        ),
      );
      continue;
    }
    const abilityModifier = abilityMod(abilityScore);
    const attackBonus = abilityModifier + proficiencyBonus;
    const damage = [{ expression: `${diceString}${flatSuffix(abilityModifier)}`, type: damageType }];
    out.push(expandRawStatblockAction({ name, desc: '', attackBonus, damage }, 'attack', 'dnd5e'));
  }
  return out;
}

const ACTION_SECTIONS = ['class', 'race', 'background', 'item', 'feat'] as const;

/**
 * Map a DDB feature's `activation.activationType` to the `expandRawStatblockAction` source
 * that determines its `spec.cost.slot` (issue #1903 review, PR #1950 finding): this used to
 * be hardcoded to `'action'` for every feature regardless of activation, so an imported
 * reaction (e.g. a Fighter subclass's free interrupt, "Uncanny Dodge"-shaped features) or
 * bonus-action feature would consume the actor's ACTION when resolved in an encounter,
 * leaving the real action-economy slot untouched — `turnState.used['action']` bumps instead
 * of `turnState.used['bonus']`/`['reaction']` (see `action-resolver.service.ts`). Only 3
 * (Bonus Action) and 4 (Reaction) are mapped; every other DDB activation type (1 action,
 * 2 no action, 5 minute, 6 hour, 7 special, 8 legendary) or a missing/unrecognized value
 * keeps the previous, correct-for-those-cases 'action' default.
 */
function featureActionSource(item: DdbActionEntry): 'action' | 'bonus' | 'reaction' | null {
  const activationType = item.activation?.activationType;
  if (activationType === 1) return 'action';
  if (activationType === 3) return 'bonus';
  if (activationType === 4) return 'reaction';
  // 2 (no action), 5 (minute), 6 (hour), 7 (special), 8 (legendary), or a missing/unrecognized
  // value have no action-economy slot this importer can represent correctly (review finding
  // on PR #1950 round 7's own activation-economy fix) — forcing any of them into the ordinary
  // 'action' slot would make resolving the feature consume a resource the source feature
  // doesn't actually cost. Returning null tells the caller to force this entry text-only
  // instead of guessing a slot.
  return null;
}

/**
 * Class/race/background/item/feat actions and features (issue #1903) — "Second Wind",
 * "Unarmed Strike", "Stunning Strike", a racial breath weapon, etc. An entry with
 * `attackTypeRange` set is attack-shaped (to-hit from its governing ability + proficiency);
 * one with `fixedSaveDc` is save-shaped; anything else lands as a text-only feature —
 * never dropped, always visible in the returned import summary.
 */
function computeFeatureActions(data: DdbCharacterData, stats: Record<string, number>, proficiencyBonus: number): CharacterActionType[] {
  const groups = data.actions;
  const out: CharacterActionType[] = [];
  if (!groups || typeof groups !== 'object') return out;
  for (const section of ACTION_SECTIONS) {
    const list = groups[section];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (out.length >= RAW_ENTRY_SAFETY_CAP) return out;
      const item = raw ?? {};
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) continue;
      // `snippet` is DDB's short plain-text summary; the `description` fallback is full HTML
      // markup, so stripDdbHtml is a no-op on the former and a real fix on the latter. Both
      // branches are typeof-guarded (review finding on PR #1950 round 12) — a sparse/changed
      // sheet whose `description` is a number or object (not a string) would otherwise reach
      // `stripDdbHtml`'s `html.replace(...)` and throw a TypeError, aborting the whole import
      // over one oddly-shaped field. `computeSpellActions` already guards this correctly;
      // this mirrors it.
      const rawDesc = typeof item.snippet === 'string' && item.snippet.trim() ? item.snippet : item.description;
      const desc = stripDdbHtml(typeof rawDesc === 'string' ? rawDesc : '');
      // A missing/unrecognized abilityModifierStatId, or a governing ability score that
      // isn't in `stats`, must NOT fall back to a modifier of 0 — that would present a
      // GUESSED to-hit as a confident, resolvable number (and the summary would never flag
      // it, since it has a `spec`). Leave attackBonus null so it lands text-only instead.
      let attackBonus: number | null = null;
      // Kept alongside attackBonus (review finding on PR #1950 round 14) — DDB's `dice`
      // field for an attack-shaped feature (an unarmed strike, martial-arts strike, etc.)
      // does NOT include the governing ability modifier; the sheet renders e.g. "1d6+3" by
      // combining `dice` with `abilityModifierStatId` separately, the same convention
      // `computeWeaponActions` already accounts for (its damage expression folds in
      // `abilityModifier` explicitly). Without also folding it in here, an imported
      // attack-shaped feature's to-hit was correct but its damage was short by the ability
      // modifier.
      let abilityModifier: number | null = null;
      if (item.attackTypeRange != null) {
        const abilityKey = item.abilityModifierStatId != null ? ABILITY_ID_TO_KEY[item.abilityModifierStatId] : undefined;
        const abilityScore = abilityKey ? stats[abilityKey] : undefined;
        if (typeof abilityScore === 'number') {
          abilityModifier = abilityMod(abilityScore);
          attackBonus = abilityModifier + proficiencyBonus;
        }
      }
      const rawDiceString = item.dice && typeof item.dice.diceString === 'string' ? item.dice.diceString.trim() : '';
      // A malformed die notation (e.g. "2d7" — a real-shaped-but-nonexistent die, or
      // arbitrary text) passes `DamagePart.formula`'s plain `z.string().max(60)` schema
      // untouched, so the entry was still marked resolvable and never flagged in
      // `summary.textOnly` — it only fails later at 400 when the resolver's `rollDice`
      // actually tries to roll it (review finding on PR #1950 round 14). Validate against
      // the SAME grammar the resolver enforces (`parseDiceExpr`, apps/server/src/common/
      // dice.ts) rather than inventing a separate check that could drift from it.
      let invalidDice = false;
      let diceString = '';
      if (rawDiceString) {
        try {
          parseDiceExpr(rawDiceString);
          diceString = rawDiceString;
        } catch {
          invalidDice = true;
        }
      }
      // `DamagePart.flat` (packages/schema/src/action-resolver.ts) is
      // `z.number().int().min(-999).max(999)` — a sparse/malformed sheet's flat `value` of
      // e.g. 1000 would reach `ActionSpec.parse` unvalidated and throw an uncaught ZodError,
      // aborting the whole import; a fractional value instead gets embedded into the dice
      // EXPRESSION as an opaque string ("1d8+1.5"), which passes schema validation (formula
      // is just a string) but fails only later when the action is actually used (review
      // finding on PR #1950 round 13). Validate before using it — an out-of-range or
      // non-integer value forces the whole entry text-only below rather than crashing or
      // silently embedding a broken formula.
      const rawFlat = item.value;
      const invalidFlat = typeof rawFlat === 'number' && (!Number.isInteger(rawFlat) || rawFlat < -999 || rawFlat > 999);
      const flat = (typeof rawFlat === 'number' && !invalidFlat ? rawFlat : 0) + (attackBonus !== null ? (abilityModifier ?? 0) : 0);
      // `invalidFlat` only checks the RAW `item.value` against `DamagePart.flat`'s
      // `min(-999).max(999)` bound, but the COMBINED `flat` above (raw value + ability
      // modifier) is what actually reaches that schema after `damagePartsFrom` re-parses the
      // expression built below — an in-range raw value (e.g. 999) plus a nonzero ability
      // modifier can still push the sum out of range and throw an uncaught ZodError that
      // aborts the whole import (review finding on PR #1950 round 16). Validate the sum too.
      const flatOutOfRange = flat < -999 || flat > 999;
      // An attack-shaped feature with no representable outcome — no dice at all (e.g. a
      // grapple/stun/control feature), an invalid die notation, or a flat value that failed
      // validation above — would otherwise still get a resolvable spec with EMPTY outcomes:
      // using it spends the action and rolls to-hit but applies nothing (review finding on
      // PR #1950 round 13, the feature-level counterpart to round 11's weapon fix). Force
      // text-only instead. A save-shaped feature with the same gap is handled symmetrically
      // below (round 15 — see that comment for why "many conditions have no damage" isn't a
      // good enough reason to keep it resolvable).
      //
      // A missing/unrecognized damage type reaches this same branch (issue #1958): the damage
      // part below used to be hardcoded to `type: ''`, and `applyDamageModifiers` skips target
      // resistance/immunity/vulnerability entirely for an empty type, so the feature resolved
      // at full damage against a creature that resists it and was never flagged in
      // `summary.textOnly`. `computeWeaponActions` already refuses to resolve an untyped weapon
      // for exactly this reason (round 16); features now match, sourcing the type from DDB's
      // own `damageTypeId` (see DDB_DAMAGE_TYPE_ID_TO_NAME) instead of inventing one.
      const damageType = featureDamageTypeName(item);
      if (attackBonus !== null && (!diceString || invalidFlat || flatOutOfRange || !damageType)) {
        attackBonus = null;
      }
      const damage =
        // `expandRawStatblockAction` also turns this list into the visible `CharacterAction.damage`
        // string / roll chip. Keep a validated dice expression for a text-only healing or utility
        // feature that has no `damageTypeId` (for example Second Wind); the missing-type gates
        // above and below have already cleared `attackBonus` / `savingThrow`, so this empty type
        // can never enter a resolvable spec or bypass damage modifiers.
        diceString && !invalidFlat && !flatOutOfRange
          ? [{ expression: `${diceString}${flatSuffix(flat)}`, type: damageType }]
          : undefined;
      // Same principle for a save DC: a missing/unrecognized saveStatId must not default to
      // DEX — that's inventing which ability the target saves with, which resolution would
      // then roll against silently. No resolvable ability -> no savingThrow -> text-only.
      //
      // The "no save" value here is explicit `null`, not `undefined` (review finding on PR
      // #1950 round 10): `expandRawStatblockAction` -> `savingThrowFrom` falls back to
      // scanning the free-text `desc` for a "DC N Ability" phrase when no explicit save is
      // given, and DDB feature descriptions very commonly contain exactly that phrasing —
      // "...must make a DC 13 Dexterity saving throw...". An `undefined` here would let that
      // description-text scan silently resurrect a resolvable (and wrongly action-economy-
      // costed) save spec for an entry this importer has deliberately decided is unresolvable.
      // `savingThrowFrom` treats explicit `null` as "do not infer at all."
      const saveAbilityKey = item.saveStatId != null ? ABILITY_ID_TO_KEY[item.saveStatId] : undefined;
      // `ActionSpec`'s fixed-DC schema (packages/schema/src/action-resolver.ts) is
      // `z.number().int().min(1).max(60)` — a sparse/malformed sheet's `fixedSaveDc` of `0`,
      // `61`, or a non-integer like `12.5` would otherwise reach `ActionSpec.parse` inside
      // `expandRawStatblockAction` and throw an uncaught ZodError, aborting the ENTIRE import
      // over one bad feature (review finding on PR #1950 round 11) — the same class of crash
      // fixed for out-of-range HTML entities in round 4. Validate the range here too, before
      // treating the DC as confidently resolved.
      const validFixedSaveDc =
        typeof item.fixedSaveDc === 'number' && Number.isInteger(item.fixedSaveDc) && item.fixedSaveDc >= 1 && item.fixedSaveDc <= 60
          ? item.fixedSaveDc
          : null;
      let savingThrow: { dc: number; ability: string } | null =
        validFixedSaveDc !== null && saveAbilityKey ? { dc: validFixedSaveDc, ability: saveAbilityKey } : null;
      // Same principle a third time for action economy (review finding on PR #1950 round 8):
      // an activation type this importer can't map to a real action-economy slot (see
      // featureActionSource) must not silently spend the actor's ordinary action either —
      // force the whole entry text-only rather than resolve it against the wrong resource.
      const source = featureActionSource(item);
      if (source === null) {
        attackBonus = null;
        savingThrow = null;
      }
      // A fourth "can't confidently represent this" case (review finding on PR #1950 round
      // 12): a limited-use resource pool this importer has no mapping for. Force text-only
      // rather than presenting the feature as freely, unlimitedly resolvable.
      if (hasUnmappedLimitedUse(item)) {
        attackBonus = null;
        savingThrow = null;
      }
      // A save-shaped feature carrying a flat value that failed the DamagePart validation
      // above (review finding on PR #1950 round 13), a combined flat that overflows once the
      // ability modifier is folded in (round 16), an invalid die notation (round 14), or no
      // damage dice at all (round 15 — CORRECTING round 13/14's own reasoning here, which
      // argued a save-shaped feature with no damage should stay resolvable since "many
      // conditions/effects legitimately have no damage component"; the flaw in that argument
      // is that `expandRawStatblockAction`'s save branch has no way to encode a non-damage
      // effect either — `outcomes` is simply `{}` when there's no damage — so the "resolvable"
      // spec rolls the save and then does nothing, identical in kind to the outcome-free
      // attack case round 13 already forces text-only) must not resolve — a save spec with no
      // representable outcome, or one paired with a broken damage expression, would either
      // silently under-deliver or embed the same crash/broken-formula risk described above.
      // A missing/unrecognized `damageTypeId` (issue #1958) joins the same list: a save-for-half
      // spec whose damage is untyped bypasses the target's resistance/immunity on both the
      // failure and the halved-success branch, so it is no more trustworthy than one carrying a
      // broken damage expression. Symmetric with the attack-shaped gate above.
      if (invalidFlat || flatOutOfRange || invalidDice || !diceString || !damageType) {
        savingThrow = null;
      }
      // A feature that is BOTH attack-shaped (attackTypeRange resolved to a real
      // attackBonus) AND save-shaped (a valid fixedSaveDc/saveStatId also resolved) at once
      // — e.g. an on-hit maneuver followed by a saving throw — cannot be faithfully
      // represented here: `expandRawStatblockAction` always builds its ATTACK branch first
      // whenever `attackBonus !== null`, silently discarding the save entirely. With usable
      // damage dice this still looked fully resolvable and was never flagged in
      // `summary.textOnly`, even though using it would never actually roll the required save
      // (review finding on PR #1950 round 17). There is no "attack, then also a save"
      // outcome shape in `ActionSpec` today, so force the whole entry text-only rather than
      // silently keep only one of the two mechanics.
      if (attackBonus !== null && savingThrow !== null) {
        attackBonus = null;
        savingThrow = null;
      }
      out.push(
        expandRawStatblockAction(
          { name, desc, attackBonus, damage, savingThrow, noSaveInference: savingThrow === null },
          source ?? 'action',
          'dnd5e',
        ),
      );
    }
  }
  return out;
}

function isWizardClass(data: DdbCharacterData, characterClassId?: number | null): boolean {
  const classes = Array.isArray(data.classes) ? data.classes : [];
  if (classes.length === 0) return false;

  if (characterClassId != null) {
    const matched = classes.find(
      (c) => c.id === characterClassId || c.characterClassId === characterClassId,
    );
    if (matched) {
      return matched.definition?.name?.toLowerCase() === 'wizard';
    }
  }

  if (classes.length === 1) {
    return classes[0].definition?.name?.toLowerCase() === 'wizard';
  }

  return false;
}

/** True unless a prepared caster's entry explicitly marks the spell unprepared (except unprepared Wizard rituals). */
function isKnownOrPrepared(entry: DdbSpellEntry, isWizard = false): boolean {
  if (entry.prepared !== false) return true;
  return isWizard && Boolean(entry.definition?.ritual);
}

/**
 * Known/prepared/granted spells (issue #1903) — `kind:'spell'` rows carrying
 * `spec.uses.spellLevel` so the imported PC's slots track correctly against them (0 for a
 * cantrip, matching {@link ActionUses}'s "0 = none / cantrip / non-spell" convention).
 * Attack/save math for spells is intentionally NOT inferred here (the DDB fields for a
 * spell's target save ability are not reliably shaped across sheets) — every imported spell
 * keeps its full description as notes and is enumerated in the summary rather than guessed.
 */
function computeSpellActions(data: DdbCharacterData): CharacterActionType[] {
  const out: CharacterActionType[] = [];
  const seen = new Set<string>();
  const pushEntry = (entry: DdbSpellEntry | null | undefined, isWizard: boolean) => {
    if (!entry || out.length >= RAW_ENTRY_SAFETY_CAP) return;
    if (!isKnownOrPrepared(entry, isWizard)) return;
    const def = entry.definition;
    // Clamp to CharacterAction's 120-char name cap (mirrors expandRawStatblockAction) so an
    // unusually long DDB spell name can never abort the whole import with a Zod throw.
    const name = typeof def?.name === 'string' ? def.name.trim().slice(0, 120) : '';
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const rawLevel = def?.level;
    // `ActionUses.spellLevel` (packages/schema/src/action-resolver.ts) is a plain
    // `z.number().int().min(0).max(9).default(0)` — it has no "unknown" representation, and
    // 0 means a real, specific thing: a free cantrip that never costs a slot. A missing or
    // out-of-range `definition.level` must NOT silently become 0 — that would misrepresent a
    // sparse/malformed sheet's leveled spell as a cantrip, which (if the action were ever
    // given a resolvable mode by hand) could be cast for free (review finding on PR #1950
    // round 8). When the level can't be confirmed, omit `spec` entirely instead — the spell
    // still imports (name + notes, always visible in the summary), just without spellLevel
    // usage tracking, consistent with every other "can't confirm it -> text-only" case here.
    // `spellLevel`'s schema is also `.int()` (review finding on PR #1950 round 12) — a
    // fractional level like `1.5` passed the range check above but failed Zod's integer
    // constraint inside `CharacterAction.parse`, throwing an uncaught ZodError that aborted
    // the whole import instead of degrading just this spell to text-only as intended.
    const level = typeof rawLevel === 'number' && Number.isInteger(rawLevel) && rawLevel >= 0 && rawLevel <= 9 ? rawLevel : null;
    const desc = stripDdbHtml(typeof def?.description === 'string' ? def.description : '');
    const tags = [def?.ritual ? 'Ritual.' : '', def?.concentration ? 'Concentration.' : ''].filter(Boolean);
    const notes = [...tags, desc].join(' ').trim().slice(0, 500);
    out.push(
      CharacterAction.parse({
        name,
        kind: 'spell',
        notes,
        ...(level !== null ? { spec: { uses: { spellLevel: level, concentration: Boolean(def?.concentration) } } } : {}),
      }),
    );
  };
  for (const group of Array.isArray(data.classSpells) ? data.classSpells : []) {
    const isWizard = isWizardClass(data, group?.characterClassId);
    for (const entry of Array.isArray(group?.spells) ? group.spells : []) pushEntry(entry, isWizard);
  }
  const granted = data.spells;
  if (granted && typeof granted === 'object') {
    for (const [section, list] of Object.entries(granted)) {
      const isWizard = section === 'class' && isWizardClass(data, null);
      if (Array.isArray(list)) for (const entry of list) pushEntry(entry, isWizard);
    }
  }
  return out;
}

type CasterProgression = 'full' | 'half' | 'halfRoundUp' | 'pact' | 'third';
const FULL_CASTER_CLASSES = new Set(['bard', 'cleric', 'druid', 'sorcerer', 'wizard']);
const HALF_CASTER_CLASSES = new Set(['paladin', 'ranger']);
// Artificer (Tasha's) tracks the same ceil(level/2) curve as a solo Paladin/Ranger when it
// is the character's only caster class, BUT — unlike Paladin/Ranger — it ALSO rounds up
// (not down) when combined with another spellcasting class: Sage Advice/Tasha's errata is
// explicit that Artificer multiclass levels are "half your Artificer level, rounded up",
// the opposite of the Paladin/Ranger multiclass rule. So it gets its own progression tag
// rather than sharing HALF_CASTER_CLASSES — see the solo-vs-multiclass branch below.
const HALF_CASTER_ROUND_UP_CLASSES = new Set(['artificer']);
const PACT_CASTER_CLASSES = new Set(['warlock']);
// The only two core-rules 1/3-caster archetypes; identified by subclass, not base class,
// since Fighter/Rogue themselves are non-casters.
const THIRD_CASTER_SUBCLASSES = new Set(['eldritch knight', 'arcane trickster']);

function casterProgressionForClass(name: string, subclassName?: string | null): CasterProgression | null {
  const key = name.trim().toLowerCase();
  if (FULL_CASTER_CLASSES.has(key)) return 'full';
  if (HALF_CASTER_CLASSES.has(key)) return 'half';
  if (HALF_CASTER_ROUND_UP_CLASSES.has(key)) return 'halfRoundUp';
  if (PACT_CASTER_CLASSES.has(key)) return 'pact';
  const sub = subclassName?.trim().toLowerCase();
  if (sub && THIRD_CASTER_SUBCLASSES.has(sub)) return 'third';
  return null;
}

/**
 * PHB multiclass spellcaster slot table (index = combined effective caster level 0-20,
 * columns = spell levels 1-9). When COMBINING two or more caster classes, full casters
 * contribute their whole level, half casters (Paladin/Ranger) floor(level/2), and third
 * casters (Eldritch Knight/Arcane Trickster) floor(level/3) — standard 5e multiclassing
 * math (PHB p.165). Artificer is the one exception to "half caster floors when combined":
 * per Tasha's/Sage Advice it rounds UP (ceil(level/2)) whether solo or multiclassed — see
 * HALF_CASTER_ROUND_UP_CLASSES.
 *
 * A character with exactly ONE caster class in this table (Warlock/Pact Magic is not
 * modeled by this table at all — see the doc comment on {@link computeSpellSlots}) does not
 * use the combining formula for Paladin/Ranger/third
 * casters: their own class table applies, which for a half caster is equivalent to this
 * full-caster table read at ceil(level/2), and for a third caster at ceil(level/3)
 * (verified against the PHB Paladin/Ranger tables and the Eldritch Knight/Arcane Trickster
 * tables respectively — e.g. a level-5 solo Paladin gets 4 first + 2 second, not the
 * multiclass floor(5/2)=2 row's 3 first only). {@link computeSpellSlots} picks floor vs.
 * ceil based on whether more than one non-Warlock caster class is present.
 */
const FULL_CASTER_SLOT_TABLE: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 2, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 3, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 4, 2, 0, 0, 0, 0, 0, 0, 0],
  [0, 4, 3, 0, 0, 0, 0, 0, 0, 0],
  [0, 4, 3, 2, 0, 0, 0, 0, 0, 0],
  [0, 4, 3, 3, 0, 0, 0, 0, 0, 0],
  [0, 4, 3, 3, 1, 0, 0, 0, 0, 0],
  [0, 4, 3, 3, 2, 0, 0, 0, 0, 0],
  [0, 4, 3, 3, 3, 1, 0, 0, 0, 0],
  [0, 4, 3, 3, 3, 2, 0, 0, 0, 0],
  [0, 4, 3, 3, 3, 2, 1, 0, 0, 0],
  [0, 4, 3, 3, 3, 2, 1, 0, 0, 0],
  [0, 4, 3, 3, 3, 2, 1, 1, 0, 0],
  [0, 4, 3, 3, 3, 2, 1, 1, 0, 0],
  [0, 4, 3, 3, 3, 2, 1, 1, 1, 0],
  [0, 4, 3, 3, 3, 2, 1, 1, 1, 0],
  [0, 4, 3, 3, 3, 2, 1, 1, 1, 1],
  [0, 4, 3, 3, 3, 3, 1, 1, 1, 1],
  [0, 4, 3, 3, 3, 3, 2, 1, 1, 1],
  [0, 4, 3, 3, 3, 3, 2, 2, 1, 1],
];

/**
 * Spell slots (issue #1903) — a DDB sheet's slot maxima are not reliably present as a flat
 * field on the public payload, so this always derives them from the standard 5e class/level
 * table (the "falling back to the full-caster table" the issue calls for is really the ONLY
 * source here, which keeps the numbers correct for every sheet rather than only the ones
 * that happen to carry an as-yet-unobserved slot field). Non-casters get `{}`.
 *
 * Warlock Pact Magic is deliberately NOT imported here (review finding on this PR):
 * Campfire's `Character.spellSlots` is one flat per-level pool with a single recovery rule
 * — `resetSpellSlotsForRest` (packages/schema/src/rest.ts) only refills slots on a LONG
 * rest, and its own comment states real Pact Magic short-rest recovery is "#1039's
 * problem," i.e. a tracked, not-yet-built cross-cutting change (schema + rest planning +
 * encounter resolver + UI). Writing Pact Magic slots into the ordinary pool here would
 * silently mismodel their recovery cadence (a Warlock told to take a long rest to get back
 * slots that should refresh every short rest) and, for a Warlock/other-caster multiclass,
 * merge two resources 5e keeps separate into one spendable pool. Until #1039 gives Pact
 * Magic its own representation, a DM importing a Warlock sets its slots up by hand — no
 * slots is honest; wrong-cadence slots is not.
 *
 * `usedByLevel` (issue #1903 review) carries the sheet's CURRENT expenditure — read from
 * `data.spellSlots` at the call site — clamped against the computed max per level.
 * Without this every imported caster arrived with every slot fresh regardless of how many
 * the sheet showed already spent, silently granting a free long rest on import.
 */
export function computeSpellSlots(
  classes: DdbClass[] | null | undefined,
  usedByLevel: Readonly<Record<string, number>> = {},
): CharacterCreateInput['spellSlots'] {
  if (!Array.isArray(classes) || classes.length === 0) return {};
  const casterEntries: { progression: 'full' | 'half' | 'halfRoundUp' | 'third'; level: number }[] = [];
  for (const cls of classes) {
    const name = cls.definition?.name ?? '';
    const level = typeof cls.level === 'number' && cls.level > 0 ? cls.level : 0;
    if (!name || level <= 0) continue;
    // 'pact' (Warlock) is recognized by casterProgressionForClass but intentionally not
    // collected here — see the doc comment above.
    const progression = casterProgressionForClass(name, cls.subclassDefinition?.name);
    if (progression && progression !== 'pact') {
      casterEntries.push({ progression, level });
    }
  }
  if (casterEntries.length === 0) return {};

  // Exactly one non-Warlock caster class -> use that class's own table (ceil), not the
  // multiclass combining formula (floor), which only applies when genuinely combining two
  // or more spellcasting progressions. See the comment on FULL_CASTER_SLOT_TABLE.
  const solo = casterEntries.length === 1 ? casterEntries[0] : null;
  let fullEquivalentLevel = 0;
  if (solo) {
    if (solo.progression === 'full') {
      fullEquivalentLevel = solo.level;
    } else if (solo.progression === 'half') {
      fullEquivalentLevel = solo.level < 2 ? 0 : Math.ceil(solo.level / 2);
    } else if (solo.progression === 'halfRoundUp') {
      fullEquivalentLevel = Math.ceil(solo.level / 2);
    } else if (solo.progression === 'third') {
      fullEquivalentLevel = solo.level < 3 ? 0 : Math.ceil(solo.level / 3);
    }
  } else {
    let halfLevels = 0;
    let thirdLevels = 0;
    for (const entry of casterEntries) {
      if (entry.progression === 'full') {
        fullEquivalentLevel += entry.level;
      } else if (entry.progression === 'half') {
        halfLevels += entry.level;
      } else if (entry.progression === 'halfRoundUp') {
        fullEquivalentLevel += Math.ceil(entry.level / 2);
      } else if (entry.progression === 'third') {
        thirdLevels += entry.level;
      }
    }
    fullEquivalentLevel += Math.floor(halfLevels / 2) + Math.floor(thirdLevels / 3);
  }

  const slots: Record<string, { max: number; used: number }> = {};
  const addSlots = (level: number, count: number) => {
    if (count <= 0) return;
    const key = String(level);
    slots[key] = { max: (slots[key]?.max ?? 0) + count, used: 0 };
  };

  const clampedFull = Math.max(0, Math.min(20, fullEquivalentLevel));
  const fullRow = FULL_CASTER_SLOT_TABLE[clampedFull];
  if (fullRow) for (let lvl = 1; lvl <= 9; lvl++) addSlots(lvl, fullRow[lvl] ?? 0);

  // Apply the sheet's current expenditure, clamped to the computed max — never trust the
  // source `used` to exceed what this level pool can actually hold.
  for (const [level, slot] of Object.entries(slots)) {
    const used = usedByLevel[level] ?? 0;
    slot.used = Math.max(0, Math.min(slot.max, used));
  }

  return slots;
}

/**
 * Map a public D&D Beyond character sheet (`response.data`) into a Campfire
 * `CharacterCreate`. Pure and total: every field is optional on the wire, so a sparse
 * sheet yields a sparse-but-valid character rather than throwing. Numeric fields are left
 * for the service's clamps (AC/HP) to bound.
 */
export function mapDdbCharacter(data: DdbCharacterData): CharacterCreateInput {
  const stats = computeAbilityScores(data);
  const totalLevel = computeTotalLevel(data.classes);
  const level = Math.min(20, Math.max(1, totalLevel));
  const hpMax = computeHitPoints(data, stats.CON, totalLevel);
  const removed = typeof data.removedHitPoints === 'number' ? data.removedHitPoints : 0;
  const hpCurrent = Math.max(0, hpMax - removed);
  const mods = allModifiers(data);
  const portraitUrl = data.decorations?.avatarUrl ?? data.avatarUrl ?? null;
  const backstory = data.notes?.backstory?.trim();
  const proficiencyBonus = proficiencyBonusForLevel(level);

  // Issue #1903: attacks/spells so an imported PC arrives ready to take a turn — the
  // encounter Actions card and the /turn payload consume `actions`/`spellSlots` as-is, no
  // new fields, no new endpoints. The 100-entry cap is `Character.actions`'s real schema
  // limit — the ONLY intentional truncation point (see RAW_ENTRY_SAFETY_CAP above); any
  // overflow past it is reported via `computeDdbActionEntryCount`/`summarizeDdbImport`
  // rather than silently dropped.
  const rawActions = [...computeWeaponActions(data, stats, proficiencyBonus), ...computeFeatureActions(data, stats, proficiencyBonus), ...computeSpellActions(data)];
  const actions = rawActions.slice(0, 100);
  // Current slot expenditure (issue #1903 review) — see the doc comment on computeSpellSlots.
  const usedByLevel: Record<string, number> = {};
  if (Array.isArray(data.spellSlots)) {
    for (const entry of data.spellSlots) {
      const lvl = typeof entry?.level === 'number' ? entry.level : null;
      // `SpellSlotLevel.used`'s schema is an integer. This DDB-import path builds `spellSlots`
      // directly (not through `CharacterCreate.parse`), so a fractional `used` here (e.g.
      // `0.5`) would be persisted verbatim instead of being caught by validation, corrupting
      // remaining-slot arithmetic and risking a later schema-validated update rejecting the
      // stored state (review finding on PR #1950 round 13). Require an integer.
      const used = typeof entry?.used === 'number' && Number.isInteger(entry.used) && entry.used > 0 ? entry.used : 0;
      if (lvl !== null && lvl >= 1 && lvl <= 9 && used > 0) {
        const key = String(lvl);
        usedByLevel[key] = (usedByLevel[key] ?? 0) + used;
      }
    }
  }
  const spellSlots = computeSpellSlots(data.classes, usedByLevel);

  const created: CharacterCreateInput = {
    name: (data.name ?? '').trim() || 'Imported Character',
    species: computeSpecies(data),
    className: computeClassName(data.classes),
    level,
    xp: typeof data.currentXp === 'number' && data.currentXp >= 0 ? data.currentXp : 0,
    background: computeBackground(data),
    stats,
    ac: computeArmorClass(data, stats.DEX),
    speed: computeSpeed(data),
    hpMax,
    hpCurrent,
    saveProficiencies: computeSaveProficiencies(mods),
    skills: computeSkills(mods),
    weaponProficiencies: computeWeaponProficiencies(mods),
    actions,
    spellSlots,
    portraitUrl: portraitUrl ? String(portraitUrl) : null,
    ddbId: typeof data.id === 'number' ? String(data.id) : null,
    notes: backstory ? backstory.slice(0, 20_000) : '',
  };
  return created;
}

/**
 * Ceiling for the COUNTING-only pass below — deliberately much higher than
 * `RAW_ENTRY_SAFETY_CAP` (which bounds the heavier MAPPING pass that builds full
 * `CharacterAction`/attack-math objects). Counting is cheap (a handful of property reads
 * per entry, no dice/attack computation), so it can afford to stay accurate far past any
 * sheet size that could plausibly exist, while still bounding a truly pathological payload.
 */
const COUNT_ENTRY_SAFETY_CAP = 10_000;

/**
 * Total attack/feature/spell entries a DDB sheet would produce BEFORE `mapDdbCharacter`
 * applies the `Character.actions` schema cap (100) — issue #1903 review: a sheet with more
 * raw entries than the cap must report the true overflow (`DdbImportSummary.entriesOmitted`)
 * rather than trimming silently.
 *
 * Deliberately does NOT call `computeWeaponActions`/`computeFeatureActions`/
 * `computeSpellActions` (review finding: an earlier version did, which meant a category with
 * more than `RAW_ENTRY_SAFETY_CAP` raw entries was undercounted by exactly as much as the
 * mapping pass trimmed, contradicting the "always reported" promise). These three helpers
 * mirror each mapping function's INCLUSION filter only (what counts as a real entry — a
 * named item, a known/prepared spell, deduped by name) without building the full
 * `CharacterAction`/attack-math objects, so they can count accurately far past
 * `RAW_ENTRY_SAFETY_CAP` cheaply.
 */
export function computeDdbActionEntryCount(data: DdbCharacterData): number {
  return countWeaponEntries(data) + countFeatureEntries(data) + countSpellEntries(data);
}

function countWeaponEntries(data: DdbCharacterData): number {
  const items = Array.isArray(data.inventory) ? data.inventory : [];
  let n = 0;
  for (const item of items) {
    if (n >= COUNT_ENTRY_SAFETY_CAP) break;
    if (item?.equipped && isWeaponItem(item) && item.definition) n++;
  }
  return n;
}

function countFeatureEntries(data: DdbCharacterData): number {
  const groups = data.actions;
  if (!groups || typeof groups !== 'object') return 0;
  let n = 0;
  for (const section of ACTION_SECTIONS) {
    const list = groups[section];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (n >= COUNT_ENTRY_SAFETY_CAP) return n;
      const item = raw ?? {};
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (name) n++;
    }
  }
  return n;
}

function countSpellEntries(data: DdbCharacterData): number {
  const seen = new Set<string>();
  let n = 0;
  const consider = (entry: DdbSpellEntry | null | undefined, isWizard: boolean) => {
    if (!entry || n >= COUNT_ENTRY_SAFETY_CAP) return;
    if (!isKnownOrPrepared(entry, isWizard)) return;
    const name = typeof entry.definition?.name === 'string' ? entry.definition.name.trim().slice(0, 120) : '';
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    n++;
  };
  for (const group of Array.isArray(data.classSpells) ? data.classSpells : []) {
    const isWizard = isWizardClass(data, group?.characterClassId);
    for (const entry of Array.isArray(group?.spells) ? group.spells : []) consider(entry, isWizard);
  }
  const granted = data.spells;
  if (granted && typeof granted === 'object') {
    for (const [section, list] of Object.entries(granted)) {
      const isWizard = section === 'class' && isWizardClass(data, null);
      if (Array.isArray(list)) for (const entry of list) consider(entry, isWizard);
    }
  }
  return n;
}

/**
 * Build the import summary (issue #1903) for a mapped character: counts of what imported
 * with a resolvable `spec` vs. what landed text-only, so REST/MCP callers can show the DM
 * what needs a manual touch-up rather than discovering it only inside the sheet.
 *
 * "Needs touch-up" is `!isResolvableSpec(a.spec)`, not merely `!a.spec` — every imported
 * spell (`computeSpellActions`) carries a real `spec` object (`{uses:{spellLevel,...}}`,
 * needed so slot-tracking sees the right level) but deliberately never gets a `mode`, since
 * DDB's target-save-ability fields for a spell aren't reliably shaped (see the comment on
 * `computeSpellActions`). `isResolvableSpec` returns false for `mode:'none'`, matching the
 * encounter UI's own Use-button gate (`CharacterStatCard`'s `canUse`) and the server's
 * action-resolver 400 ("no resolvable structured spec") — so every imported spell is
 * exactly the class of thing this summary exists to flag: present, but not yet actionable
 * without the DM adding an attack/save mode by hand.
 *
 * `entriesOmitted` (default 0, for callers that only have the already-mapped character) is
 * the count trimmed by the `Character.actions` schema cap — see
 * `computeDdbActionEntryCount`. Reported rather than silently dropped.
 */
export function summarizeDdbImport(create: CharacterCreateInput, entriesOmitted = 0): DdbImportSummary {
  const actions = create.actions ?? [];
  const spells = actions.filter((a) => a.kind === 'spell');
  const nonSpells = actions.filter((a) => a.kind !== 'spell');
  const textOnly = actions.filter((a) => !isResolvableSpec(a.spec ?? null)).map((a) => a.name);
  return {
    actionsImported: nonSpells.length,
    spellsImported: spells.length,
    spellSlotsImported: Object.keys(create.spellSlots ?? {}).length > 0,
    textOnly: textOnly.slice(0, 200),
    entriesOmitted: Math.max(0, entriesOmitted),
  };
}

/** Injectable fetch signature so tests can point the importer at a fake server. */
export type DdbFetch = (url: string) => Promise<Response>;

async function defaultFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a PUBLIC D&D Beyond character sheet's JSON and return `response.data`. Clean,
 * user-facing errors for the two failure modes the issue calls out:
 *   - private / campaign-only sheet  -> 403 (or `success:false`) -> BadRequest with a
 *     "make it public" hint,
 *   - non-existent id                -> 404                      -> NotFound.
 * Any other transport/shape failure becomes a BadRequest rather than a raw fetch error.
 *
 * `baseUrl` (defaults to the live character service) and `fetchImpl` (defaults to the
 * global fetch) are injectable so the mapping/error paths can be tested against a fake
 * in-process server without touching the live API — mirrors the Open5e importer.
 */
export async function fetchDdbCharacter(
  ddbId: string,
  baseUrl: string = DDB_CHARACTER_SERVICE_BASE_URL,
  fetchImpl: DdbFetch = defaultFetch,
): Promise<DdbCharacterData> {
  const url = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(ddbId)}`;
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new BadRequestException(`Failed to reach D&D Beyond for character ${ddbId}: ${(err as Error).message}`);
  }

  if (res.status === 404) {
    throw new NotFoundException(`No D&D Beyond character ${ddbId} — check the id or URL.`);
  }
  if (res.status === 403 || res.status === 401) {
    throw new BadRequestException(
      `D&D Beyond character ${ddbId} is private. Set the sheet's privacy to Public on D&D Beyond, then import again.`,
    );
  }
  if (!res.ok) {
    throw new BadRequestException(`D&D Beyond returned HTTP ${res.status} for character ${ddbId}.`);
  }

  let body: DdbCharacterResponse;
  try {
    body = (await res.json()) as DdbCharacterResponse;
  } catch (err) {
    throw new BadRequestException(`D&D Beyond returned invalid JSON for character ${ddbId}: ${(err as Error).message}`);
  }

  // The service answers 200 with `success:false` for some private/unavailable sheets.
  if (body.success === false || !body.data) {
    throw new BadRequestException(
      body.message?.trim()
        ? `D&D Beyond could not return character ${ddbId}: ${body.message.trim()} (is the sheet public?)`
        : `D&D Beyond character ${ddbId} is not available — is the sheet set to Public?`,
    );
  }
  return body.data;
}
