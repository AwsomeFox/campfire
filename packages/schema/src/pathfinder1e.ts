import type { AbilityRepresentation, MonsterStatblockData, RuleSystemAdapter, StatblockPresentation } from './index';

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

/** Read the governing (DEX) score from either a canonical (`{ DEX }`) or raw monster
 *  (`{ dexterity }`) ability map, if numeric — mirrors the 5e adapter's DEX lookup. */
function pf1eDexScore(abilities: Record<string, unknown> | null | undefined): number | null {
  if (!abilities) return null;
  const raw = abilities.DEX ?? abilities.dexterity ?? abilities.dex;
  return typeof raw === 'number' ? raw : null;
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
/** PF1e presentation — Challenge Rating + Armor Class (ascending AC, like 5e). */
export const PF1E_STATBLOCK_PRESENTATION: StatblockPresentation = {
  rating: { full: 'Challenge Rating', short: 'CR' },
  defense: { full: 'Armor Class', short: 'AC' },
  hitPoints: { full: 'Hit Points', short: 'HP' },
  abilities: { full: 'Abilities' },
  actions: { full: 'Actions' },
  creatureType: { full: 'Type' },
};

export const Pathfinder1eAdapter: RuleSystemAdapter = {
  id: PF1E_ADAPTER_ID,
  label: 'Pathfinder 1e',
  presentation: PF1E_STATBLOCK_PRESENTATION,
  abilityModifier: pf1eAbilityModifier,
  // PF1e initiative is a d20 roll + DEX modifier (feats like Improved Initiative are per-
  // creature and live in the statblock's stored init, not this base derivation) — same die
  // and same governing ability as 5e.
  initiativeDie: 20,
  // Pathfinder 1e caps at character level 20 (Core Rulebook), matching the 5e ceiling.
  maxLevel: 20,
  initiativeModifier(
    abilities: Record<string, unknown> | null | undefined,
    representation: AbilityRepresentation = 'score',
  ): number {
    const dex = pf1eDexScore(abilities);
    if (dex === null) return 0;
    // Inline of resolveAbilityModifier — this file cannot runtime-import from ./index
    // without creating a cycle (index registers Pathfinder1eAdapter).
    return representation === 'score' ? pf1eAbilityModifier(dex) : Math.trunc(dex);
  },
  conditions: PF1E_CONDITIONS,
  // PF1e statblocks share the 5e-family field vocabulary (size/type/CR/AC/HP/speed/ability
  // scores). AC is ascending, so the stored `armorClass` is used as-is. We accept both the
  // camelCase shape the importer writes and PF1e-SRD snake_case keys (armor_class, hit_points,
  // challenge_rating, ability_scores) so a raw imported row maps without pre-normalisation.
  mapStatblock(d: Record<string, unknown>): MonsterStatblockData {
    const abilityScores = (d.abilityScores ?? d.ability_scores) as Record<string, unknown> | undefined;
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
