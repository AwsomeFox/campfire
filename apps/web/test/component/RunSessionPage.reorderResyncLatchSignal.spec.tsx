/**
 * Component-render (real `@tanstack/react-query` + `@tanstack/query-core`) regression test for
 * issue #2140 — "Reorder resync latch can stay armed forever: `dataUpdatedAt` is
 * `Date.now()`-derived and collides."
 *
 * Issue #2116 review round 7 (merged on `main` via PR #2131) keyed the reorder resync latch's
 * clearing `useEffect` on `encounterQuery.dataUpdatedAt`. Verified against the installed
 * `@tanstack/query-core` source (`query.js`'s `successState()`):
 *
 *   dataUpdatedAt: dataUpdatedAt ?? Date.now()
 *
 * A real (non-`setQueryData`) fetch's `Query#fetch` calls `this.setData(data)` with no
 * `options`, so every completed fetch stamps `Date.now()` at millisecond resolution. Two
 * accepted GET results landing in the same millisecond therefore produce an IDENTICAL
 * `dataUpdatedAt`. React compares `useEffect` dependencies with `Object.is`; an unchanged
 * dependency does not re-run the effect, so the clearing effect never re-examines the latch and
 * it stays armed until some later, unrelated cache write happens to land in a different
 * millisecond.
 *
 * `RunSessionPage.tsx`'s fix replaces that dependency with `encounterDataUpdateCount` — read via
 * `queryClient.getQueryState(queryKeys.encounter(eid))?.dataUpdateCount` — `@tanstack/query-core`'s
 * own per-query counter, verified against `query.js`'s `#dispatch` reducer to be incremented
 * UNCONDITIONALLY (`dataUpdateCount: state.dataUpdateCount + 1`) in the same `"success"` branch
 * that publishes `data`/`dataUpdatedAt`. That gives it both properties the latch's wake-up signal
 * needs: it cannot collide (a plain integer, never re-derived from a clock), and it is published
 * atomically with `data` (same reducer action, same `query.state` snapshot `getQueryState` reads).
 *
 * This test drives that exact collision against the REAL, unmodified TanStack libraries — only
 * `Date.now` is pinned to a single constant so two genuinely separate, real `queryFn` completions
 * are forced to share one `dataUpdatedAt` millisecond, and only the network layer (`api.get` /
 * `api.post`) is mocked:
 *
 *   - `FixedResyncHarness` mirrors `RunSessionPage.tsx`'s actual (fixed) wiring: the clearing
 *     effect depends on `queryClient.getQueryState(...)?.dataUpdateCount`.
 *   - `BuggyResyncHarness` mirrors the wiring that shipped on `main` via PR #2131 (issue #2116
 *     round 7, now reopened as #2140): the clearing effect depends on `encounterQuery.dataUpdatedAt`
 *     directly.
 *
 * Both harnesses share the identical arm/gate decision (`isAwaitingReorderResync`, imported
 * unmodified from `combatantReorder.ts`) and the identical `encounterReadRevisionRef` bump-on-
 * real-GET mechanism established by rounds 3 and 5 — the only difference is the clearing effect's
 * dependency, which is exactly the variable under test. Running the identical two-accepted-results
 * collision against both is this test's own revert-and-confirm-failure evidence: the buggy harness
 * reproduces the exact code shape that was on `main` before this fix, and it fails to clear.
 */
import { useEffect, useRef, useState } from 'react';
import { render, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock, post: postMock },
  };
});

import { api } from '../../src/lib/api';
import { queryKeys } from '../../src/lib/query';
import { isAwaitingReorderResync } from '../../src/features/encounters/combatantReorder';

const EID = 501;

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
  vi.restoreAllMocks();
});

type EncounterShape = { id: number; combatants: unknown[] };

function seededClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

/**
 * Mirrors `RunSessionPage.tsx`'s FIXED wiring: the clearing effect's dependency is
 * `encounterDataUpdateCount`, read through `queryClient.getQueryState(...)?.dataUpdateCount` —
 * never on `encounterQuery` directly, since `@tanstack/query-core`'s `queryObserver.js` does not
 * copy `dataUpdateCount` into the `QueryObserverResult` `useQuery` returns.
 */
function FixedResyncHarness() {
  const queryClient = useQueryClient();
  const encounterReadRevisionRef = useRef(0);
  useQuery({
    queryKey: queryKeys.encounter(EID),
    queryFn: async ({ signal }) => {
      const data = await api.get<EncounterShape>(`/api/encounters/${EID}`);
      signal.throwIfAborted();
      encounterReadRevisionRef.current += 1;
      return data;
    },
  });
  const encounterDataUpdateCount = queryClient.getQueryState<EncounterShape>(queryKeys.encounter(EID))?.dataUpdateCount ?? 0;

  const [armedAt, setArmedAt] = useState<number | null>(null);
  useEffect(() => {
    if (armedAt !== null && !isAwaitingReorderResync(armedAt, encounterReadRevisionRef.current)) {
      setArmedAt(null);
    }
  }, [encounterDataUpdateCount, armedAt]);

  const arm = useMutation({
    mutationFn: () => api.post(`/api/encounters/${EID}/combatants/1/reorder`, {}),
    onSettled: () => setArmedAt(encounterReadRevisionRef.current),
  });

  return (
    <div>
      <div data-testid="latch">{armedAt !== null ? 'armed' : 'clear'}</div>
      <button onClick={() => arm.mutate()}>reorder</button>
      <button onClick={() => void queryClient.refetchQueries({ queryKey: queryKeys.encounter(EID) })}>refetch</button>
    </div>
  );
}

