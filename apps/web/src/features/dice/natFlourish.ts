/**
 * Which d20 flourish a settled roll earns.
 *
 * Shared because two surfaces have to agree on it: the 3D roller picks the
 * animation (gold ring and sparks, or red flash and camera shake) and the
 * overlay picks the colour-vision assist badge that explains it. They encoded
 * the rule separately, and disagreed on a kept `2d20` of [1, 20] — the roller
 * looked for a 20 across all the dice first and played the critical, while the
 * badge took whichever came first and drew a skull over it. A badge that
 * contradicts the animation is worse than no badge.
 */
export interface NatFlourishDie {
  sides: number;
  value?: number;
  /** Discarded advantage dice do not set off a flourish. */
  kept: boolean;
}

export type NatFlourish = 'crit' | 'fumble' | null;

/**
 * A natural 20 on any KEPT d20 wins; a natural 1 only counts when no 20 does.
 * Ties go to the crit deliberately — a roll that produced a 20 is a hit at the
 * table however many 1s came with it.
 */
export function natFlourish(dice: readonly NatFlourishDie[]): NatFlourish {
  const has = (value: number) =>
    dice.some((d) => d.sides === 20 && d.kept && d.value === value);
  if (has(20)) return 'crit';
  if (has(1)) return 'fumble';
  return null;
}

/** Index of the die the flourish plays on, or -1. */
export function natFlourishDieIndex(dice: readonly NatFlourishDie[]): number {
  const flourish = natFlourish(dice);
  if (!flourish) return -1;
  const value = flourish === 'crit' ? 20 : 1;
  return dice.findIndex((d) => d.sides === 20 && d.kept && d.value === value);
}
