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

import type { AbilityRepresentation, MonsterStatblockData, RuleSystemAdapter, StatblockPresentation } from './index';
import { initModDescThenSortOrderAsc } from './initiative-tiebreak';
import { DEFAULT_STARFINDER_REST_OPTIONS } from './rest';

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
  /** Resolve Points — spent for stamina recovery, stabilization, etc. */
  resolve: number;
  /** Combat-tracker effective max HP = stamina + hitPoints. */
  total: number;
}

/** Starfinder statblock fields, widening the generic shape with EAC/KAC, Stamina, and Resolve. */
export interface StarfinderStatblockData extends MonsterStatblockData {
  /** Energy Armor Class. */
  eac: unknown;
  /** Kinetic Armor Class (also surfaced as the generic `armorClass`). */
  kac: unknown;
  /** Stamina Points sub-pool (undefined for plain monsters). */
  stamina: unknown;
  /** Resolve Points (undefined for plain monsters). */
  resolve: unknown;
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
  const eac = num(d.eac ?? d.energyArmorClass ?? d.energy_armor_class);
  const kac = num(d.kac ?? d.kineticArmorClass ?? d.kinetic_armor_class ?? d.armorClass ?? d.armor_class);
  return {
    eac,
    kac,
  };
}

/**
 * Split a Starfinder statblock's damage pool into Stamina + Hit Points + Resolve. Stamina soaks first,
 * so the combat-tracker max HP is their sum. Plain monsters carry only HP (stamina 0); PCs
 * and class-leveled NPCs carry both. Missing/invalid values coerce to 0.
 */
export function starfinderHitPoints(d: Record<string, unknown>): StarfinderHitPoints {
  const stamina = Math.max(0, Math.round(num(d.stamina ?? d.staminaPoints ?? d.stamina_points ?? d.sp) ?? 0));
  const hitPoints = Math.max(0, Math.round(num(d.hitPoints ?? d.hit_points ?? d.hp) ?? 0));
  const resolve = Math.max(0, Math.round(num(d.resolve ?? d.resolvePoints ?? d.resolve_points ?? d.rp) ?? 0));
  return { stamina, hitPoints, resolve, total: stamina + hitPoints };
}

/**
 * Starfinder 1e Damage Application Logic.
 * Damage order: Temp HP -> Stamina Points (SP) -> Hit Points (HP).
 */
export interface StarfinderDamageState {
  hpCurrent: number;
  hpMax: number;
  spCurrent: number;
  spMax: number;
  rpCurrent: number;
  rpMax: number;
  hpTemp: number;
  deathState: 'none' | 'dying' | 'stable' | 'dead';
}

export interface StarfinderDamageResult {
  hpCurrent: number;
  spCurrent: number;
  rpCurrent: number;
  hpTemp: number;
  deathState: 'none' | 'dying' | 'stable' | 'dead';
  spDamageTaken: number;
  hpDamageTaken: number;
}

export function applyStarfinderDamage(
  state: StarfinderDamageState,
  damageAmount: number,
): StarfinderDamageResult {
  let { hpCurrent, spCurrent, rpCurrent, hpTemp, deathState } = state;
  const { hpMax } = state;
  let remainingDmg = Math.max(0, damageAmount);

  let spDamageTaken = 0;
  let hpDamageTaken = 0;

  // 1. Temp HP soaks first
  const absorbedByTemp = Math.min(hpTemp, remainingDmg);
  hpTemp -= absorbedByTemp;
  remainingDmg -= absorbedByTemp;

  // 2. SP soaks second
  if (remainingDmg > 0 && spCurrent > 0) {
    spDamageTaken = Math.min(spCurrent, remainingDmg);
    spCurrent -= spDamageTaken;
    remainingDmg -= spDamageTaken;
  }

  // 3. HP soaks remaining overflow
  if (remainingDmg > 0) {
    const wasAtZeroHp = hpCurrent === 0;
    hpDamageTaken = Math.min(hpCurrent, remainingDmg);
    const overflowPastZero = remainingDmg - hpCurrent;
    hpCurrent = Math.max(0, hpCurrent - remainingDmg);

    if (hpCurrent === 0) {
      if (wasAtZeroHp || overflowPastZero >= hpMax) {
        // Taking damage while down or massive damage: loses 1 RP.
        rpCurrent = Math.max(0, rpCurrent - 1);
        if (rpCurrent === 0 || overflowPastZero >= hpMax) {
          deathState = 'dead';
        } else {
          deathState = 'dying';
        }
      } else {
        deathState = 'dying';
      }
    }
  }

  return {
    hpCurrent,
    spCurrent,
    rpCurrent,
    hpTemp,
    deathState,
    spDamageTaken,
    hpDamageTaken,
  };
}

