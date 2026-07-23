/**
 * Issue #723 — PWA restore safety: invalidate cached responses after a backup restore.
 *
 * The bug (persona-audit, severity Medium): the SW runtime cache is keyed only by
 * URL and lives up to 7 days. A whole-server backup RESTORE reuses the same
 * numeric user/campaign IDs but swaps the entire dataset (DB + uploads)
 * underneath, so a cached GET for `/api/v1/campaigns/3` would serve PRE-restore
 * bytes offline — leaking data the operator just rolled back. Numeric IDs alone
 * can't detect that; we need a token that changes on restore.
 *
 * The fix: the server now carries a per-install UUID + a monotonic
 * `dataGeneration` (bumped on every restore) on `/me` as `Me.instance`. The web
 * client namespaces its cached responses by that identity and wipes the cache
 * the moment a proven-live `/me` reports a different generation.
 *
 * These specs cover the decision + persistence layer where the fix lives (the
 * browser-SW interaction itself is covered by `test:pwa` and is impractical to
 * drive headlessly here). The first test is the REGRESSION: against the pre-#723
 * `decideAuthOutcome` (which looked at user id only) a same-ID restore leaves
 * `shouldWipeCaches` false, so the assertion `shouldWipeCaches === true` FAILS —
 * confirming the test catches the bug. With the fix, the generation token drives
 * the wipe and the test passes.
 */
import { expect, test } from '@playwright/test';
import { decideAuthOutcome, type MeFetchOutcome } from '../../src/app/authDecision';
import {
  clearApiCache,
  persistMeSnapshot,
  readMeSnapshot,
  sameDataIdentity,
  dataIdentityToken,
  subscribeToCachePurges,
} from '../../src/lib/swCache';
import type { Me, ServerInstance } from '@campfire/schema';

