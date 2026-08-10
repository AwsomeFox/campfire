/**
 * AI-transcript privacy on a shared browser (#573).
 *
 * THE LEAK. The AI-DM transcript paint cache was keyed by campaign id alone
 * (`cf.aiDm.transcript.v2.<campaignId>`), and nothing in the sign-out path removed it.
 * A transcript carries player identity, the raw text players typed, and the rules
 * lookups they asked for. So on a shared device: user A plays, signs out, user B signs
 * in to the same campaign, and A's scrollback repaints as B's history.
 *
 * WHY NOT JUST DELETE THE CACHE. #572 made the SERVER transcript authoritative and
 * refetched on mount, and its PR noted #573 "can now delete it outright". That is true
 * for the `table` scope — but only for it. The `activity` scope backs
 * `useAiDmLiveActivity`; it also reconciles server history, but retains a separately scoped
 * paint cache while that request is in flight. Deleting it outright would leave the encounter
 * driver dock (#427) blank after every reload or temporary transcript-read failure. So the
 * cache stays, and the privacy work is done in three layers instead:
 *
 *   1. NARROW — nothing is written at all unless the viewer has explicitly opted in on
 *      this device ({@link isTranscriptRememberEnabled}, default false). This is the
 *      strongest form of "delete it outright": by default there is no cache to leak, and
 *      the `table` scope loses nothing because the server repaints it anyway.
 *   2. QUARANTINE — what IS written is namespaced by user id, so a second account
 *      cannot read the first's entries even while both exist on disk.
 *   3. CLEAR — every identity boundary (logout, peer-tab sign-out, session expiry,
 *      account switch, restore) sweeps the whole prefix, so nothing is recoverable
 *      afterwards. Namespacing alone would only make A's data unread, not gone.
 *
 * WHY THE DEVICE GRANT IS PURGED TOO. `cf.aiDm.remember.v1.u42` names a user who used
 * this browser, which is exactly the identity signal a shared device should not keep.
 * The codebase already treats identity-naming keys this way — `cf.meSnapshot` and
 * `cf.authUserId` are both cleared on sign-out — so the grant follows the same rule. The
 * cost is that the opt-in must be re-made after a sign-out, which is the correct
 * direction for a control whose whole point is that the private choice is the default.
 */

/**
 * The single prefix every AI-DM local key shares. One prefix means one sweep — a new
 * key added under it is purged by {@link purgeLocalAiTranscripts} without anyone having
 * to remember to register it.
 */
export const AI_DM_STORAGE_PREFIX = 'cf.aiDm.';

/**
 * Per-user transcript cache generation. `v3` deliberately orphans every `v2` key: those
 * were written with no user namespace at all, so there is no way to tell whose they are
 * and the only safe reading is "somebody else's". {@link purgeLegacyTranscripts} deletes
 * them outright rather than leaving them orphaned on disk.
 */
export const TRANSCRIPT_KEY_PREFIX = `${AI_DM_STORAGE_PREFIX}transcript.`;
const TRANSCRIPT_GENERATION = 'v3';
const REMEMBER_KEY_PREFIX = `${AI_DM_STORAGE_PREFIX}remember.v1.`;

/**
 * The viewer a transcript belongs to: an authenticated user id, or `null` for BOTH
 * "signed out" and "identity not established yet".
 *
 * Collapsing those two into one value is deliberate. Every storage entry point takes
 * this type and does nothing when it is null, so "never hydrate before current identity
 * is established" is enforced by the type rather than by each caller remembering to
 * check — a surface that has not resolved `/me` yet simply has no key to read or write.
 */
export type TranscriptViewerId = number | null;

/** Reject anything that is not a real server user id, so a bad value can't mint a key. */
function normalizeViewerId(viewerId: TranscriptViewerId): number | null {
  return typeof viewerId === 'number' && Number.isInteger(viewerId) && viewerId > 0 ? viewerId : null;
}

function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

/** Every localStorage key currently under a prefix. Snapshot first — removal reindexes. */
function keysWithPrefix(prefix: string): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    /* private mode / blocked storage — nothing to sweep */
  }
  return keys;
}

