import { describe, it, expect } from '@jest/globals';
import { abilityMod, profBonus, resolveSavingThrow } from '../../src/modules/mcp/saving-throw-math';

/**
 * #1040: Verify the 5e saving throw math used by the `saving_throw` MCP tool.
 * Imports the production helpers so formula regressions fail here, not only in e2e.
 */

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

  describe('resolveSavingThrow', () => {
    it('proficient level-5 DEX 16 save: +6 (+3 dex, +3 prof)', () => {
      const result = resolveSavingThrow({
        stats: { DEX: 16 },
        saveProficiencies: ['DEX'],
        ability: 'DEX',
        level: 5,
      });
      expect(result).toEqual({
        score: 16,
        abilityMod: 3,
        proficient: true,
        profBonus: 3,
        bonus: 6,
      });
    });

    it('unproficient level-5 DEX 16 save: +3 (dex only)', () => {
      expect(
        resolveSavingThrow({
          stats: { DEX: 16 },
          saveProficiencies: [],
          ability: 'DEX',
          level: 5,
        }).bonus,
      ).toBe(3);
    });

    it('level-1 STR 10 unproficient: +0', () => {
      expect(
        resolveSavingThrow({
          stats: { STR: 10 },
          saveProficiencies: [],
          ability: 'STR',
          level: 1,
        }).bonus,
      ).toBe(0);
    });

    it('level-20 CON 20 proficient: +11 (+5 con, +6 prof)', () => {
      expect(
        resolveSavingThrow({
          stats: { CON: 20 },
          saveProficiencies: ['CON'],
          ability: 'CON',
          level: 20,
        }).bonus,
      ).toBe(11);
    });

    it('negative ability modifier is preserved even when proficient', () => {
      // Level-1 STR 8 proficient: STR -1 + prof 2 = +1
      expect(
        resolveSavingThrow({
          stats: { STR: 8 },
          saveProficiencies: ['STR'],
          ability: 'STR',
          level: 1,
        }).bonus,
      ).toBe(1);
    });

    it('normalizes mixed-case stats keys (issue #48)', () => {
      const result = resolveSavingThrow({
        stats: { Dex: 14 },
        saveProficiencies: [],
        ability: 'DEX',
        level: 1,
      });
      expect(result.score).toBe(14);
      expect(result.abilityMod).toBe(2);
      expect(result.bonus).toBe(2);
    });

    it('matches save proficiency case-insensitively', () => {
      const result = resolveSavingThrow({
        stats: { WIS: 12 },
        saveProficiencies: ['wis'],
        ability: 'WIS',
        level: 5,
      });
      expect(result.proficient).toBe(true);
      expect(result.bonus).toBe(4); // +1 wis +3 prof
    });

    it('defaults missing ability score to 10', () => {
      const result = resolveSavingThrow({
        stats: {},
        saveProficiencies: [],
        ability: 'CHA',
        level: 1,
      });
      expect(result.score).toBe(10);
      expect(result.bonus).toBe(0);
    });
  });
});
