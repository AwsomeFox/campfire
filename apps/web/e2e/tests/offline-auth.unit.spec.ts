/**
 * Issue #579 — PWA offline auth cache survival.
 *
 * The bug: `/me` was served from the SW cache when the network couldn't be
 * reached, AuthProvider mistook that cached identity for a live one (using
 * navigator.onLine, which only reflects the network INTERFACE), and wiped the
 * entire API cache — destroying the offline-fallback data the SW exists to
 * preserve. The fix:
 *
 *   1. /me + /auth/* are now excluded from the SW runtime cache, so a successful
 *      /me is PROVEN-LIVE (never served from cache).
 *   2. AuthProvider decides from the FETCH OUTCOME, never navigator.onLine.
 *   3. The last-known identity is persisted to localStorage so an offline reload
 *      still renders the authed UI (clearly marked stale), instead of wiping
 *      caches or bouncing to /login.
 *
 * These specs cover the acceptance scenarios — origin unreachable while online,
 * restart, true offline, and account switch — at the decision + persistence
 * layer, since that's where the bug lived. (Browser-SW interaction is covered by
 * the PWA dist check `test:pwa` and is impractical to drive headlessly here.)
 */
import { expect, test } from '@playwright/test';
import { decideAuthOutcome, type MeFetchOutcome } from '../../src/app/authDecision';
import {
  clearApiCache,
  clearMeSnapshot,
  persistMeSnapshot,
  readMeSnapshot,
} from '../../src/lib/swCache';
import type { Me, ServerInstance } from '@campfire/schema';

/**
 * Minimal but type-complete Me for decision tests. decideAuthOutcome reads
 * `user.id` AND `instance` (the #723 data-generation identity), so the mock
 * carries both. `instance` defaults to a stable generation; tests that exercise
 * a restore pass a different generation to drive the wipe.
 */
function meFor(id: number, instance: ServerInstance = INSTANCE_GEN0): Me {
  return {
    user: {
      id,
      username: `user${id}`,
      displayName: `User ${id}`,
      serverRole: 'user',
      accentColor: null,
      textSize: 'default',
    },
    memberships: [],
    instance,
  } as unknown as Me;
}

/** A stable install identity for the "no change" cases. */
const INSTANCE_ID = '11111111-1111-1111-1111-111111111111';
const INSTANCE_GEN0: ServerInstance = { instanceId: INSTANCE_ID, dataGeneration: 0 };

const NOW = 1_700_000_000_000;

