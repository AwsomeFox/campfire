/**
 * Timing budget for the 3D dice roll, shared by the roller and the overlay that
 * hosts it.
 *
 * These live in their own three.js-free module for one reason: `DiceRollOverlay`
 * has to know how long a roll can possibly take (it arms a backstop against a
 * frozen animation) but must reach `dice3d.ts` only through a dynamic import, or
 * three lands in the entry chunk. A duplicated number on each side is exactly
 * what let the backstop silently drift under the animation it was guarding.
 */

/** Gap between one die leaving the hold and the next. */
export const STAGGER_MS = 70;
/**
 * Ceiling on the whole stagger, however many dice are thrown.
 *
 * The server caps dice per TERM at 20 but does not cap terms, so `20d6+20d6+20d6`
 * is a legal 60-die roll. At a flat 70ms each the last die would not begin
 * falling until 4.1s in — past the overlay's backstop, so it was cut off mid-air
 * having never landed. Beyond a handful of dice the stagger is a flourish, not
 * information, so it compresses instead of accumulating.
 */
export const MAX_TOTAL_STAGGER_MS = 600;

/** Alignment nudge after the die is already at rest — a few degrees of rocking flat. */
export const ALIGN_MS = 220;
export const ALIGN_MS_REDUCED = 120;

/**
 * How long the flourish plays before the overlay hands off to the result toast.
 * A plain roll only needs the eye to register the faces; a crit/fumble needs its
 * ring, flash and sparks to read.
 */
export const LINGER_MS = 260;
export const LINGER_MS_FLOURISH = 620;

/**
 * Longest flight the integrator produces, in ms. Measured at 84 frames (1400ms)
 * over 60k sampled throws; `dice3d-throw.unit.spec.ts` holds the line so this
 * cannot drift under a change to gravity, bounce or the settle threshold.
 */
export const MAX_TRAJECTORY_MS = 1600;

/** Longest a roll can legitimately run, from release to hand-off. */
export const MAX_ANIMATION_MS =
  MAX_TOTAL_STAGGER_MS + MAX_TRAJECTORY_MS + ALIGN_MS + LINGER_MS_FLOURISH;

/** When die `i` of `count` is released, relative to the throw starting. */
export function dieDelayMs(i: number, count: number): number {
  if (count < 2) return 0;
  return i * Math.min(STAGGER_MS, MAX_TOTAL_STAGGER_MS / (count - 1));
}
