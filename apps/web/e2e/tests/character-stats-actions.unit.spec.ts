import { expect, test } from '@playwright/test';
import {
  damageExpr,
  parseDamage,
  rollPreview,
  toHitExpr,
} from '../../src/lib/characterStats';

/**
 * Issue #718 — character action roll-notation parsing.
 *
 * The sheet's to-hit / damage fields used to silently truncate free text:
 *   - "1d20+5" became +1 (first integer wins) instead of a +5 attack roll,
 *   - compound damage "1d8+3 slashing + 1d4 cold" rolled only the first die group.
 *
 * These specs pin the strict acceptance scenarios the issue lays out:
 *   - +5, 1d20+5, negatives, flat damage, compound/type damage, and invalid dice.
 *
 * The parsers live in a pure, UI-agnostic module (`characterStats.ts`) so they
 * can be exercised exhaustively here without a browser. The ActionsCard's only
 * jobs are to render the preview these return, surface the edit affordance, and
 * post the same dice expressions the Dice tray would.
 */
test.describe('character action roll notation (issue #718)', () => {
  test.describe('toHitExpr — strict d20 attack bonus parsing', () => {
    test('+5 (the canonical form) rolls a d20 with a +5 bonus', () => {
      expect(toHitExpr('+5', 'flat')).toBe('1d20+5');
    });

    test('an unsigned "5" is accepted as a +5 bonus (lenient historical input)', () => {
      expect(toHitExpr('5', 'flat')).toBe('1d20+5');
    });

    test('1d20+5 is no longer truncated to +1 — the explicit d20 form parses whole', () => {
      // The regression the issue names directly: this used to become +1.
      expect(toHitExpr('1d20+5', 'flat')).toBe('1d20+5');
    });

    test('d20+5 (implicit count) parses the same as 1d20+5', () => {
      expect(toHitExpr('d20+5', 'flat')).toBe('1d20+5');
    });

    test('negatives roll with a penalty ("-1", "1d20-1")', () => {
      expect(toHitExpr('-1', 'flat')).toBe('1d20-1');
      expect(toHitExpr('1d20-1', 'flat')).toBe('1d20-1');
    });

    test('+0 rolls a clean 1d20 (no dangling sign)', () => {
      expect(toHitExpr('+0', 'flat')).toBe('1d20');
      expect(toHitExpr('0', 'flat')).toBe('1d20');
    });

    test('advantage/disadvantage wrap the d20 even when a bonus is present', () => {
      expect(toHitExpr('+5', 'adv')).toBe('2d20kh1+5');
      expect(toHitExpr('+5', 'dis')).toBe('2d20kl1+5');
      expect(toHitExpr('1d20+5', 'adv')).toBe('2d20kh1+5');
    });

    test('non-d20 dice are rejected as to-hit (a damage line, not an attack bonus)', () => {
      // "1d8+5" looks like a damage line; truncating it to a +5 attack would be wrong,
      // so we return null and let the UI surface it as "not rollable".
      expect(toHitExpr('1d8+5', 'flat')).toBeNull();
      expect(toHitExpr('2d6', 'flat')).toBeNull();
    });

    test('ambiguous / junk text is rejected rather than silently coerced', () => {
      expect(toHitExpr('advantage?', 'flat')).toBeNull();
      expect(toHitExpr('STR', 'flat')).toBeNull();
      expect(toHitExpr('', 'flat')).toBeNull();
      expect(toHitExpr('   ', 'flat')).toBeNull();
      // A multi-pool d20 ("2d20+5") belongs to advantage/disadvantage and must NOT
      // be silently treated as a flat +5 attack — the click modifiers express adv/dis.
      expect(toHitExpr('2d20+5', 'flat')).toBeNull();
    });
  });

  test.describe('damageExpr — compound, typed damage', () => {
    test('a single typed die ("1d8+3 slashing") keeps the inline modifier', () => {
      expect(damageExpr('1d8+3 slashing')).toBe('1d8+3');
    });

    test('a bare die ("2d6 fire") rolls the die', () => {
      expect(damageExpr('2d6 fire')).toBe('2d6');
    });

    test('compound damage now rolls EVERY die, not just the first', () => {
      // The regression the issue names directly: "1d8+3 slashing + 1d4 cold" used to
      // roll only "1d8+3" — the 1d4 cold was dropped silently.
      expect(damageExpr('1d8+3 slashing + 1d4 cold')).toBe('1d8+3+1d4');
    });

    test('three damage components all contribute', () => {
      expect(damageExpr('1d6 fire + 1d4 cold + 2 poison')).toBe('1d6+1d4');
    });

    test('compound die within one component ("1d8+1d6 piercing") survives', () => {
      expect(damageExpr('1d8+1d6 piercing')).toBe('1d8+1d6');
    });

    test('flat damage ("5 fire") has nothing to roll — returns null, not "5"', () => {
      expect(damageExpr('5 fire')).toBeNull();
      expect(damageExpr('5')).toBeNull();
    });

    test('negative modifiers on a die are preserved ("1d4-1")', () => {
      expect(damageExpr('1d4-1 poison')).toBe('1d4-1');
    });

    test('invalid die faces are not silently rolled ("1d7")', () => {
      // 7 is not a standard polyhedral face; the server would reject it. Rather than
      // roll something the server rejects, treat the component as non-rollable.
      expect(damageExpr('1d7 fire')).toBeNull();
    });

    test('empty / whitespace damage has nothing to roll', () => {
      expect(damageExpr('')).toBeNull();
      expect(damageExpr('   ')).toBeNull();
    });
  });

  test.describe('parseDamage — per-component structure', () => {
    test('preserves damage type per component', () => {
      const comps = parseDamage('1d8+3 slashing + 1d4 cold');
      expect(comps).toHaveLength(2);
      expect(comps[0]).toMatchObject({ expr: '1d8+3', type: 'slashing' });
      expect(comps[1]).toMatchObject({ expr: '1d4', type: 'cold' });
    });

    test('flat components carry their type even when not rollable', () => {
      const comps = parseDamage('5 fire');
      expect(comps).toHaveLength(1);
      expect(comps[0]).toMatchObject({ expr: null, type: 'fire' });
    });

    test('mixed rollable + flat components', () => {
      const comps = parseDamage('2d6 fire + 3 poison');
      expect(comps).toHaveLength(2);
      expect(comps[0]).toMatchObject({ expr: '2d6', type: 'fire' });
      expect(comps[1]).toMatchObject({ expr: null, type: 'poison' });
    });

    test('a component without a type label has an empty type', () => {
      const comps = parseDamage('1d8');
      expect(comps).toHaveLength(1);
      expect(comps[0]).toMatchObject({ expr: '1d8', type: '' });
    });
  });

  test.describe('rollPreview — "Campfire will roll …" disclosure', () => {
    test('classic attack + damage', () => {
      expect(rollPreview('+5', '1d8+3 slashing')).toEqual({ hit: '1d20+5', dmg: '1d8+3' });
    });

    test('explicit d20 to-hit form parses identically', () => {
      expect(rollPreview('1d20+5', '1d8+3 slashing')).toEqual({ hit: '1d20+5', dmg: '1d8+3' });
    });

    test('flat damage reports a hit but no damage roll', () => {
      expect(rollPreview('+5', '5 fire')).toEqual({ hit: '1d20+5', dmg: null });
    });

    test('non-rollable to-hit reports null so the UI can explain', () => {
      expect(rollPreview('1d8+5', '1d8+3 slashing')).toEqual({ hit: null, dmg: '1d8+3' });
    });

    test('an action with neither roll reports both null', () => {
      // A pure feature ("Second Wind") — the UI shows it as display-only text.
      expect(rollPreview('', '')).toEqual({ hit: null, dmg: null });
    });
  });
});
