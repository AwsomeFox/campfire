import type { DriverLastUndoableCommit } from '@campfire/schema';

/**
 * The DM undo snackbar is short-lived by design: it must only offer to undo an action that
 * happens WHILE the DM is viewing the AI table (#1501).
 *
 * The lever (`session.lastUndoableCommit`) is projected to DMs whenever a reversible action is
 * armed, so it can already be present when the DM (re)opens the page — either left over from a
 * prior visit or rehydrated from the react-query cache. Surfacing an undo offer for such a stale
 * commit defeats the snackbar's purpose. The first LOADED session therefore seeds the "seen"
 * chain id; only a chain id that arrives AFTER that seed pops the snackbar.
 *
 * Extracted as a pure step function so the seeding rule is unit-testable without mounting the
 * React component (mirrors `aiDmPauseRequest` / `toolActivity`). The component owns the two refs
 * (`seenUndoChainRef`, the seeded flag) and applies the returned values each render.
 */
export interface UndoLeverStep {
  /** The commit to pop a fresh snackbar for this step, or `null` to leave the snackbar untouched. */
  pop: DriverLastUndoableCommit | null;
  /** Whether seeding has happened after this step (sticky once true). */
  seeded: boolean;
  /** The new value for the "seen" chain-id ref. */
  seenChainId: string | null;
}

export function nextUndoLeverState(args: {
  /** Has the session query finished loading (not still in its initial undefined state). */
  sessionFetched: boolean;
  /** Whether the "seen" chain id has been seeded from the first loaded session yet. */
  seeded: boolean;
  /** The current `session.lastUndoableCommit`, or `null` when absent/consumed. */
  commit: DriverLastUndoableCommit | null;
  /** The current "seen" chain id (previous step's `seenChainId`). */
  seenChainId: string | null;
}): UndoLeverStep {
  // Until the session has actually loaded, leave the lever untouched — neither a spurious pop
  // from a transient `undefined` session nor a premature seed.
  if (!args.sessionFetched) {
    return { pop: null, seeded: args.seeded, seenChainId: args.seenChainId };
  }
  // First loaded session: adopt whatever lever is present as already-seen so a commit that
  // predates the DM opening the table (prior visit, or rehydrated from cache on reopen) does
  // NOT pop a stale undo. Subsequent updates fall through to the normal "new chain id" check.
  if (!args.seeded) {
    return { pop: null, seeded: true, seenChainId: args.commit?.chainId ?? null };
  }
  // New reversible action arrived after the seed → pop. A repeated or absent lever is a no-op,
  // and the seen ref clears when the lever is consumed (undo applied / superseded) so the next
  // armed commit always pops.
  if (args.commit && args.commit.chainId !== args.seenChainId) {
    return { pop: args.commit, seeded: true, seenChainId: args.commit.chainId };
  }
  return { pop: null, seeded: true, seenChainId: args.commit ? args.seenChainId : null };
}
