import type { DiceRoll } from '@campfire/schema';

/**
 * Heuristic for whether a roll is plausibly damage worth applying in combat
 * (issue #1315). Excludes d20 checks/attacks/saves; requires a positive total
 * and a dice-bearing expression (or an explicit "damage" label from character
 * card rolls).
 */
export function looksLikeDamageRoll(r: Pick<DiceRoll, 'expr' | 'total' | 'label'>): boolean {
  if (r.total <= 0) return false;
  const label = (r.label ?? '').toLowerCase();
  if (label.includes('damage')) return true;
  if (label.includes('heal') || label.includes('cure')) return false;
  const expr = r.expr.trim();
  if (!/\d*d\d/i.test(expr)) return false;
  if (/d20(?!\d)/i.test(expr)) return false;
  return true;
}
