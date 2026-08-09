import { expect, test } from '@playwright/test';
import { flourishHeroIndex } from '../../src/features/dice/natFlourish';
import { d20Flavor } from '../../src/lib/d20Flavor';
import { keptFaceFlags } from '../../src/lib/keptFaceFlags';

/**
 * The dice tray must agree with the rest of the app about what a roll was.
 * `d20Flavor` decides whether there is a flourish; this decides which drawn die
 * wears it. Both the roller and the colour-vision badge read the second, so they
 * cannot describe different outcomes.
 */

const d20 = (value: number, kept = true) => ({ sides: 20, value, kept });

test.describe('flourishHeroIndex', () => {
  test('finds the die carrying the flavor, and only a kept one', () => {
    expect(flourishHeroIndex('crit', [d20(1), d20(20)])).toBe(1);
    expect(flourishHeroIndex('fumble', [d20(1), d20(20)])).toBe(0);
    // Advantage threw this 20 away; it is not the die the roll turned on.
    expect(flourishHeroIndex('crit', [d20(20, false), d20(13)])).toBe(-1);
  });

  test('no flavor, no hero — and a hero the tray did not draw is no hero', () => {
    expect(flourishHeroIndex(null, [d20(20)])).toBe(-1);
    // A large roll draws a selection; the badge reads this same answer, so both
    // stay silent rather than one promising a critical the tray never shows.
    expect(flourishHeroIndex('crit', [d20(7), d20(13)])).toBe(-1);
    expect(flourishHeroIndex('crit', [])).toBe(-1);
  });

  test('only a d20 can wear one', () => {
    expect(flourishHeroIndex('crit', [{ sides: 100, value: 20, kept: true }])).toBe(-1);
    expect(flourishHeroIndex('fumble', [{ sides: 6, value: 1, kept: true }])).toBe(-1);
  });
});

test.describe('the tray agrees with d20Flavor', () => {
  test('a pooled 2d20 never flourishes, however its faces land', () => {
    // `2d20` sums both faces — there is no natural result to celebrate, which is
    // why d20Flavor excludes pooled terms. Deciding from `sides === 20` in the
    // overlay made the tray flourish on rolls the toast called ordinary.
    const roll = { expr: '2d20', rolls: [20, 1], source: 'rolled' as const };
    expect(d20Flavor(roll)).toBeNull();
    const dice = roll.rolls.map((v, i) => ({ sides: 20, value: v, kept: keptFaceFlags(roll)[i] }));
    expect(flourishHeroIndex(d20Flavor(roll), dice)).toBe(-1);
  });

  test('a compound keep/drop roll flourishes on the kept d20, not the dropped one', () => {
    // `2d20kh1+1d4` has no unambiguous flat `kept`, so the server omits it. Read
    // naively, every die looks kept — and the DROPPED 20 drove the flourish.
    const roll = {
      expr: '2d20kh1+1d4',
      rolls: [20, 3, 2],
      source: 'rolled' as const,
      terms: [
        { term: '2d20kh1', value: 20, rolls: [20, 3], kept: [20] },
        { term: '1d4', value: 2, rolls: [2] },
      ],
    };
    const flags = keptFaceFlags(roll);
    expect(flags).toEqual([true, false, true]);
    expect(d20Flavor(roll)).toBe('crit');
    const dice = roll.rolls.map((v, i) => ({ sides: i < 2 ? 20 : 4, value: v, kept: flags[i] }));
    expect(flourishHeroIndex(d20Flavor(roll), dice)).toBe(0);
  });

  test('a compound roll whose kept d20 is the LOW one fumbles on that die', () => {
    const roll = {
      expr: '2d20kl1+1d4',
      rolls: [20, 1, 2],
      source: 'rolled' as const,
      terms: [
        { term: '2d20kl1', value: 1, rolls: [20, 1], kept: [1] },
        { term: '1d4', value: 2, rolls: [2] },
      ],
    };
    const flags = keptFaceFlags(roll);
    expect(flags).toEqual([false, true, true]);
    expect(d20Flavor(roll)).toBe('fumble');
    const dice = roll.rolls.map((v, i) => ({ sides: i < 2 ? 20 : 4, value: v, kept: flags[i] }));
    // The discarded 20 must not steal it.
    expect(flourishHeroIndex(d20Flavor(roll), dice)).toBe(1);
  });
});
