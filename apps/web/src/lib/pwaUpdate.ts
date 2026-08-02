/**
 * Service Worker update management (issue #515).
 *
 * Controls service worker registration, update readiness, deferred reloads,
 * reload guards (in-flight encounter actions/forms), and update recovery UI.
 */

import { clearApiCache } from './swCache';
import { canReloadNow } from './reloadGuard';

export interface PwaUpdateState {
  needRefresh: boolean;
  offlineReady: boolean;
  deferred: boolean;
  updateError: string | null;
  blockedByGuard: boolean;
}

type Listener = (state: PwaUpdateState) => void;

let updateSWFn: ((reloadPage?: boolean) => Promise<void>) | null = null;
let state: PwaUpdateState = {
  needRefresh: false,
  offlineReady: false,
  deferred: false,
  updateError: null,
  blockedByGuard: false,
};

const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      /* swallow listener errors */
    }
  }
}

/** Get the current PWA update state snapshot. */
export function getPwaState(): PwaUpdateState {
  return { ...state };
}

/** Subscribe to PWA update state changes. */
export function subscribePwaState(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Dismiss the update notification banner for the remainder of the session ("After session"). */
export function dismissUpdate(): void {
  state = { ...state, deferred: true, blockedByGuard: false };
  emit();
}

/** Set or clear registration/update error state. */
export function setPwaUpdateError(error: unknown): void {
  let message = 'Service worker update failed.';
  if (typeof error === 'string') message = error;
  else if (error instanceof Error) message = error.message;
  state = { ...state, updateError: message };
  emit();
}

export function clearPwaUpdateError(): void {
  state = { ...state, updateError: null };
  emit();
}

/**
 * Trigger immediate reload if safe.
 * Returns true if reload was executed/initiated, false if blocked by in-flight actions/forms.
 */
export async function triggerUpdateNow(): Promise<boolean> {
  if (!canReloadNow()) {
    state = { ...state, blockedByGuard: true };
    emit();
    return false;
  }

  state = { ...state, blockedByGuard: false };
  emit();

  try {
    if (updateSWFn) {
      await updateSWFn(true);
    }
    if (typeof window !== 'undefined') {
      window.location.reload();
    } else if (
      typeof globalThis !== 'undefined' &&
      (globalThis as unknown as { window?: { location?: { reload?: () => void } } }).window?.location?.reload
    ) {
      (globalThis as unknown as { window: { location: { reload: () => void } } }).window.location.reload();
    }
    return true;
  } catch (err) {
    setPwaUpdateError(err);
    return false;
  }
}

/** Recovery action for SW registration/update errors: clear caches & reload. */
export async function clearCacheAndReload(): Promise<boolean> {
  if (!canReloadNow()) {
    state = { ...state, blockedByGuard: true };
    emit();
    return false;
  }

  state = { ...state, blockedByGuard: false };
  emit();

  try {
    await clearApiCache();
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        await reg.unregister();
      }
    }
    if (typeof globalThis.caches !== 'undefined') {
      const keys = await globalThis.caches.keys();
      for (const key of keys) {
        await globalThis.caches.delete(key);
      }
    }
  } catch {
    /* best effort */
  } finally {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }
  return true;
}

/** Initialize service worker registration. */
export function initPwaRegistration(): void {
  if (typeof window === 'undefined') return;

  void (async () => {
    try {
      // Dynamic import so virtual module is safely resolved inside Vite bundle
      // without breaking Node unit test runners.
      const pwa = await import('virtual:pwa-register');
      updateSWFn = pwa.registerSW({
        immediate: true,
        onNeedRefresh() {
          state = { ...state, needRefresh: true, deferred: false };
          emit();
        },
        onOfflineReady() {
          state = { ...state, offlineReady: true };
          emit();
        },
        onRegisterError(error) {
          if (
            typeof window !== 'undefined' &&
            (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
          ) {
            return;
          }
          setPwaUpdateError(error);
        },
      });
    } catch (err) {
      // Ignore module missing / preview / dev error in non-SW environments
      const errStr = String(err);
      if (
        errStr.includes('virtual:pwa-register') ||
        errStr.includes('Cannot find module') ||
        errStr.includes('Failed to fetch dynamically imported module') ||
        errStr.includes('404') ||
        errStr.includes('Importing a module script failed')
      ) {
        return;
      }
      setPwaUpdateError(err);
    }
  })();
}

/** Override state for testing or simulation. */
export function setPwaStateForTesting(newState: Partial<PwaUpdateState>, updateFn?: () => Promise<void>): void {
  state = { ...state, ...newState };
  if (updateFn) {
    updateSWFn = async () => {
      await updateFn();
    };
  }
  emit();
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).setPwaStateForTesting = setPwaStateForTesting;
}
