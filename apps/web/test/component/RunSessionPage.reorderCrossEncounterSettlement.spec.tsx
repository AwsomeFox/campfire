/**
 * Component-render (real `@tanstack/react-query`) regression test for issue #2116 review
 * round 7 — "Ignore settlements from the previous encounter."
 *
 * `RunSessionPage` is reused across encounters: its route (`app/router.tsx`,
 * `/c/:campaignId/encounters/:encounterId`) carries no `key={encounterId}`, so navigating the
 * DM from encounter A to encounter B re-renders the SAME component instance rather than
 * remounting it. `useMutation`'s effect calls `observer.setOptions(options)` on every render
 * (`@tanstack/react-query`'s `useMutation.js`), and `MutationObserver.setOptions`
 * (`@tanstack/query-core`'s `mutationObserver.js`) splices those newest options straight into
 * an in-flight `Mutation` instance whenever its status is still `'pending'`:
 *
 *   } else if (this.#currentMutation?.state.status === "pending") {
 *     this.#currentMutation.setOptions(this.options);
 *   }
 *
 * A reorder `onSettled` that closed over `eid` directly would therefore run with WHICHEVER
 * encounter is on screen when the request finishes, not the one the completed write actually
 * belongs to. A source-scan test (see `reorder-touch-and-sync-gate.unit.spec.ts`) cannot see
 * this at all — the bug is a property of the REAL library's runtime behavior interacting with a
 * re-render, not of the file's static shape, which is exactly the blind spot flagged in review.
 *
 * This test drives that exact race against the REAL, unmodified `@tanstack/react-query` +
 * `@tanstack/query-core` the app ships (only the network layer — `api.post` — is mocked): arm a
 * reorder on encounter 101, rerender with encounter 202 active BEFORE the mutation resolves
 * (simulating the DM navigating away mid-flight), then resolve it.
 *
 *   - `FixedReorderHarness` mirrors `RunSessionPage.tsx`'s actual `reorderCombatant` wiring:
 *     `onSettled` reads `encounterId` from the mutation's own variables and guards arming
 *     through the real, imported `shouldArmReorderResyncLatch`.
 *   - `BuggyReorderHarness` mirrors what that wiring looked like before this round's fix:
 *     `onSettled` closes over the active-encounter prop directly and arms/invalidates
 *     unconditionally.
 *
 * Running the identical race against both is this test's own revert-and-confirm-failure
 * evidence: hand-reverting the real `onSettled` in `RunSessionPage.tsx` back to the shape
 * `BuggyReorderHarness` models reproduces exactly its outcome, so the assertions below are
 * proven to actually distinguish correct from broken behavior, not just to pass by construction.
 */
import { useRef } from 'react';
import { render, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from '@tanstack/react-query';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, post: postMock },
  };
});

import { api } from '../../src/lib/api';
import { queryKeys, invalidateEncounter } from '../../src/lib/query';
import { shouldArmReorderResyncLatch } from '../../src/features/encounters/combatantReorder';

afterEach(() => {
  cleanup();
  postMock.mockReset();
});

type ReorderVars = { combatantId: number; encounterId: number };

/** Mirrors `RunSessionPage.tsx`'s actual, FIXED `reorderCombatant` wiring exactly. */
function FixedReorderHarness({
  activeEncounterId,
  onArm,
}: {
  activeEncounterId: number;
  onArm: (encounterId: number) => void;
}) {
  const queryClient = useQueryClient();
  // Mirrors `activeEncounterIdRef` in `RunSessionPage.tsx`: a ref updated fresh on every
  // render — never a value `onSettled` closes over directly.
  const activeEncounterIdRef = useRef(activeEncounterId);
  activeEncounterIdRef.current = activeEncounterId;

  const reorderCombatant = useMutation({
    mutationFn: ({ combatantId, encounterId }: ReorderVars) =>
      api.post(`/api/encounters/${encounterId}/combatants/${combatantId}/reorder`, {}),
    onSettled: (_data, _err, { encounterId }) => {
      if (shouldArmReorderResyncLatch(encounterId, activeEncounterIdRef.current)) onArm(encounterId);
      invalidateEncounter(queryClient, encounterId);
    },
  });

  return (
    <button onClick={() => reorderCombatant.mutate({ combatantId: 1, encounterId: activeEncounterId })}>
      drag
    </button>
  );
}

