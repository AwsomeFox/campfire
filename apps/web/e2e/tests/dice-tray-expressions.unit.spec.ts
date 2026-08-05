import { expect, test } from '@playwright/test';
import {
  buildDiceTrayExprs,
  openLegendActionRollAnimationExpr,
} from '../../src/features/dice/diceTrayExpressions';

test.describe('dice tray expressions (issue #1918)', () => {
  test('submits a flat mixed pool as one compound expression with the modifier at the end', () => {
    expect(buildDiceTrayExprs({ 6: 2, 8: 1 }, 3, 'flat')).toEqual(['2d6+1d8+3']);
    expect(buildDiceTrayExprs({ 20: 1 }, -2, 'flat')).toEqual(['1d20-2']);
  });

  test('preserves keep/drop expressions for advantage and disadvantage', () => {
    expect(buildDiceTrayExprs({ 20: 1 }, 4, 'adv')).toEqual(['2d20kh1+4']);
    expect(buildDiceTrayExprs({ 20: 1 }, -1, 'dis')).toEqual(['2d20kl1-1']);
  });

  test('falls back to one expression per group when a compound pool exceeds RollRequest length', () => {
    const expressions = buildDiceTrayExprs({ 4: 20, 6: 20, 8: 20, 10: 20, 12: 20, 20: 20, 100: 20 }, 99, 'flat');

    expect(expressions).toEqual(['20d4+99', '20d6', '20d8', '20d10', '20d12', '20d20', '20d100']);
    expect(expressions.every((expression) => expression.length <= 40)).toBe(true);
  });

  test('derives Open Legend animation dice from the submitted action pool, including score-zero disadvantage', () => {
    expect(openLegendActionRollAnimationExpr(6)).toBe('1d20+1d8+1d8');
    expect(openLegendActionRollAnimationExpr(0)).toBe('1d20+1d20');
  });
});
