import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DiceRoll } from '@campfire/schema';
import {
  d20Flavor,
  d20FlourishI18nKey,
  d20TotalClasses,
} from '../../src/lib/d20Flavor';
import diceEn from '../../src/i18n/locales/en/dice.json';

/** Resolve from this test file so paths stay stable regardless of cwd. */
const WEB_ROOT = resolve(__dirname, '../..');

/**
 * Issue #745 — Shared Dice Log crit/fumble flourish for ordinary d20 rolls.
 *
 * The log used to gate on `/\bd20\b/`, which misses `1d20+5` (digit before `d`
 * is a word char). The shared helper matches `d20` with a negative lookahead
 * (excluding `d200`) and bases advantage/disadvantage flavour on KEPT dice only.
 *
 * These specs pin the pure flavour + visual/SR announcement contract without a
 * browser; SharedDiceLog / useRoller / RollResultBanner all consume this module.
 */

type FlavorInput = Pick<DiceRoll, 'expr' | 'rolls' | 'kept' | 'terms'>;

function roll(partial: FlavorInput): FlavorInput {
  return partial;
}

test.describe('d20Flavor — expression matching (issue #745)', () => {
  test('bare d20 with a natural 20 is a crit', () => {
    expect(d20Flavor(roll({ expr: 'd20', rolls: [20] }))).toBe('crit');
  });

  test('1d20 with a natural 1 is a fumble', () => {
    expect(d20Flavor(roll({ expr: '1d20', rolls: [1] }))).toBe('fumble');
  });

  test('1d20+5 (ordinary attack) crits — the regression the issue names', () => {
    // `\bd20\b` fails here because the leading `1` is a word character.
    expect(
      d20Flavor(
        roll({
          expr: '1d20+5',
          rolls: [20],
          terms: [
            { term: '1d20', value: 20, rolls: [20] },
            { term: '+5', value: 5 },
          ],
        }),
      ),
    ).toBe('crit');
  });

  test('1d20+5 with a natural 1 is a fumble', () => {
    expect(
      d20Flavor(
        roll({
          expr: '1d20+5',
          rolls: [1],
          terms: [
            { term: '1d20', value: 1, rolls: [1] },
            { term: '+5', value: 5 },
          ],
        }),
      ),
    ).toBe('fumble');
  });

  test('d20+3 (implicit count + modifier) crits', () => {
    expect(
      d20Flavor(
        roll({
          expr: 'd20+3',
          rolls: [20],
          terms: [
            { term: 'd20', value: 20, rolls: [20] },
            { term: '+3', value: 3 },
          ],
        }),
      ),
    ).toBe('crit');
  });

  test('uppercase D20 expressions match case-insensitively', () => {
    expect(d20Flavor(roll({ expr: '1D20', rolls: [20] }))).toBe('crit');
    expect(
      d20Flavor(
        roll({
          expr: '1D20+5',
          rolls: [1],
          terms: [
            { term: '1D20', value: 1, rolls: [1] },
            { term: '+5', value: 5 },
          ],
        }),
      ),
    ).toBe('fumble');
  });

  test('d200 is excluded — a d200 face of 20 is not a crit', () => {
    expect(d20Flavor(roll({ expr: 'd200', rolls: [20] }))).toBeNull();
    expect(d20Flavor(roll({ expr: '1d200', rolls: [1] }))).toBeNull();
  });

  test('non-d20 dice never flourish', () => {
    expect(d20Flavor(roll({ expr: '2d6+4', rolls: [6, 6] }))).toBeNull();
    expect(d20Flavor(roll({ expr: '1d8', rolls: [1] }))).toBeNull();
  });

  test('a middling d20 face is plain', () => {
    expect(d20Flavor(roll({ expr: '1d20+5', rolls: [11], terms: [
      { term: '1d20', value: 11, rolls: [11] },
      { term: '+5', value: 5 },
    ] }))).toBeNull();
  });
});

