import { expect, test } from '@playwright/test';
import { keptFaceFlags } from '../../src/lib/keptFaceFlags';

/**
 * The server publishes the flat `kept` array only when a roll has ONE die term;
 * with two it would be ambiguous (a dropped face in one term can positionally
 * match a kept face in another), so it omits it and `terms[].kept` becomes the
 * truth. Anything reading the flat array alone therefore treats a compound
 * keep/drop roll as though every die counted.
 */

test.describe('keptFaceFlags', () => {
  test('a compound keep/drop roll fades the die that was dropped', () => {
    // `2d20kh1+1d4`: no flat `kept`, so this used to mark all three as counted.
    expect(
      keptFaceFlags({
        rolls: [20, 3, 2],
        terms: [
          { term: '2d20kh1', value: 20, rolls: [20, 3], kept: [20] },
          { term: '1d4', value: 2, rolls: [2] },
        ],
      }),
    ).toEqual([true, false, true]);
  });

  test('the single-term shapes still work off the flat kept', () => {
    // Advantage and disadvantage: one die term, so the server does publish it.
    expect(keptFaceFlags({ rolls: [14, 18], kept: [18] })).toEqual([false, true]);
    expect(keptFaceFlags({ rolls: [14, 18], kept: [14] })).toEqual([true, false]);
    // Duplicate faces are matched by count, not by value alone.
    expect(keptFaceFlags({ rolls: [7, 7, 2], kept: [7] })).toEqual([true, false, false]);
  });

  test('a roll with nothing dropped counts every die', () => {
    expect(keptFaceFlags({ rolls: [3, 5, 6] })).toEqual([true, true, true]);
    expect(keptFaceFlags({ rolls: [] })).toEqual([]);
    // Modifier terms roll no dice and contribute no faces.
    expect(
      keptFaceFlags({
        rolls: [4, 6],
        terms: [
          { term: '2d6', value: 10, rolls: [4, 6] },
          { term: '+3', value: 3 },
        ],
      }),
    ).toEqual([true, true]);
  });

  test('a shape we cannot line up fades nothing rather than fading wrongly', () => {
    // If the terms ever stop accounting for every face, guessing which die was
    // dropped is worse than showing them all: the roll is still legible, just
    // undimmed. The flat kept is the fallback, then all-kept.
    expect(
      keptFaceFlags({
        rolls: [20, 3, 2],
        terms: [{ term: '2d20kh1', value: 20, rolls: [20, 3], kept: [20] }],
        kept: [20],
      }),
    ).toEqual([true, false, false]);
    expect(
      keptFaceFlags({
        rolls: [20, 3, 2],
        terms: [{ term: '2d20kh1', value: 20, rolls: [20, 3], kept: [20] }],
      }),
    ).toEqual([true, true, true]);
  });
});
