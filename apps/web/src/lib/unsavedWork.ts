/**
 * Lightweight unsaved-work registry (issue #760).
 *
 * Feature forms register a stable id while dirty. The campaign switcher (and
 * any other leave path that opts in) consults this before navigating so a
 * mid-edit Switch campaign cannot silently discard draft metadata.
 *
 * Intentionally module-scoped (not React context) so Layout chrome and feature
 * pages can share one registry without provider nesting, and so unit tests can
 * drive it without DOM.
 */

type Listener = () => void;

const dirtyIds = new Set<string>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Mark or clear a dirty reason. Empty ids are ignored. */
export function setUnsavedWork(id: string, dirty: boolean): void {
  if (!id) return;
  const before = dirtyIds.size;
  if (dirty) dirtyIds.add(id);
  else dirtyIds.delete(id);
  if (dirtyIds.size !== before) emit();
}

export function hasUnsavedWork(): boolean {
  return dirtyIds.size > 0;
}

export function unsavedWorkIds(): string[] {
  return [...dirtyIds];
}

export function clearAllUnsavedWork(): void {
  if (dirtyIds.size === 0) return;
  dirtyIds.clear();
  emit();
}

export function subscribeUnsavedWork(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const UNSAVED_WORK_CONFIRM_MESSAGE =
  'You have unsaved changes. Leave this campaign and discard them?';

/**
 * Returns true when navigation may proceed. When dirty, asks the user via
 * `confirmFn` (defaults to `window.confirm`). Injectable for tests.
 */
export function confirmDiscardUnsavedWork(
  confirmFn: (message: string) => boolean = defaultConfirm,
): boolean {
  if (!hasUnsavedWork()) return true;
  return confirmFn(UNSAVED_WORK_CONFIRM_MESSAGE);
}

function defaultConfirm(message: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(message);
}
