/**
 * `createStatblockSaveQueue` (issue #1909 review, Devin) — pure unit suite via pw-unit (no
 * server/browser). See the module's own doc comment for the full mechanism: this fixes a
 * regression the earlier `withStatblockRevision` CAS-token fix introduced, where
 * `CombatantStatblockEditor`'s per-keystroke, undebounced `onChange` PATCHed on every
 * character, each carrying a CAS token the PRIOR keystroke's PATCH had already invalidated
 * server-side (every combatant PATCH advances `encounters.updatedAt`), 409ing at ordinary
 * typing speed.
 */
import { expect, test } from '@playwright/test';
import { createStatblockSaveQueue } from '../../src/features/encounters/statblockSaveQueue';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.describe('createStatblockSaveQueue (issue #1909 review)', () => {
  test('debounces rapid enqueues into ONE save of the LATEST draft, not one per keystroke', async () => {
    const calls: Array<{ id: number; draft: string }> = [];
    const queue = createStatblockSaveQueue<string>({
      debounceMs: 20,
      save: async (id, draft) => {
        calls.push({ id, draft });
      },
    });

    // Simulates rapid keystrokes: many enqueues, all well within the debounce window.
    queue.enqueue(1, 'A');
    queue.enqueue(1, 'AB');
    queue.enqueue(1, 'ABC');
    queue.enqueue(1, 'ABCD');

    await wait(80);

    expect(calls).toEqual([{ id: 1, draft: 'ABCD' }]);
  });

  test('serializes saves per combatant: a second save never starts while the first is still in flight', async () => {
    const events: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const queue = createStatblockSaveQueue<string>({
      debounceMs: 5,
      save: async (id, draft) => {
        events.push(`start:${draft}`);
        if (draft === 'first') await firstGate;
        events.push(`end:${draft}`);
      },
    });

    queue.enqueue(1, 'first');
    await wait(20); // let the first save's debounce fire and its save() begin
    expect(events).toEqual(['start:first']);

    // Enqueue the second edit WHILE the first save is still in flight (gated on firstGate).
    queue.enqueue(1, 'second');
    await wait(20); // long past the second save's own debounce window
    // The second save must NOT have started yet — it is waiting on the first to settle.
    expect(events).toEqual(['start:first']);

    resolveFirst();
    await wait(20);
    expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  test('different combatant ids are independent — one does not block or coalesce with another', async () => {
    const calls: Array<{ id: number; draft: string }> = [];
    const queue = createStatblockSaveQueue<string>({
      debounceMs: 10,
      save: async (id, draft) => {
        calls.push({ id, draft });
      },
    });

    queue.enqueue(1, 'goblin-notes');
    queue.enqueue(2, 'orc-notes');
    await wait(40);

    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({ id: 1, draft: 'goblin-notes' });
    expect(calls).toContainEqual({ id: 2, draft: 'orc-notes' });
  });

  // Issue #1909 review (Devin) — the actual regression proof: a fake server that advances
  // its own revision on every successful save and 409s a mismatched `expectedRevision`,
  // exactly like `encounters.service.ts`'s real `assertNotStale`. A `save()` shaped like
  // the ACTUAL RunSessionPage wiring (re-reads the CURRENT revision immediately before
  // sending, rather than trusting a value captured once) must let two successive edits
  // from the SAME client both succeed.
  test('two successive statblock edits from the same client both succeed against a CAS-token server (regression proof)', async () => {
    let serverRevision = 'T0';
    let serverStatblock = 'initial';
    const fakeServer = {
      write(expectedRevision: string, draft: string): { ok: true; revision: string } | { ok: false; status: 409 } {
        if (expectedRevision !== serverRevision) return { ok: false, status: 409 };
        serverStatblock = draft;
        serverRevision = `${serverRevision}+1`;
        return { ok: true, revision: serverRevision };
      },
    };

    // Mirrors the real fix: `save()` reads the CURRENT revision (as if freshly refetched)
    // immediately before sending, never a value captured once outside the save.
    let clientCachedRevision = serverRevision;
    const queue = createStatblockSaveQueue<string>({
      debounceMs: 10,
      save: async (_id, draft) => {
        const freshRevision = clientCachedRevision; // stands in for an awaited cache refetch
        const result = fakeServer.write(freshRevision, draft);
        if (!result.ok) throw new Error(`stale write: expected ${freshRevision}`);
        clientCachedRevision = result.revision; // reconciled synchronously from the response
      },
    });

    queue.enqueue(1, 'edit one');
    await wait(40);
    expect(serverStatblock).toBe('edit one');
    expect(serverRevision).toBe('T0+1');

    // A second, later edit from the SAME client — the exact "type, pause, type again"
    // pattern the regression broke.
    queue.enqueue(1, 'edit one, edit two');
    await wait(40);
    expect(serverStatblock).toBe('edit one, edit two');
    expect(serverRevision).toBe('T0+1+1');
  });

  // Prove the test above actually exercises the regression: a `save()` that captures the
  // revision ONCE (outside the save, matching the BROKEN pre-fix behavior) must fail its
  // second write, confirming the fake server model faithfully reproduces the real 409.
  test('(fails-first proof) a save() that reuses a stale captured revision does 409 on the second edit', async () => {
    let serverRevision = 'T0';
    const fakeServer = {
      write(expectedRevision: string): { ok: true; revision: string } | { ok: false } {
        if (expectedRevision !== serverRevision) return { ok: false };
        serverRevision = `${serverRevision}+1`;
        return { ok: true, revision: serverRevision };
      },
    };

    // BROKEN wiring: captures the revision ONCE before the queue is even created, and
    // never updates it — exactly the bug this PR's round-2 fix (withStatblockRevision)
    // introduced by sending `encounter?.updatedAt` from a query-cache snapshot that only
    // refreshes asynchronously, well after a second keystroke's save has already fired.
    const staleCapturedRevision = serverRevision;
    let failures = 0;
    const queue = createStatblockSaveQueue<string>({
      debounceMs: 10,
      save: async () => {
        const result = fakeServer.write(staleCapturedRevision);
        if (!result.ok) {
          failures += 1;
          throw new Error('stale write');
        }
      },
    });

    queue.enqueue(1, 'edit one');
    await wait(40);
    expect(failures).toBe(0); // first write still succeeds — revision hadn't moved yet

    queue.enqueue(1, 'edit two');
    await wait(40);
    expect(failures).toBe(1); // second write reuses the now-stale token and fails
  });
});
