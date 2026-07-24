import type { AbilityRepresentation, MonsterStatblockData, RuleSystemAdapter } from './index';
import { initModDescThenSortOrderAsc } from './initiative-tiebreak';

/**
 * Pathfinder 1e rule-system adapter (issue #296, part of the #275 open-ruleset program).
 *
 * PF1e is 3.5e-derived and maps very close to the built-in 5e adapter (`Dnd5eAdapter`):
 * the ability-modifier formula is identical (floor((score-10)/2)), initiative is a DEX-
 * derived d20 roll, and AC is ascending (higher is better) just like 5e. The differences
 * that matter for combat math are the 3.5e-family progressions — Base Attack Bonus and the
 * three saving throws (Fortitude/Reflex/Will) each advancing on a "good" or "poor" track —
 * which the base `RuleSystemAdapter` interface does not model (it is deliberately 5e-shaped:
 * a single init modifier, no per-save tracks). Those PF1e-specific formulas are exported as
 * pure functions alongside the adapter so they can be unit-tested and consumed independently,
 * without widening the shared interface (which would force every other adapter to implement
 * them too).
 *
 * This file has NO runtime dependency on ./index — it imports only *types* from it (erased at
 * compile time), so registering the adapter in index.ts's ADAPTERS map creates no import cycle.
 */

/** Family id of the Pathfinder 1e adapter. Doubles as the rule-pack slug it installs under, so a
 *  campaign whose `ruleSystem` is set to this pack resolves straight to this adapter. */
export const PF1E_ADAPTER_ID = 'pathfinder-1e';

/** Rule-pack slug the PF1e importer installs under (kept identical to the adapter id so
 *  `ruleSystemAdapter(campaign.ruleSystem)` resolves without a slug→id lookup table). */
export const PF1E_PACK_SLUG = 'pathfinder-1e';

/**
 * The Pathfinder 1e condition vocabulary (Core Rulebook, OGL). PF1e carries a substantially
 * larger condition list than 5e — the 3.5e lineage kept fine-grained states like cowering,
 * dazzled, entangled, sickened, and the dying/disabled/stable chain that 5e folded away.
 * This is the chip list offered in the combat UI for a PF1e campaign (parallel to the 5e
 * adapter's `conditions`). Presented in the same alphabetical order the SRD uses.
 */
export const PF1E_CONDITIONS = [
  'Bleed',
  'Blinded',
  'Broken',
  'Confused',
  'Cowering',
  'Dazed',
  'Dazzled',
  'Dead',
  'Deafened',
  'Disabled',
  'Dying',
  'Energy Drained',
  'Entangled',
  'Exhausted',
  'Fascinated',
  'Fatigued',
  'Flat-Footed',
  'Frightened',
  'Grappled',
  'Helpless',
  'Incorporeal',
  'Invisible',
  'Nauseated',
  'Panicked',
  'Paralyzed',
  'Petrified',
  'Pinned',
  'Prone',
  'Shaken',
  'Sickened',
  'Stable',
  'Staggered',
  'Stunned',
  'Unconscious',
] as const;

export type Pf1eCondition = (typeof PF1E_CONDITIONS)[number];

/**
 * Coerce a value to a finite number, or null. Accepts any finite number (including
 * floats) and numeric strings `Number(...)` can parse (the SRD sometimes emits
 * these); rejects NaN / Infinity / empty / non-numeric strings.
 * Used for ability scores and the flat initiative bonus the importer stores on a
 * monster's `dataJson`.
 */
function pf1eNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** First numeric value among `keys` on `source`, skipping invalid-but-present entries. */
function pf1eFirstNum(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const n = pf1eNum(source[key]);
    if (n !== null) return n;
  }
  return null;
}

/** Read the governing (DEX) score from either a canonical (`{ DEX }`) or raw monster
 *  (`{ dexterity }`) ability map, if numeric — mirrors the 5e adapter's DEX lookup.
 *  Uses pf1eNum so SRD numeric strings are accepted the same way as native Init. */
function pf1eDexScore(abilities: Record<string, unknown> | null | undefined): number | null {
  if (!abilities) return null;
  return pf1eFirstNum(abilities, ['DEX', 'dexterity', 'dex']);
}

/**
 * Read an explicit native initiative bonus from a monster ability/statblock map.
 * Prefers the camelCase key the PF1e importer writes (`initiative`), then the SRD's
 * short `init` key. Returns null when absent or non-numeric — never invents a zero
 * (issue #764: surface unavailable rather than silently +0).
 */
