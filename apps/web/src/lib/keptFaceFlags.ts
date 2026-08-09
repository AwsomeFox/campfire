/**
 * Which of a roll's faces actually counted, one flag per entry of `rolls`.
 *
 * The flat `kept` array is only emitted when a roll has exactly ONE die term
 * (see apps/server/src/common/dice.ts): across two die terms a dropped face in
 * one could positionally match a kept face in the other, so the server omits it
 * rather than publish something ambiguous, and `terms[].kept` becomes the source
 * of truth. `d20Flavor` already reads terms for that reason.
 *
 * Anything reading the flat `kept` alone therefore treats every die in a
 * compound keep/drop roll — `2d20kh1+1d4` — as counted: the dropped d20 renders
 * as though it mattered.
 *
 * Reconstruction is positional and safe because the flat `rolls` is the ordered
 * concatenation of each die term's own `rolls`, and each term's `kept` is
 * unambiguous within its own dice.
 */
import type { DiceRoll } from '@campfire/schema';

/** Positional kept flags for one term's rolls, matching its kept faces by multiset. */
function flagsForTerm(rolls: readonly number[], kept?: readonly number[]): boolean[] {
  // No keep clause on this term: every die it rolled counted.
  if (!kept) return rolls.map(() => true);
  const remaining = new Map<number, number>();
  for (const face of kept) remaining.set(face, (remaining.get(face) ?? 0) + 1);
  return rolls.map((face) => {
    const left = remaining.get(face) ?? 0;
    if (left > 0) {
      remaining.set(face, left - 1);
      return true;
    }
    return false;
  });
}

export function keptFaceFlags(
  roll: Pick<DiceRoll, 'rolls' | 'kept' | 'terms'>,
): boolean[] {
  const rolls = roll.rolls ?? [];
  if (roll.terms && roll.terms.length > 0) {
    const flags: boolean[] = [];
    for (const term of roll.terms) {
      // Modifier terms roll no dice and contribute no faces.
      if (!term.rolls) continue;
      flags.push(...flagsForTerm(term.rolls, term.kept));
    }
    // Only trust the reconstruction when it lines up with the faces it describes;
    // a shape we did not anticipate should fade nothing rather than fade wrongly.
    if (flags.length === rolls.length) return flags;
  }
  if (roll.kept && roll.kept.length > 0) return flagsForTerm(rolls, roll.kept);
  return rolls.map(() => true);
}
