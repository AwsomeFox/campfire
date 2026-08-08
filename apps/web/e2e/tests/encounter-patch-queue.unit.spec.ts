/**
 * Unit tests for encounter patch queue optimistic rollback (issue #1614).
 */
import { expect, test } from '@playwright/test';
import {
  isAdjacentDuplicateEncounterPatch,
  observedEncounterPatchRevision,
  preferNewerEncounterTurn,
  reconcileEncounterPatchResponse,
  rollbackEncounterPatchError,
  type QueuedEncounterPatch,
} from '../../src/features/encounters/encounterPatchQueue';

test.describe('encounterPatchQueue unit tests — rollbackEncounterPatchError', () => {
  test('isAdjacentDuplicateEncounterPatch identifies adjacent identical pending patch', () => {
    const queue: QueuedEncounterPatch[] = [
      { encounterId: 1, queueId: '1:scale:1', pendingKey: '1:scale', patch: { gridScale: 5 } },
    ];
    expect(isAdjacentDuplicateEncounterPatch(queue, 1, '1:scale')).toBe(true);
    expect(isAdjacentDuplicateEncounterPatch(queue, 1, '1:unit')).toBe(false);
  });

  test('observedEncounterPatchRevision returns latest observed revision', () => {
    const queue: QueuedEncounterPatch[] = [
      { encounterId: 1, queueId: '1', pendingKey: 'k', observedUpdatedAt: 'rev-1', patch: {} },
    ];
    expect(observedEncounterPatchRevision(queue, 1, 'base')).toBe('rev-1');
  });

  test('reconcileEncounterPatchResponse applies remaining pending patches over updated response', () => {
    const updated = { id: 1, gridScale: 10, name: 'Boss Fight' };
    const pending: QueuedEncounterPatch[] = [
      { encounterId: 1, queueId: 'q1', pendingKey: 'k1', patch: { gridUnit: 'ft' } },
      { encounterId: 1, queueId: 'q2', pendingKey: 'k2', patch: { gridScale: 5 } },
    ];
    const reconciled = reconcileEncounterPatchResponse(updated, pending, 'q1', 1);
    expect(reconciled).toEqual({ id: 1, gridScale: 5, name: 'Boss Fight' });
  });

  test('preferNewerEncounterTurn rejects an older keyed replay without blocking a current response', () => {
    const cached = { id: 1, turnVersion: 12, currentCombatantId: 7 };
    const replay = { id: 1, turnVersion: 11, currentCombatantId: 6 };
    const current = { id: 1, turnVersion: 12, currentCombatantId: 8 };

    expect(preferNewerEncounterTurn(cached, replay)).toBe(cached);
    expect(preferNewerEncounterTurn(cached, current)).toBe(current);
    expect(preferNewerEncounterTurn(undefined, replay)).toBe(replay);
  });

  test('rollbackEncounterPatchError restores previous values when failed patch has no overriding pending patch', () => {
    const current = { id: 1, gridSize: 8, gridScale: 5, gridUnit: 'ft' };
    const failedEntry: QueuedEncounterPatch = {
      encounterId: 1,
      queueId: 'q1',
      pendingKey: '1:scale',
      patch: { gridScale: 5 },
      previousValues: { gridScale: null },
    };
    const rolledBack = rollbackEncounterPatchError(current, failedEntry, [], 1);
    expect(rolledBack).toEqual({ id: 1, gridSize: 8, gridScale: null, gridUnit: 'ft' });
  });

  test('rollbackEncounterPatchError retains overriding pending patch value if present', () => {
    const current = { id: 1, gridSize: 8, gridScale: 5, gridUnit: 'ft' };
    const failedEntry: QueuedEncounterPatch = {
      encounterId: 1,
      queueId: 'q1',
      pendingKey: '1:scale',
      patch: { gridScale: 5 },
      previousValues: { gridScale: null },
    };
    const remaining: QueuedEncounterPatch[] = [
      { encounterId: 1, queueId: 'q2', pendingKey: '1:scale', patch: { gridScale: 10 } },
    ];
    const rolledBack = rollbackEncounterPatchError(current, failedEntry, remaining, 1);
    expect(rolledBack).toEqual({ id: 1, gridSize: 8, gridScale: 10, gridUnit: 'ft' });
  });
});