/**
 * Starfinder 1e Rest & Recovery logic:
 * - Stamina Rest (10 minutes): Spends 1 RP to restore full SP.
 * - Night's Rest (8 hours): Restores full SP, full RP, and HP equal to character level (min 1).
 */
export function applyStarfinderRest(
  state: StarfinderDamageState,
  restType: 'stamina' | 'night' | 'short' | 'long',
  level = 1,
): { state: StarfinderDamageState; success: boolean; message: string } {
  const isStaminaRest = restType === 'stamina' || restType === 'short';
  if (isStaminaRest) {
    if (state.rpCurrent < 1) {
      return {
        state,
        success: false,
        message: 'Cannot take a Stamina Rest: requires at least 1 Resolve Point.',
      };
    }
    return {
      state: {
        ...state,
        rpCurrent: state.rpCurrent - 1,
        spCurrent: state.spMax,
      },
      success: true,
      message: '10-minute Stamina Rest completed: spent 1 RP to restore full Stamina Points.',
    };
  }

  // Night's / 8-hour Rest
  const hpHealed = Math.min(state.hpMax - state.hpCurrent, Math.max(1, level));
  return {
    state: {
      ...state,
      spCurrent: state.spMax,
      rpCurrent: state.rpMax,
      hpCurrent: Math.min(state.hpMax, state.hpCurrent + hpHealed),
      deathState: state.hpCurrent + hpHealed > 0 ? 'none' : state.deathState,
    },
    success: true,
    message: `Night's Rest completed: restored full SP, full RP, and ${hpHealed} HP.`,
  };
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
/**
 * Starfinder presentation — CR for rating; the generic defense slot carries KAC, so the
 * accessible label is Kinetic Armor Class (short KAC). EAC remains available via
 * `armorClasses()` for surfaces that show both.
 */
export const STARFINDER_STATBLOCK_PRESENTATION: StatblockPresentation = {
  rating: { full: 'Challenge Rating', short: 'CR' },
  defense: { full: 'Kinetic Armor Class', short: 'KAC' },
  hitPoints: { full: 'Stamina + Hit Points', short: 'SP + HP' },
  abilities: { full: 'Abilities' },
  actions: { full: 'Actions' },
  creatureType: { full: 'Type' },
};

const STARFINDER_CHARACTER_ABILITY_FIELDS = [
  { key: 'STR', label: 'STR' },
  { key: 'DEX', label: 'DEX' },
  { key: 'CON', label: 'CON' },
  { key: 'INT', label: 'INT' },
  { key: 'WIS', label: 'WIS' },
  { key: 'CHA', label: 'CHA' },
] as const;

/** Starfinder 1e cumulative XP thresholds (Core Rulebook — same curve as PF1e, issue #441). */
const STARFINDER_XP_THRESHOLDS = [
  0, 1_000, 3_000, 6_000, 10_000, 15_000, 21_000, 28_000, 36_000, 45_000, 55_000, 66_000, 78_000, 91_000,
  105_000, 120_000, 136_000, 153_000, 171_000, 190_000,
] as const;

function starfinderXpForLevel(level: number): number {
  const clamped = Math.max(1, Math.min(20, Math.floor(level)));
  return STARFINDER_XP_THRESHOLDS[clamped - 1]!;
}

function starfinderLevelForXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < STARFINDER_XP_THRESHOLDS.length; i++) {
    if (xp >= STARFINDER_XP_THRESHOLDS[i]!) level = i + 1;
  }
  return level;
}

