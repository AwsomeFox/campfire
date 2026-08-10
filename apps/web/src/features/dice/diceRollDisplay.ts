import type { DiceRoll, DiceRollKind } from '@campfire/schema';
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

/**
 * Shared dice log grouping/colour by roll kind (issue #2155). One `tag-*` class per
 * kind, reusing the existing chip system (see `.tag`/`.tag-*` in nocturne.css) rather
 * than introducing new colour tokens. `undefined` (unclassified — a pre-#2155 row, or
 * a manual/physical entry this server never guesses a kind for) renders no badge at
 * all, which is the honest answer: it is not wrong, it is unknown.
 */
export function diceRollKindTagClass(kind: DiceRollKind | undefined): string | null {
  switch (kind) {
    case 'to-hit':
      return 'tag-accent';
    case 'damage':
      return 'tag-amber';
    case 'check':
      return 'tag-accent-2';
    case 'roll':
      return 'tag-neutral';
    default:
      return null;
  }
}

/** i18n key for a roll kind's short badge label; null when `diceRollKindTagClass` is null. */
export function diceRollKindLabelKey(
  kind: DiceRollKind | undefined,
): 'dice.kindToHit' | 'dice.kindDamage' | 'dice.kindCheck' | 'dice.kindRoll' | null {
  switch (kind) {
    case 'to-hit':
      return 'dice.kindToHit';
    case 'damage':
      return 'dice.kindDamage';
    case 'check':
      return 'dice.kindCheck';
    case 'roll':
      return 'dice.kindRoll';
    default:
      return null;
  }
}