test.describe('decideAuthOutcome — stale vs logged out (#579)', () => {
  test('LIVE same-identity reload leaves the cache untouched (the common case)', () => {
    // The returning-user reload. The session is unchanged, so wiping the cache
    // would destroy offline campaign data for no reason. lastUserId is null on
    // a fresh tab — that's a FIRST confirmed-live identity, not a CHANGE.
    const outcome: MeFetchOutcome = { kind: 'live', me: meFor(42) };
    const d = decideAuthOutcome(outcome, { currentUserId: null, snapshot: null }, NOW);

    expect(d.me).toEqual(meFor(42));
    expect(d.staleIdentity).toBe(false);
    expect(d.lastSyncedAt).toBe(NOW);
    // First live resolution is not an identity CHANGE — it's the initial sign-in.
    expect(d.shouldWipeCaches).toBe(false);
    expect(d.shouldClearSnapshot).toBe(false);
    // But we DO persist the new snapshot so the next offline load can use it.
    expect(d.snapshotToPersist).toEqual({ me: meFor(42), confirmedAt: NOW, instance: INSTANCE_GEN0 });
    expect(d.connectionError).toBe(false);
  });

  test('LIVE same-identity on a tab that already has that user still does not wipe', () => {
    // A subsequent refresh where the same user resolves live again. Still no
    // change — caches survive.
    const outcome: MeFetchOutcome = { kind: 'live', me: meFor(42) };
    const d = decideAuthOutcome(outcome, { currentUserId: 42, currentInstance: INSTANCE_GEN0, snapshot: null }, NOW);

    expect(d.shouldWipeCaches).toBe(false);
    expect(d.me?.user.id).toBe(42);
  });

  test('ACCOUNT SWITCH: proven-live identity change wipes caches (issue #268 regression guard)', () => {
    // Tab already had user 42 confirmed live this session; now /me resolves live
    // as user 99. That's a real account switch on the same device — wipe both
    // caches so the prior account's campaign data can never render for user 99.
    const outcome: MeFetchOutcome = { kind: 'live', me: meFor(99) };
    const d = decideAuthOutcome(outcome, { currentUserId: 42, currentInstance: INSTANCE_GEN0, snapshot: null }, NOW);

    expect(d.me?.user.id).toBe(99);
    expect(d.shouldWipeCaches).toBe(true);
    expect(d.shouldClearSnapshot).toBe(false);
    expect(d.snapshotToPersist).toEqual({ me: meFor(99), confirmedAt: NOW, instance: INSTANCE_GEN0 });
    expect(d.staleIdentity).toBe(false);
  });

  test('LOGGED OUT: proven 401 wipes caches AND clears the persisted snapshot', () => {
    // A real 401 is the only signal that means "session is gone". Clear
    // everything so the next sign-in can't inherit this account's data.
    const d = decideAuthOutcome({ kind: 'loggedOut' }, { currentUserId: 42, snapshot: null }, NOW);

    expect(d.me).toBeNull();
    expect(d.shouldWipeCaches).toBe(true);
    expect(d.shouldClearSnapshot).toBe(true);
    expect(d.snapshotToPersist).toBeNull();
    expect(d.staleIdentity).toBe(false);
    expect(d.lastSyncedAt).toBeNull();
    expect(d.connectionError).toBe(false);
  });

  test('UNREACHABLE while online (router up, Campfire down) does NOT wipe cache', () => {
    // The #579 regression: origin reachable but server down. A successful /me is
    // now impossible (it's not cached), so the fetch genuinely fails — NOT 401.
    // Restore the persisted identity flagged stale, and CRUCIALLY leave the cache
    // intact so the SW can keep serving last-known campaign data.
    const snapshot = { me: meFor(42), confirmedAt: NOW - 5 * 60_000 };
    const d = decideAuthOutcome({ kind: 'unreachable' }, { currentUserId: 42, snapshot }, NOW);

    expect(d.me).toEqual(meFor(42));
    expect(d.staleIdentity).toBe(true);
    expect(d.lastSyncedAt).toBe(snapshot.confirmedAt);
    expect(d.shouldWipeCaches).toBe(false);
    expect(d.shouldClearSnapshot).toBe(false);
    expect(d.snapshotToPersist).toBeNull();
    expect(d.connectionError).toBe(true);
  });

  test('TRUE OFFLINE: no snapshot + unreachable does not fabricate a login', () => {
    // First-ever visit, offline, no persisted identity. Must not invent a user
    // (no snapshot to restore) and must not treat the failure as a 401.
    const d = decideAuthOutcome({ kind: 'unreachable' }, { currentUserId: null, snapshot: null }, NOW);

    expect(d.me).toBeNull();
    expect(d.staleIdentity).toBe(false);
    expect(d.shouldWipeCaches).toBe(false);
    expect(d.connectionError).toBe(true);
    expect(d.lastSyncedAt).toBeNull();
  });

  test('RESTART: offline reload restores the persisted identity as stale, cache survives', () => {
    // The homelab-server-restart scenario from the issue: tab reopened, server
    // is mid-restart so /me can't reach it. The previously-confirmed identity is
    // restored from localStorage and marked stale. Cache is NOT wiped, so cached
    // campaign pages keep rendering. (Once the server is back, a successful /me
    // will resolve 'live' same-id and clear the stale flag — covered above.)
    const snapshot = { me: meFor(7), confirmedAt: NOW - 60 * 60_000 };
    const d = decideAuthOutcome({ kind: 'unreachable' }, { currentUserId: null, snapshot }, NOW);

    expect(d.me?.user.id).toBe(7);
    expect(d.staleIdentity).toBe(true);
    expect(d.shouldWipeCaches).toBe(false);
    expect(d.shouldClearSnapshot).toBe(false);
    expect(d.connectionError).toBe(true);
    // lastSyncedAt reflects when the snapshot was confirmed live, not "now".
    expect(d.lastSyncedAt).toBe(NOW - 60 * 60_000);
  });
});

test.describe('me snapshot persistence (swCache)', () => {
  // Each test gets a fresh localStorage so persistence is isolated.
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

  test('persist then read round-trips the identity + confirmedAt', () => {
    const store = new Map<string, string>();
    withLocalStorage(store, () => {
      persistMeSnapshot(meFor(5), 1234);
      const snap = readMeSnapshot<Me>();
      expect(snap).not.toBeNull();
      expect(snap!.me.user.id).toBe(5);
      expect(snap!.confirmedAt).toBe(1234);
    });
  });

  test('clear removes a snapshot so a subsequent read returns null', () => {
    const store = new Map<string, string>();
    withLocalStorage(store, () => {
      persistMeSnapshot(meFor(5), 1234);
      expect(readMeSnapshot()).not.toBeNull();
      clearMeSnapshot();
      expect(readMeSnapshot()).toBeNull();
    });
  });

  test('a corrupt snapshot string is treated as no snapshot, not rendered as truth', () => {
    const store = new Map<string, string>([['cf.meSnapshot', '{not json']]);
    withLocalStorage(store, () => {
      expect(readMeSnapshot()).toBeNull();
    });
  });

  test('a snapshot missing confirmedAt is rejected so a stale-time can never be 0/NaN', () => {
    const store = new Map<string, string>([['cf.meSnapshot', JSON.stringify({ me: meFor(9) })]]);
    withLocalStorage(store, () => {
      expect(readMeSnapshot()).toBeNull();
    });
  });

  test('persist + clear never throw when localStorage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
    try {
      expect(() => persistMeSnapshot(meFor(1), 1)).not.toThrow();
      expect(() => clearMeSnapshot()).not.toThrow();
      expect(readMeSnapshot()).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  test('clearApiCache is safe when Cache Storage is undefined (Node/unsupported)', async () => {
    // The Playwright test process has no `caches`. This must resolve, not throw,
    // so the auth flow is never blocked by an unsupported environment.
    await expect(clearApiCache()).resolves.toBeUndefined();
  });
});
