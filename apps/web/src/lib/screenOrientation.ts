/**
 * Issue #797 — optional Screen Orientation API helpers for route-local use.
 *
 * The installed PWA manifest uses `orientation: "any"` so maps, AI table, and
 * player display can rotate freely. When a surface also wants a temporary lock
 * (typically alongside a user-initiated fullscreen enter), callers must:
 *   1. Invoke only from a user gesture (button click / key activation).
 *   2. Release the lock when leaving that mode (exit / Escape / unmount).
 *   3. Tolerate failure — iOS Safari and many desktop browsers reject lock().
 *
 * These helpers never throw to the UI layer; they report a coarse outcome so
 * callers can keep fullscreen (or other) flows working when orientation is
 * unsupported.
 */

export type OrientationLockOutcome = 'locked' | 'unlocked' | 'unsupported' | 'failed';

type OrientationLike = {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
};

function screenOrientation(): OrientationLike | null {
  try {
    const orientation = globalThis.screen?.orientation as OrientationLike | null | undefined;
    return orientation ?? null;
  } catch {
    return null;
  }
}

/** True when the browser exposes a callable `screen.orientation.lock`. */
export function canLockOrientation(): boolean {
  const orientation = screenOrientation();
  return typeof orientation?.lock === 'function';
}

/**
 * Attempt a Screen Orientation lock. Safe to call when unsupported — returns
 * `'unsupported'` / `'failed'` instead of throwing.
 *
 * Prefer `'landscape'` for cast/TV surfaces; pass `'any'` only when you need to
 * reaffirm free rotation without forcing a side.
 */
export type ScreenOrientationLockType =
  | 'any'
  | 'natural'
  | 'landscape'
  | 'portrait'
  | 'portrait-primary'
  | 'portrait-secondary'
  | 'landscape-primary'
  | 'landscape-secondary';

export async function requestOrientationLock(
  lockType: ScreenOrientationLockType = 'landscape',
): Promise<OrientationLockOutcome> {
  const orientation = screenOrientation();
  if (typeof orientation?.lock !== 'function') return 'unsupported';
  try {
    await orientation.lock(lockType);
    return 'locked';
  } catch {
    // NotAllowedError (no transient activation / policy), SecurityError (not
    // fullscreen on some engines), TypeError (unknown lock type), or iOS
    // silently rejecting — all are non-fatal for Campfire.
    return 'failed';
  }
}

/**
 * Release a prior orientation lock. Idempotent and failure-tolerant so exit
 * paths (Escape, browser chrome, route unmount) never throw.
 */
export function releaseOrientationLock(): OrientationLockOutcome {
  const orientation = screenOrientation();
  if (typeof orientation?.unlock !== 'function') return 'unsupported';
  try {
    orientation.unlock();
    return 'unlocked';
  } catch {
    return 'failed';
  }
}
