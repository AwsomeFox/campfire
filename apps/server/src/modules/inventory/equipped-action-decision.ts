/**
 * What a write should do with an item's `equippedAction` / `equippedActionSource` pair
 * (issue #2097).
 *
 * This decision used to live as a chain of conditions inside `InventoryService.update()`,
 * and it accreted a clause per review round: gate on an equip transition, then also on a
 * rename, then protect a concurrently-authored manual action, then fence on the accepted
 * revision, then on the owner, then on the wielder's stats, then on the item name. Each
 * addition was correct in isolation and none of them made the whole reachable state visible,
 * so the next review kept finding the next unconsidered cell.
 *
 * Pulling it out as a pure function does not by itself make the logic right — the point is
 * that the state space becomes something a test can ENUMERATE rather than something a reader
 * has to hold in their head while scrolling a transaction body. The companion spec sweeps the
 * full cross product and asserts the invariants that matter, so an uncovered combination
 * shows up as a failing property instead of as a review comment three rounds later.
 *
 * Deliberately server-internal rather than in `@campfire/schema`: this is orchestration for
 * one write path, not a shared domain contract.
 */

/** Where an item's equipped action came from. Mirrors the schema's `EquippedActionSource`. */
export type ActionProvenance = 'derived' | 'manual';

/** The four things a write can do with the action pair. */
export type EquippedActionWrite =
  /** Touch neither column — the row keeps whatever it has. */
  | { kind: 'leave' }
  /** Null both columns. */
  | { kind: 'clear' }
  /** Store the caller's own action and mark it `manual`. */
  | { kind: 'authored' }
  /** Store this request's derivation and mark it `derived`. */
  | { kind: 'derived' };

/**
 * The subset of the state that decides whether a derivation is worth ATTEMPTING — known
 * before the transaction opens, which is when the caller has to run it (deriving awaits, and
 * a better-sqlite3 transaction is synchronous). Exported so the service gates its expensive
 * pre-transaction derivation on exactly the same rule the final decision applies, rather
 * than on a second copy of it that can drift.
 */
export interface DerivationTrigger {
  ownerIsCharacter: boolean;
  moved: boolean;
  equipTransition: boolean;
  renameOfDerivedAction: boolean;
  authoredProvided: boolean;
  existingHasAction: boolean;
  existingProvenance: ActionProvenance | null;
}

/**
 * Everything the final decision depends on: the trigger fields above, plus what the row looks
 * like INSIDE the transaction (`fresh*`, which is how concurrent writers are detected) and
 * what the derivation attempt produced.
 */
export interface EquippedActionDecision extends DerivationTrigger {
  /** The caller's supplied `equippedAction` was non-null (see `authoredProvided`). */
  authoredIsAction: boolean;

  // ---- the row inside the transaction ----
  freshHasAction: boolean;
  freshProvenance: ActionProvenance | null;

  // ---- the derivation attempt ----
  /** Every input the derivation read still matches the in-transaction row. */
  derivationInputsUnchanged: boolean;
  /** The derivation produced an action (false = it produced nothing usable). */
  derivationProducedAction: boolean;
}

/**
 * Decide what to write. Pure: no I/O, no clock, no randomness.
 *
 * The order of the branches is the priority order, and it is load-bearing:
 *
 *  1. An explicit `equippedAction` from the caller always wins. It is a human's intent, and
 *     it marks the row `manual` so derivation never regenerates over it again.
 *  2. Otherwise a derivation may run — see {@link shouldDeriveEquippedAction} for when, and note it can
 *     resolve to `clear` as well as to `derived`.
 *  3. Otherwise an ownership change clears the pair, because an action is private to the
 *     character it was granted to.
 *  4. Otherwise nothing is touched.
 */
export function resolveEquippedActionWrite(state: EquippedActionDecision): EquippedActionWrite {
  if (state.authoredProvided) {
    return state.authoredIsAction ? { kind: 'authored' } : { kind: 'clear' };
  }

  if (shouldDeriveEquippedAction(state)) {
    // A concurrent writer may have authored a manual action between this request reading the
    // row and the transaction opening. That action is a human's and outranks this derivation,
    // so the write stands down entirely rather than clearing. `moved` is exempt: the
    // ownership rule discards the old owner's action in this same write regardless of who
    // wrote it, so there is nothing left to protect.
    const concurrentManual = !state.moved && state.freshHasAction && state.freshProvenance === 'manual';
    if (concurrentManual) return { kind: 'leave' };

    // A derivation only lands if it is still current AND produced something. Otherwise the
    // pair is CLEARED, never left as-is: leaving a stale derived action while the transaction
    // goes on to equip the item would arm mechanics computed from inputs the row no longer
    // has — the failure mode the fences exist to prevent, reached by doing nothing.
    return state.derivationInputsUnchanged && state.derivationProducedAction ? { kind: 'derived' } : { kind: 'clear' };
  }

  if (state.moved) return { kind: 'clear' };

  return { kind: 'leave' };
}

/**
 * Whether this request should attempt a derivation at all.
 *
 * Two triggers, for unrelated reasons: an equip (the action becomes usable, so it has to
 * exist and to reflect the current wielder) and a rename of an already-derived action (a
 * derived action is titled after its item; only a MANUAL action may carry a name of its own).
 *
 * Three preconditions: the item must end up on a character, the caller must not have supplied
 * an action of their own, and any action already on the row must not be `manual` — unless the
 * request moves the item, in which case the old owner's action is being discarded anyway.
 */
export function shouldDeriveEquippedAction(state: DerivationTrigger): boolean {
  const triggered = state.equipTransition || state.renameOfDerivedAction;
  if (!triggered) return false;
  if (!state.ownerIsCharacter) return false;
  if (state.authoredProvided) return false;
  return state.moved || !state.existingHasAction || state.existingProvenance === 'derived';
}