export function pf1eNativeInitiative(abilities: Record<string, unknown> | null | undefined): number | null {
  if (!abilities) return null;
  return pf1eFirstNum(abilities, ['initiative', 'init']);
}

/**
 * Provenance-preserving initiative resolution for Pathfinder 1e (issue #764).
 *
 * PF1e monsters carry a flat Init bonus that already includes DEX + feats (e.g. Improved
 * Initiative). Prefer that native bonus when present; fall back to a DEX-derived modifier
 * only when the native value is absent; return `unavailable` when neither can be resolved
 * so callers can surface the gap instead of treating a missing score as a silent +0.
 */
export type Pf1eInitiativeBreakdown =
  | { source: 'native'; bonus: number }
  | { source: 'dex'; bonus: number; dexScore: number }
  | { source: 'unavailable'; bonus: null };

export function pf1eInitiativeBreakdown(
  abilities: Record<string, unknown> | null | undefined,
): Pf1eInitiativeBreakdown {
  const native = pf1eNativeInitiative(abilities);
  if (native !== null) return { source: 'native', bonus: native };
  const dex = pf1eDexScore(abilities);
  if (dex !== null) return { source: 'dex', bonus: pf1eAbilityModifier(dex), dexScore: dex };
  return { source: 'unavailable', bonus: null };
}

/** PF1e ability-score → modifier: floor((score - 10) / 2). Identical to 3.5e/5e. */
export function pf1eAbilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

// ---------------------------------------------------------------------------
// PF1e save & Base-Attack-Bonus progressions (3.5e family).
//
// A creature/class of a given level advances each save on one of two tracks and its BAB on
// one of three. These are the standard PF1e Core Rulebook progressions:
//   - Good save:  floor(level / 2) + 2       (2,3,3,4,4,5,…)
//   - Poor save:  floor(level / 3)           (0,0,1,1,1,2,…)
//   - Full BAB:   level                      (fighter/barbarian/… — 1,2,3,…)
//   - 3/4 BAB:    floor(level * 3 / 4)        (cleric/rogue/… — 0,1,2,3,3,4,…)
//   - 1/2 BAB:    floor(level / 2)            (wizard/sorcerer — 0,1,1,2,2,3,…)
// The final saving throw a creature rolls is the track bonus plus the governing ability
// modifier (Fort=CON, Ref=DEX, Will=WIS), which `pf1eSavingThrow` composes.
// ---------------------------------------------------------------------------

export type Pf1eSaveTrack = 'good' | 'poor';
export type Pf1eBabTrack = 'full' | 'threeQuarter' | 'half';

/** Base save bonus for a level on the good/poor track (before the ability modifier). */
export function pf1eBaseSaveBonus(level: number, track: Pf1eSaveTrack): number {
  const lvl = Math.max(0, Math.floor(level));
  return track === 'good' ? Math.floor(lvl / 2) + 2 : Math.floor(lvl / 3);
}

/** Base Attack Bonus for a level on the full / three-quarter / half track. */
export function pf1eBaseAttackBonus(level: number, track: Pf1eBabTrack): number {
  const lvl = Math.max(0, Math.floor(level));
  switch (track) {
    case 'full':
      return lvl;
    case 'threeQuarter':
      return Math.floor((lvl * 3) / 4);
    case 'half':
      return Math.floor(lvl / 2);
  }
}

/** A creature's total saving throw: base track bonus + the governing ability's modifier. */
export function pf1eSavingThrow(level: number, track: Pf1eSaveTrack, abilityScore: number): number {
  return pf1eBaseSaveBonus(level, track) + pf1eAbilityModifier(abilityScore);
}

/**
 * PF1e ascending Armor Class = 10 + Dexterity modifier + the sum of every AC bonus
 * (armor, shield, natural armor, deflection, dodge, size, …). Any omitted component
 * defaults to 0; the DEX score (not modifier) is passed and converted. Higher is better,
 * exactly like 5e AC — this helper just exposes the additive PF1e breakdown for callers
 * that store the components rather than a pre-summed number.
 */
export function pf1eArmorClass(parts: {
  dexScore?: number;
  armor?: number;
  shield?: number;
  natural?: number;
  deflection?: number;
  dodge?: number;
  size?: number;
}): number {
  const dexMod = typeof parts.dexScore === 'number' ? pf1eAbilityModifier(parts.dexScore) : 0;
  const sum = (parts.armor ?? 0) + (parts.shield ?? 0) + (parts.natural ?? 0) + (parts.deflection ?? 0) + (parts.dodge ?? 0) + (parts.size ?? 0);
  return 10 + dexMod + sum;
}

