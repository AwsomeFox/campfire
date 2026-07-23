import type { AbilityRepresentation, MonsterStatblockData, RuleSystemAdapter } from './index';

// ---------- OSR (Old-School Renaissance) rule-system adapter (issues #70, #300) ----------
// A single shared adapter for the B/X-descended retroclone family: Basic Fantasy RPG
// (CC-BY-SA 4.0), OSRIC, Swords & Wizardry, Labyrinth Lord, and Old-School Essentials
// (all OGL). These systems share the same core math, so ONE adapter unlocks the whole
// family rather than one per clone. The two things that actually vary between clones —
// whether armor class counts DOWN (classic THAC0) or UP (ascending AC) — are handled by
// a single normalized to-hit path so a campaign can use either convention and get
// identical hit/miss results (see `osrAttackHits`).

/** Family id for the shared OSR adapter (not a pack slug). */
export const OSR_ADAPTER_ID = 'osr';

/**
 * Rule-pack slugs that resolve to the shared OSR adapter. The importer stamps a pack
 * with one of these slugs per source system (Basic Fantasy → 'basic-fantasy', etc.), and
 * a campaign whose `ruleSystem` is any of them gets OSR combat behavior. 'osr' is the
 * generic catch-all for a mixed/home OSR pack.
 */
export const OSR_RULE_SYSTEM_SLUGS = [
  'osr',
  'basic-fantasy',
  'osric',
  'swords-wizardry',
  'labyrinth-lord',
  'old-school-essentials',
  'ose',
] as const;

/**
 * The B/X ability-score adjustment table shared by Basic Fantasy and the OGL retroclones.
 * Unlike 5e's linear floor((score-10)/2), OSR uses a fixed banded table that tops out at
 * ±3 (or ±2 in some clones — Basic Fantasy uses ±3, which is the widest and a superset).
 *   3 → -3 · 4-5 → -2 · 6-8 → -1 · 9-12 → 0 · 13-15 → +1 · 16-17 → +2 · 18 → +3
 * Scores below 3 clamp to -3 and above 18 clamp to +3 (exceptional scores are rare in
 * OSR and always sit at the extremes of the band).
 */
export function osrAbilityModifier(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score <= 3) return -3;
  if (score <= 5) return -2;
  if (score <= 8) return -1;
  if (score <= 12) return 0;
  if (score <= 15) return 1;
  if (score <= 17) return 2;
  return 3;
}

/**
 * The five OSR saving-throw categories (Basic Fantasy / B/X). Ascending-AC clones keep
 * the same five categories, so this vocabulary is shared. A save succeeds on a d20 roll
 * that MEETS OR BEATS the character's target number for the category (see `savingThrowSucceeds`).
 */
export const OSR_SAVES = [
  'Death Ray or Poison',
  'Magic Wands',
  'Paralysis or Petrify',
  'Dragon Breath',
  'Spells',
] as const;
export type OsrSaveCategory = (typeof OSR_SAVES)[number];

/**
 * Whether an OSR saving throw succeeds: roll d20, add any situational modifier, and
 * meet-or-beat the target number for the category. Lower target numbers are better (they
 * improve with level), the opposite of 5e's DC model — this helper hides that so callers
 * don't re-implement the comparison. A natural 20 always succeeds and a natural 1 always
 * fails, matching common OSR practice.
 */
export function savingThrowSucceeds(roll: number, target: number, modifier = 0): boolean {
  if (roll <= 1) return false;
  if (roll >= 20) return true;
  return roll + modifier >= target;
}

// ---------- AC / to-hit: descending (THAC0) AND ascending, one normalized path ----------
// Descending and ascending AC are two encodings of the same thing. Anchored so the
// unarmored value matches both traditions: descending AC 9 ⇄ ascending AC 10, and the
// THAC0 reference descending AC 0 ⇄ ascending AC 19. Under this anchor `AAC = 19 - DAC`
// is its own inverse, and a THAC0 converts to an ascending attack bonus of `19 - THAC0`
// such that BOTH conventions yield the identical to-hit threshold (proven in the tests):
//   descending:  hit ⇔ roll ≥ THAC0 - DAC
//   ascending:   hit ⇔ roll + (19 - THAC0) ≥ AAC = 19 - DAC   ⇔   roll ≥ THAC0 - DAC

export type AcMode = 'descending' | 'ascending';

/** Convert a descending armor class to its ascending equivalent (self-inverse: 19 - x). */
export function descendingToAscendingAc(descendingAc: number): number {
  return 19 - descendingAc;
}
/** Convert an ascending armor class to its descending equivalent (self-inverse: 19 - x). */
export function ascendingToDescendingAc(ascendingAc: number): number {
  return 19 - ascendingAc;
}
/** The ascending attack bonus exactly equivalent to a descending THAC0 (19 - THAC0). */
export function thac0ToAttackBonus(thac0: number): number {
  return 19 - thac0;
}
/** The descending THAC0 exactly equivalent to an ascending attack bonus (19 - bonus). */
export function attackBonusToThac0(attackBonus: number): number {
  return 19 - attackBonus;
}

