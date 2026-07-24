/**
 * Coalesce concurrent callers onto a single in-flight promise.
 *
 * Used by HandoutsCard so `await load()` during an overlapping fetch waits for
 * the active request instead of returning immediately with a stale list (#691).
 */
export function shareInFlightRef<T>(
  ref: { current: Promise<T> | null },
  start: () => Promise<T>,
): Promise<T> {
  if (ref.current) return ref.current;
  const promise = start().finally(() => {
    if (ref.current === promise) ref.current = null;
  });
  ref.current = promise;
  return promise;
}
