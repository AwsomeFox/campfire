/**
 * GatedControl pure logic (issue #1933) — the visibility/merge rules behind the shared
 * gating-reason affordance, pinned without a browser. The React wrapper itself
 * (`GatedControl.tsx`) is exercised by `combatant-row-sync-disable.spec.ts` and
 * `gated-control-measure.spec.ts` (real browser, CI-validated).
 */
import { expect, test } from '@playwright/test';
import {
  applyGatedHintEvent,
  clearTapHint,
  GATED_HINT_STATE_IDLE,
  gatedTooltipVisible,
  isCoarsePointerQuery,
  mergeDescribedBy,
  mergeGatedClassName,
  type GatedHintState,
} from '../../src/components/gatedControlState';

test.describe('gatedTooltipVisible (issue #1933)', () => {
  test('idle state is not visible', () => {
    expect(gatedTooltipVisible(GATED_HINT_STATE_IDLE)).toBe(false);
  });

  test('hover alone shows it (desktop hover)', () => {
    const state: GatedHintState = { hovered: true, focused: false, tapHintActive: false };
    expect(gatedTooltipVisible(state)).toBe(true);
  });

  test('focus alone shows it (keyboard focus)', () => {
    const state: GatedHintState = { hovered: false, focused: true, tapHintActive: false };
    expect(gatedTooltipVisible(state)).toBe(true);
  });

  test('a coarse-pointer tap hint alone shows it, with no hover or focus', () => {
    const state: GatedHintState = { hovered: false, focused: false, tapHintActive: true };
    expect(gatedTooltipVisible(state)).toBe(true);
  });

  test('none of the three showing means not visible', () => {
    const state: GatedHintState = { hovered: false, focused: false, tapHintActive: false };
    expect(gatedTooltipVisible(state)).toBe(false);
  });
});

test.describe('isCoarsePointerQuery (issue #1933)', () => {
  test('matches: true on the media query means coarse pointer', () => {
    expect(isCoarsePointerQuery({ matches: true })).toBe(true);
  });

  test('matches: false means NOT a coarse pointer', () => {
    expect(isCoarsePointerQuery({ matches: false })).toBe(false);
  });

  test('a missing MediaQueryList (null/undefined) is treated as not coarse', () => {
    expect(isCoarsePointerQuery(null)).toBe(false);
    expect(isCoarsePointerQuery(undefined)).toBe(false);
  });
});

test.describe('mergeDescribedBy (issue #1933)', () => {
  test('no existing aria-describedby: just this control\'s own reason-node id', () => {
    expect(mergeDescribedBy(undefined, 'gated-reason-1')).toBe('gated-reason-1');
  });

  test('an existing aria-describedby is preserved, not clobbered', () => {
    expect(mergeDescribedBy('existing-hint', 'gated-reason-1')).toBe('existing-hint gated-reason-1');
  });
});

test.describe('applyGatedHintEvent (issue #1933 review finding)', () => {
  test('desktop: mouseEnter/focus latch, mouseLeave/blur release, on a fine pointer', () => {
    let state = applyGatedHintEvent(GATED_HINT_STATE_IDLE, 'mouseEnter', false);
    expect(state.hovered).toBe(true);
    state = applyGatedHintEvent(state, 'mouseLeave', false);
    expect(state.hovered).toBe(false);
    state = applyGatedHintEvent(state, 'focus', false);
    expect(state.focused).toBe(true);
    state = applyGatedHintEvent(state, 'blur', false);
    expect(state.focused).toBe(false);
  });

  test('a coarse pointer ignores mouseEnter/mouseLeave/focus/blur entirely — they are compatibility artifacts of a tap, not real hover/focus', () => {
    let state = applyGatedHintEvent(GATED_HINT_STATE_IDLE, 'mouseEnter', true);
    expect(state).toEqual(GATED_HINT_STATE_IDLE);
    state = applyGatedHintEvent(state, 'focus', true);
    expect(state).toEqual(GATED_HINT_STATE_IDLE);
  });

  test('tapStart only applies on a coarse pointer', () => {
    expect(applyGatedHintEvent(GATED_HINT_STATE_IDLE, 'tapStart', true).tapHintActive).toBe(true);
    expect(applyGatedHintEvent(GATED_HINT_STATE_IDLE, 'tapStart', false).tapHintActive).toBe(false);
  });

  test('the exact review-finding sequence: tap, then its compatibility mouseEnter + focus, then the tap timer firing — hint ends up hidden, not stuck on', () => {
    // A tap on real touch hardware fires, in order: pointerup (tapStart), a compatibility
    // mouseenter, and a focus move — with no mouseleave/blur ever following on that device.
    let state = applyGatedHintEvent(GATED_HINT_STATE_IDLE, 'tapStart', true);
    state = applyGatedHintEvent(state, 'mouseEnter', true);
    state = applyGatedHintEvent(state, 'focus', true);
    expect(gatedTooltipVisible(state)).toBe(true); // visible immediately after the tap
    // GATED_HINT_MS elapses: the timer calls clearTapHint directly (no DOM event).
    state = clearTapHint(state);
    expect(gatedTooltipVisible(state)).toBe(false); // and it actually goes away
  });
});

test.describe('mergeGatedClassName (issue #1933)', () => {
  test('no existing className: just the gated class', () => {
    expect(mergeGatedClassName(undefined, 'cf-gated-disabled')).toBe('cf-gated-disabled');
  });

  test('an existing className is preserved alongside the gated class', () => {
    expect(mergeGatedClassName('btn btn-secondary', 'cf-gated-disabled')).toBe('btn btn-secondary cf-gated-disabled');
  });

  test('an empty existing className does not leave a leading space', () => {
    expect(mergeGatedClassName('', 'cf-gated-disabled')).toBe('cf-gated-disabled');
  });
});
