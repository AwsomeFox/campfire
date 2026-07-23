// ---------- Starfinder 1e rule-system adapter (issue #297) ----------
// Starfinder 1e is a d20 sci-fi system built on the Pathfinder 1e / d20 chassis, so it
// reuses the same ability-modifier formula and DEX-derived, d20-rolled initiative as 5e.
// Its two notable wrinkles live entirely in the statblock→combatant mapping:
//
//   1. Stamina + Hit Points split. A creature's damage pool is Stamina Points (SP), which
//      soak damage first, on top of Hit Points (HP). Effective max HP for the combat
//      tracker is therefore SP + HP (plain monsters with no Stamina fall back to just HP).
//   2. Two Armor Classes: Energy AC (EAC) and Kinetic AC (KAC). There is no single "AC" —
//      an attack targets one or the other. The generic combat layer only has one
//      `armorClass` slot, so we map the canonical `armorClass` to KAC (the physical/melee
//      AC, the more commonly-referenced of the two) and expose BOTH via the Starfinder-
//      specific `armorClasses()` helper for any surface that wants to show EAC/KAC.
//
// This file is deliberately self-contained: it imports only *types* from the schema index
// (erased at compile time, so there is no runtime import cycle), and index.ts registers
// `StarfinderAdapter` with a two-line change. See #275 (candidate rulesets), #70 (the
// RuleSystemAdapter seam), #295-300 (sibling rulesets following the same pattern).

import type { AbilityRepresentation, MonsterStatblockData, RuleSystemAdapter } from './index';

/** Family id of the Starfinder 1e adapter. Matches the rule-pack slug the importer stamps, so a
 *  campaign whose `ruleSystem` is set to the installed Starfinder pack resolves to this adapter. */
export const STARFINDER_ADAPTER_ID = 'starfinder-1e';

/**
 * Starfinder 1e's condition vocabulary (Starfinder Core Rulebook / Starjammer SRD, OGL).
 * Distinct from the 5e list: it adds sci-fi/tactical states like off-kilter, off-target,
 * flat-footed, and the broken (equipment) condition, and drops 5e-only ones (charmed,
 * invisible, petrified, restrained). Offered as combat-UI suggestions for Starfinder games.
 */
export const STARFINDER_CONDITIONS = [
  'Asleep',
  'Bleeding',
  'Blinded',
  'Broken',
  'Burning',
  'Confused',
  'Cowering',
  'Dazed',
  'Dazzled',
  'Dead',
  'Deafened',
  'Dying',
  'Encumbered',
  'Entangled',
  'Exhausted',
  'Fascinated',
  'Fatigued',
  'Flat-Footed',
  'Frightened',
  'Grappled',
  'Helpless',
  'Nauseated',
  'Off-Kilter',
  'Off-Target',
  'Overburdened',
  'Panicked',
  'Paralyzed',
  'Pinned',
  'Prone',
  'Shaken',
  'Sickened',
  'Stable',
  'Staggered',
  'Stunned',
  'Unconscious',
] as const;

/** The EAC/KAC pair pulled from a Starfinder statblock's `dataJson` (either may be null). */
export interface StarfinderArmorClasses {
  /** Energy Armor Class — targeted by energy attacks (lasers, plasma, spells). */
  eac: number | null;
  /** Kinetic Armor Class — targeted by kinetic attacks (melee, projectiles). Mapped to the
   *  generic `armorClass` slot as the primary/physical AC. */
  kac: number | null;
}

/** The Stamina/HP damage-pool breakdown pulled from a Starfinder statblock's `dataJson`. */
export interface StarfinderHitPoints {
  /** Stamina Points — soak damage first (0 for plain monsters that have no Stamina). */
  stamina: number;
  /** Hit Points — the underlying pool damage spills into once Stamina is gone. */
  hitPoints: number;
  /** Combat-tracker effective max HP = stamina + hitPoints. */
  total: number;
}

/** Starfinder statblock fields, widening the generic shape with EAC/KAC and Stamina. */
export interface StarfinderStatblockData extends MonsterStatblockData {
  /** Energy Armor Class. */
  eac: unknown;
  /** Kinetic Armor Class (also surfaced as the generic `armorClass`). */
  kac: unknown;
  /** Stamina Points sub-pool (undefined for plain monsters). */
  stamina: unknown;
}

/** Coerce a value to a finite number, or null. Accepts numeric strings ("17"), rejects NaN. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Read the governing (DEX) score from either a canonical (`DEX`) or raw (`dexterity`) map. */
function starfinderDexScore(abilities: Record<string, unknown> | null | undefined): number | null {
  if (!abilities) return null;
  return num(abilities.DEX ?? abilities.dexterity ?? abilities.dex);
}

