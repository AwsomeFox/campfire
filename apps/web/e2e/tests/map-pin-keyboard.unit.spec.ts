/**
 * Unit coverage for RegionMap keyboard pin helpers (#807).
 *
 * DOM/behavior regressions are covered in map-pin-keyboard.spec.ts; this file
 * pins the pure percent clamp used by coordinate inputs and PATCH payloads.
 */
import { expect, test } from '@playwright/test';
import { clampPercentInt } from '../../src/features/dashboard/RegionMap';

test.describe('clampPercentInt (#807)', () => {
  test('rounds and clamps to the 0–100 integer range', () => {
    expect(clampPercentInt(42.5)).toBe(43);
    expect(clampPercentInt(-3)).toBe(0);
    expect(clampPercentInt(150)).toBe(100);
    expect(clampPercentInt(0)).toBe(0);
    expect(clampPercentInt(100)).toBe(100);
  });

  test('non-finite values collapse to 0 (safe input/PATCH value)', () => {
    expect(clampPercentInt(Number.NaN)).toBe(0);
    expect(clampPercentInt(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampPercentInt(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