/**
 * The Pathfinder 1e adapter. Satisfies the shared `RuleSystemAdapter` seam so every combat
 * call site (initiative rolling, statblock mapping, HP resolution, condition chips) routes
 * through it when a campaign selects the PF1e pack — no per-system branching in the combat code.
 */
export const Pathfinder1eAdapter: RuleSystemAdapter = {
  id: PF1E_ADAPTER_ID,
  label: 'Pathfinder 1e',
  abilityModifier: pf1eAbilityModifier,
  // PF1e initiative is a d20 roll + a flat Init bonus. Monsters store that bonus on the
  // statblock (DEX + feats like Improved Initiative already baked in); characters without
  // a stored Init fall back to the DEX modifier. Same die as 5e.
  initiativeDie: 20,
  // Pathfinder 1e caps at character level 20 (Core Rulebook), matching the 5e ceiling.
  maxLevel: 20,
  // Prefer the explicit native Init folded into abilityScores by mapStatblock (issue #764);
  // derive from DEX only when that bonus is absent. `representation` applies only to the
  // DEX fallback (native Init is already a bonus).
  //
  // Callers that must surface "unavailable" (encounter addCombatant, generators) use
  // `initiativeModifierOrNull` / `pf1eInitiativeBreakdown`. The numeric seam still returns
  // 0 for rollInitiative callers that need a default when a combatant already exists.
  initiativeModifierOrNull(
    abilities: Record<string, unknown> | null | undefined,
    representation: AbilityRepresentation = 'score',
  ): number | null {
    const breakdown = pf1eInitiativeBreakdown(abilities);
    if (breakdown.source === 'unavailable') return null;
    if (breakdown.source === 'native') return breakdown.bonus;
    // Inline of resolveAbilityModifier — this file cannot runtime-import from ./index
    // without creating a cycle (index registers Pathfinder1eAdapter).
    return representation === 'score' ? breakdown.bonus : Math.trunc(breakdown.dexScore);
  },
  initiativeModifier(
    abilities: Record<string, unknown> | null | undefined,
    representation: AbilityRepresentation = 'score',
  ): number {
    return this.initiativeModifierOrNull!(abilities, representation) ?? 0;
  },
  // PF1e initiative is DEX-derived like 5e; on a tied total, higher DEX (initMod) first,
  // then sortOrder (issue #611).
  initiativeTiebreak: initModDescThenSortOrderAsc,
  conditions: PF1E_CONDITIONS,
  // PF1e statblocks share the 5e-family field vocabulary (size/type/CR/AC/HP/speed/ability
  // scores). AC is ascending, so the stored `armorClass` is used as-is. We accept both the
  // camelCase shape the importer writes and PF1e-SRD snake_case keys (armor_class, hit_points,
  // challenge_rating, ability_scores) so a raw imported row maps without pre-normalisation.
  // The importer also stores a flat `initiative` bonus — fold it into abilityScores (PF2e
  // does the same with Perception) so the encounter path
  // `initiativeModifier(mapStatblock(data).abilityScores)` preserves the native value
  // across web / REST / MCP / generator / duplicate-add / reroll call sites (issue #764).
  mapStatblock(d: Record<string, unknown>): MonsterStatblockData {
    const scores = (d.abilityScores ?? d.ability_scores) as Record<string, unknown> | undefined;
    const scoreMap = scores && typeof scores === 'object' && !Array.isArray(scores) ? scores : undefined;
    const nativeInit = pf1eNativeInitiative(d) ?? (scoreMap ? pf1eNativeInitiative(scoreMap) : null);
    // Only allocate a new object when folding native Init into the ability map.
    const abilityScores =
      scoreMap
        ? nativeInit !== null
          ? { ...scoreMap, initiative: nativeInit }
          : scoreMap
        : nativeInit !== null
          ? { initiative: nativeInit }
          : undefined;
    return {
      size: d.size,
      creatureType: d.type ?? d.creatureType,
      challengeRating: d.challengeRating ?? d.challenge_rating ?? d.cr,
      armorClass: d.armorClass ?? d.armor_class ?? d.ac,
      hitPoints: d.hitPoints ?? d.hit_points ?? d.hp,
      speed: d.speed,
      abilityScores: abilityScores && typeof abilityScores === 'object' ? abilityScores : undefined,
      abilityRepresentation: 'score',
      specialAbilities: d.specialAbilities ?? d.special_abilities,
      actions: d.actions,
    };
  },
  monsterHitPoints(d: Record<string, unknown>): number | null {
    const hp = d.hitPoints ?? d.hit_points ?? d.hp;
    return typeof hp === 'number' && hp > 0 ? Math.round(hp) : null;
  },
};
