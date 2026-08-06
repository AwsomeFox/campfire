/**
 * MonsterHpDisplayControl keyboard/a11y contract (issue #1925 review).
 *
 * The control is marked up as a WAI-ARIA radiogroup (`role="radiogroup"` /
 * `role="radio"`), which promises roving-tabindex + Arrow/Home/End navigation to a
 * keyboard user — the same base interaction model as the app's other `.seg`
 * segmented controls (`RollModeChooser`, `RsvpChooser`). A radiogroup markup with
 * no roving tabIndex and no key handling is WORSE than plain buttons: every option
 * is individually tabbable, and arrow keys do nothing, contradicting the role.
 *
 * A SECOND review round found that fixing the above the way `RollModeChooser`
 * does it — commit on every arrow press (automatic activation) — was itself a
 * secrecy bug here specifically: each commit is an immediate server PATCH, so
 * stepping from 'band' to 'hidden' with ArrowRight passed through and committed
 * 'exact' along the way, briefly shipping real HP to every player mid-navigation.
 * `RollModeChooser` gets to be automatic-activation because a roll mode has no
 * consequence until the roll button is pressed — this control does not get that
 * out, so it is now MANUAL activation: Arrow/Home/End move focus and the local
 * highlight only; Enter/Space (or a click) commits. `aria-checked` and the visual
 * highlight both track the COMMITTED value, never the mid-navigation focus
 * position.
 *
 * This repo's fast unit-test layer is pure Node (no DOM/browser — see
 * playwright.unit.config.ts), so, mirroring the project's existing pattern for
 * "thin render + a11y wiring" components (see ui-icons.unit.spec.ts's source-text
 * scans), this suite pins the contract three ways:
 *  1. The pure navigation math (`nextMonsterHpDisplayIndex`) and commit-key
 *     detection (`isMonsterHpDisplayCommitKey`) the component delegates to.
 *  2. The pure key-handling reducer (`monsterHpDisplayHandleKey`) that the
 *     component's onKeyDown actually calls — simulating a full keyboard
 *     navigation sequence and asserting exactly which keys commit and with what
 *     value, so an intermediate write fails the test loudly.
 *  3. A source-text scan proving the component actually wires roving tabIndex to
 *     the FOCUS position and aria-checked to the COMMITTED value — two distinct
 *     pieces of state — rather than collapsing them back into one.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  nextMonsterHpDisplayIndex,
  isMonsterHpDisplayCommitKey,
  monsterHpDisplayHandleKey,
  MONSTER_HP_DISPLAY_MODE_ORDER,
} from '../../src/features/encounters/MonsterHpDisplayControl';

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
  });

  test('a commit key (Enter/Space) is not itself navigation math', () => {
    expect(nextMonsterHpDisplayIndex('Enter', 0, length)).toBeNull();
    expect(nextMonsterHpDisplayIndex(' ', 0, length)).toBeNull();
  });
});

test.describe('isMonsterHpDisplayCommitKey (issue #1925)', () => {
  test('Enter and Space commit', () => {
    expect(isMonsterHpDisplayCommitKey('Enter')).toBe(true);
    expect(isMonsterHpDisplayCommitKey(' ')).toBe(true);
    expect(isMonsterHpDisplayCommitKey('Spacebar')).toBe(true);
  });

  test('navigation keys and anything else do not commit', () => {
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab', 'a']) {
      expect(isMonsterHpDisplayCommitKey(key)).toBe(false);
    }
  });
});

/**
 * Issue #1925 review, second round: keyboard navigation must never commit an
 * intermediate mode. Simulates a full keyboard session as a sequence of
 * `monsterHpDisplayHandleKey` calls — the exact reducer `MonsterHpDisplayControl`'s
 * onKeyDown calls — tracking every commit that would fire `onChange`, to prove
 * this mechanically rather than by reading the code.
 */
