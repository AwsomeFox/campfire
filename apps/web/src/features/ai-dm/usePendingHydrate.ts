import { useRef } from 'react';
import {
  decideTranscriptHydration,
  NO_IDENTITY_SEEN,
  purgeLegacyTranscripts,
  type TranscriptIdentity,
  type TranscriptIdentitySeen,
  type TranscriptViewerId,
} from './transcriptPrivacy';

export type { TranscriptIdentity } from './transcriptPrivacy';

/**
 * The ordering guard shared by every AI-DM transcript surface (#572, extended by #573).
 *
 * WHY THIS EXISTS. The AI-DM transcript surfaces all share one shape: an effect keyed on
 * `campaignId` (or on driver-mode) dispatches `hydrate` to repoint the reducer at a
 * different campaign's data, and a LATER effect in the SAME commit makes a decision from
 * `transcript.entries`. React applies the dispatch on the next render, so that later effect
 * reads the previous campaign's entries and concludes the wrong thing — and because the
 * conclusions are latched in refs (`seededRef`), one stale read poisons the rest of the
 * session rather than self-correcting on the next pass.
 *
 * It bit twice in `useAiDmLiveActivity` (a join-context placeholder seeded over cached
 * scrollback, then persisted over it) and once in `AiTablePage` (a table -> table switch
 * flipping `seededRef` true off the OLD campaign's entries, so the new table never seeded
 * its scene). Three near-identical races is enough to keep the guard in one place instead
 * of hand-rolling a fourth ref.
 *
 * #573 IS THE FOURTH ORDERING CONSTRAINT, and it lives here for exactly that reason.
 * "Never hydrate before the current identity is established" is the same class of bug one
 * level up: the surfaces mount before `/me` resolves, so a slow auth check let a surface
 * read a transcript cache without yet knowing WHOSE it was. On a shared browser that
 * painted user A's table for user B. So this latch now also owns the viewer:
 *
 *   - {@link PendingHydrateLatch.viewerId} is null until identity is established, and
 *     every storage entry point does nothing for a null viewer — so there is simply no
 *     key to read before `/me` answers. Consumers pass it straight through.
 *   - a change of established identity (first sign-in, an account switch, a dev-auth
 *     identity flip, a sign-out) auto-marks the latch, so the seed effect that runs later
 *     in that SAME commit skips its stale pass without each consumer diffing user ids.
 *
 * Deliberately a ref rather than state: this coordinates effects WITHIN a commit and must
 * not itself trigger a render, or it would race the very dispatch it is guarding. The
 * returned object's identity is stable while its `viewerId` field is refreshed each
 * render, so consumers can put `latch.viewerId` in a dependency array and get the current
 * value without the latch itself being a changing dependency.
 */
export interface PendingHydrateLatch {
  /**
   * The viewer whose transcripts this surface may touch, or null when identity is not
   * established. Pass straight to `loadTranscript` / `saveTranscript` / `clearTranscript`,
   * and use it as (part of) the key of the effect that repoints the reducer.
   */
  viewerId: TranscriptViewerId;
  /**
   * True while `/me` has not resolved. No surface may hydrate, seed or persist in this
   * state. Distinct from `viewerId === null`, which is also true for a proven sign-out.
   */
  identityPending: boolean;
  /** Call immediately after dispatching a hydrate/reset the current commit cannot see. */
  mark(): void;
  /**
   * True exactly once per {@link mark}, and consumes the latch. Call it BEFORE reading the
   * reducer state, and return early when it is true — that pass's view is stale.
   */
  consume(): boolean;
}

export function usePendingHydrate(identity: TranscriptIdentity): PendingHydrateLatch {
  const pending = useRef(false);
  const latch = useRef<PendingHydrateLatch>();
  const seen = useRef<TranscriptIdentitySeen>(NO_IDENTITY_SEEN);
  const decision = decideTranscriptHydration(identity, seen.current);

  if (!latch.current) {
    // Stable identity so the latch can sit in an effect's dependency array without
    // re-running it, and so callers can destructure it once.
    latch.current = {
      viewerId: decision.viewerId,
      identityPending: decision.identityPending,
      mark: () => {
        pending.current = true;
      },
      consume: () => {
        if (!pending.current) return false;
        pending.current = false;
        return true;
      },
    };
  }

  if (decision.identityChanged) {
    seen.current = decision.seen;
    // The identity this surface is rendering for just changed. Anything the reducer
    // currently holds belongs to the PREVIOUS identity, so the same one-pass skip the
    // campaign switch needs applies here — mark it centrally instead of asking every
    // consumer to diff user ids for itself. Marking during render is safe and matches how
    // the latch object itself is created: it is a ref write, never a state update, so it
    // cannot re-enter the render it is guarding. A StrictMode double-invoke sees no change
    // on the second pass because `seen` is already updated.
    pending.current = true;
    // First established identity of the page-session is also the moment to drop pre-#573
    // caches, which have no user namespace and so no provable owner. Self-guarded to run
    // once; doing it here rather than on the next sign-out means an upgraded install stops
    // leaking as soon as it loads, not whenever somebody happens to sign out.
    if (identity.ready) purgeLegacyTranscripts();
  }

  latch.current.viewerId = decision.viewerId;
  latch.current.identityPending = decision.identityPending;
  return latch.current;
}
