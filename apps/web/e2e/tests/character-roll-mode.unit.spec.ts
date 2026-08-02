import { expect, test } from '@playwright/test';
import { ROLL_MODES, rollModeOptions, rollModeSummary, resolveRollMode, type RollMode } from '../../src/features/characters/rollMode';

/**
 * Issue #713 — touch + keyboard roll-mode chooser.
 *
 * The chooser component (`RollModeChooser.tsx`) is thin render + a11y wiring;
 * its only logic is the pure functions in `rollMode.ts` exercised here. These
 * tests pin the three-mode vocabulary, the per-mode summary shown before
 * submission, and the rule that a modifier-key click is a ONE-SHOT override of
 * the persistent chooser selection (so the desktop shortcut coexists with the
 * touch chooser instead of clobbering it).
 */

test.describe('roll-mode vocabulary (issue #713)', () => {
  test('exposes exactly Flat / Advantage / Disadvantage, in that order', () => {
    expect(ROLL_MODES).toEqual(['normal', 'advantage', 'disadvantage']);
    const opts = rollModeOptions();
    expect(opts.map((o) => o.mode)).toEqual(['normal', 'advantage', 'disadvantage']);
    expect(opts.map((o) => o.label)).toEqual(['Normal', 'Advantage', 'Disadvantage']);
  });

  test('every option has a descriptive accessible name (not just the short label)', () => {
    for (const opt of rollModeOptions()) {
      // The accessible name must convey the effect, so a screen-reader user
      // picks "roll two d20 and keep the higher" over "Flat" unambiguously.
      expect(opt.description.length).toBeGreaterThan(opt.label.length);
      expect(opt.description.toLowerCase()).toContain('d20');
    }
  });
});

test.describe('roll-mode summary shown before submission (issue #713)', () => {
  const cases: Array<[RollMode, RegExp]> = [
    ['normal', /^normal roll$/i],
    ['advantage', /advantage/i],
    ['disadvantage', /disadvantage/i],
  ];
  for (const [mode, re] of cases) {
    test(`${mode} announces the active mode`, () => {
      expect(rollModeSummary(mode)).toMatch(re);
    });
  }
});

test.describe('modifier-key shortcut coexists with the chooser (issue #713)', () => {
  const noMods = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

  test('a plain tap rolls the chosen persistent mode', () => {
    expect(resolveRollMode('normal', noMods)).toBe('normal');
    expect(resolveRollMode('advantage', noMods)).toBe('advantage');
    expect(resolveRollMode('disadvantage', noMods)).toBe('disadvantage');
  });

  test('shift-click overrides ANY chosen mode with advantage for this roll only', () => {
    for (const chosen of ROLL_MODES) {
      expect(resolveRollMode(chosen, { ...noMods, shiftKey: true })).toBe('advantage');
    }
  });

  test('alt/ctrl/meta-click overrides ANY chosen mode with disadvantage for this roll only', () => {
    for (const chosen of ROLL_MODES) {
      expect(resolveRollMode(chosen, { ...noMods, altKey: true })).toBe('disadvantage');
      expect(resolveRollMode(chosen, { ...noMods, ctrlKey: true })).toBe('disadvantage');
      expect(resolveRollMode(chosen, { ...noMods, metaKey: true })).toBe('disadvantage');
    }
  });

  test('shift wins over alt/ctrl/meta (advantage takes precedence, matching advFromEvent)', () => {
    expect(
      resolveRollMode('normal', { shiftKey: true, altKey: true, ctrlKey: true, metaKey: true }),
    ).toBe('advantage');
  });

  test('the override does not mutate the chosen default — a following plain tap reverts', () => {
    // resolveRollMode is pure: it returns the EFFECTIVE mode for one roll, never
    // signals a state change. The chooser keeps its selection; the next no-mod
    // tap rolls the chosen mode again. (The component holds the state, not this fn.)
    const chosen: RollMode = 'disadvantage';
    resolveRollMode(chosen, { ...noMods, shiftKey: true });
    expect(resolveRollMode(chosen, noMods)).toBe('disadvantage');
  });
});
