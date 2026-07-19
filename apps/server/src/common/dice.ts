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
 */
const ALLOWED_SIDES = new Set([2, 4, 6, 8, 10, 12, 20, 100]);
const MAX_COUNT = 20;
const MAX_MODIFIER_ABS = 999;

export interface ParsedDiceExpr {
  count: number;
  sides: number;
  modifier: number;
}

export function parseDiceExpr(expr: string): ParsedDiceExpr {
  const match = DiceExprPattern.exec(expr);
  if (!match) {
    throw new BadRequestException(`Invalid dice expression "${expr}" — expected NdM+K, e.g. "1d20+3"`);
  }
  const count = match[1] ? parseInt(match[1], 10) : 1;
  const sides = parseInt(match[2], 10);
  const modifier = match[3] ? parseInt(match[3].replace(/\s+/g, ''), 10) : 0;

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

  return { count, sides, modifier };
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
  const { count, sides, modifier } = parseDiceExpr(expr);
  const rolls = Array.from({ length: count }, () => rollOne(sides));
  const total = rolls.reduce((sum, r) => sum + r, 0) + modifier;
  return { expr, rolls, total };
}

/** Convenience: roll a plain "d20 + mod" initiative check for a given ability modifier. */
export function rollInitiative(initMod: number): number {
  return rollOne(20) + initMod;
}
