/**
 * Which die the crit/fumble flourish plays on.
 *
 * WHETHER a roll earns one is not decided here — `../../lib/d20Flavor` owns that,
 * and has since issue #67. It already knows the things a side count cannot: that
 * a pooled `2d20+5` sums its faces and so has no single natural result, that a
 * compound roll's kept dice live in `terms[]`, and that a manual total is not a
 * roll at all. Deciding again from `sides === 20` made the dice tray disagree
 * with the toast, the audio cue and the screen reader about the same roll.
 *
 * What is left is a rendering question the flavor cannot answer: WHICH die on the
 * tray to lift and ring. Shared, because the roller animates that die and the
 * overlay's colour-vision badge describes what it animated — and the tray draws
 * only a selection of a large roll, so a badge that assumed the die was present
 * would promise a flourish nobody could see.
 */
import type { D20Flavor } from '../../lib/d20Flavor';

export interface FlourishDie {
  sides: number;
  value?: number;
  /** Discarded advantage dice are not the die the flourish belongs to. */
  kept: boolean;
}

/**
 * Index of the die to play `flavor` on, among the dice actually DRAWN, or -1.
 *
 * -1 is a real answer, not a failure: the flourish's die may be one the tray had
 * no room for. Both surfaces read this, so they stay silent together rather than
 * one of them claiming a critical the other never shows.
 */
export function flourishHeroIndex(
  flavor: D20Flavor | null,
  dice: readonly FlourishDie[],
): number {
  if (!flavor) return -1;
  const face = flavor === 'crit' ? 20 : 1;
  return dice.findIndex((d) => d.sides === 20 && d.kept && d.value === face);
}