export interface OsrAttack {
  /** The raw d20 attack roll (before any bonus). */
  roll: number;
  /** The attacker's THAC0. If you only have an ascending attack bonus, pass `attackBonusToThac0(bonus)`. */
  thac0: number;
  /** The defender's armor class, expressed in `mode`'s convention. */
  targetAc: number;
  /** Which AC convention `targetAc` is in — a per-campaign toggle covering both clone styles. */
  mode: AcMode;
}

/**
 * Whether an OSR attack hits, working identically whether the campaign tracks armor class
 * as descending (THAC0) or ascending. The target AC is normalized to descending internally
 * so the single classic comparison `roll ≥ THAC0 - AC` decides both — no divergent code
 * paths, no rounding drift. Natural 1 always misses and natural 20 always hits.
 */
export function osrAttackHits(attack: OsrAttack): boolean {
  if (attack.roll <= 1) return false;
  if (attack.roll >= 20) return true;
  const descendingAc = attack.mode === 'descending' ? attack.targetAc : ascendingToDescendingAc(attack.targetAc);
  return attack.roll >= attack.thac0 - descendingAc;
}

/** Read the governing (DEX) score from either a canonical (`{ DEX }`) or raw (`{ dexterity }`) map. */
function osrDexScore(abilities: Record<string, unknown> | null | undefined): number | null {
  if (!abilities) return null;
  const raw = abilities.DEX ?? abilities.dexterity ?? abilities.dex;
  return typeof raw === 'number' ? raw : null;
}

/** Prefer an explicit ascending AC; otherwise convert a descending AC; else undefined. */
function preferredAscendingAc(d: Record<string, unknown>): number | undefined {
  const asc = d.armorClassAscending ?? d.ascendingArmorClass ?? d.aac;
  if (typeof asc === 'number') return asc;
  const desc = d.armorClass ?? d.armor_class ?? d.ac;
  if (typeof desc === 'number') return descendingToAscendingAc(desc);
  return undefined;
}

/**
 * The OSR condition vocabulary offered in the combat UI. Deliberately leaner than 5e —
 * old-school play leans on rulings over a large status list — but covers the effects the
 * core spells and monster abilities actually impose (Sleep → Sleeping, Hold Person →
 * Held, gorgon/medusa → Petrified, ghoul → Paralyzed, etc.).
 */
export const OSR_CONDITIONS = [
  'Blinded',
  'Charmed',
  'Confused',
  'Deafened',
  'Feared',
  'Held',
  'Paralyzed',
  'Petrified',
  'Poisoned',
  'Prone',
  'Sleeping',
  'Stunned',
  'Unconscious',
] as const;

export const OsrAdapter: RuleSystemAdapter = {
  id: OSR_ADAPTER_ID,
  label: 'OSR (Basic Fantasy / B/X retroclones)',
  abilityModifier(score: number): number {
    return osrAbilityModifier(score);
  },
  // OSR initiative is individual d6 + DEX modifier (Basic Fantasy's optional-but-common
  // individual rule; group-initiative clones still roll a d6, just per side).
  initiativeDie: 6,
  // The OSR family has no single system-wide level cap: caps are per-class and per-clone
  // (a B/X magic-user tops out near 26, a fighter near 9-14, Basic Fantasy differs again, and
  // high-level "name level" play is open-ended). This shared adapter therefore reports Infinity
  // rather than picking one clone's number, so a retroclone campaign isn't artificially held to
  // the 5e ceiling (issue #535). The per-class progression table remains the real gate.
  maxLevel: Infinity,
  initiativeModifier(
    abilities: Record<string, unknown> | null | undefined,
    representation: AbilityRepresentation = 'score',
  ): number {
    const dex = osrDexScore(abilities);
    if (dex === null) return 0;
    // Inline of resolveAbilityModifier — no runtime import from ./index (cycle).
    return representation === 'score' ? osrAbilityModifier(dex) : Math.trunc(dex);
  },
  conditions: OSR_CONDITIONS,
  mapStatblock(d: Record<string, unknown>): MonsterStatblockData {
    const abilityScores = (d.abilityScores ?? d.ability_scores) as Record<string, unknown> | undefined;
    return {
      size: d.size,
      creatureType: d.type ?? d.creatureType ?? d.category,
      // OSR has no CR — hit dice is the difficulty proxy, so it fills the same slot.
      challengeRating: d.hitDice ?? d.hit_dice ?? d.hd ?? d.challengeRating,
      // Normalize to ascending AC so downstream numeric comparisons behave like the 5e UI,
      // regardless of which convention the source statblock used.
      armorClass: preferredAscendingAc(d),
      hitPoints: d.hitPoints ?? d.hit_points ?? d.hp,
      speed: d.movement ?? d.speed,
      abilityScores: abilityScores && typeof abilityScores === 'object' ? abilityScores : undefined,
      abilityRepresentation: 'score',
      specialAbilities: d.specialAbilities ?? d.special_abilities ?? d.abilities,
      actions: d.actions ?? d.attacks,
    };
  },
  monsterHitPoints(d: Record<string, unknown>): number | null {
    const hp = d.hitPoints ?? d.hit_points ?? d.hp;
    return typeof hp === 'number' && hp > 0 ? Math.round(hp) : null;
  },
};
