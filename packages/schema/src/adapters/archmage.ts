/**
 * 13th Age (Archmage Engine) rule-system adapter — issue #298, part of the #275
 * open-ruleset program. 13th Age is d20-adjacent and close to 5e (same ability-score →
 * modifier curve, a d20 initiative roll), so most of the RuleSystemAdapter seam maps
 * cleanly onto it. What's DIFFERENT — and what this file captures beyond the shared
 * interface — is the **escalation die** (a rising to-hit bonus PCs gain as a fight drags
 * on), a distinct **condition vocabulary**, and monster statblocks that carry a *level*
 * and THREE defenses (AC / Physical Defense / Mental Defense) instead of a 5e-style CR.
 *
 * The base `RuleSystemAdapter` interface (packages/schema/src/index.ts) is a SHARED,
 * frozen contract every rule system implements, so the escalation-die helpers are added
 * on a widened `Archmage13aRuleSystemAdapter` interface here rather than by editing the
 * shared one. The concrete `Archmage13aAdapter` export exposes them; the registry only
 * needs the base type.
 *
 * Design notes tied to the SRD (verified against www.13thagesrd.com, 2026-07):
 *  - Escalation die: "At the start of the second round, the GM sets the escalation die at
 *    1. Each PC gains a bonus to attack rolls equal to the current value on the escalation
 *    die. Each round, the escalation die advances by +1, to a maximum of +6. Monsters and
 *    NPCs do not add the escalation die bonus to their attacks." Fear "prevents you from
 *    using the escalation die" — modelled by the `escalationPrevented` flag.
 *  - Conditions: the SRD "Conditions" list (confused, dazed, fear, hampered, helpless,
 *    stuck, stunned, vulnerable, weakened) plus the ubiquitous combat states a tracker
 *    needs (staggered, unconscious, grabbed, ongoing damage).
 *  - Ability modifier: floor((score - 10) / 2) — identical to 5e.
 *  - Initiative: d20 + Dexterity modifier + level. The generic seam only sees an ability
 *    map, so `initiativeModifier` returns the Dex modifier (like 5e); the +level term is
 *    added by callers via `levelInitiativeBonus` (monsters carry a flat Initiative in
 *    their statblock instead, surfaced from dataJson).
 */
import type { AbilityRepresentation, MonsterStatblockData, RuleSystemAdapter } from '../index';

/** Family id of the 13th Age (Archmage Engine) adapter. Matches the importer's pack slug family. */
export const ARCHMAGE_ADAPTER_ID = 'archmage';

/** Maximum value the escalation die can reach (SRD: +6). */
export const ESCALATION_DIE_MAX = 6;

/**
 * The 13th Age combat condition vocabulary offered by the tracker. The first nine are the
 * SRD's named "Conditions"; the rest are the common combat states (staggered = at or below
 * half HP, unconscious, grabbed, and ongoing damage) a session needs as togglable chips.
 * Sorted for a stable chip order.
 */
export const ARCHMAGE_CONDITIONS: readonly string[] = [
  'confused',
  'dazed',
  'fear',
  'grabbed',
  'hampered',
  'helpless',
  'ongoing damage',
  'staggered',
  'stuck',
  'stunned',
  'unconscious',
  'vulnerable',
  'weakened',
];

/** Read the governing (Dexterity) score from either a canonical or raw ability map, if numeric. */
function dexScore(abilities: Record<string, unknown> | null | undefined): number | null {
  if (!abilities) return null;
  const raw = abilities.DEX ?? abilities.dexterity ?? abilities.dex;
  return typeof raw === 'number' ? raw : null;
}

/** Coerce a possibly-string statblock number ("+4", "17") to a finite number, else null. */
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/^\+/, '').trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Options for {@link Archmage13aRuleSystemAdapter.attackModifier}. */
export interface EscalationAttackContext {
  /** 1-based combat round number. */
  round: number;
  /** PCs add the escalation die to attacks; monsters/NPCs do not. */
  isPlayerCharacter: boolean;
  /** Set when the attacker can't use the escalation die this turn (e.g. is subject to Fear). */
  escalationPrevented?: boolean;
}

