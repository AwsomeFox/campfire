/**
 * Issue #797 — PWA orientation: free rotation for maps / AI table / player display.
 *
 * Acceptance covered here (pure helpers, no browser):
 *   - Route-local orientation lock is opt-in, failure-tolerant, and reversible.
 *   - Missing / throwing Screen Orientation API never raises to the caller.
 *
 * Manifest `"any"` (or omitted) is asserted by `scripts/check-pwa-dist.mjs` after
 * `vite build`. Landscape layout + map-coordinate preservation live in
 * `pwa-orientation.spec.ts`.
 */
import { expect, test } from '@playwright/test';
import {
  canLockOrientation,
  releaseOrientationLock,
  requestOrientationLock,
} from '../../src/lib/screenOrientation';

type OrientationStub = {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
};

function installScreenOrientation(stub: OrientationStub | null | undefined) {
  Object.defineProperty(globalThis, 'screen', {
    configurable: true,
    value: stub === undefined ? {} : { orientation: stub },
  });
}

test.describe('screen orientation helpers (issue #797)', () => {
  const originalScreen = globalThis.screen;

  test.afterEach(() => {
    Object.defineProperty(globalThis, 'screen', {
      configurable: true,
      value: originalScreen,
    });
  });

  test('canLockOrientation is false when the API is missing', () => {
    installScreenOrientation(null);
    expect(canLockOrientation()).toBe(false);
    installScreenOrientation({});
    expect(canLockOrientation()).toBe(false);
  });

  test('requestOrientationLock reports unsupported without throwing', async () => {
    installScreenOrientation({});
    await expect(requestOrientationLock('landscape')).resolves.toBe('unsupported');
  });

  test('requestOrientationLock locks when the API accepts the user gesture', async () => {
    const calls: string[] = [];
    installScreenOrientation({
      lock: async (orientation) => {
        calls.push(orientation);
      },
      unlock: () => {
        calls.push('unlock');
      },
    });
    expect(canLockOrientation()).toBe(true);
    await expect(requestOrientationLock('landscape')).resolves.toBe('locked');
    expect(calls).toEqual(['landscape']);
  });

  test('requestOrientationLock tolerates rejection (iOS / policy / no activation)', async () => {
    installScreenOrientation({
      lock: async () => {
        throw new DOMException('Orientation lock denied', 'NotAllowedError');
      },
    });
    await expect(requestOrientationLock('landscape')).resolves.toBe('failed');
  });

  test('releaseOrientationLock is reversible and idempotent on unsupported engines', () => {
    installScreenOrientation({});
    expect(releaseOrientationLock()).toBe('unsupported');

    let unlocked = 0;
    installScreenOrientation({
      lock: async () => undefined,
      unlock: () => {
        unlocked += 1;
      },
    });
    expect(releaseOrientationLock()).toBe('unlocked');
    expect(releaseOrientationLock()).toBe('unlocked');
    expect(unlocked).toBe(2);
  });

  test('releaseOrientationLock tolerates unlock throwing', () => {
    installScreenOrientation({
      unlock: () => {
        throw new Error('already unlocked');
      },
    });
    expect(releaseOrientationLock()).toBe('failed');
  });
});
