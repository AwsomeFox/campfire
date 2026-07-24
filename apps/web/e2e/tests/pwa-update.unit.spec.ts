/**
 * Unit spec for PWA update readiness, reload safety guard, and update failure recovery (#515).
 */

import { expect, test } from '@playwright/test';
import {
  canReloadNow,
  getInFlightCount,
  hasInFlightActions,
  registerInFlightAction,
  resetReloadGuard,
  trackInFlightPromise,
} from '../../src/lib/reloadGuard';
import { clearAllUnsavedWork, setUnsavedWork } from '../../src/lib/unsavedWork';
import {
  clearPwaUpdateError,
  dismissUpdate,
  getPwaState,
  setPwaStateForTesting,
  setPwaUpdateError,
  subscribePwaState,
  triggerUpdateNow,
} from '../../src/lib/pwaUpdate';

test.describe('reloadGuard (#515)', () => {
  test.beforeEach(() => {
    resetReloadGuard();
    clearAllUnsavedWork();
  });

  test('canReloadNow is true when no dirty forms or in-flight actions exist', () => {
    expect(canReloadNow()).toBe(true);
    expect(hasInFlightActions()).toBe(false);
    expect(getInFlightCount()).toBe(0);
  });

  test('registerInFlightAction increments count and blocks reload until cleared', () => {
    const done = registerInFlightAction();
    expect(hasInFlightActions()).toBe(true);
    expect(getInFlightCount()).toBe(1);
    expect(canReloadNow()).toBe(false);

    done();
    expect(hasInFlightActions()).toBe(false);
    expect(getInFlightCount()).toBe(0);
    expect(canReloadNow()).toBe(true);
  });

  test('trackInFlightPromise holds in-flight state during execution', async () => {
    let resolved = false;
    const promise = new Promise<string>((res) => {
      setTimeout(() => {
        resolved = true;
        res('ok');
      }, 10);
    });

    const tracked = trackInFlightPromise(promise);
    expect(hasInFlightActions()).toBe(true);
    expect(canReloadNow()).toBe(false);

    const result = await tracked;
    expect(result).toBe('ok');
    expect(resolved).toBe(true);
    expect(hasInFlightActions()).toBe(false);
    expect(canReloadNow()).toBe(true);
  });

  test('canReloadNow returns false when unsaved form work is dirty', () => {
    setUnsavedWork('form-1', true);
    expect(canReloadNow()).toBe(false);

    setUnsavedWork('form-1', false);
    expect(canReloadNow()).toBe(true);
  });
});

test.describe('pwaUpdate state & transitions (#515)', () => {
  test.beforeEach(() => {
    resetReloadGuard();
    clearAllUnsavedWork();
    clearPwaUpdateError();
    setPwaStateForTesting({
      needRefresh: false,
      offlineReady: false,
      deferred: false,
      updateError: null,
      blockedByGuard: false,
    });
  });

  test('dismissUpdate defers update notification', () => {
    setPwaStateForTesting({ needRefresh: true, deferred: false });
    expect(getPwaState().deferred).toBe(false);

    dismissUpdate();
    expect(getPwaState().deferred).toBe(true);
  });

  test('triggerUpdateNow blocks reload when guarded', async () => {
    let reloaded = false;
    setPwaStateForTesting({ needRefresh: true }, async () => {
      reloaded = true;
    });

    const done = registerInFlightAction();
    const success = await triggerUpdateNow();

    expect(success).toBe(false);
    expect(reloaded).toBe(false);
    expect(getPwaState().blockedByGuard).toBe(true);

    done();
    const success2 = await triggerUpdateNow();
    expect(success2).toBe(true);
    expect(reloaded).toBe(true);
    expect(getPwaState().blockedByGuard).toBe(false);
  });

  test('setPwaUpdateError sets error message and notifies subscribers', () => {
    let lastError: string | null = null;
    const unsub = subscribePwaState((st) => {
      lastError = st.updateError;
    });

    setPwaUpdateError(new Error('Failed to fetch service worker script'));
    expect(getPwaState().updateError).toBe('Failed to fetch service worker script');
    expect(lastError).toBe('Failed to fetch service worker script');

    clearPwaUpdateError();
    expect(getPwaState().updateError).toBe(null);
    expect(lastError).toBe(null);

    unsub();
  });
});