test.describe('monsterHpDisplayHandleKey — navigation and commit are decoupled (issue #1925, secrecy)', () => {
  const length = MONSTER_HP_DISPLAY_MODE_ORDER.length;

  /** Replays a key sequence starting at `startIndex`, returning every commit's index, in order. */
  function replay(keys: string[], startIndex: number): number[] {
    let focusedIndex = startIndex;
    const commits: number[] = [];
    for (const key of keys) {
      const result = monsterHpDisplayHandleKey(key, focusedIndex, length);
      focusedIndex = result.focusedIndex;
      if (result.commitIndex != null) commits.push(result.commitIndex);
    }
    return commits;
  }

  test("navigating from 'band' past 'exact' to 'hidden' with two ArrowRights commits NOTHING — only Enter commits, exactly once, with 'hidden'", () => {
    // Starting focus/commit state: 'band' (index 0). ArrowRight -> 'exact' (1),
    // ArrowRight -> 'hidden' (2), Enter commits.
    const commits = replay(['ArrowRight', 'ArrowRight', 'Enter'], 0);
    // Exactly one commit — the pre-fix bug committed on every navigation key,
    // which would show two commits here (index 1 'exact', then index 2 'hidden').
    expect(commits).toHaveLength(1);
    expect(commits[0]).toBe(2); // 'hidden'
    expect(MONSTER_HP_DISPLAY_MODE_ORDER[commits[0]!]).toBe('hidden');
  });

  test('the intermediate option is never among the commits, even for a longer navigation session', () => {
    // band -> exact -> hidden -> band -> exact, THEN commit. 'exact' and 'hidden'
    // are each passed through twice without a keyboard user ever intending to
    // select them — none of that must reach onChange.
    const commits = replay(['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'Enter'], 0);
    expect(commits).toHaveLength(1);
    expect(MONSTER_HP_DISPLAY_MODE_ORDER[commits[0]!]).toBe('exact');
  });

  test('pure navigation with no commit key at the end commits nothing at all', () => {
    const commits = replay(['ArrowRight', 'ArrowRight', 'ArrowLeft', 'Home', 'End'], 0);
    expect(commits).toHaveLength(0);
  });

  test('Space commits the focused option too, same as Enter', () => {
    const commits = replay(['ArrowRight', ' '], 0);
    expect(commits).toEqual([1]); // 'exact'
  });

  test('committing twice in a row without moving in between re-commits the same option (idempotent, not a second silent write of something else)', () => {
    const commits = replay(['ArrowRight', 'Enter', 'Enter'], 0);
    expect(commits).toEqual([1, 1]);
  });
});

test.describe('MonsterHpDisplayControl markup — roving tabindex, manual-activation commit, and aria-checked wiring (issue #1925)', () => {
  test('tabIndex (the roving focus target) is driven by the FOCUS position, not the committed value', () => {
    const text = readFileSync(CONTROL_FILE, 'utf8');
    expect(text).toContain('tabIndex={isFocusTarget ? 0 : -1}');
    expect(text).toContain("const isFocusTarget = mode === focusedMode;");
  });

  test("aria-checked (and the accent highlight) is driven by the COMMITTED value, never focusedMode — assistive tech must never announce a mode the server doesn't hold", () => {
    const text = readFileSync(CONTROL_FILE, 'utf8');
    expect(text).toContain('const checked = mode === value;');
    expect(text).toContain('aria-checked={checked}');
    // The regression this guards against: collapsing checked/tabIndex back onto
    // the SAME expression (as the automatic-activation version did) would make
    // aria-checked track the focus position again.
    expect(text).not.toContain('aria-checked={isFocusTarget}');
  });

  test('onKeyDown delegates to the extracted monsterHpDisplayHandleKey reducer (not a re-implementation that could drift from the tested one)', () => {
    const text = readFileSync(CONTROL_FILE, 'utf8');
    expect(text).toContain('onKeyDown={(e) => onKeyDown(e, mode)}');
    expect(text).toContain('monsterHpDisplayHandleKey(e.key, idx, MONSTER_HP_DISPLAY_MODE_ORDER.length)');
  });

  test('only the commit branch calls onChange from the keyboard — the move branch only updates focus/highlight state', () => {
    const text = readFileSync(CONTROL_FILE, 'utf8');
    // The commit branch's onChange call, guarded by result.commitIndex.
    expect(text).toContain('if (committedMode !== value) onChange(committedMode);');
    // The move branch touches local state/focus only.
    expect(text).toContain('setFocusedMode(next);');
    expect(text).toContain('focusMode(next);');
  });

  test('a click still commits immediately (manual-activation radiogroups still select on click, only keyboard nav is deferred)', () => {
    const text = readFileSync(CONTROL_FILE, 'utf8');
    expect(text).toContain('if (!checked) onChange(mode);');
  });
});
