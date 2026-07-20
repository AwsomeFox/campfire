/**
 * Poll a callback on a fixed interval, but only while the tab is visible.
 *
 * At-the-table live surfaces (dashboard, quest board, party HP, notes) need to
 * pick up other players' edits without a manual reload. Most of these reads have
 * no dedicated SSE event (SSE only carries encounter/combat signals — see
 * useCampaignEvents), so a slow poll is the fallback the docs promise
 * ("everything is polled so players see updates shortly after you make them").
 *
 * The poll pauses whenever document.visibilityState !== 'visible' so backgrounded
 * tabs don't hammer the API, and fires once immediately on becoming visible again
 * to catch up on whatever changed while hidden. The interval is always cleared on
 * unmount. Matches the RunSessionPage/PlayerDisplayPage refetch convention: `fn`
 * is the page's existing `load`, which the render already gates on `loading && !data`.
 *
 * @param fn      Callback to run each tick (typically the page's `load`).
 * @param ms      Interval in milliseconds.
 * @param enabled Skip polling entirely when false (e.g. no campaign selected).
 */
import { useEffect, useRef } from 'react';

export function usePollWhileVisible(fn: () => void, ms: number, enabled = true): void {
  // Latest callback in a ref so a re-render (new `fn` identity) never restarts
  // the interval — the effect only depends on `ms`/`enabled`.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;

    let handle: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
      if (handle !== undefined) {
        clearInterval(handle);
        handle = undefined;
      }
    };

    const start = () => {
      if (handle === undefined) handle = setInterval(() => fnRef.current(), ms);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Refetch immediately to catch anything missed while hidden, then resume.
        fnRef.current();
        start();
      } else {
        stop();
      }
    };

    // Only run the timer when the tab is currently visible.
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stop();
    };
  }, [ms, enabled]);
}