/** Read EAC/KAC off a statblock's `dataJson`, tolerating camelCase and snake_case keys. */
export function starfinderArmorClasses(d: Record<string, unknown>): StarfinderArmorClasses {
  return {
    eac: num(d.eac ?? d.energyArmorClass ?? d.energy_armor_class),
    // `armorClass`/`armor_class`/`kac` all resolve to KAC — the value the generic slot carries.
    kac: num(d.kac ?? d.kineticArmorClass ?? d.kinetic_armor_class ?? d.armorClass ?? d.armor_class),
  };
}

/**
 * Split a Starfinder statblock's damage pool into Stamina + Hit Points. Stamina soaks first,
 * so the combat-tracker max HP is their sum. Plain monsters carry only HP (stamina 0); PCs
 * and class-leveled NPCs carry both. Missing/invalid values coerce to 0.
 */
export function starfinderHitPoints(d: Record<string, unknown>): StarfinderHitPoints {
  const stamina = Math.max(0, Math.round(num(d.stamina ?? d.staminaPoints ?? d.stamina_points ?? d.sp) ?? 0));
  const hitPoints = Math.max(0, Math.round(num(d.hitPoints ?? d.hit_points ?? d.hp) ?? 0));
  return { stamina, hitPoints, total: stamina + hitPoints };
}

/**
 * The Starfinder adapter's type: the shared RuleSystemAdapter contract, with `mapStatblock`
 * widened to return the EAC/KAC/Stamina-carrying statblock and two extra helpers for the
 * sci-fi detail the single-slot base interface can't carry. Still assignable to
 * RuleSystemAdapter (StarfinderStatblockData extends MonsterStatblockData), so it registers
 * in the shared ADAPTERS map unchanged.
 */
export interface StarfinderRuleSystemAdapter extends RuleSystemAdapter {
  mapStatblock(d: Record<string, unknown>): StarfinderStatblockData;
  armorClasses(d: Record<string, unknown>): StarfinderArmorClasses;
  hitPointsBreakdown(d: Record<string, unknown>): StarfinderHitPoints;
}

/**
 * The Starfinder 1e adapter. Ability modifier and initiative are the shared d20 rules; the
 * Starfinder-specific behavior is concentrated in `mapStatblock`/`monsterHitPoints` (the
 * SP+HP pool and EAC/KAC), with `armorClasses()`/`hitPointsBreakdown()` for surfaces that
 * need the full sci-fi detail the single-slot RuleSystemAdapter interface can't carry.
 */
export const StarfinderAdapter: StarfinderRuleSystemAdapter = {
  id: STARFINDER_ADAPTER_ID,
  label: 'Starfinder 1e',
  // Same d20 ability-modifier formula as 5e/PF1e.
  abilityModifier(score: number): number {
    return Math.floor((score - 10) / 2);
  },
  initiativeDie: 20,
  // Starfinder 1e caps characters at level 20 (Core Rulebook), the same ceiling as 5e/PF.
  maxLevel: 20,
  initiativeModifier(
    abilities: Record<string, unknown> | null | undefined,
    representation: AbilityRepresentation = 'score',
  ): number {
    const dex = starfinderDexScore(abilities);
    if (dex === null) return 0;
    // Inline of resolveAbilityModifier — no runtime import from ./index (cycle).
    return representation === 'score' ? this.abilityModifier(dex) : Math.trunc(dex);
  },
  conditions: STARFINDER_CONDITIONS,
  mapStatblock(d: Record<string, unknown>): StarfinderStatblockData {
    const abilityScores = (d.abilityScores ?? d.ability_scores) as Record<string, unknown> | undefined;
    const { kac } = starfinderArmorClasses(d);
    const { total } = starfinderHitPoints(d);
    return {
      size: d.size,
      creatureType: d.type ?? d.creatureType,
      // Starfinder rates creatures by Challenge Rating like d20; some sources label it "CR".
      challengeRating: d.challengeRating ?? d.challenge_rating ?? d.cr,
      // Generic slot carries KAC (physical AC); EAC/KAC both available via armorClasses().
      armorClass: kac,
      // Generic slot carries the effective damage pool (Stamina + HP).
      hitPoints: total > 0 ? total : null,
      speed: d.speed,
      abilityScores: abilityScores && typeof abilityScores === 'object' ? abilityScores : undefined,
      abilityRepresentation: 'score',
      specialAbilities: d.specialAbilities ?? d.special_abilities,
      actions: d.actions,
      eac: d.eac ?? d.energyArmorClass ?? d.energy_armor_class ?? null,
      kac: kac,
      stamina: d.stamina ?? d.staminaPoints ?? d.stamina_points ?? d.sp ?? null,
    };
  },
  monsterHitPoints(d: Record<string, unknown>): number | null {
    const { total } = starfinderHitPoints(d);
    return total > 0 ? total : null;
  },
  armorClasses(d: Record<string, unknown>): StarfinderArmorClasses {
    return starfinderArmorClasses(d);
  },
  hitPointsBreakdown(d: Record<string, unknown>): StarfinderHitPoints {
    return starfinderHitPoints(d);
  },
};
