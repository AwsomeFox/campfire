/**
 * `run.gate.*` catalog (issue #1933) — every disabled-control reason string GatedControl
 * adopters pass through `t()`. `npm run check:i18n` only checks KEY PARITY between `en`
 * and `ar`, which a `ar` file full of copy-pasted English would still pass (see issue
 * #1464's finding on `encounters.sync.controlsPaused`, and `safety.json`'s `ar` catalog,
 * which is English passthrough top to bottom today). This test pins that every
 * `run.gate.*` string actually differs between `en` and `ar`, and that the `ar` string
 * contains real Arabic-script text — i.e. it fails against an English-passthrough
 * catalog even though `check:i18n` would not.
 */
import { expect, test } from '@playwright/test';
import runEn from '../../src/i18n/locales/en/run.json';
import runAr from '../../src/i18n/locales/ar/run.json';

const ARABIC = /[؀-ۿ]/;

const GATE_KEYS = [
  'syncBlocked',
  'dmControlsTurns',
  'measureNoGridScale',
  'advDisRequiresLoneD20',
  'allInitiativeRolled',
  'needsCombatantsToStart',
  'needsInitiativeToStart',
  'undoNothingToUndo',
  'safetyHold',
] as const;

test.describe('run.gate.* localization (issue #1933)', () => {
  test('en and ar carry the exact same key set', () => {
    expect(Object.keys(runEn.run.gate).sort()).toEqual(Object.keys(runAr.run.gate).sort());
    expect(Object.keys(runEn.run.gate).sort()).toEqual([...GATE_KEYS].sort());
  });

  for (const key of GATE_KEYS) {
    test(`run.gate.${key}: ar is real Arabic, not an English copy`, () => {
      const en = (runEn.run.gate as Record<string, string>)[key];
      const ar = (runAr.run.gate as Record<string, string>)[key];
      expect(en, `en/run.json is missing run.gate.${key}`).toBeTruthy();
      expect(ar, `ar/run.json is missing run.gate.${key}`).toBeTruthy();
      expect(ar, `run.gate.${key}'s ar string must not be identical to its en string`).not.toBe(en);
      expect(ar, `run.gate.${key}'s ar string must contain Arabic-script characters`).toMatch(ARABIC);
    });
  }

  test('every gate string is distinct from every other (a copy/paste never collapsed two reasons)', () => {
    const enValues = GATE_KEYS.map((key) => (runEn.run.gate as Record<string, string>)[key]);
    expect(new Set(enValues).size).toBe(enValues.length);
    const arValues = GATE_KEYS.map((key) => (runAr.run.gate as Record<string, string>)[key]);
    expect(new Set(arValues).size).toBe(arValues.length);
  });
});
