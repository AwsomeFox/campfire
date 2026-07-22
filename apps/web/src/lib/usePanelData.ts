/**
 * Independent auxiliary-panel data loader (issue #697).
 *
 * Several detail pages historically fetched their core entity and every auxiliary
 * panel (calendar feed, audit log, character roster, related locations/factions/
 * quests, …) in a single `Promise.all`. One failing auxiliary request rejected the
 * whole batch and either blanked the page or — worse — mapped to a page-level
 * error/not-found state, hiding the perfectly valid primary content.
 *
 * `usePanelData` loads ONE request independently with its own loading/error/retry
 * state, so a panel failure is reported inline (via {@link PanelState.error} +
 * {@link PanelState.retry}) and NEVER touches the page-level `error`/`notFound`
 * state the host page owns. The retry button re-runs only this panel's request.
 *
 * This mirrors the existing hand-rolled `useState`/`useEffect`/`load()` data
 * primitive these detail pages already use (rather than migrating them wholesale
 * onto react-query), so the isolation change is local and low-risk. Pages that
 * already use react-query continue to do so.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The outcome of one auxiliary panel's load.
 *
 * - `loading` — first fetch in flight, no data yet.
 * - `data`     — fetch succeeded; holds the value.
 * - `error`    — fetch failed; holds the message and a {@link retry} that re-runs
 *                ONLY this panel's request (never the host page's full reload).
 */
export interface PanelState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Re-run only this panel's request. Safe to wire straight to a Retry button. */
  retry: () => void;
  /**
   * Optimistically patch the panel's cached value (e.g. fold in a just-saved edit)
   * without a full reload — mirrors react-query's `setQueryData`. Pass the next
   * value, or an updater that receives the current (possibly null) data.
   */
  setData: (next: T | null | ((prev: T | null) => T | null)) => void;
}

/**
 * Load a single auxiliary request independently of the page's core content.
 *
 * @param fetcher  Returns the panel's data. Receives nothing; close over the ids
 *                 you need. Must be referentially stable (wrap in `useCallback`) —
 *                 an identity change re-runs the fetch, exactly like the page-level
 *                 `load()` these pages already use.
 * @param enabled  When `false`, the panel stays idle (no fetch, no error). Any error
 *                 left over from a prior enabled period is cleared on the transition
 *                 to disabled, so a gated-off panel never surfaces a stale failure.
 *                 Prior `data` is retained (callers don't render disabled panels, so
 *                 it's never shown stale). Use this to gate a DM-only panel (e.g. the
 *                 audit log) without coupling its lifecycle to the host page's role
 *                 check.
 * @param errorMessage  Shown in the inline degraded state when the fetch fails.
 *
 * The friendly `errorMessage` always leads the inline alert so it identifies which
 * panel failed (and stays stable for a11y/assertions); any server-supplied detail is
 * appended in parens for debuggability. A failure here sets only `error` on the
 * returned state — it never throws and never touches any outer state.
 */
export function usePanelData<T>(
  fetcher: () => Promise<T>,
  enabled: boolean,
  errorMessage: string,
): PanelState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  // Keep the latest fetcher in a ref so `load` has a stable identity (no re-render
  // loop) while still calling the freshest closure on each run.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const value = await fetcherRef.current();
      setData(value);
    } catch (err) {
      // Deliberately panel-scoped: this never reaches the host page's error/notFound.
      // The friendly `errorMessage` leads (so the inline alert always identifies WHICH
      // panel failed and stays stable for assertions/a11y); append the server detail
      // when present so a real outage reason is still visible for debugging.
      const detail = err instanceof Error && err.message ? err.message : '';
      setError(detail ? `${errorMessage} (${detail})` : errorMessage);
    } finally {
      setLoading(false);
    }
  }, [errorMessage]);

  // Functional setter wrapper so callers can pass updaters (like the core state
  // setters these pages already use) or absolute values.
  const updateData = useCallback((next: T | null | ((prev: T | null) => T | null)) => {
    setData((prev) => (typeof next === 'function' ? (next as (p: T | null) => T | null)(prev) : next));
  }, []);

  useEffect(() => {
    if (!enabled) {
      // A panel going idle (e.g. its `isDm`/`idReady` gate just flipped off) must
      // not keep advertising a failure from the period it was enabled — otherwise a
      // disabled panel can surface a stale inline error for a request it's no longer
      // making. Prior `data` is retained: callers don't render disabled panels, so it
      // is never shown stale, and keeping it lets a re-enabled panel flash its last
      // good value before the next load resolves.
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [enabled, load]);

  return { data, loading, error, retry: load, setData: updateData };
}
