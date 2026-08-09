import { expect, test } from '@playwright/test';
import { natFlourish, natFlourishDieIndex } from '../../src/features/dice/natFlourish';

/**
 * One rule, two consumers: the 3D roller picks the animation and the overlay
 * picks the colour-vision badge that explains it. They used to decide separately
 * and could disagree, which is the only reason this is its own module.
 */

const d20 = (value: number, kept = true) => ({ sides: 20, value, kept });

test.describe('natFlourish', () => {
  test('a kept natural 20 outranks a kept natural 1 in the same roll', () => {
    // The case that broke it: the badge took whichever die came first and drew a
    // skull over the gold critical the roller was playing.
    expect(natFlourish([d20(1), d20(20)])).toBe('crit');
    expect(natFlourish([d20(20), d20(1)])).toBe('crit');
    // And the flourish plays on the 20, whichever end of the roll it landed on.
    expect(natFlourishDieIndex([d20(1), d20(20)])).toBe(1);
    expect(natFlourishDieIndex([d20(20), d20(1)])).toBe(0);
  });

  test('a discarded die never sets off a flourish', () => {
    // Disadvantage keeps the 1 and throws the 20 away: the roll is a fumble.
    expect(natFlourish([d20(20, false), d20(1)])).toBe('fumble');
    // Advantage keeps the 20 and throws the 1 away: no fumble anywhere.
    expect(natFlourish([d20(1, false), d20(20)])).toBe('crit');
    expect(natFlourish([d20(20, false), d20(1, false)])).toBeNull();
  });

  test('only a d20 has a nat 20 or a nat 1', () => {
    expect(natFlourish([{ sides: 12, value: 1, kept: true }])).toBeNull();
    expect(natFlourish([{ sides: 100, value: 20, kept: true }])).toBeNull();
    expect(natFlourish([{ sides: 6, value: 1, kept: true }])).toBeNull();
  });

  test('an ordinary roll earns nothing, and neither does an unsettled one', () => {
    expect(natFlourish([d20(13)])).toBeNull();
    expect(natFlourish([])).toBeNull();
    // Values are absent until the server answers.
    expect(natFlourish([{ sides: 20, kept: true }])).toBeNull();
    expect(natFlourishDieIndex([d20(13)])).toBe(-1);
  });
});
