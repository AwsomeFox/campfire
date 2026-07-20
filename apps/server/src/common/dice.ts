import { randomInt } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { DiceExprPattern, type RollResult } from '@campfire/schema';

/**
 * Tiny, SAFE dice expression parser/roller — no eval(), no dynamic Function().
 * Matches @campfire/schema's RollRequest.expr pattern (DiceExprPattern) so anything
 * that passes zod validation is guaranteed to parse here too, e.g. "1d20+3", "2d6-1",
 * "d20" (== "1d20").
 *
 * Beyond the regex shape, we further constrain to tabletop-sane bounds:
 *  - count (N): 1..20, defaults to 1 when omitted
 *  - sides (M): one of the standard polyhedral die faces {2,4,6,8,10,12,20,100}
 *  - modifier (K): |K| <= 999
 * Anything outside these bounds is a 400, even if it matched the regex.
 *
 * Optional keep/drop clause (issue #130) sits between the die and the modifier:
 *  - khN: keep the highest N dice   (advantage: "2d20kh1")
 *  - klN: keep the lowest N dice    (disadvantage: "2d20kl1")
 *  - dhN: drop the highest N dice
 *  - dlN: drop the lowest N dice    (stat-gen: "4d6dl1")
 * Keep N must be 1..count; drop N must be 1..count-1 (at least one die survives).
 */
const ALLOWED_SIDES = new Set([2, 4, 6, 8, 10, 12, 20, 100]);
const MAX_COUNT = 20;
const MAX_MODIFIER_ABS = 999;

export type KeepMode = 'kh' | 'kl' | 'dh' | 'dl';

export interface KeepSpec {
  mode: KeepMode;
  n: number;
}

export interface ParsedDiceExpr {
  count: number;
  sides: number;
  modifier: number;
  /** Present only when the expression carried a khN/klN/dhN/dlN clause. */
  keep?: KeepSpec;
}

export function parseDiceExpr(expr: string): ParsedDiceExpr {
  const match = DiceExprPattern.exec(expr);
  if (!match) {
    throw new BadRequestException(`Invalid dice expression "${expr}" — expected NdM+K, e.g. "1d20+3" or "2d20kh1"`);
  }
  const count = match[1] ? parseInt(match[1], 10) : 1;
  const sides = parseInt(match[2], 10);
  const keepClause = match[3];
  const modifier = match[4] ? parseInt(match[4].replace(/\s+/g, ''), 10) : 0;

  if (count < 1 || count > MAX_COUNT) {
    throw new BadRequestException(`Dice count must be between 1 and ${MAX_COUNT}`);
  }
  if (!ALLOWED_SIDES.has(sides)) {
    throw new BadRequestException(
      `Die sides must be one of ${[...ALLOWED_SIDES].join(', ')}`,
    );
  }
  if (Math.abs(modifier) > MAX_MODIFIER_ABS) {
    throw new BadRequestException(`Modifier must be between -${MAX_MODIFIER_ABS} and ${MAX_MODIFIER_ABS}`);
  }

  let keep: KeepSpec | undefined;
  if (keepClause) {
    const km = /^(kh|kl|dh|dl)\s*(\d{1,2})$/i.exec(keepClause.replace(/\s+/g, ''));
    // The outer regex already guarantees the shape, so km is non-null; guard anyway.
    if (!km) {
      throw new BadRequestException(`Invalid keep/drop clause "${keepClause.trim()}"`);
    }
    const mode = km[1].toLowerCase() as KeepMode;
    const n = parseInt(km[2], 10);
    if (mode === 'kh' || mode === 'kl') {
      if (n < 1 || n > count) {
        throw new BadRequestException(`Keep count must be between 1 and the number of dice (${count})`);
      }
    } else {
      // dh/dl: must leave at least one die behind.
      if (n < 1 || n >= count) {
        throw new BadRequestException(`Drop count must be between 1 and ${count - 1} (need more than one die to drop)`);
      }
    }
    keep = { mode, n };
  }

  return { count, sides, modifier, keep };
}

/**
 * Given the rolled dice and a keep/drop spec, returns the indices (into `rolls`) that
 * are KEPT — i.e. count toward the total. Ties are broken by original position so the
 * choice is deterministic and the dropped dice are unambiguous for display.
 */
function keptIndices(rolls: number[], keep: KeepSpec): number[] {
  // Order indices by value; ties keep original (ascending) order.
  const byValueAsc = rolls.map((_, i) => i).sort((a, b) => rolls[a] - rolls[b] || a - b);
  let picked: number[];
  switch (keep.mode) {
    case 'kh':
      picked = byValueAsc.slice(byValueAsc.length - keep.n);
      break;
    case 'kl':
      picked = byValueAsc.slice(0, keep.n);
      break;
    case 'dl':
      picked = byValueAsc.slice(keep.n);
      break;
    case 'dh':
    default:
      picked = byValueAsc.slice(0, byValueAsc.length - keep.n);
      break;
  }
  // Return in original roll order so `kept` lines up visually with `rolls`.
  return picked.sort((a, b) => a - b);
}

function rollOne(sides: number): number {
  // randomInt's max is exclusive -> [1, sides]
  return randomInt(1, sides + 1);
}

/**
 * Rolls a parsed dice expression using crypto.randomInt (uniform, no modulo bias) —
 * fairness matters for a shared multiplayer combat tracker where a DM/players roll
 * dice everyone can see, unlike a purely cosmetic client-side roller.
 */
export function rollDice(expr: string): RollResult {
  const { count, sides, modifier, keep } = parseDiceExpr(expr);
  // Roll ALL dice first, then keep/drop — never re-roll or discard eagerly, so the
  // full set is recorded and the kept subset is attestable against it.
  const rolls = Array.from({ length: count }, () => rollOne(sides));
  if (!keep) {
    const total = rolls.reduce((sum, r) => sum + r, 0) + modifier;
    return { expr, rolls, total };
  }
  const kept = keptIndices(rolls, keep).map((i) => rolls[i]);
  const total = kept.reduce((sum, r) => sum + r, 0) + modifier;
  return { expr, rolls, kept, total };
}

/**
 * Convenience: roll a plain "dN + mod" initiative check for a given initiative modifier.
 * The die defaults to 20 (D&D 5e). The d20 assumption is NOT baked in here — callers pass
 * the die from the campaign's RuleSystemAdapter (`adapter.initiativeDie`, issue #70); this
 * roller stays rule-system-agnostic, and every existing 5e caller gets the same d20 roll.
 */
export function rollInitiative(initMod: number, die = 20): number {
  return rollOne(die) + initMod;
}