/**
 * Mirrors the wiring that shipped on `main` via PR #2131 (issue #2116 round 7, the defect
 * reopened as #2140): the clearing effect's dependency is `encounterQuery.dataUpdatedAt` — the
 * TanStack-native, `Date.now()`-derived field directly on the hook result.
 */
function BuggyResyncHarness() {
  const queryClient = useQueryClient();
  const encounterReadRevisionRef = useRef(0);
  const encounterQuery = useQuery({
    queryKey: queryKeys.encounter(EID),
    queryFn: async ({ signal }) => {
      const data = await api.get<EncounterShape>(`/api/encounters/${EID}`);
      signal.throwIfAborted();
      encounterReadRevisionRef.current += 1;
      return data;
    },
  });

  const [armedAt, setArmedAt] = useState<number | null>(null);
  useEffect(() => {
    if (armedAt !== null && !isAwaitingReorderResync(armedAt, encounterReadRevisionRef.current)) {
      setArmedAt(null);
    }
  }, [encounterQuery.dataUpdatedAt, armedAt]);

  const arm = useMutation({
    mutationFn: () => api.post(`/api/encounters/${EID}/combatants/1/reorder`, {}),
    onSettled: () => setArmedAt(encounterReadRevisionRef.current),
  });

  return (
    <div>
      <div data-testid="latch">{armedAt !== null ? 'armed' : 'clear'}</div>
      <button onClick={() => arm.mutate()}>reorder</button>
      <button onClick={() => void queryClient.refetchQueries({ queryKey: queryKeys.encounter(EID) })}>refetch</button>
    </div>
  );
}

describe('reorder resync latch clearing signal survives a dataUpdatedAt collision (issue #2140)', () => {
  test('fixed wiring (dataUpdateCount): the latch clears even when two accepted GETs share an identical dataUpdatedAt', async () => {
    // Pin the clock so every accepted fetch below stamps the SAME `Date.now()`-derived
    // `dataUpdatedAt` — the exact collision the issue describes, forced deterministically
    // rather than left to a real race.
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    getMock.mockResolvedValue({ id: EID, combatants: [] });
    postMock.mockResolvedValue({});
    const client = seededClient();

    const { getByText, getByTestId } = render(
      <QueryClientProvider client={client}>
        <FixedResyncHarness />
      </QueryClientProvider>,
    );

    // Accepted result #1: the mount fetch.
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    const firstDataUpdatedAt = client.getQueryState(queryKeys.encounter(EID))?.dataUpdatedAt;

    // Arm the latch, as `reorderCombatant.onSettled` does on a real drag.
    fireEvent.click(getByText('reorder'));
    await waitFor(() => expect(getByTestId('latch').textContent).toBe('armed'));

    // Accepted result #2: a real completed GET after the reorder settled (this reorder's own
    // invalidate+refetch, or an unrelated SSE-triggered refetch — either is the same shape).
    fireEvent.click(getByText('refetch'));
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));

    const secondDataUpdatedAt = client.getQueryState(queryKeys.encounter(EID))?.dataUpdatedAt;
    // The collision precondition: both accepted results really do share one dataUpdatedAt.
    expect(secondDataUpdatedAt).toBe(firstDataUpdatedAt);

    // Despite the collision, the latch still clears — `dataUpdateCount` advanced (1 -> 2) even
    // though `dataUpdatedAt` did not, so the clearing effect still re-ran.
    await waitFor(() => expect(getByTestId('latch').textContent).toBe('clear'));
  });

  test('buggy wiring (dataUpdatedAt, the shape that shipped on main via PR #2131): the identical collision leaves the latch armed forever', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    getMock.mockResolvedValue({ id: EID, combatants: [] });
    postMock.mockResolvedValue({});
    const client = seededClient();

    const { getByText, getByTestId } = render(
      <QueryClientProvider client={client}>
        <BuggyResyncHarness />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));

    fireEvent.click(getByText('reorder'));
    await waitFor(() => expect(getByTestId('latch').textContent).toBe('armed'));

    fireEvent.click(getByText('refetch'));
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));

    // A real completed GET landed (revision advanced past armedAt) but the clearing effect's
    // dependency — `dataUpdatedAt` — never changed (Object.is sees the same millisecond both
    // times), so it never re-ran and the gate never got re-examined. Give any spurious async
    // clear a chance to happen before asserting the negative.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getByTestId('latch').textContent).toBe('armed');
  });
});