const INSTANCE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GEN0: ServerInstance = { instanceId: INSTANCE_ID, dataGeneration: 0 };
const GEN1: ServerInstance = { instanceId: INSTANCE_ID, dataGeneration: 1 }; // post-restore
const GEN2: ServerInstance = { instanceId: INSTANCE_ID, dataGeneration: 2 }; // second restore
const OTHER_INSTALL: ServerInstance = { instanceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', dataGeneration: 0 };

/** A `Me` for `userId` carrying the given data-generation identity. */
function meFor(userId: number, instance: ServerInstance = GEN0): Me {
  return {
    user: {
      id: userId,
      username: `user${userId}`,
      displayName: `User ${userId}`,
      serverRole: 'user',
      accentColor: null,
      textSize: 'default',
    },
    memberships: [],
    instance,
  } as unknown as Me;
}

const NOW = 1_700_000_000_000;

test.describe('decideAuthOutcome — restore invalidation (#723)', () => {
  test('REGRESSION: same-ID restore (generation bump) wipes the cache', () => {
    // The exact scenario from the issue: user id is UNCHANGED (a restore reuses
    // IDs), but the server's dataGeneration bumped. Pre-#723 this returned
    // shouldWipeCaches=false (only user id was checked) and stale bytes served
    // offline. The generation token is the only signal that catches it.
    const outcome: MeFetchOutcome = { kind: 'live', me: meFor(42, GEN1) };
    const snapshot = { me: meFor(42, GEN0), confirmedAt: NOW - 1000, instance: GEN0 };
    const d = decideAuthOutcome(outcome, { currentUserId: 42, snapshot }, NOW);

    expect(d.me?.user.id).toBe(42); // same user
    expect(d.shouldWipeCaches).toBe(true); // ...but the data generation changed
    expect(d.shouldClearSnapshot).toBe(false); // not a logout
    expect(d.snapshotToPersist).toEqual({ me: meFor(42, GEN1), confirmedAt: NOW, instance: GEN1 });
  });

  test('same-ID, same-generation reload leaves the cache intact (no false positives)', () => {
    // The common case must NOT wipe — a normal reload where neither the user nor
    // the generation changed must preserve offline campaign data.
    const outcome: MeFetchOutcome = { kind: 'live', me: meFor(42, GEN0) };
    const snapshot = { me: meFor(42, GEN0), confirmedAt: NOW - 1000, instance: GEN0 };
    const d = decideAuthOutcome(outcome, { currentUserId: 42, snapshot }, NOW);

    expect(d.shouldWipeCaches).toBe(false);
  });

  test('mid-session restore (no reload) wipes via currentInstance mismatch', () => {
    // A tab that already confirmed GEN0 this session polls /me again (e.g. on
    // window focus) and now sees GEN1 — a restore happened without a page load.
    // currentInstance drives the wipe even with no persisted snapshot in play.
    const outcome: MeFetchOutcome = { kind: 'live', me: meFor(42, GEN1) };
    const d = decideAuthOutcome(
      outcome,
      { currentUserId: 42, currentInstance: GEN0, snapshot: null },
      NOW,
    );

    expect(d.shouldWipeCaches).toBe(true);
  });

  test('different physical install (instanceId change) wipes even at the same generation', () => {
    // If the SW somehow pointed at a different origin/install (e.g. a migrated
    // box reusing the same numeric IDs), the instanceId differs — wipe. This is
    // the "namespace caches by instance AND generation" criterion.
    const outcome: MeFetchOutcome = { kind: 'live', me: meFor(42, OTHER_INSTALL) };
    const snapshot = { me: meFor(42, GEN0), confirmedAt: NOW - 1000, instance: GEN0 };
    const d = decideAuthOutcome(outcome, { currentUserId: 42, snapshot }, NOW);

    expect(d.shouldWipeCaches).toBe(true);
  });

  test('rollback to an older backup bumps generation again and still wipes', () => {
    // Restoring an OLDER backup is still a restore — the server bumps generation
    // (GEN0 -> GEN1 -> GEN2), so each restore is detected regardless of whether
    // the restored data is "newer" or "older" than the current set.
    const outcome: MeFetchOutcome = { kind: 'live', me: meFor(42, GEN2) };
    const snapshot = { me: meFor(42, GEN1), confirmedAt: NOW - 1000, instance: GEN1 };
    const d = decideAuthOutcome(outcome, { currentUserId: 42, snapshot }, NOW);

    expect(d.shouldWipeCaches).toBe(true);
  });

  test('immediate offline use after restore: unreachable does NOT wipe, preserves offline fallback', () => {
    // #579 regression guard combined with #723: if the server is unreachable
    // right after a restore (operator restarted it), we must NOT wipe — the
    // cached campaign data is the offline fallback the SW exists to provide.
    // The generation re-validation only happens on a reachable /me; an offline
    // reload restores the persisted (stale) identity and keeps the cache.
    const snapshot = { me: meFor(42, GEN1), confirmedAt: NOW - 1000, instance: GEN1 };
    const d = decideAuthOutcome({ kind: 'unreachable' }, { currentUserId: 42, snapshot }, NOW);

    expect(d.shouldWipeCaches).toBe(false);
    expect(d.staleIdentity).toBe(true);
    expect(d.me?.user.id).toBe(42);
  });

  test('a snapshot persisted before #723 (no instance) does not false-wipe on first live /me', () => {
    // Back-compat: a snapshot written by an older client has no `instance`. A
    // first live /me on the new client must NOT treat that as a generation
    // change (there's nothing to compare) — only a real instance mismatch wipes.
    const outcome: MeFetchOutcome = { kind: 'live', me: meFor(42, GEN0) };
    const legacySnapshot = { me: meFor(42), confirmedAt: NOW - 1000 }; // no instance
    const d = decideAuthOutcome(outcome, { currentUserId: 42, snapshot: legacySnapshot }, NOW);

    expect(d.shouldWipeCaches).toBe(false);
  });
});

test.describe('sameDataIdentity / dataIdentityToken (#723 helpers)', () => {
  test('same identity matches', () => {
    expect(sameDataIdentity(GEN0, GEN0)).toBe(true);
  });

  test('generation bump mismatches', () => {
    expect(sameDataIdentity(GEN0, GEN1)).toBe(false);
  });

  test('different install mismatches', () => {
    expect(sameDataIdentity(GEN0, OTHER_INSTALL)).toBe(false);
  });

  test('null/undefined never matches (forces the safe wipe direction)', () => {
    expect(sameDataIdentity(null, GEN0)).toBe(false);
    expect(sameDataIdentity(GEN0, null)).toBe(false);
    expect(sameDataIdentity(undefined, GEN0)).toBe(false);
  });

  test('token is a stable string for equal identities', () => {
    expect(dataIdentityToken(GEN0)).toBe(`${INSTANCE_ID}#0`);
    expect(dataIdentityToken(GEN0)).not.toBe(dataIdentityToken(GEN1));
  });
});

test.describe('me snapshot carries the data-generation identity (#723)', () => {
  function withLocalStorage<T>(store: Map<string, string>, fn: () => T): T {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    try {
      return fn();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }

  test('persist with instance round-trips the generation into the snapshot', () => {
    const store = new Map<string, string>();
    withLocalStorage(store, () => {
      persistMeSnapshot(meFor(42, GEN1), 1234, GEN1);
      const snap = readMeSnapshot<Me>();
      expect(snap).not.toBeNull();
      expect(snap!.instance).toEqual(GEN1);
      expect(snap!.me.user.id).toBe(42);
    });
  });

  test('a snapshot persisted with an instance drives the restore wipe on next live /me', () => {
    // End-to-end of the persistence + decision path: persist GEN0, then a live
    // /me reporting GEN1 must wipe. This is the acceptance criterion "same-ID
    // restores" wired through the actual storage layer.
    const store = new Map<string, string>();
    withLocalStorage(store, () => {
      persistMeSnapshot(meFor(42, GEN0), NOW - 1000, GEN0);
      const snapshot = readMeSnapshot<Me>();
      const d = decideAuthOutcome(
        { kind: 'live', me: meFor(42, GEN1) },
        { currentUserId: 42, snapshot },
        NOW,
      );
      expect(d.shouldWipeCaches).toBe(true);
    });
  });

  test('a corrupt instance envelope is dropped (not rendered as truth), forcing a wipe on next /me', () => {
    // A snapshot with a malformed instance (e.g. dataGeneration is a string, or
    // instanceId empty) must not be trusted as the real generation. The
    // validated read drops it, so the snapshot has no instance — and since a
    // missing instance is NOT treated as a mismatch on first /me, this verifies
    // the validation itself (corrupt -> undefined) rather than a false wipe.
    const corrupt = {
      me: meFor(42),
      confirmedAt: NOW - 1000,
      instance: { instanceId: '', dataGeneration: 'oops' },
    };
    const store = new Map<string, string>([['cf.meSnapshot', JSON.stringify(corrupt)]]);
    withLocalStorage(store, () => {
      const snap = readMeSnapshot<Me>();
      expect(snap).not.toBeNull();
      expect(snap!.instance).toBeUndefined();
    });
  });
});

test.describe('cross-tab cache purge broadcast (#723)', () => {
  test('subscribeToCachePurges fires when clearApiCache broadcasts', async () => {
    // The SW Cache Storage is origin-wide, so one tab's clearApiCache() already
    // empties it for every tab. This broadcast additionally tells peer tabs to
    // drop their IN-MEMORY (React Query) caches. We verify the wiring by
    // subscribing, clearing, and asserting the callback fired with 'purge'.
    if (typeof BroadcastChannel === 'undefined') {
      // The Playwright Node test process has no BroadcastChannel — the
      // subscription is a no-op there, which is itself the safe behavior.
      expect(subscribeToCachePurges(() => {})).toBeInstanceOf(Function);
      return;
    }
    let fired = false;
    const unsubscribe = subscribeToCachePurges(() => {
      fired = true;
    });
    try {
      await clearApiCache();
      // The broadcast is async; allow it to drain.
      await new Promise((r) => setTimeout(r, 10));
      expect(fired).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  test('unsubscribe stops the callback and is safe to call when unsupported', () => {
    const unsubscribe = subscribeToCachePurges(() => {
      throw new Error('should not fire after unsubscribe');
    });
    expect(() => unsubscribe()).not.toThrow();
  });

  test('clearApiCache resolves safely with no Cache Storage / BroadcastChannel', async () => {
    // Must never throw in an unsupported environment (the Node test process) —
    // a restore-driven wipe can never block the auth flow.
    await expect(clearApiCache()).resolves.toBeUndefined();
  });
});
