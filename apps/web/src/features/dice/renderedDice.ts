/**
 * Which dice of a roll the 3D tray actually draws.
 *
 * Shared, and three.js-free, because two surfaces have to agree on it: the
 * roller builds a rig per chosen die, and the overlay's colour-vision badge
 * describes the flourish those rigs produce. A badge computed over the whole
 * roll while the animation only knows about a subset is a star with no critical
 * behind it.
 */

/**
 * Most dice a roll draws.
 *
 * The grammar caps dice per TERM at 20 and does not cap terms, and `expr` allows
 * 40 characters — so `20d6+20d6+...` eight times over is a legal 160-die roll.
 * Every die is a mesh, an edge pass and a shadow quad, and separation is
 * all-pairs, so drawing all 160 costs over a thousand draw calls a frame and a
 * five-million-iteration relaxation before the first one. That is a frozen phone
 * in exchange for a pile nobody can count anyway.
 *
 * The overlay is decorative — `role="presentation"`, `aria-hidden` — and the
 * authoritative faces are in the result toast and the shared dice log, which
 * both report the full roll. So past this many, it shows a handful and lets
 * those surfaces carry the result.
 */
export const MAX_RENDERED_DICE = 24;

/**
 * Indices of the dice to draw, in roll order.
 *
 * d20s are taken first. Taking a plain prefix instead dropped the d20 from
 * `20d6+20d6+1d20` — 41 dice, the d20 last — so a natural 20 there animated
 * nothing while the badge still called it a critical. A d20 is the only die that
 * earns a flourish, and there are rarely many, so keeping them costs a couple of
 * d6 nobody was counting.
 *
 * When even the d20s overflow the budget the flourish may genuinely be on a die
 * that is not drawn; the badge reads this same selection, so it agrees with the
 * animation either way rather than promising something the tray never shows.
 */
export function renderedDiceIndices(sides: readonly number[]): number[] {
  if (sides.length <= MAX_RENDERED_DICE) return sides.map((_, i) => i);
  const flourishing: number[] = [];
  const rest: number[] = [];
  for (const [i, s] of sides.entries()) (s === 20 ? flourishing : rest).push(i);
  const picked = flourishing.slice(0, MAX_RENDERED_DICE);
  for (const i of rest) {
    if (picked.length >= MAX_RENDERED_DICE) break;
    picked.push(i);
  }
  // Back into roll order, so the tray still reads left to right as thrown.
  return picked.sort((a, b) => a - b);
}
