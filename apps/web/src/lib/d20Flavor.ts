/**
 * Crit/fumble flavour for a d20 roll (issues #67, #745).
 *
 * Matches `d20` even when preceded by a die count (`1d20+3`, `2d20kh1`) — a
 * `\bd20\b` boundary fails there because a digit is a word char — while excluding
 * `d200` via the negative lookahead. Checks the KEPT die when a keep/drop clause
 * is present (advantage/disadvantage), so a nat-20/nat-1 reflects the die that
 * actually counted, not any rolled die.
 *
 * For a COMPOUND expression (issue #536, e.g. "2d20kh1+1d4") the flat `kept` is
 * omitted (ambiguous across terms), so we read each d20 term's own kept dice from
 * `terms[]` instead — a nat-20/nat-1 must reflect a d20 term's kept die, not a
 * dropped d20 or a coincidental 1 on a different die in the flat rolls array.
 */
import type { DiceRoll } from '@campfire/schema';

export type D20Flavor = 'crit' | 'fumble';

/** True when `term` is a (keep/drop) d20 die term — optional leading `+`/`-`, not d200. */
function isD20Term(term: string): boolean {
  // Allow count (`2d20kh1`), implicit count (`d20`), and a leading sign (`+1d20` /
  // `-1d20`) from compound expression term splits. `(?!\d)` after `d20` excludes
  // `d200` / `1d200`.
  return /^[+-]?\d*d20(?!\d)/i.test(term);
}

export function d20Flavor(r: Pick<DiceRoll, 'expr' | 'rolls' | 'kept' | 'terms'>): D20Flavor | null {
  if (!/d20(?!\d)/i.test(r.expr)) return null;
  let dice: number[];
  if (r.terms) {
    // Gather the kept (or all, when no keep clause) dice from every d20 term only.
    dice = [];
    for (const t of r.terms) {
      if (!isD20Term(t.term)) continue;
      const termDice = t.kept && t.kept.length > 0 ? t.kept : t.rolls;
      if (termDice) dice.push(...termDice);
    }
    if (dice.length === 0) return null; // expr had d20 but no d20 term survived (shouldn't happen)
  } else {
    dice = r.kept && r.kept.length > 0 ? r.kept : r.rolls;
  }
  if (dice.includes(20)) return 'crit';
  if (dice.includes(1)) return 'fumble';
  return null;
}

/**
 * CSS classes for the shared dice log total (visual crit/fumble flourish).
 * `fresh` is true only for the roll the local user just submitted so polled-in
 * rolls from other players don't re-animate on every refresh.
 */
export function d20TotalClasses(flavor: D20Flavor | null, fresh: boolean): string {
  return [
    flavor === 'crit' ? 'cf-roll-crit' : flavor === 'fumble' ? 'cf-roll-fumble' : '',
    fresh ? 'cf-anim-roll' : '',
    fresh && flavor === 'crit' ? 'cf-anim-crit' : '',
    fresh && flavor === 'fumble' ? 'cf-anim-fumble' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** i18n key for the screen-reader flourish suffix spoken with the roll announcement. */
export function d20FlourishI18nKey(
  flavor: D20Flavor | null,
): 'dice.flourishCrit' | 'dice.flourishFumble' | null {
  if (flavor === 'crit') return 'dice.flourishCrit';
  if (flavor === 'fumble') return 'dice.flourishFumble';
  return null;
}
