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

  // Devin review on PR #2062: `recharge` carries EITHER a die condition OR a rest cadence.
  // Branching on "non-empty" instead of "parses as a die roll" printed the raw slug and
  // swallowed the count, so a pool that IS tracked on `max` rendered with no idea how many
  // uses were left. A test asserting only the die-condition cases passes against that bug.
  test('a rest cadence alongside an X/day pool still shows the remaining count, not the cadence', () => {
    for (const recharge of ['short-rest', 'long-rest', 'dawn']) {
      const uses: UsableActionUses = { max: 3, recharge, spent: 1, available: 2 };
      expect(usesBadge(uses, t)).toBe('3/day · 2 left');
    }
  });

  test('a rest cadence with no X/day pool does not render the raw cadence slug', () => {
    const uses: UsableActionUses = { max: 0, recharge: 'long-rest', spent: 0, available: 0 };
    expect(usesBadge(uses, t)).not.toContain('long-rest');
  });
});