/**
 * Issue #1916 scenario 4 — queue CAS-base composition at the dispatch boundary.
 *
 * `RunSessionPage.queueEncounterPatch` computes each queued patch's `observedUpdatedAt`
 * via `observedEncounterPatchRevision` AT ENQUEUE TIME, against whatever else is still
 * pending — then dispatches with `expectedUpdatedAt = lastLocalEncounterRevision.get(id)
 * ?? observedUpdatedAt` (RunSessionPage.tsx's `mutateQueuedPatch` call). `lastLocalRevision`
 * is only ever set by a SUCCESSFUL predecessor. So: while an earlier queued edit may still
 * fail, every later edit must keep dispatching against that earlier edit's ORIGINAL base —
 * never a fresher revision the local cache happens to have seen in the meantime (e.g. from
 * an unrelated SSE frame) — because adopting that fresher value would let the later edit
 * sail through against a server state the earlier edit's intent never reached, silently
 * discarding it instead of failing safely.
 *
 * This models that exact dispatch sequence with a tiny fake server, without a browser.
 */
test.describe('encounterPatchQueue unit tests — queue CAS-base composition (issue #1916)', () => {
  test('a second queued edit keeps dispatching against the first edit\'s ORIGINAL base while the first may still fail, so it 409s safely instead of clobbering a concurrent bump', () => {
    const encounterId = 1;
    const pending: QueuedEncounterPatch[] = [];
    const lastLocalRevision = new Map<number, string>();

    // A fake server: a write only lands when its expectedUpdatedAt matches the CURRENT
    // revision; a matching write advances the revision, anything else 409s untouched.
    let serverRevision = 'rev-0';
    function fakeServerPatch(expectedUpdatedAt: string | undefined): boolean {
      if (expectedUpdatedAt !== serverRevision) return false;
      serverRevision = `${serverRevision}+1`;
      return true;
    }

    // Entry 1 (a name edit) is queued first, against the server's true starting revision.
    const entry1: QueuedEncounterPatch = {
      encounterId,
      queueId: 'q1',
      pendingKey: 'k-name',
      observedUpdatedAt: observedEncounterPatchRevision(pending, encounterId, serverRevision),
      patch: { name: 'A' },
    };
    expect(entry1.observedUpdatedAt).toBe('rev-0');
    pending.push(entry1);

    // Before entry1 settles, a DIFFERENT writer bumps the server out of band (e.g. a co-DM's
    // unrelated edit) — the local cache picks this up (an SSE frame, a background poll) and
    // now reports a fresher revision than the one entry1 is still queued against.
    serverRevision = 'rev-1';
    const cacheSeesFresherRevision = serverRevision;

    // Entry 2 (a gridScale edit) is queued while entry1 is STILL pending. The CAS-base rule
    // says this must inherit entry1's original base, not the fresher cache value.
    const entry2: QueuedEncounterPatch = {
      encounterId,
      queueId: 'q2',
      pendingKey: 'k-gridScale',
      observedUpdatedAt: observedEncounterPatchRevision(pending, encounterId, cacheSeesFresherRevision),
      patch: { gridScale: 5 },
    };
    expect(entry2.observedUpdatedAt).toBe('rev-0');
    pending.push(entry2);

    // Entry 1 dispatches against its own base and genuinely 409s — the out-of-band bump
    // already moved the server past 'rev-0'. It never sets lastLocalRevision.
    const dispatch1Expected = lastLocalRevision.get(encounterId) ?? entry1.observedUpdatedAt;
    expect(fakeServerPatch(dispatch1Expected)).toBe(false);

    // Entry 2 dispatches next, still with no successful predecessor to hand it a newer
    // token — it falls back to its OWN observedUpdatedAt, which is entry1's original base,
    // not the fresher 'rev-1' the cache already knew about at enqueue time.
    const dispatch2Expected = lastLocalRevision.get(encounterId) ?? entry2.observedUpdatedAt;
    expect(dispatch2Expected).toBe('rev-0');
    // Fails safely (409) instead of silently landing against a server state entry1's intent
    // never reached — the "instead of clobbering" half of the acceptance criterion. A naive
    // implementation that dispatched entry2 against the fresher 'rev-1' would incorrectly
    // succeed here, since the server truly is at 'rev-1'.
    expect(fakeServerPatch(dispatch2Expected)).toBe(false);
  });
});
