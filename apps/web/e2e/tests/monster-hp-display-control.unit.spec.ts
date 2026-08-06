/**
 * MonsterHpDisplayControl keyboard/a11y contract (issue #1925 review, finding #3).
 *
 * The control is marked up as a WAI-ARIA radiogroup (`role="radiogroup"` /
 * `role="radio"`), which promises roving-tabindex + Arrow/Home/End navigation to a
 * keyboard user — the same interaction model as the app's other `.seg` segmented
 * controls (`RollModeChooser`, `RsvpChooser`). A radiogroup markup with no roving
 * tabIndex and no key handling is WORSE than plain buttons: every option is
 * individually tabbable, and arrow keys do nothing, contradicting the role.
 *
 * This repo's fast unit-test layer is pure Node (no DOM/browser — see
 * playwright.unit.config.ts), so, mirroring the project's existing pattern for
 * "thin render + a11y wiring" components (see ui-icons.unit.spec.ts's source-text
 * scans), this suite pins the interaction two ways:
 *  1. The pure index-navigation math the component's onKeyDown delegates to.
 *  2. A source-text scan proving the component actually wires up roving tabIndex
 *     and an onKeyDown handler (rather than only defining the math and never using
 *     it) — this is the assertion that fails against the pre-fix source, which had
 *     no keyboard handling at all.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nextMonsterHpDisplayIndex, MONSTER_HP_DISPLAY_MODE_ORDER } from '../../src/features/encounters/MonsterHpDisplayControl';

const CONTROL_FILE = resolve(__dirname, '../../src/features/encounters/MonsterHpDisplayControl.tsx');

test.describe('nextMonsterHpDisplayIndex — roving-tabindex navigation math (issue #1925)', () => {
  const length = MONSTER_HP_DISPLAY_MODE_ORDER.length; // 3: band, exact, hidden

  test('ArrowRight/ArrowDown move to the next option', () => {
    expect(nextMonsterHpDisplayIndex('ArrowRight', 0, length)).toBe(1);
    expect(nextMonsterHpDisplayIndex('ArrowDown', 1, length)).toBe(2);
  });

  test('ArrowRight wraps from the last option back to the first', () => {
    expect(nextMonsterHpDisplayIndex('ArrowRight', 2, length)).toBe(0);
  });

  test('ArrowLeft/ArrowUp move to the previous option', () => {
    expect(nextMonsterHpDisplayIndex('ArrowLeft', 2, length)).toBe(1);
    expect(nextMonsterHpDisplayIndex('ArrowUp', 1, length)).toBe(0);
  });

  test('ArrowLeft wraps from the first option back to the last', () => {
    expect(nextMonsterHpDisplayIndex('ArrowLeft', 0, length)).toBe(2);
  });

  test('Home jumps to the first option; End jumps to the last', () => {
    expect(nextMonsterHpDisplayIndex('Home', 1, length)).toBe(0);
    expect(nextMonsterHpDisplayIndex('End', 0, length)).toBe(2);
  });

  test('an unhandled key (e.g. Tab) returns null so the browser default is not preempted', () => {
    expect(nextMonsterHpDisplayIndex('Tab', 0, length)).toBeNull();
    expect(nextMonsterHpDisplayIndex('Enter', 0, length)).toBeNull();
  });
});

test.describe('MonsterHpDisplayControl markup — roving tabindex + key handling actually wired up (issue #1925)', () => {
  test('every radio option has a roving tabIndex (only the checked option is tabbable)', () => {
    const text = readFileSync(CONTROL_FILE, 'utf8');
    expect(text).toContain('tabIndex={checked ? 0 : -1}');
  });

  test('every radio option wires an onKeyDown handler to the navigation math', () => {
    const text = readFileSync(CONTROL_FILE, 'utf8');
    expect(text).toContain('onKeyDown={(e) => onKeyDown(e, mode)}');
    expect(text).toContain('nextMonsterHpDisplayIndex(');
  });

  test('a selected option is moved to on navigation (focus follows selection, not left behind)', () => {
    const text = readFileSync(CONTROL_FILE, 'utf8');
    expect(text).toContain('focusMode(next)');
  });
});
