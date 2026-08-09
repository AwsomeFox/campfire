/**
 * Issue #573 — AI transcript privacy on a shared browser.
 *
 * THE BUG. The AI-DM transcript paint cache was keyed by campaign id alone and nothing in
 * the sign-out path removed it, so on a shared device user A played, signed out, user B
 * signed in to the same campaign — and A's scrollback repainted as B's history, including
 * the raw text A typed and the rules A looked up.
 *
 * These pin the three layers of the fix, because any one of them alone is insufficient:
 *   - NARROW: nothing is written without an explicit device grant, which defaults to off.
 *   - QUARANTINE: what is written is namespaced per user, so B cannot read A's key.
 *   - CLEAR: identity boundaries purge, so A's data is gone rather than merely unread.
 *
 * And the ORDERING rule that makes the namespace meaningful: a surface must never hydrate
 * before it knows whose cache it is reading. That race will not reproduce in a browser
 * today (every AI-DM surface mounts behind AuthedLayout's splash), so it is driven here
 * deterministically against the pure decision function instead of hoped for in e2e.
 */
import { expect, test } from '@playwright/test';

/** Minimal in-memory localStorage so the persistence helpers have a store in Node. */
class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return Array.from(this.m.keys())[i] ?? null;
  }
  /** Every key currently held — the assertion surface for "nothing was left behind". */
  keys(): string[] {
    return Array.from(this.m.keys());
  }
}

const store = new MemoryStorage();

// This stub used to be assigned at MODULE SCOPE, with the note "install a window before
// importing it". That premise was wrong — transcript.ts touches `window` only inside its
// functions, never while loading — and the assignment was quietly the most destructive
// line in the tier.
//
// The unit tier runs every spec in ONE worker and Playwright loads all files before
// running any test, so a module-scope global here becomes the `window` that every later
// spec's imports observe. Two separate failures came out of that: `src/i18n/locale.ts`
// attaches `languagechange`/`storage` listeners at import behind a bare
// `typeof window !== 'undefined'`, so a stub without addEventListener killed six specs at
// load; and `detail-list-origin` reads `window.scrollY`, which is a clean `0` when there
// is no window but `undefined` on a partial one — an order-dependent failure that moved
// as unrelated files changed. Completing the stub property-by-property is whack-a-mole:
// the fix is not to leak it at all.
//
// Installed per-file instead, so outside these tests `window` stays undefined and every
// `typeof window !== 'undefined'` guard in src/ takes its real Node branch.
const HAD_WINDOW = 'window' in globalThis;
const PREVIOUS_WINDOW = (globalThis as { window?: Window }).window;

test.beforeAll(() => {
  (globalThis as unknown as { window: { localStorage: Storage } }).window = {
    localStorage: store as unknown as Storage,
  };
});

test.afterAll(() => {
  if (HAD_WINDOW) (globalThis as { window?: Window }).window = PREVIOUS_WINDOW;
  else delete (globalThis as { window?: Window }).window;
});

import {
  emptyTranscript,
  loadTranscript,
  saveTranscript,
  clearTranscript,
  transcriptStorageKey,
  type TranscriptState,
} from '../../src/features/ai-dm/transcript';
import {
  AI_DM_STORAGE_PREFIX,
  decideTranscriptHydration,
  isTranscriptRememberEnabled,
  NO_IDENTITY_SEEN,
  purgeLegacyTranscripts,
  purgeLocalAiTranscripts,
  resetLegacyTranscriptSweepForTests,
  setTranscriptRemember,
  transcriptRememberKey,
  type TranscriptIdentitySeen,
} from '../../src/features/ai-dm/transcriptPrivacy';

const USER_A = 41;
const USER_B = 42;
const CAMPAIGN = 7;

function transcriptOf(text: string): TranscriptState {
  return {
    entries: [
      { id: `p-${text}`, kind: 'player', memberName: 'Runa', text, at: '2026-07-22T10:00:00.000Z' },
    ],
  };
}

test.beforeEach(() => {
  store.clear();
  resetLegacyTranscriptSweepForTests();
});

// ---- Namespacing (quarantine) ---------------------------------------------

test('the cache key namespaces by user AND campaign AND scope', () => {
  const a = transcriptStorageKey(USER_A, CAMPAIGN);
  const b = transcriptStorageKey(USER_B, CAMPAIGN);
  expect(a).not.toBeNull();
  // Two accounts on the same device, same campaign: different keys. This is the read the
  // issue reports — a second account inheriting the first's entries.
  expect(a).not.toBe(b);
  // #572's scope axis still separates the authoritative page from the activity provider;
  // #573 composes over it rather than replacing it, so BOTH axes must still split.
  expect(transcriptStorageKey(USER_A, CAMPAIGN, 'activity')).not.toBe(a);
  expect(transcriptStorageKey(USER_A, 8)).not.toBe(a);
  // Every key this feature owns lives under one prefix, which is what makes one sweep total.
  expect(a!.startsWith(AI_DM_STORAGE_PREFIX)).toBe(true);
  expect(transcriptRememberKey(USER_A)!.startsWith(AI_DM_STORAGE_PREFIX)).toBe(true);
});

