/**
 * Reload guard registry (issue #515).
 *
 * Prevents forced service-worker reloads or accidental app refreshes while:
 * 1) An encounter action, form submission, or mutating API call is in flight.
 * 2) The user has dirty unsaved work registered in `unsavedWork.ts`.
 */

import { hasUnsavedWork } from './unsavedWork';

type Listener = () => void;

let inFlightCount = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* swallow listener errors */
    }
  }
}

/** Increment in-flight mutation count. Returns a cleanup function to decrement. */
export function registerInFlightAction(): () => void {
  inFlightCount += 1;
  emit();
  let cleared = false;
  return () => {
    if (!cleared) {
      cleared = true;
      inFlightCount = Math.max(0, inFlightCount - 1);
      emit();
    }
  };
}

/** Track an async promise as an in-flight action. */
export async function trackInFlightPromise<T>(promise: Promise<T>): Promise<T> {
  const done = registerInFlightAction();
  try {
    return await promise;
  } finally {
    done();
  }
}

/** Check whether any encounter action or mutation is currently in flight. */
export function hasInFlightActions(): boolean {
  return inFlightCount > 0;
}

/** Returns total number of active in-flight actions. */
export function getInFlightCount(): number {
  return inFlightCount;
}

/**
 * Returns true if it is safe to reload the page right now.
 * False if dirty unsaved form work OR in-flight actions are pending.
 */
export function canReloadNow(): boolean {
  return !hasUnsavedWork() && !hasInFlightActions();
}

/** Subscribe to changes in reload guard status. */
export function subscribeReloadGuard(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reset in-flight count (primarily for tests). */
export function resetReloadGuard(): void {
  inFlightCount = 0;
  emit();
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).registerInFlightAction = registerInFlightAction;
  (window as unknown as Record<string, unknown>).resetReloadGuard = resetReloadGuard;
}
