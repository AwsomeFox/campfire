import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import type { CharacterCreate } from '@campfire/schema';

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
  level?: number;
  definition?: { name?: string } | null;
  subclassDefinition?: { name?: string } | null;
}
interface DdbInventoryItem {
  equipped?: boolean;
  definition?: {
    armorClass?: number | null;
    armorTypeId?: number | null; // 1 light, 2 medium, 3 heavy, 4 shield
  } | null;
}
export interface DdbCharacterData {
  id?: number;
  name?: string;
  race?: { fullName?: string; baseName?: string } | null;
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

/** Total character level = sum of every class's level (min 1, capped at 20 by the schema). */
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

  const created: CharacterCreateInput = {
    name: (data.name ?? '').trim() || 'Imported Character',
    species: computeSpecies(data),
    className: computeClassName(data.classes),
    level,
    xp: typeof data.currentXp === 'number' && data.currentXp >= 0 ? data.currentXp : 0,
    background: computeBackground(data),
    stats,
    ac: computeArmorClass(data, stats.DEX),
    hpMax,
    hpCurrent,
    saveProficiencies: computeSaveProficiencies(mods),
    skills: computeSkills(mods),
    portraitUrl: portraitUrl ? String(portraitUrl) : null,
    ddbId: typeof data.id === 'number' ? String(data.id) : null,
    notes: backstory ? backstory.slice(0, 20_000) : '',
  };
  return created;
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
