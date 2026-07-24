/**
 * useWakeLock — Screen Wake Lock API management for presentation mode (#826).
 *
 * Requests a screen wake lock when `enabled` is true, releases it on
 * deactivation or unmount, and reacquires after the page returns from a
 * background (visibilitychange → 'visible'). Degrades gracefully when the
 * API is unavailable or the request is denied.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type WakeLockStatus = 'active' | 'released' | 'unavailable' | 'error';

export interface UseWakeLockResult {
  /** Current wake lock status. */
  status: WakeLockStatus;
  /** Human-readable message when status is 'unavailable' or 'error'. */
  message: string | null;
}

/** Detects whether the Screen Wake Lock API is available in this browser. */
function wakeLockSupported(): boolean {
  return 'wakeLock' in navigator && typeof navigator.wakeLock?.request === 'function';
}

/**
 * Acquires and manages a screen wake lock while `enabled` is true.
 *
 * - Requests `navigator.wakeLock.request('screen')` when enabled.
 * - Releases on disable or component unmount.
 * - Reacquires after a visibilitychange → 'visible' event (browsers
 *   automatically release wake locks when a tab is backgrounded).
 * - Exposes a status and optional guidance message for unsupported browsers.
 */
export function useWakeLock(enabled: boolean): UseWakeLockResult {
  const [status, setStatus] = useState<WakeLockStatus>(() =>
    enabled && !wakeLockSupported() ? 'unavailable' : 'released',
  );
  const [message, setMessage] = useState<string | null>(null);
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  // Invalidate in-flight acquire() calls when disabled, unmounted, or superseded.
  const acquireGenerationRef = useRef(0);
  // Track whether we're still mounted to avoid state updates after unmount.
  const mountedRef = useRef(true);
  // Track the current `enabled` value for the visibility handler.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const invalidateAcquire = useCallback(() => {
    acquireGenerationRef.current += 1;
  }, []);

  const acquire = useCallback(async (generation: number) => {
    if (!wakeLockSupported()) {
      if (mountedRef.current && enabledRef.current && generation === acquireGenerationRef.current) {
        setStatus('unavailable');
        setMessage(
          'Screen Wake Lock is not supported in this browser. To keep your display awake, check your OS power/sleep settings or use a browser that supports the Wake Lock API (Chrome, Edge, or Opera on desktop/Android).',
        );
      }
      return;
    }
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (
        !mountedRef.current ||
        !enabledRef.current ||
        generation !== acquireGenerationRef.current
      ) {
        // Disabled, unmounted, or superseded during the async request — release immediately.
        void sentinel.release();
        return;
      }
      sentinelRef.current = sentinel;
      setStatus('active');
      setMessage(null);
      // The browser may release the lock (e.g. low battery, tab hidden via
      // non-standard path). Listen for that so we track state accurately.
      sentinel.addEventListener('release', () => {
        if (mountedRef.current && sentinelRef.current === sentinel) {
          sentinelRef.current = null;
          setStatus('released');
        }
      });
    } catch (err) {
      if (
        !mountedRef.current ||
        !enabledRef.current ||
        generation !== acquireGenerationRef.current
      ) {
        return;
      }
      sentinelRef.current = null;
      setStatus('error');
      const detail = err instanceof Error ? err.message : 'Unknown error';
      setMessage(
        `Wake lock request was denied: ${detail}. Your screen may dim or lock. Adjust your device's display sleep settings to keep it awake.`,
      );
    }
  }, []);

  const release = useCallback(async () => {
    const sentinel = sentinelRef.current;
    if (sentinel) {
      sentinelRef.current = null;
      try {
        await sentinel.release();
      } catch {
        // Already released — ignore.
      }
    }
    if (mountedRef.current) {
      setStatus('released');
      setMessage(null);
    }
  }, []);

  const requestAcquire = useCallback(() => {
    const generation = ++acquireGenerationRef.current;
    void acquire(generation);
  }, [acquire]);

  // Acquire/release based on `enabled`; cleanup releases on disable or unmount.
  useEffect(() => {
    if (!enabled) {
      invalidateAcquire();
      void release();
      return;
    }
    requestAcquire();
    return () => {
      invalidateAcquire();
      void release();
    };
  }, [enabled, invalidateAcquire, release, requestAcquire]);

  // Reacquire after visibility restoration.
  useEffect(() => {
    if (!enabled) return;

    function handleVisibilityChange() {
      if (
        document.visibilityState === 'visible' &&
        enabledRef.current &&
        mountedRef.current &&
        sentinelRef.current == null
      ) {
        requestAcquire();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, requestAcquire]);

  // Track mount state for async acquire guards.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return { status, message };
}
