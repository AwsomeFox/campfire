import { openLegendAttributeDicePool } from '@campfire/schema';
import type { AdvMode, Pool } from './savedRollsState';

/** Standard polyhedral faces accepted by the shared roll endpoint. */
export const DICE_FACES = [4, 6, 8, 10, 12, 20, 100] as const;

/** RollRequest limits expressions to 40 characters. */
const MAX_ROLL_EXPR_LENGTH = 40;

function formatMod(modifier: number): string {
  if (modifier === 0) return '';
  return modifier > 0 ? `+${modifier}` : `${modifier}`;
}

export function poolEntries(pool: Pool): [number, number][] {
  return DICE_FACES.map((sides) => [sides, pool[sides] ?? 0] as [number, number]).filter(
    ([, count]) => count > 0,
  );
}

/**
 * Build the tray's server expressions. Flat pools stay one compound roll when
 * possible so the shared log and animation retain the whole result. At the
 * RollRequest cap, retain the prior safe per-group submission behavior.
 */
export function buildDiceTrayExprs(pool: Pool, modifier: number, advMode: AdvMode): string[] {
  if (advMode === 'adv') return [`2d20kh1${formatMod(modifier)}`];
  if (advMode === 'dis') return [`2d20kl1${formatMod(modifier)}`];

  const entries = poolEntries(pool);
  if (entries.length === 0) return [];

  const compound = `${entries.map(([sides, count]) => `${count}d${sides}`).join('+')}${formatMod(modifier)}`;
  if (compound.length <= MAX_ROLL_EXPR_LENGTH) return [compound];

  return entries.map(([sides, count], index) => `${count}d${sides}${index === 0 ? formatMod(modifier) : ''}`);
}

/** Expression whose dice sides match an Open Legend action roll's initial pool. */
export function openLegendActionRollAnimationExpr(score: number): string {
  const pool = openLegendAttributeDicePool(score);
  const terms = pool.dice.map((sides) => `1d${sides}`);
  return (pool.disadvantage ? [...terms, ...terms] : terms).join('+');
}
