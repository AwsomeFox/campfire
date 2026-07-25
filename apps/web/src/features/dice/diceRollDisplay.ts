import type { DiceRoll } from '@campfire/schema';
import { PHYSICAL_ROLL_EXPR } from '@campfire/schema';
import { isManualDiceRoll, physicalRollActorName } from './physicalRollForm';

/** Primary expression/label line for a dice-log row. */
export function diceRollSummaryLine(roll: DiceRoll, physicalLabel: string): string {
  const check = roll.label ? `${roll.label}: ` : '';
  if (isManualDiceRoll(roll)) {
    const nat = roll.natural20 != null ? ` (nat ${roll.natural20})` : '';
    return `${check}${physicalLabel}${roll.dc != null ? ` vs DC ${roll.dc}` : ''}${nat}`;
  }
  return `${check}${roll.expr}${roll.dc != null ? ` vs DC ${roll.dc}` : ''}`;
}

export function diceRollDisplayActor(roll: DiceRoll): string {
  return physicalRollActorName(roll);
}

export function showRolledDice(roll: DiceRoll): boolean {
  return !isManualDiceRoll(roll) && roll.rolls.length > 0;
}

export function isPhysicalRollExpr(expr: string): boolean {
  return expr === PHYSICAL_ROLL_EXPR;
}
