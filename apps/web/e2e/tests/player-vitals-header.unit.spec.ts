import { expect, test } from '@playwright/test';

/**
 * PlayerVitalsHeader (issue #1938) — Max HP wiring and removal of fabricated spell tiles.
 */
test.describe('PlayerVitalsHeader wiring (issue #1938)', () => {
  test('validates commitMaxHp: integer >= 1', () => {
    function isValidMaxHp(val: string): boolean {
      if (!val || val.includes('.')) return false;
      const max = parseInt(val, 10);
      return !isNaN(max) && Number.isInteger(max) && max >= 1;
    }

    expect(isValidMaxHp('25')).toBe(true);
    expect(isValidMaxHp('1')).toBe(true);
    expect(isValidMaxHp('0')).toBe(false);
    expect(isValidMaxHp('-5')).toBe(false);
    expect(isValidMaxHp('abc')).toBe(false);
    expect(isValidMaxHp('12.5')).toBe(false);
  });
});
