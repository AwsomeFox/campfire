/**
 * Limited-use/recharge action badge formatting (issue #1921) — pure formatting logic, no
 * component render or backend needed. Uses the same fallback shape react-i18next's `t`
 * falls back to when a key/locale isn't loaded (return `defaultValue` verbatim).
 */
import { expect, test } from '@playwright/test';
import type { UsableActionUses } from '@campfire/schema';
import { usesBadge, type Translate } from '../../src/features/encounters/CombatantActionsList';

const t: Translate = (_key, opts) => opts?.defaultValue ?? _key;

test.describe('usesBadge (issue #1921)', () => {
  test('a ready recharge action shows only the recharge range', () => {
    const uses: UsableActionUses = { max: 1, recharge: 'recharge-5-6', spent: 0, available: 1 };
    expect(usesBadge(uses, t)).toBe('Recharge 5–6');
  });

  test('a spent recharge action appends "spent"', () => {
    const uses: UsableActionUses = { max: 1, recharge: 'recharge-5-6', spent: 1, available: 0 };
    expect(usesBadge(uses, t)).toBe('Recharge 5–6 · spent');
  });

  test('a single-value recharge condition (min === max) uses the singular phrase', () => {
    const uses: UsableActionUses = { max: 1, recharge: 'recharge-6-6', spent: 1, available: 0 };
    expect(usesBadge(uses, t)).toBe('Recharge 6 · spent');
  });

  test('an X/day pool always shows the remaining count, even at 0', () => {
    const uses: UsableActionUses = { max: 1, recharge: '', spent: 1, available: 0 };
    expect(usesBadge(uses, t)).toBe('1/day · 0 left');
  });

  test('an X/day pool with uses remaining shows the count', () => {
    const uses: UsableActionUses = { max: 3, recharge: '', spent: 1, available: 2 };
    expect(usesBadge(uses, t)).toBe('3/day · 2 left');
  });
});
