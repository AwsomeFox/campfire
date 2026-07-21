/**
 * Shared character stat helpers (issue: encounter character cards).
 *
 * Pure, UI-agnostic helpers for reading a Character's combat numbers — ability
 * scores/modifiers, proficiency bonus, the SRD skill→ability map, and the
 * click-to-roll dice-expression builders. Extracted from CharacterPage so the
 * character sheet AND the in-encounter character card share one source of truth
 * (a sheet roll and an encounter roll must produce identical expressions/labels).
 */
import type { Character, RuleSystemAdapter } from '@campfire/schema';
import type { MouseEvent } from 'react';

export const ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;
export type Ability = (typeof ABILITY_KEYS)[number];

/** SRD 5e skill list with governing abilities. */
export const SKILLS: ReadonlyArray<{ name: string; ability: Ability }> = [
  { name: 'Acrobatics', ability: 'DEX' },
  { name: 'Animal Handling', ability: 'WIS' },
  { name: 'Arcana', ability: 'INT' },
  { name: 'Athletics', ability: 'STR' },
  { name: 'Deception', ability: 'CHA' },
  { name: 'History', ability: 'INT' },
  { name: 'Insight', ability: 'WIS' },
  { name: 'Intimidation', ability: 'CHA' },
  { name: 'Investigation', ability: 'INT' },
  { name: 'Medicine', ability: 'WIS' },
  { name: 'Nature', ability: 'INT' },
  { name: 'Perception', ability: 'WIS' },
  { name: 'Performance', ability: 'CHA' },
  { name: 'Persuasion', ability: 'CHA' },
  { name: 'Religion', ability: 'INT' },
  { name: 'Sleight of Hand', ability: 'DEX' },
  { name: 'Stealth', ability: 'DEX' },
  { name: 'Survival', ability: 'WIS' },
];

export const SPELL_LEVELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** 5e proficiency bonus by level: +2 at 1-4 up to +6 at 17-20. */
export function profBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

/**
 * Read an ability score tolerantly. `stats` is a free-keyed record, so a character
 * saved with lowercase keys (`{ str: 16 }` — schema-valid, and what some API/MCP
 * writers produce) would miss a canonical-uppercase lookup and read 10 (issue #48).
 * The server now folds keys to uppercase, but this guards data that reaches the
 * client by any other path. Defaults to 10 when the ability is absent.
 */
export function abilityScore(character: Character, ability: Ability): number {
  const stats = character.stats;
  return stats[ability] ?? stats[ability.toLowerCase()] ?? 10;
}

// Ability modifier comes from the active campaign's rule-system adapter (issue #234),
// not the 5e formula hardcoded here — so a future non-5e adapter's math takes effect.
// Default (5e) yields floor((score - 10) / 2), unchanged.
export function modOf(adapter: RuleSystemAdapter, character: Character, ability: Ability): number {
  return adapter.abilityModifier(abilityScore(character, ability));
}

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

// ---------- click-to-roll (issue #258) ----------
// The sheet already knows every number (Athletics +6, Longsword +5 / 1d8+3); these
// helpers turn those into the SAME restricted dice expressions the Dice tray posts,
// so a sheet roll lands in the shared campaign feed (POST /campaigns/:id/roll) with
// no re-typing. Advantage/disadvantage reuse the tray's 2d20kh1 / 2d20kl1 keep-die
// expressions (issue #130) — a d20 roll can be taken with advantage (shift-click) or
// disadvantage (alt/ctrl-click); damage rolls ignore the modifier keys.

export type Adv = 'flat' | 'adv' | 'dis';

/** How a modifier-key click maps to advantage/disadvantage on a d20 roll. */
export function advFromEvent(e: MouseEvent): Adv {
  if (e.shiftKey) return 'adv';
  if (e.altKey || e.ctrlKey || e.metaKey) return 'dis';
  return 'flat';
}

/** d20 check/attack expression for a numeric modifier, honouring advantage/disadvantage. */
export function d20Expr(mod: number, adv: Adv): string {
  const tail = mod === 0 ? '' : signed(mod);
  if (adv === 'adv') return `2d20kh1${tail}`;
  if (adv === 'dis') return `2d20kl1${tail}`;
  return `1d20${tail}`;
}

/**
 * Turn a free-text to-hit string ("+5", "5", "-1") into a d20 attack expression.
 * Returns null when there's no number to roll.
 */
export function toHitExpr(toHit: string, adv: Adv): string | null {
  const m = toHit.match(/[+-]?\s*\d{1,3}/);
  if (!m) return null;
  const n = parseInt(m[0].replace(/\s+/g, ''), 10);
  if (!Number.isFinite(n)) return null;
  return d20Expr(n, adv);
}

/**
 * Extract the first "NdM(+/-K)" dice group from a free-text damage string
 * ("1d8+3 slashing" -> "1d8+3", "2d6 fire" -> "2d6"). Returns null when the damage
 * field carries no dice (e.g. a flat "5 fire"), matching the server's single-group
 * expression grammar.
 */
export function damageExpr(damage: string): string | null {
  const m = damage.match(/(\d{0,2})\s*d\s*(\d{1,3})\s*([+-]\s*\d{1,3})?/i);
  if (!m) return null;
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2], 10);
  if (!count || !sides) return null;
  const mod = m[3] ? m[3].replace(/\s+/g, '') : '';
  return `${count}d${sides}${mod}`;
}
