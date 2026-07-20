/**
 * TanStack Query data layer (issue #73).
 *
 * The web app historically hand-rolled its reads (`useState`/`useEffect`/`load()`)
 * and its writes (POST-then-full-refetch, gated behind one global `busy` flag). That
 * pattern is fine at small scale but makes the highest-frequency interaction — a DM
 * spamming HP ±1 in combat — the slowest: every click waits a full round-trip plus a
 * blanket refetch, and the global lock disables *every* control while it's in flight.
 *
 * This module is the shared seam other pages migrate onto incrementally:
 *   - {@link queryClient} — the app-wide client (mounted in App.tsx).
 *   - {@link queryKeys}   — the canonical key registry, so reads and their
 *     invalidations never drift.
 *   - {@link invalidateEncounter} — one helper an SSE event handler (or a mutation's
 *     `onSettled`) calls to mark the encounter's reads stale.
 *
 * Reads still go through {@link api} (cookie auth + dev-role headers + ApiError); Query
 * only owns caching, dedupe, polling, and optimistic writes on top of it.
 */
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Canonical query-key registry. Keeping keys here (rather than inline string arrays
 * scattered across components) means a read and the mutation that invalidates it can't
 * silently disagree about the key shape. Keys are hierarchical: invalidating
 * `['encounter', id]` with the default (prefix) match also re-runs
 * `['encounter', id, 'difficulty']` and `['encounter', id, 'events']`.
 */
export const queryKeys = {
  encounter: (encounterId: number) => ['encounter', encounterId] as const,
  encounterDifficulty: (encounterId: number) => ['encounter', encounterId, 'difficulty'] as const,
  encounterEvents: (encounterId: number) => ['encounter', encounterId, 'events'] as const,
  campaignCharacters: (campaignId: number) => ['campaign', campaignId, 'characters'] as const,
} satisfies Record<string, (...args: never[]) => QueryKey>;

/**
 * Invalidate every read scoped to one encounter (the encounter itself, its difficulty
 * derivation, and its combat log). Called from the SSE handler and from mutation
 * `onSettled` so a change — ours or another member's — reconciles against server truth.
 * The prefix match on `['encounter', id]` sweeps the child keys in one call.
 */
export function invalidateEncounter(client: QueryClient, encounterId: number): void {
  void client.invalidateQueries({ queryKey: queryKeys.encounter(encounterId) });
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // At-the-table surfaces want fresh data when you tab back in.
      refetchOnWindowFocus: true,
      // A 4xx (not-found, forbidden, validation) won't heal by retrying — surface it
      // immediately. Transient 5xx / network errors get a couple of retries.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
      // Slightly stale-tolerant by default; live reads set their own refetchInterval.
      staleTime: 5_000,
    },
    mutations: {
      // Same 4xx-is-terminal rule as reads.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 1;
      },
    },
  },
});