test('there is NO key at all without an established viewer', () => {
  // The null return is the enforcement mechanism for "never hydrate before identity is
  // established": a surface that has not resolved /me has nowhere to read or write, so the
  // rule cannot be forgotten at a call site. A fallback "shared" key would reintroduce the
  // exact bug under a new name.
  expect(transcriptStorageKey(null, CAMPAIGN)).toBeNull();
  expect(transcriptRememberKey(null)).toBeNull();
  // Non-ids are rejected rather than stringified into a key.
  expect(transcriptStorageKey(0, CAMPAIGN)).toBeNull();
  expect(transcriptStorageKey(-1, CAMPAIGN)).toBeNull();
  expect(transcriptStorageKey(1.5, CAMPAIGN)).toBeNull();
});

// ---- The device grant (narrow) --------------------------------------------

test('remembering is OFF by default, so nothing is written until it is asked for', () => {
  expect(isTranscriptRememberEnabled(USER_A)).toBe(false);

  saveTranscript(USER_A, CAMPAIGN, transcriptOf('I open the door.'));
  // Not "written and then hidden" — never written. There is nothing on disk to recover.
  expect(store.keys()).toEqual([]);
  expect(loadTranscript(USER_A, CAMPAIGN)).toEqual(emptyTranscript);

  setTranscriptRemember(USER_A, true);
  saveTranscript(USER_A, CAMPAIGN, transcriptOf('I open the door.'));
  expect(loadTranscript(USER_A, CAMPAIGN).entries).toHaveLength(1);
});

test('withdrawing the grant erases the copy that is already stored', () => {
  setTranscriptRemember(USER_A, true);
  saveTranscript(USER_A, CAMPAIGN, transcriptOf('I pick the lock.'));
  saveTranscript(USER_A, 8, transcriptOf('A second campaign.'));
  // Another account's grant + data must survive one user withdrawing theirs.
  setTranscriptRemember(USER_B, true);
  saveTranscript(USER_B, CAMPAIGN, transcriptOf('Someone else at this table.'));

  setTranscriptRemember(USER_A, false);

  expect(loadTranscript(USER_A, CAMPAIGN)).toEqual(emptyTranscript);
  expect(loadTranscript(USER_A, 8)).toEqual(emptyTranscript);
  expect(store.keys().some((k) => k.includes(`u${USER_A}.`))).toBe(false);
  expect(loadTranscript(USER_B, CAMPAIGN).entries).toHaveLength(1);
});

test('a viewer never reads another viewer’s cache, even with both grants held', () => {
  setTranscriptRemember(USER_A, true);
  setTranscriptRemember(USER_B, true);
  saveTranscript(USER_A, CAMPAIGN, transcriptOf('User A said this.'));

  // The reported symptom: same browser, same campaign, second account.
  expect(loadTranscript(USER_B, CAMPAIGN)).toEqual(emptyTranscript);
  // And an unauthenticated / not-yet-known viewer reads nothing at all.
  expect(loadTranscript(null, CAMPAIGN)).toEqual(emptyTranscript);
  // Nor can an unestablished viewer WRITE — a stray save must not mint a shared key.
  saveTranscript(null, CAMPAIGN, transcriptOf('nobody'));
  expect(store.keys().some((k) => k.includes('transcript') && !k.includes('u4'))).toBe(false);
});

test('clearTranscript is scoped to one viewer + campaign + scope', () => {
  setTranscriptRemember(USER_A, true);
  saveTranscript(USER_A, CAMPAIGN, transcriptOf('table scope'));
  saveTranscript(USER_A, CAMPAIGN, transcriptOf('activity scope'), 'activity');

  clearTranscript(USER_A, CAMPAIGN);

  expect(loadTranscript(USER_A, CAMPAIGN)).toEqual(emptyTranscript);
  expect(loadTranscript(USER_A, CAMPAIGN, 'activity').entries).toHaveLength(1);
  // A clear with no viewer is a no-op, not a wildcard wipe.
  clearTranscript(null, CAMPAIGN, 'activity');
  expect(loadTranscript(USER_A, CAMPAIGN, 'activity').entries).toHaveLength(1);
});

test('an activity cache only hydrates for the role projection that wrote it', () => {
  setTranscriptRemember(USER_A, true);
  saveTranscript(USER_A, CAMPAIGN, transcriptOf('DM-only transcript row.'), 'activity', 'dm');

  expect(loadTranscript(USER_A, CAMPAIGN, 'activity', 'dm').entries).toHaveLength(1);
  // A later player projection must start empty and refetch server-authorized rows; it may
  // never paint the prior DM cache while that request is pending.
  expect(loadTranscript(USER_A, CAMPAIGN, 'activity', 'player')).toEqual(emptyTranscript);
  const activityKey = transcriptStorageKey(USER_A, CAMPAIGN, 'activity');
  expect(activityKey).not.toBeNull();
  expect(store.keys()).not.toContain(activityKey!);
});

// ---- Clearing on identity boundaries --------------------------------------

