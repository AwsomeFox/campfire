import { expect, test } from '@playwright/test';
import { nextUndoLeverState, resolveUndoPostError } from '../../src/features/ai-dm/aiDmUndoLever';
import type { DriverLastUndoableCommit } from '@campfire/schema';

/**
 * Issue #1501 — the DM undo snackbar must only offer to undo an action that happens WHILE the DM
 * is viewing the AI table. The lever (`session.lastUndoableCommit`) is projected to DMs whenever a
 * reversible action is armed, so it can already be present when the DM (re)opens the page — left
 * over from a prior visit or rehydrated from the react-query cache. That pre-existing commit must
 * NOT pop a stale undo; only an action armed AFTER the first session load should.
 *
 * These step the component's effect through the same `nextUndoLeverState` reducer it uses each
 * render, threading the returned `seeded` / `seenChainId` forward, and asserting on `pop`.
 */

function commit(chainId: string, actionName = 'AI acted'): DriverLastUndoableCommit {
  return {
    encounterId: 1,
    actorCombatantId: 7,
    chainId,
    actionName,
    committedAt: '2026-07-31T00:00:00.000Z',
  };
}

test.describe('nextUndoLeverState — undo snackbar seeding (issue #1501)', () => {
  test('a pre-existing lever on the first loaded session does NOT pop (stale-undo guard)', () => {
    // The DM reopens the table; the session arrives already carrying an armed lever.
    const step = nextUndoLeverState({
      sessionFetched: true,
      seeded: false,
      commit: commit('chain-A'),
      seenChainId: null,
    });
    expect(step.pop).toBeNull();
    expect(step.seeded).toBe(true);
    expect(step.seenChainId).toBe('chain-A');
  });

  test('a NEW lever armed after the seed pops the snackbar', () => {
    // First load: no lever present yet.
    const seeded = nextUndoLeverState({
      sessionFetched: true,
      seeded: false,
      commit: null,
      seenChainId: null,
    });
    expect(seeded.pop).toBeNull();
    // The seat then arms a fresh reversible action.
    const step = nextUndoLeverState({
      sessionFetched: true,
      seeded: seeded.seeded,
      commit: commit('chain-B'),
      seenChainId: seeded.seenChainId,
    });
    expect(step.pop?.chainId).toBe('chain-B');
    expect(step.seenChainId).toBe('chain-B');
  });

  test('a lever that arrives while the session is still loading does not pop or seed', () => {
    // Initial render: sessionQuery has not resolved, commit not yet observable.
    const step = nextUndoLeverState({
      sessionFetched: false,
      seeded: false,
      commit: null,
      seenChainId: null,
    });
    expect(step.pop).toBeNull();
    expect(step.seeded).toBe(false);
  });

  test('a repeated chain id after the seed does not re-pop', () => {
    // Seed absorbs a pre-existing lever...
    const seeded = nextUndoLeverState({
      sessionFetched: true,
      seeded: false,
      commit: commit('chain-A'),
      seenChainId: null,
    });
    // ...so a background refetch returning the SAME lever is a no-op.
    const step = nextUndoLeverState({
      sessionFetched: true,
      seeded: seeded.seeded,
      commit: commit('chain-A'),
      seenChainId: seeded.seenChainId,
    });
    expect(step.pop).toBeNull();
    expect(step.seenChainId).toBe('chain-A');
  });

  test('undoing (lever consumed) clears seen, and a later fresh action still pops', () => {
    const seeded = nextUndoLeverState({
      sessionFetched: true,
      seeded: false,
      commit: commit('chain-A'),
      seenChainId: null,
    });
    // The lever is consumed (DM undoes, or the seat self-undoes) → null.
    const consumed = nextUndoLeverState({
      sessionFetched: true,
      seeded: seeded.seeded,
      commit: null,
      seenChainId: seeded.seenChainId,
    });
    expect(consumed.pop).toBeNull();
    expect(consumed.seenChainId).toBeNull();
    // A subsequent new action must still pop.
    const step = nextUndoLeverState({
      sessionFetched: true,
      seeded: consumed.seeded,
      commit: commit('chain-C'),
      seenChainId: consumed.seenChainId,
    });
    expect(step.pop?.chainId).toBe('chain-C');
  });
});

test.describe('resolveUndoPostError — undo POST failure classification (issue #1501)', () => {
  // The DM's undo control is driven by the cached `session.lastUndoableCommit`. When the undo POST
  // 404s the server has ALREADY cleared the lever, so the cached session must be refetched or the
  // header keeps offering a reversal that fails every time. A genuine failure (any other status)
  // leaves the cached lever in place (the chain may still be undoable) and surfaces the error.
  test('a 404 (nothing left to undo) invalidates the cached session and dismisses the snackbar', () => {
    const outcome = resolveUndoPostError(404, 'Undo failed');
    expect(outcome.invalidateSession).toBe(true);
    expect(outcome.dismissSnackbar).toBe(true);
    expect(outcome.errorMessage).toBeNull();
  });

  test('a non-404 failure surfaces an error and leaves the cached lever in place', () => {
    const outcome = resolveUndoPostError(500, 'Undo failed');
    expect(outcome.invalidateSession).toBe(false);
    expect(outcome.dismissSnackbar).toBe(false);
    expect(outcome.errorMessage).toBe('Undo failed');
  });

  test('a thrown non-ApiError (undefined status) is treated as a genuine failure', () => {
    // A network drop or a thrown string has no HTTP status — it is NOT a server-cleared lever.
    const outcome = resolveUndoPostError(undefined, 'Undo failed');
    expect(outcome.invalidateSession).toBe(false);
    expect(outcome.errorMessage).toBe('Undo failed');
  });
});