function removeKeys(keys: readonly string[]): void {
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * The namespaced cache key, or `null` when there is no established viewer.
 *
 * Returning null rather than a "shared" fallback key is the whole point: a caller with
 * no identity yet cannot accidentally read or write anything, because there is nowhere
 * for it to read or write. The user id comes FIRST in the key so a prefix scan can
 * select one user's caches.
 */
export function transcriptCacheKey(viewerId: TranscriptViewerId, campaignId: number, scope: string): string | null {
  const id = normalizeViewerId(viewerId);
  if (id === null) return null;
  if (!Number.isInteger(campaignId)) return null;
  return `${TRANSCRIPT_KEY_PREFIX}${TRANSCRIPT_GENERATION}.u${id}.${scope}.${campaignId}`;
}

/** The device-grant key for a user, or null when there is no established viewer. */
export function transcriptRememberKey(viewerId: TranscriptViewerId): string | null {
  const id = normalizeViewerId(viewerId);
  return id === null ? null : `${REMEMBER_KEY_PREFIX}u${id}`;
}

/**
 * Has this viewer opted into keeping AI transcripts on THIS device?
 *
 * FALSE IS THE DEFAULT AND THE SAFE ANSWER — absent key, unparseable value, no storage,
 * or no established identity all read as "do not remember". A privacy control whose
 * failure mode is "remember anyway" is not a privacy control.
 */
export function isTranscriptRememberEnabled(viewerId: TranscriptViewerId): boolean {
  const key = transcriptRememberKey(viewerId);
  if (key === null || !hasStorage()) return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * Record (or withdraw) the device grant. Withdrawing it PURGES this viewer's cached
 * transcripts immediately rather than merely stopping future writes — the user asked for
 * the transcript not to be on this device, and leaving what is already written there
 * until the next sign-out would not honour that.
 */
export function setTranscriptRemember(viewerId: TranscriptViewerId, remember: boolean): void {
  const key = transcriptRememberKey(viewerId);
  if (key === null || !hasStorage()) return;
  try {
    if (remember) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  } catch {
    /* quota / private mode — the grant simply stays at its safe default */
  }
  if (!remember) purgeTranscriptsForViewer(viewerId);
}

/** Drop one viewer's cached transcripts, leaving their grant and other users' data alone. */
export function purgeTranscriptsForViewer(viewerId: TranscriptViewerId): void {
  const id = normalizeViewerId(viewerId);
  if (id === null || !hasStorage()) return;
  removeKeys(keysWithPrefix(`${TRANSCRIPT_KEY_PREFIX}${TRANSCRIPT_GENERATION}.u${id}.`));
}

/**
 * Sweep EVERY AI-DM local key — all users, campaigns, scopes and cache generations,
 * plus the device grants.
 *
 * Called from every identity boundary in AuthProvider. It is deliberately total rather
 * than scoped to the departing user: at sign-out we know only who is leaving, not who
 * else has left residue on this browser, and residue from any prior account is the leak
 * this issue is about. Sweeping is cheap (a handful of keys) and unrecoverable, which is
 * the "clear" half of the acceptance criteria that namespacing alone cannot satisfy.
 */
export function purgeLocalAiTranscripts(): void {
  if (!hasStorage()) return;
  removeKeys(keysWithPrefix(AI_DM_STORAGE_PREFIX));
}

/** Guard so the legacy sweep runs once per page-session rather than on every render. */
let legacySwept = false;

/**
 * Delete pre-#573 caches, which have no user namespace and therefore no provable owner.
 *
 * Run once as soon as an identity is established, so an existing install stops leaking
 * the moment it loads this build — waiting for the next sign-out would leave the very
 * data the issue reports readable by whoever signs in first after the upgrade.
 */
export function purgeLegacyTranscripts(): void {
  if (legacySwept) return;
  legacySwept = true;
  if (!hasStorage()) return;
  const stale = keysWithPrefix(TRANSCRIPT_KEY_PREFIX).filter(
    (key) => !key.startsWith(`${TRANSCRIPT_KEY_PREFIX}${TRANSCRIPT_GENERATION}.`),
  );
  removeKeys(stale);
}

/** Test seam: re-arm the once-per-session legacy sweep. */
export function resetLegacyTranscriptSweepForTests(): void {
  legacySwept = false;
}

// ---- Hydration ordering (#573) --------------------------------------------

/** What a surface knows about the viewer on one render pass. */
export interface TranscriptIdentity {
  /** True once the `/me` probe has resolved — signed in OR proven signed out. */
  ready: boolean;
  /** The authenticated user id. Meaningless (and ignored) while `ready` is false. */
  userId: number | null;
}

/** The identity a surface was last rendered for. Opaque; produced by {@link decideTranscriptHydration}. */
export interface TranscriptIdentitySeen {
  ready: boolean;
  viewerId: TranscriptViewerId;
}

/** The starting point for {@link decideTranscriptHydration} — "we have seen nothing yet". */
export const NO_IDENTITY_SEEN: TranscriptIdentitySeen = { ready: false, viewerId: null };

export interface TranscriptHydrationDecision {
  /** The viewer whose cache this pass may touch; null means "touch nothing". */
  viewerId: TranscriptViewerId;
  /** True while `/me` has not resolved: no hydrate, no seed, no persist on this pass. */
  identityPending: boolean;
  /**
   * The established identity differs from the last pass, so whatever the reducer holds
   * belongs to the PREVIOUS identity and one pass must be skipped.
   */
  identityChanged: boolean;
  /** Feed back as `previous` on the next pass. */
  seen: TranscriptIdentitySeen;
}

/**
 * Decide what a transcript surface may do on one render pass (#573).
 *
 * Extracted as a pure function for the same reason `authDecision.ts` was: the ordering it
 * encodes — "never hydrate before the current identity is established, and skip one pass
 * whenever that identity changes" — is the load-bearing rule of this fix, it will not
 * reproduce reliably in a browser (every AI-DM surface currently mounts behind
 * AuthedLayout's splash, so the race is latent rather than live today), and a rule that
 * cannot be driven deterministically is a rule that silently rots. Feeding this a
 * hand-built sequence of passes IS driving the ordering.
 *
 * `ready` and `viewerId` are tracked separately on purpose. `viewerId === null` is true
 * both while `/me` is in flight and after a proven sign-out; only the first must block,
 * while both must count as a CHANGE when they flip — otherwise a sign-out followed by a
 * different sign-in on the same mounted tree would look like "null the whole time".
 */
export function decideTranscriptHydration(
  identity: TranscriptIdentity,
  previous: TranscriptIdentitySeen,
): TranscriptHydrationDecision {
  const viewerId = identity.ready ? normalizeViewerId(identity.userId) : null;
  const identityChanged = previous.ready !== identity.ready || previous.viewerId !== viewerId;
  return {
    viewerId,
    identityPending: !identity.ready,
    identityChanged,
    seen: { ready: identity.ready, viewerId },
  };
}