test('the identity-boundary purge removes EVERY user’s transcripts and grants', () => {
  setTranscriptRemember(USER_A, true);
  setTranscriptRemember(USER_B, true);
  saveTranscript(USER_A, CAMPAIGN, transcriptOf('A at the table'));
  saveTranscript(USER_B, CAMPAIGN, transcriptOf('B at the table'));
  saveTranscript(USER_A, CAMPAIGN, transcriptOf('A activity'), 'activity');
  store.setItem('cf.unrelated.draft.1', 'keep me');

  purgeLocalAiTranscripts();

  // Namespacing alone would leave A's bytes on disk, merely unread — the criteria ask for
  // clear OR quarantine, and this does both. Total on purpose: at sign-out we know who is
  // leaving, not who else left residue on this browser.
  expect(store.keys()).toEqual(['cf.unrelated.draft.1']);
  expect(isTranscriptRememberEnabled(USER_A)).toBe(false);
  expect(isTranscriptRememberEnabled(USER_B)).toBe(false);
});

test('pre-#573 caches are deleted on the first established identity, not orphaned', () => {
  // Written by a build before this fix: no user namespace, so no provable owner. Leaving
  // these merely unreadable would keep the reported data on disk for every existing
  // install until somebody happened to sign out.
  store.setItem('cf.aiDm.transcript.v2.7', JSON.stringify(transcriptOf('legacy')));
  store.setItem('cf.aiDm.transcript.v2.activity.7', JSON.stringify(transcriptOf('legacy')));
  setTranscriptRemember(USER_A, true);
  saveTranscript(USER_A, CAMPAIGN, transcriptOf('current generation'));

  purgeLegacyTranscripts();

  expect(store.keys().some((k) => k.startsWith('cf.aiDm.transcript.v2.'))).toBe(false);
  // The current generation and the grant are untouched.
  expect(loadTranscript(USER_A, CAMPAIGN).entries).toHaveLength(1);
  expect(isTranscriptRememberEnabled(USER_A)).toBe(true);
});

// ---- Hydration ordering ----------------------------------------------------

test('identity ordering: never hydrate before /me resolves, and skip one pass on every change', () => {
  // Drives the ordering constraint pass by pass, in the sequence a real surface sees it.
  // This is the fourth ordering constraint on the shared hydrate latch (#572 fixed three),
  // and the one that will not reproduce in a browser — so it is pinned here, deterministically.
  let seen: TranscriptIdentitySeen = NO_IDENTITY_SEEN;
  const passes: { ready: boolean; userId: number | null }[] = [
    { ready: false, userId: null }, // mount: /me in flight
    { ready: false, userId: null }, // still in flight (a re-render for some other reason)
    { ready: true, userId: USER_A }, // /me answers: user A
    { ready: true, userId: USER_A }, // steady state
    { ready: true, userId: USER_B }, // account switch on the same mounted tree
    { ready: true, userId: null }, // proven sign-out
    { ready: false, userId: null }, // a fresh probe starts (e.g. reauth)
  ];
  const log = passes.map((identity) => {
    const decision = decideTranscriptHydration(identity, seen);
    seen = decision.seen;
    return decision;
  });

  // Pass 0 and 1: /me has not answered. `identityPending` blocks the hydrate, and
  // `viewerId` is null so there is no key even if a caller ignored the flag.
  expect(log[0].identityPending).toBe(true);
  expect(log[0].viewerId).toBeNull();
  // The very first pass is NOT a change — there is nothing stale to skip on mount, and
  // reporting one would make every surface burn its first seed pass for nothing.
  expect(log[0].identityChanged).toBe(false);
  expect(log[1]).toMatchObject({ identityPending: true, viewerId: null, identityChanged: false });

  // Pass 2: identity established. This is the first pass that may hydrate — and it is a
  // change, so the seed effect running later in the SAME commit skips its stale view.
  expect(log[2]).toMatchObject({ identityPending: false, viewerId: USER_A, identityChanged: true });
  // Pass 3: nothing moved, so no spurious skip.
  expect(log[3]).toMatchObject({ identityPending: false, viewerId: USER_A, identityChanged: false });
  // Pass 4: account switch with no unmount — the reducer still holds A's entries.
  expect(log[4]).toMatchObject({ identityPending: false, viewerId: USER_B, identityChanged: true });
  // Pass 5: sign-out is an identity change too, so the surface drops to "no viewer".
  expect(log[5]).toMatchObject({ identityPending: false, viewerId: null, identityChanged: true });
  // Pass 6: `ready` flipping back to false is a change even though `viewerId` stayed null —
  // tracking only the id would treat "signed out" and "probing again" as the same state and
  // let a surface hydrate against a viewer it has not re-confirmed.
  expect(log[6]).toMatchObject({ identityPending: true, viewerId: null, identityChanged: true });
});

test('a signed-in identity reported before /me resolves is ignored', () => {
  // `userId` is meaningless while `ready` is false — an optimistic or restored value must
  // not unlock the cache early, which is exactly how a slow auth check paints the wrong
  // account's table.
  const decision = decideTranscriptHydration({ ready: false, userId: USER_A }, NO_IDENTITY_SEEN);
  expect(decision.viewerId).toBeNull();
  expect(decision.identityPending).toBe(true);
});
