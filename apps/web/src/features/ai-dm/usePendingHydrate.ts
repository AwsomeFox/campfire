import { useRef } from 'react';

/**
 * A one-pass latch for "I just dispatched a hydrate/reset; the next reader of this reducer
 * state is looking at the OLD value" (#572).
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
 * Deliberately a ref rather than state: this coordinates effects WITHIN a commit and must
 * not itself trigger a render, or it would race the very dispatch it is guarding.
 */
export interface PendingHydrateLatch {
  /** Call immediately after dispatching a hydrate/reset the current commit cannot see. */
  mark(): void;
  /**
   * True exactly once per {@link mark}, and consumes the latch. Call it BEFORE reading the
   * reducer state, and return early when it is true — that pass's view is stale.
   */
  consume(): boolean;
}

export function usePendingHydrate(): PendingHydrateLatch {
  const pending = useRef(false);
  const latch = useRef<PendingHydrateLatch>();
  if (!latch.current) {
    // Stable identity so the latch can sit in an effect's dependency array without
    // re-running it, and so callers can destructure it once.
    latch.current = {
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
  return latch.current;
}
