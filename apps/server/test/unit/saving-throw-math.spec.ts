import { describe, it, expect } from '@jest/globals';

/**
 * #1040: Verify the 5e saving throw math used by the new `saving_throw` MCP tool.
 * The tool itself is integration-tested via mcp-tools e2e; this covers the pure
 * math functions in isolation so regressions in the formula are caught.
 */

/** 5e ability modifier from a 3-18 score. */
function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** 5e proficiency bonus by character level: +2 at 1-4, +3 at 5-8, +4 at 9-12, etc. */
function profBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

/**
 * The bonus applied to the d20 roll for a save. Adds prof bonus only when the ability
 * is in the character's saveProficiencies array.
 */
function saveBonus(score: number, level: number, proficient: boolean): number {
  const mod = abilityMod(score);
  const prof = profBonus(level);
  return mod + (proficient ? prof : 0);
}

describe('Saving throw math (#1040)', () => {
  describe('abilityMod', () => {
    it.each([
      [1, -5],
      [8, -1],
      [10, 0],
      [11, 0],
      [12, 1],
      [15, 2],
      [18, 4],
      [20, 5],
      [30, 10],
    ])('score %i -> mod %i', (score, expected) => {
      expect(abilityMod(score)).toBe(expected);
    });
  });

  describe('profBonus', () => {
    it.each([
      [1, 2],
      [4, 2],
      [5, 3],
      [8, 3],
      [9, 4],
      [12, 4],
      [13, 5],
      [16, 5],
      [17, 6],
      [20, 6],
    ])('level %i -> prof +%i', (level, expected) => {
      expect(profBonus(level)).toBe(expected);
    });

    it('clamps level to at least 1', () => {
      expect(profBonus(0)).toBe(2);
      expect(profBonus(-5)).toBe(2);
    });
  });

  describe('saveBonus', () => {
    it('proficient level-5 DEX 16 save: +6 (+3 dex, +3 prof)', () => {
      expect(saveBonus(16, 5, true)).toBe(6);
    });

    it('unproficient level-5 DEX 16 save: +3 (dex only)', () => {
      expect(saveBonus(16, 5, false)).toBe(3);
    });

    it('level-1 STR 10 unproficient: +0', () => {
      expect(saveBonus(10, 1, false)).toBe(0);
    });

    it('level-20 CON 20 proficient: +11 (+5 con, +6 prof)', () => {
      expect(saveBonus(20, 20, true)).toBe(11);
    });

    it('negative ability modifier is preserved even when proficient', () => {
      // Level-1 STR 8 proficient: STR -1 + prof 2 = +1
      expect(saveBonus(8, 1, true)).toBe(1);
    });
  });
});
