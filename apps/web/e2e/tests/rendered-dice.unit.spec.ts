import { expect, test } from '@playwright/test';
import { MAX_RENDERED_DICE, renderedDiceIndices } from '../../src/features/dice/renderedDice';
import { natFlourish } from '../../src/features/dice/natFlourish';

/**
 * The tray draws a selection of a very large roll. Which dice it picks is shared
 * with the colour-vision badge, because a badge that judges the whole roll while
 * the animation only knows a subset promises a critical the tray never plays.
 */

const many = (n: number, s: number) => Array.from({ length: n }, () => s);

test.describe('renderedDiceIndices', () => {
  test('an ordinary roll is drawn whole, in order', () => {
    for (const count of [1, 2, 8, 20, MAX_RENDERED_DICE]) {
      expect(renderedDiceIndices(many(count, 6))).toEqual(
        Array.from({ length: count }, (_, i) => i),
      );
    }
  });

  test('never draws more than the budget, and always in roll order', () => {
    for (const sides of [many(41, 6), many(160, 6), many(40, 20), [...many(100, 6), ...many(60, 20)]]) {
      const picked = renderedDiceIndices(sides);
      expect(picked.length).toBeLessThanOrEqual(MAX_RENDERED_DICE);
      expect(picked).toEqual([...picked].sort((a, b) => a - b));
      expect(new Set(picked).size, 'no die drawn twice').toBe(picked.length);
      expect(picked.every((i) => i >= 0 && i < sides.length)).toBe(true);
    }
  });

  test('keeps the d20 out of a roll that is mostly d6', () => {
    // `20d6+20d6+1d20` is 14 characters and 41 dice with the d20 LAST. A plain
    // prefix dropped it, so a natural 20 animated nothing while the badge still
    // called it a critical.
    const sides = [...many(40, 6), 20];
    const picked = renderedDiceIndices(sides);
    expect(picked).toContain(40);
    expect(picked.filter((i) => sides[i] === 20)).toEqual([40]);
  });

  test('the badge and the animation see the same dice', () => {
    // The mismatch this selection exists to prevent, stated end to end.
    const sides = [...many(40, 6), 20];
    const dice = sides.map((s, i) => ({ sides: s, value: i === 40 ? 20 : 3, kept: true }));
    const drawn = renderedDiceIndices(sides).map((i) => dice[i]);
    expect(natFlourish(drawn)).toBe('crit');
    expect(natFlourish(drawn)).toBe(natFlourish(dice));
  });

  test('when even the d20s overflow, badge and animation still agree', () => {
    // 40d20 cannot all be drawn. Whatever the badge says must be true of the
    // tray, so both read the same selection rather than the whole roll.
    const sides = many(40, 20);
    const dice = sides.map((s, i) => ({ sides: s, value: i === 39 ? 20 : 7, kept: true }));
    const drawn = renderedDiceIndices(sides).map((i) => dice[i]);
    expect(drawn).toHaveLength(MAX_RENDERED_DICE);
    // The nat 20 is on a die past the budget: no badge, and no flourish either.
    expect(natFlourish(drawn)).toBeNull();
  });
});