test.describe('d20Flavor — keep-high / keep-low (issue #745)', () => {
  test('advantage (2d20kh1): crit only when the KEPT die is 20', () => {
    expect(
      d20Flavor(roll({ expr: '2d20kh1', rolls: [20, 7], kept: [20] })),
    ).toBe('crit');
    expect(
      d20Flavor(roll({ expr: '2d20kh1', rolls: [20, 7], kept: [7] })),
    ).toBeNull();
  });

  test('disadvantage (2d20kl1): fumble only when the KEPT die is 1', () => {
    expect(
      d20Flavor(roll({ expr: '2d20kl1', rolls: [1, 14], kept: [1] })),
    ).toBe('fumble');
    expect(
      d20Flavor(roll({ expr: '2d20kl1', rolls: [1, 14], kept: [14] })),
    ).toBeNull();
  });

  test('a discarded natural 20 does not crit under disadvantage', () => {
    // rolls include 20, but kl1 kept the 3 — must NOT flourish.
    expect(
      d20Flavor(roll({ expr: '2d20kl1', rolls: [20, 3], kept: [3] })),
    ).toBeNull();
  });

  test('a discarded natural 1 does not fumble under advantage', () => {
    expect(
      d20Flavor(roll({ expr: '2d20kh1', rolls: [1, 15], kept: [15] })),
    ).toBeNull();
  });

  test('compound advantage with a modifier reads the d20 term kept die', () => {
    expect(
      d20Flavor(
        roll({
          expr: '2d20kh1+5',
          rolls: [20, 8],
          kept: [20],
          terms: [
            { term: '2d20kh1', value: 20, rolls: [20, 8], kept: [20] },
            { term: '+5', value: 5 },
          ],
        }),
      ),
    ).toBe('crit');
    expect(
      d20Flavor(
        roll({
          expr: '2d20kl1+5',
          rolls: [20, 4],
          kept: [4],
          terms: [
            { term: '2d20kl1', value: 4, rolls: [20, 4], kept: [4] },
            { term: '+5', value: 5 },
          ],
        }),
      ),
    ).toBeNull();
  });

  test('a coincidental 1 on a damage die does not fumble a d20 attack', () => {
    expect(
      d20Flavor(
        roll({
          expr: '1d20+1d4',
          rolls: [12, 1],
          terms: [
            { term: '1d20', value: 12, rolls: [12] },
            { term: '1d4', value: 1, rolls: [1] },
          ],
        }),
      ),
    ).toBeNull();
  });

  test('a dropped d20 in a multi-die-term keep expression cannot fake a crit', () => {
    // Flat `kept` is omitted when 2+ die terms carry keep clauses; only terms[].kept counts.
    expect(
      d20Flavor(
        roll({
          expr: '2d20kh1+1d4',
          rolls: [20, 5, 3],
          terms: [
            { term: '2d20kh1', value: 5, rolls: [20, 5], kept: [5] },
            { term: '1d4', value: 3, rolls: [3] },
          ],
        }),
      ),
    ).toBeNull();
  });
});

test.describe('visual + screen-reader crit/fumble announcements (issue #745)', () => {
  test('fresh crit totals get the gold colour + flourish animation classes', () => {
    const classes = d20TotalClasses('crit', true);
    expect(classes.split(/\s+/)).toEqual(
      expect.arrayContaining(['cf-roll-crit', 'cf-anim-roll', 'cf-anim-crit']),
    );
    expect(classes).not.toMatch(/fumble/);
  });

  test('fresh fumble totals get the rose colour + shudder animation classes', () => {
    const classes = d20TotalClasses('fumble', true);
    expect(classes.split(/\s+/)).toEqual(
      expect.arrayContaining(['cf-roll-fumble', 'cf-anim-roll', 'cf-anim-fumble']),
    );
    expect(classes).not.toMatch(/crit/);
  });

  test('polled-in (non-fresh) crits keep colour but do not re-animate', () => {
    expect(d20TotalClasses('crit', false)).toBe('cf-roll-crit');
    expect(d20TotalClasses(null, false)).toBe('');
  });

  test('screen-reader flourish keys map to spoken critical / fumble copy', () => {
    expect(d20FlourishI18nKey('crit')).toBe('dice.flourishCrit');
    expect(d20FlourishI18nKey('fumble')).toBe('dice.flourishFumble');
    expect(d20FlourishI18nKey(null)).toBeNull();

    expect(diceEn.dice.flourishCrit).toMatch(/critical/i);
    expect(diceEn.dice.flourishFumble).toMatch(/fumble/i);
    // The roll announcement template must actually interpolate the flourish.
    expect(diceEn.dice.announceRoll).toContain('{{flourish}}');
  });

  test('stylesheet defines the crit/fumble flourish selectors the classes target', () => {
    const css = readFileSync(join(WEB_ROOT, 'src/index.css'), 'utf8');
    for (const sel of ['.cf-roll-crit', '.cf-roll-fumble', '.cf-anim-crit', '.cf-anim-fumble', '.cf-crit-spark']) {
      expect(css, `missing ${sel}`).toContain(sel);
    }
  });

  test('end-to-end flavour → classes → announce key for an ordinary 1d20+5 crit', () => {
    const flavor = d20Flavor(
      roll({
        expr: '1d20+5',
        rolls: [20],
        terms: [
          { term: '1d20', value: 20, rolls: [20] },
          { term: '+5', value: 5 },
        ],
      }),
    );
    expect(flavor).toBe('crit');
    expect(d20TotalClasses(flavor, true)).toContain('cf-anim-crit');
    expect(d20FlourishI18nKey(flavor)).toBe('dice.flourishCrit');
    // Simulate what SharedDiceLog announces: template + flourish suffix.
    const spoken = diceEn.dice.announceRoll
      .replace('{{label}}', '')
      .replace('{{expr}}', '1d20+5')
      .replace('{{total}}', '25')
      .replace('{{rolls}}', '20')
      .replace('{{kept}}', '')
      .replace('{{check}}', '')
      .replace('{{flourish}}', diceEn.dice.flourishCrit);
    expect(spoken).toMatch(/1d20\+5/);
    expect(spoken).toMatch(/critical/i);
  });
});
