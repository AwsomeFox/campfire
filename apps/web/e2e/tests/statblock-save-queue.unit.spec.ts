/**
 * `createStatblockSaveQueue` (issue #1909 review) — pure unit suite via pw-unit (no
 * server/browser). See the module's own doc comment for the full mechanism. This module
 * exists to fix TWO regressions found across two review rounds, both introduced by the
 * earlier `withStatblockRevision` CAS-token fix:
 *
 *  - (Devin, round 1) `CombatantStatblockEditor`'s per-keystroke, undebounced `onChange`
 *    PATCHed on every character, each carrying a CAS token the PRIOR keystroke's PATCH had
 *    already invalidated server-side (every combatant PATCH advances
 *    `encounters.updatedAt`), 409ing at ordinary typing speed. DEBOUNCE + SERIALIZATION
 *    (this module's two structural properties) fix this.
 *  - (Devin + Codex, round 2, found independently) the FIRST attempt at a `save()` fixed
 *    round 1 by awaiting a fresh REFETCH of the encounter and reading its revision
 *    IMMEDIATELY BEFORE sending — but the draft being sent was captured before that
 *    refetch, so a refetch that picked up a genuinely CONCURRENT OTHER writer's change
 *    would pair a STALE draft with that writer's FRESH token and sail straight through the
 *    server's CAS guard, silently clobbering their edit — the exact whole-blob-clobber
 *    class this PR set out to close in the first place. The fix tracks a per-id "known
 *    revision" that is read to build a save's token BEFORE that save's own network call,
 *    and reconciled ONLY from a refetch AFTER that save's own write lands — never before.
 *    The tests below for the round-2 fix deliberately include a fails-first proof using
 *    the ORIGINAL (buggy) refetch-before-send shape, so it is demonstrated — not just
 *    asserted — that the correct pattern is the one that actually closes the hole.
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

  // Issue #1909 review (Devin) — `flushNow` existed with zero call sites, so a debounced
  // edit sitting only in the pending-draft map (its 600ms timer not yet fired) was silently
  // lost if the caller navigated away before it fired. `flushAll` is what RunSessionPage's
  // unmount/page-hide handler calls; prove it actually flushes every id with an
  // un-flushed pending draft, not just whichever one happens to have a live timer.
  test('flushAll flushes every pending id immediately, bypassing each one\'s debounce timer', async () => {
    const calls: Array<{ id: number; draft: string }> = [];
    const queue = createStatblockSaveQueue<string>({
      debounceMs: 10_000, // deliberately long — flushAll must not wait for it
      save: async (id, draft) => {
        calls.push({ id, draft });
      },
    });

    queue.enqueue(1, 'goblin edit, unflushed');
    queue.enqueue(2, 'orc edit, unflushed');
    // No wait() — both debounce timers are still pending when flushAll is called.
    await queue.flushAll();

    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({ id: 1, draft: 'goblin edit, unflushed' });
    expect(calls).toContainEqual({ id: 2, draft: 'orc edit, unflushed' });
  });

  // Prove the test above actually exercises the regression: without flushAll (or any
  // other flush), the same un-flushed edits are never sent — modeling exactly what
  // happened pre-fix when a DM navigated away mid-debounce.
  test("(fails-first proof) without flushing, an un-flushed edit is never sent", async () => {
    const calls: Array<{ id: number; draft: string }> = [];
    const queue = createStatblockSaveQueue<string>({
      debounceMs: 10_000,
      save: async (id, draft) => {
        calls.push({ id, draft });
      },
    });

    queue.enqueue(1, 'lost edit');
    await wait(30); // long past enough for a normal debounce, nowhere near 10s

    expect(calls).toHaveLength(0);
  });

  test('flushAll also waits for an already-in-flight save before resolving', async () => {
    const events: string[] = [];
    let resolveInFlight!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveInFlight = resolve;
    });
    const queue = createStatblockSaveQueue<string>({
      debounceMs: 5,
      save: async (_id, draft) => {
        events.push(`start:${draft}`);
        await gate;
        events.push(`end:${draft}`);
      },
    });

    queue.enqueue(1, 'in-flight edit');
    await wait(20); // let the debounce fire and the save begin, gated on `gate`
    expect(events).toEqual(['start:in-flight edit']);

    const flushPromise = queue.flushAll();
    resolveInFlight();
    await flushPromise;

    expect(events).toEqual(['start:in-flight edit', 'end:in-flight edit']);
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

  // Issue #1909 review round 1 (Devin) — the regression proof for the debounce/
  // serialization fix itself: a fake server that advances its own revision on every
  // successful save and 409s a mismatched `expectedRevision`, exactly like
  // `encounters.service.ts`'s real `assertNotStale`. A `save()` shaped like the ACTUAL
  // (round-2-corrected) RunSessionPage wiring — reads a per-id KNOWN revision, updated
  // only from ITS OWN prior write's response, never from a live refetch performed just
  // before sending THIS write — must let two successive edits from the SAME client both
  // succeed.
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

    // Mirrors the CORRECTED real fix: `save()` reads the LAST KNOWN revision — captured
    // before THIS save's own network call — and reconciles it ONLY from the response of a
    // write that has already landed. It never re-reads a live source immediately before
    // sending (that shape is exercised, and shown to be wrong, by the two tests below).
    let knownRevision = serverRevision;
    const queue = createStatblockSaveQueue<string>({
      debounceMs: 10,
      save: async (_id, draft) => {
        const result = fakeServer.write(knownRevision, draft);
        if (!result.ok) throw new Error(`stale write: expected ${knownRevision}`);
        knownRevision = result.revision; // reconciled synchronously from the response
      },
    });

    queue.enqueue(1, 'edit one');
    await wait(40);
    expect(serverStatblock).toBe('edit one');
    expect(serverRevision).toBe('T0+1');

    // A second, later edit from the SAME client — the exact "type, pause, type again"
    // pattern the round-1 regression broke.
    queue.enqueue(1, 'edit one, edit two');
    await wait(40);
    expect(serverStatblock).toBe('edit one, edit two');
    expect(serverRevision).toBe('T0+1+1');
  });

  // Prove the test above actually exercises the round-1 regression: a `save()` that
  // captures the revision ONCE (outside the save, matching the BROKEN pre-round-1-fix
  // behavior) must fail its second write, confirming the fake server model faithfully
  // reproduces the real 409.
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
    // never updates it — exactly the bug this PR's round-1 fix (withStatblockRevision)
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

  // Issue #1909 review round 2 (Devin + Codex, converging independently) — the regression
  // proof for the SECOND fix. The FIRST attempted fix for round 1 refetched the encounter
  // and read ITS revision immediately before every send; this test proves why that shape is
  // wrong: a genuinely CONCURRENT OTHER writer's change, landing between when this client's
  // draft was captured and when its debounced save actually fires, must cause a 409 — NOT
  // be silently overwritten because a same-moment refetch happened to pick up the other
  // writer's fresher token and paired it with our stale draft anyway.
  test('a concurrent OTHER writer is not silently overwritten by a same-client save whose draft predates it', async () => {
    let serverRevision = 'T0';
    // No meaningful starting value: this test overwrites it (simulating the other writer)
    // before it is ever read, so an 'initial' placeholder would be a dead assignment.
    let serverStatblock: string;
    const fakeServer = {
      write(expectedRevision: string, draft: string): { ok: true; revision: string } | { ok: false; status: 409 } {
        if (expectedRevision !== serverRevision) return { ok: false, status: 409 };
        serverStatblock = draft;
        serverRevision = `${serverRevision}+1`;
        return { ok: true, revision: serverRevision };
      },
    };

    // CORRECT wiring: the token is the LAST KNOWN revision, seeded once from the client's
    // starting point and updated ONLY from this client's own successful writes — never
    // refreshed by reading a live source right before sending.
    let knownRevision = serverRevision;
    let failures = 0;
    const queue = createStatblockSaveQueue<string>({
      debounceMs: 10,
      save: async (_id, draft) => {
        const result = fakeServer.write(knownRevision, draft);
        if (!result.ok) {
          failures += 1;
          throw new Error(`stale write: expected ${knownRevision}`);
        }
        knownRevision = result.revision;
      },
    });

    // Our client enqueues a draft based on T0 — but before its 10ms debounce fires, an
    // OTHER writer (another DM tab, an AI DM over MCP) commits directly against the server,
    // advancing its revision. Our client's `knownRevision` is NOT told about this — exactly
    // like a real client whose draft was already typed before the other write landed.
    queue.enqueue(1, 'our draft, based on the old state');
    serverRevision = `${serverRevision}+1(other writer)`;
    serverStatblock = "other writer's statblock";

    await wait(40);

    // Our save must have been rejected — never silently applied over the other writer's
    // change, and the server must still show THEIR statblock, not ours.
    expect(failures).toBe(1);
    expect(serverStatblock).toBe("other writer's statblock");
  });

  // Prove the test above actually exercises the round-2 regression: a `save()` shaped like
  // the FIRST (buggy) attempted fix — awaiting a refetch and reading ITS revision
  // immediately before sending, rather than the draft's own known base revision — lets the
  // stale draft ride in on the other writer's fresh token and silently overwrite it.
  test('(fails-first proof) refetching the revision immediately before send lets a stale draft silently overwrite a concurrent writer', async () => {
    let serverRevision = 'T0';
    // No meaningful starting value: this test overwrites it (simulating the other writer)
    // before it is ever read, so an 'initial' placeholder would be a dead assignment.
    let serverStatblock: string;
    const fakeServer = {
      write(expectedRevision: string, draft: string): { ok: true; revision: string } | { ok: false; status: 409 } {
        if (expectedRevision !== serverRevision) return { ok: false, status: 409 };
        serverStatblock = draft;
        serverRevision = `${serverRevision}+1`;
        return { ok: true, revision: serverRevision };
      },
    };

    // BROKEN wiring (the first attempted round-2 fix): read the CURRENT revision live,
    // immediately before sending — standing in for `await invalidateQueries(); const fresh
    // = getQueryData(...)` performed right before building the CAS token in production.
    const readCurrentRevisionLive = () => serverRevision;
    let failures = 0;
    const queue = createStatblockSaveQueue<string>({
      debounceMs: 10,
      save: async (_id, draft) => {
        const freshRevision = readCurrentRevisionLive();
        const result = fakeServer.write(freshRevision, draft);
        if (!result.ok) {
          failures += 1;
          throw new Error(`stale write: expected ${freshRevision}`);
        }
      },
    });

    queue.enqueue(1, 'our draft, based on the old state');
    serverRevision = `${serverRevision}+1(other writer)`;
    serverStatblock = "other writer's statblock";

    await wait(40);

    // The bug: our stale draft rode in on the other writer's fresh token and won.
    expect(failures).toBe(0);
    expect(serverStatblock).toBe('our draft, based on the old state');
  });
});