export const StarfinderAdapter: StarfinderRuleSystemAdapter = {
  id: STARFINDER_ADAPTER_ID,
  label: 'Starfinder 1e',
  presentation: STARFINDER_STATBLOCK_PRESENTATION,
  // #1503 — Starfinder models 0 HP as 'dying' (recovered via Resolve Points, not a 5e death-save
  // tracker). The damage path computes the exact dying/dead outcome in applyStarfinderDamage;
  // declaring dyingAtZeroHp makes the absolute-set (hpSet) path and the character sheet agree, so
  // a Starfinder combatant reaches 'dying' at 0 HP regardless of how the zero was applied.
  hpModel: { massiveDamageInstantDeath: false, deathSaves: false, dyingAtZeroHp: true },
  characterSheet: {
    abilityFields: STARFINDER_CHARACTER_ABILITY_FIELDS,
    classField: { label: 'Class', placeholder: 'Class', required: true, visible: true },
    supportsSavingThrowEditor: true,
    supportsSkillEditor: true,
    supportsSpellSlotEditor: false,
    genericModeDescription:
      'Starfinder sheets use adapter-owned stamina, resolve, EAC/KAC, actions, and resources; 5e spell slots are not shown.',
  },
  // Same d20 ability-modifier formula as 5e/PF1e.
  abilityModifier(score: number): number {
    return Math.floor((score - 10) / 2);
  },
  initiativeDie: 20,
  // Starfinder 1e caps characters at level 20 (Core Rulebook), the same ceiling as 5e/PF.
  maxLevel: 20,
  restOptions: DEFAULT_STARFINDER_REST_OPTIONS,
  supportsXpProgression: true,
  xpForLevel: starfinderXpForLevel,
  levelForXp: starfinderLevelForXp,
  initiativeModifier(
    abilities: Record<string, unknown> | null | undefined,
    representation: AbilityRepresentation = 'score',
  ): number {
    const dex = starfinderDexScore(abilities);
    if (dex === null) return 0;
    // Inline of resolveAbilityModifier — no runtime import from ./index (cycle).
    return representation === 'score' ? this.abilityModifier(dex) : Math.trunc(dex);
  },
  // Starfinder initiative is DEX-derived like 5e/PF1e; on a tied total, higher DEX
  // (initMod) first, then sortOrder (issue #611).
  initiativeTiebreak: initModDescThenSortOrderAsc,
  conditions: STARFINDER_CONDITIONS,
  mapStatblock(d: Record<string, unknown>): StarfinderStatblockData {
    const abilityScores = (d.abilityScores ?? d.ability_scores) as Record<string, unknown> | undefined;
    const { eac, kac } = starfinderArmorClasses(d);
    const { stamina, resolve, total } = starfinderHitPoints(d);
    return {
      size: d.size,
      creatureType: d.type ?? d.creatureType,
      // Starfinder rates creatures by Challenge Rating like d20; some sources label it "CR".
      challengeRating: d.challengeRating ?? d.challenge_rating ?? d.cr,
      // Generic slot carries KAC (physical AC); EAC/KAC both available via armorClasses().
      armorClass: kac ?? eac,
      // Generic slot carries the effective damage pool (Stamina + HP).
      hitPoints: total > 0 ? total : null,
      speed: d.speed,
      abilityScores: abilityScores && typeof abilityScores === 'object' ? abilityScores : undefined,
      abilityRepresentation: 'score',
      specialAbilities: d.specialAbilities ?? d.special_abilities,
      actions: d.actions,
      eac: eac ?? d.eac ?? d.energyArmorClass ?? d.energy_armor_class ?? null,
      kac: kac ?? d.kac ?? d.kineticArmorClass ?? d.kinetic_armor_class ?? null,
      stamina: stamina > 0 ? stamina : d.stamina ?? d.staminaPoints ?? d.stamina_points ?? d.sp ?? null,
      resolve: resolve > 0 ? resolve : d.resolve ?? d.resolvePoints ?? d.resolve_points ?? d.rp ?? null,
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
