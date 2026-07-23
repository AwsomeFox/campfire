import { expect, test } from '@playwright/test';
import {
  armMapPingTap,
  decideMapPingTapRelease,
  isMapPingKeyboardActivation,
  mapPingTapExceededSlop,
  mapPingTapTimedOut,
  MAP_PING_KEYBOARD_POINT,
  MAP_PING_TAP_MAX_MS,
  MAP_PING_TAP_SLOP_PX,
} from '../../src/features/encounters/mapPingTap';

/**
 * Issue #809: battle-map ping publishes only after a completed tap.
 * Pure helpers — no DOM — so every cancel/publish branch is pinned here.
 */

const ARM = armMapPingTap({
  pointerId: 11,
  clientX: 100,
  clientY: 200,
  startedAt: 1_000,
  x: 40,
  y: 60,
});

test.describe('map ping tap completion (issue #809)', () => {
  test('exposes defined tap-slop and hold thresholds', () => {
    expect(MAP_PING_TAP_SLOP_PX).toBeGreaterThan(0);
    expect(MAP_PING_TAP_MAX_MS).toBeGreaterThan(0);
    expect(MAP_PING_KEYBOARD_POINT).toEqual({ x: 50, y: 50 });
  });

  test('ordinary mouse/touch release inside slop + time publishes the armed coordinates once', () => {
    const decision = decideMapPingTapRelease(ARM, {
      pointerId: 11,
      clientX: 100 + MAP_PING_TAP_SLOP_PX,
      clientY: 200,
      nowMs: 1_000 + MAP_PING_TAP_MAX_MS,
    });
    expect(decision).toEqual({ action: 'publish', x: 40, y: 60 });
  });

  test('drag-away past tap slop cancels; release never publishes', () => {
    expect(mapPingTapExceededSlop(ARM, 100 + MAP_PING_TAP_SLOP_PX + 0.1, 200)).toBe(true);
    const decision = decideMapPingTapRelease(ARM, {
      pointerId: 11,
      clientX: 100 + MAP_PING_TAP_SLOP_PX + 1,
      clientY: 200,
      nowMs: 1_100,
    });
    expect(decision).toEqual({ action: 'cancel', reason: 'slop' });
  });

  test('held past the time threshold cancels on release', () => {
    expect(mapPingTapTimedOut(ARM, 1_000 + MAP_PING_TAP_MAX_MS + 1)).toBe(true);
    const decision = decideMapPingTapRelease(ARM, {
      pointerId: 11,
      clientX: 100,
      clientY: 200,
      nowMs: 1_000 + MAP_PING_TAP_MAX_MS + 1,
    });
    expect(decision).toEqual({ action: 'cancel', reason: 'timeout' });
  });

  test('mismatched pointer id (secondary / palm up) never publishes', () => {
    expect(decideMapPingTapRelease(ARM, {
      pointerId: 99,
      clientX: 100,
      clientY: 200,
      nowMs: 1_100,
    })).toEqual({ action: 'cancel', reason: 'mismatch' });
    expect(decideMapPingTapRelease(null, {
      pointerId: 11,
      clientX: 100,
      clientY: 200,
      nowMs: 1_100,
    })).toEqual({ action: 'cancel', reason: 'mismatch' });
  });

  test('keyboard / screen-reader activation keys are Enter and Space without modifiers', () => {
    expect(isMapPingKeyboardActivation({ key: 'Enter' })).toBe(true);
    expect(isMapPingKeyboardActivation({ key: ' ' })).toBe(true);
    expect(isMapPingKeyboardActivation({ key: 'Spacebar' })).toBe(true);
    expect(isMapPingKeyboardActivation({ key: 'Enter', ctrlKey: true })).toBe(false);
    expect(isMapPingKeyboardActivation({ key: 'a' })).toBe(false);
  });

  test('held-key auto-repeat never counts as a keyboard ping activation', () => {
    expect(isMapPingKeyboardActivation({ key: 'Enter', repeat: true })).toBe(false);
    expect(isMapPingKeyboardActivation({ key: ' ', repeat: true })).toBe(false);
    expect(isMapPingKeyboardActivation({ key: 'Spacebar', repeat: true })).toBe(false);
    expect(isMapPingKeyboardActivation({ key: 'Enter', repeat: false })).toBe(true);
  });
});
