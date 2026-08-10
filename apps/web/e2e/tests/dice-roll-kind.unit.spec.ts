import { expect, test } from '@playwright/test';
import type { DiceRollKind } from '@campfire/schema';
import { diceRollKindLabelKey, diceRollKindTagClass } from '../../src/features/dice/diceRollDisplay';
import diceEn from '../../src/i18n/locales/en/dice.json';

/**
 * Shared dice log grouping/colour by roll kind (issue #2155). Pure-function coverage for
 * the two lookups `SharedDiceLog` renders the kind badge from — one per kind, plus the
 * `undefined` (unclassified: a pre-#2155 row, or a manual/physical entry) no-badge case.
 */
test.describe('dice roll kind badge (#2155)', () => {
  const kinds: DiceRollKind[] = ['to-hit', 'damage', 'check', 'roll'];

  test('every classified kind gets a distinct tag class and a resolvable i18n label', () => {
    const seenClasses = new Set<string>();
    for (const kind of kinds) {
      const cls = diceRollKindTagClass(kind);
      const labelKey = diceRollKindLabelKey(kind);
      expect(cls).not.toBeNull();
      expect(labelKey).not.toBeNull();
      // Distinct kinds must not collide on the same colour — that would defeat the point
      // of "colour-coded" grouping.
      expect(seenClasses.has(cls!)).toBe(false);
      seenClasses.add(cls!);
      // The i18n key actually resolves to something in the English catalog, not a raw
      // untranslated key falling through to the `t()` fallback.
      const short = labelKey!.slice('dice.'.length);
      expect((diceEn.dice as Record<string, unknown>)[short]).toBeTruthy();
    }
    expect(seenClasses.size).toBe(kinds.length);
  });

  test('an unclassified roll (undefined kind) renders no badge — not a guessed one', () => {
    expect(diceRollKindTagClass(undefined)).toBeNull();
    expect(diceRollKindLabelKey(undefined)).toBeNull();
  });

  test('the reference vocabulary matches the enum exactly: To Hit / Damage / Check / Roll', () => {
    expect(diceEn.dice.kindToHit).toBe('To Hit');
    expect(diceEn.dice.kindDamage).toBe('Damage');
    expect(diceEn.dice.kindCheck).toBe('Check');
    expect(diceEn.dice.kindRoll).toBe('Roll');
  });
});