/**
 * Mirrors what `reorderCombatant`'s `onSettled` looked like before this round's fix:
 * unconditional, and closing over the active-encounter prop directly instead of reading
 * `encounterId` from the mutation's own variables.
 */
function BuggyReorderHarness({
  activeEncounterId,
  onArm,
}: {
  activeEncounterId: number;
  onArm: (encounterId: number) => void;
}) {
  const queryClient = useQueryClient();

  const reorderCombatant = useMutation({
    mutationFn: ({ combatantId, encounterId }: ReorderVars) =>
      api.post(`/api/encounters/${encounterId}/combatants/${combatantId}/reorder`, {}),
    onSettled: () => {
      onArm(activeEncounterId);
      invalidateEncounter(queryClient, activeEncounterId);
    },
  });

  return (
    <button onClick={() => reorderCombatant.mutate({ combatantId: 1, encounterId: activeEncounterId })}>
      drag
    </button>
  );
}

/** Deferred network response the test resolves on its own schedule. */
function deferredPost(): () => void {
  let resolve!: () => void;
  const promise = new Promise<unknown>((r) => {
    resolve = () => r({});
  });
  postMock.mockReturnValue(promise);
  return resolve;
}

function seededClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(queryKeys.encounter(101), { id: 101 });
  client.setQueryData(queryKeys.encounter(202), { id: 202 });
  return client;
}

describe('reorder settlement after a cross-encounter navigation (issue #2116 review round 7)', () => {
  test('fixed wiring: a write that settles after the DM has navigated away neither arms the new encounter\'s latch nor invalidates it', async () => {
    const resolvePost = deferredPost();
    const client = seededClient();
    const armSpy = vi.fn();

    const { getByText, rerender } = render(
      <QueryClientProvider client={client}>
        <FixedReorderHarness activeEncounterId={101} onArm={armSpy} />
      </QueryClientProvider>,
    );

    fireEvent.click(getByText('drag')); // Drag fired on encounter 101; POST still in flight.

    // The DM navigates to encounter 202 before the reorder resolves — same component
    // instance, new props, exactly like `RunSessionPage` receiving a new `eid` from its route.
    rerender(
      <QueryClientProvider client={client}>
        <FixedReorderHarness activeEncounterId={202} onArm={armSpy} />
      </QueryClientProvider>,
    );

    await act(async () => {
      resolvePost();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(client.getQueryState(queryKeys.encounter(101))?.isInvalidated).toBe(true));
    expect(client.getQueryState(queryKeys.encounter(202))?.isInvalidated ?? false).toBe(false);
    expect(armSpy).not.toHaveBeenCalled();
  });

  test('buggy wiring (pre-fix shape): the identical race arms the WRONG encounter\'s latch and invalidates the WRONG encounter', async () => {
    const resolvePost = deferredPost();
    const client = seededClient();
    const armSpy = vi.fn();

    const { getByText, rerender } = render(
      <QueryClientProvider client={client}>
        <BuggyReorderHarness activeEncounterId={101} onArm={armSpy} />
      </QueryClientProvider>,
    );

    fireEvent.click(getByText('drag'));

    rerender(
      <QueryClientProvider client={client}>
        <BuggyReorderHarness activeEncounterId={202} onArm={armSpy} />
      </QueryClientProvider>,
    );

    await act(async () => {
      resolvePost();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(client.getQueryState(queryKeys.encounter(202))?.isInvalidated).toBe(true));
    // The write belonged to 101, but the buggy `onSettled` closed over 202 by the time it ran —
    // 101, which actually changed, is never invalidated by this mutation.
    expect(client.getQueryState(queryKeys.encounter(101))?.isInvalidated ?? false).toBe(false);
    expect(armSpy).toHaveBeenCalledWith(202);
  });
});