/**
 * The 13th Age adapter widens the shared `RuleSystemAdapter` with the escalation-die math,
 * which has no analogue in 5e. Assignable to `RuleSystemAdapter` (and thus to the registry)
 * because it only ADDS members.
 */
export interface Archmage13aRuleSystemAdapter extends RuleSystemAdapter {
  /** Highest value the escalation die reaches (+6). */
  readonly escalationDieMax: number;
  /**
   * Value on the escalation die at the start of the given 1-based round. It is 0 in round 1
   * (not yet set), 1 at the start of round 2, then +1 per round to a max of +6. Non-finite
   * or sub-1 rounds yield 0.
   */
  escalationDieForRound(round: number): number;
  /**
   * A combatant's effective attack bonus once the escalation die is applied. PCs add the
   * current escalation die (unless `escalationPrevented`); monsters/NPCs never do.
   */
  attackModifier(baseAttackBonus: number, ctx: EscalationAttackContext): number;
  /** The +level term added to a character's initiative (init = d20 + Dex mod + level). */
  levelInitiativeBonus(level: number): number;
}

export const Archmage13aAdapter: Archmage13aRuleSystemAdapter = {
  id: ARCHMAGE_ADAPTER_ID,
  label: '13th Age',
  // Same ability-score → modifier curve as 5e: floor((score - 10) / 2).
  abilityModifier(score: number): number {
    return Math.floor((score - 10) / 2);
  },
  initiativeDie: 20,
  // 13th Age caps at level 10 (the game's "epic tier" ceiling — 10 is to 13th Age what 20 is
  // to 5e). Sourced from the adapter, not hardcoded, so a 13th-Age campaign rejects a level-11
  // level-up that 5e's hardcoded cap would wrongly allow (issue #535).
  maxLevel: 10,
  initiativeModifier(
    abilities: Record<string, unknown> | null | undefined,
    representation: AbilityRepresentation = 'score',
  ): number {
    const dex = dexScore(abilities);
    if (dex === null) return 0;
    // Inline of resolveAbilityModifier — no runtime import from ../index (cycle).
    return representation === 'score' ? this.abilityModifier(dex) : Math.trunc(dex);
  },
  conditions: ARCHMAGE_CONDITIONS,
  escalationDieMax: ESCALATION_DIE_MAX,
  escalationDieForRound(round: number): number {
    const r = Math.floor(round);
    if (!Number.isFinite(r) || r <= 1) return 0;
    return Math.min(r - 1, ESCALATION_DIE_MAX);
  },
  attackModifier(baseAttackBonus: number, ctx: EscalationAttackContext): number {
    const esc = this.escalationDieForRound(ctx.round);
    const add = ctx.isPlayerCharacter && !ctx.escalationPrevented ? esc : 0;
    return baseAttackBonus + add;
  },
  levelInitiativeBonus(level: number): number {
    const l = toNum(level);
    return l === null ? 0 : Math.trunc(l);
  },
  // 13th Age monster statblocks carry a *level* (the difficulty analog, mapped onto the
  // challengeRating slot so existing UI keeps working), an AC, and — in dataJson — PD/MD
  // and a flat Initiative. Accept 13th-Age keys first, then 5e-style fallbacks so a mixed
  // dataset still maps.
  mapStatblock(d: Record<string, unknown>): MonsterStatblockData {
    const abilityScores = (d.abilityScores ?? d.ability_scores) as Record<string, unknown> | undefined;
    return {
      size: d.size,
      creatureType: d.creatureType ?? d.type ?? d.role,
      challengeRating: d.level ?? d.challengeRating ?? d.challenge_rating ?? d.cr,
      armorClass: d.ac ?? d.armorClass ?? d.armor_class,
      hitPoints: d.hp ?? d.hitPoints ?? d.hit_points,
      speed: d.speed,
      abilityScores: abilityScores && typeof abilityScores === 'object' ? abilityScores : undefined,
      abilityRepresentation: 'score',
      specialAbilities: d.specialAbilities ?? d.special_abilities ?? d.traits,
      actions: d.actions ?? d.attacks,
    };
  },
  monsterHitPoints(d: Record<string, unknown>): number | null {
    const hp = toNum(d.hp ?? d.hitPoints ?? d.hit_points);
    return hp !== null && hp > 0 ? Math.round(hp) : null;
  },
};
