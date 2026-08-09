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
  | { kind: 'derived' }
  /**
   * The write cannot be reconciled — the caller must refetch and retry. Raised for a rename
   * that lost its race: applying it would leave the item named one thing while granting an
   * action named another, and neither silently winning nor silently discarding the other
   * writer's work is honest. The service turns this into a 409, the way it already does for
   * a slot conflict and an owner change.
   */
  | { kind: 'conflict' };

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

    // A concurrent EXPLICIT removal. Review (chatgpt-codex-connector P2): a rename-only
    // request that began from a derived action does not change any fingerprint input, so a
    // `PATCH { equippedAction: null }` landing mid-derivation would otherwise pass every
    // check and resurrect exactly what the user just deleted. The removal is a human
    // decision and outranks a rename's incidental re-derivation; the rename still applies,
    // and with no action on the row there is no name to mismatch. An EQUIP is excluded —
    // equipping is the documented way to ask for a fresh derivation.
    const concurrentRemoval = !state.moved && !state.equipTransition && state.existingHasAction && !state.freshHasAction;
    if (concurrentRemoval) return { kind: 'leave' };

    if (state.derivationInputsUnchanged && state.derivationProducedAction) return { kind: 'derived' };

    // The derivation cannot land. What that MEANS depends on why this request was deriving.
    //
    // An equip must clear: the transaction goes on to set `equipped = true`, so leaving an
    // action computed from inputs the row no longer has would arm stale mechanics — the
    // failure mode the fences exist to prevent, reached by doing nothing.
    //
    // A rename-only request arms nothing. Review (chatgpt-codex-connector P2): when a DM's
    // name-only PATCH derives for character A while a concurrent move-and-equip commits a
    // fresh, correct action for character B, this request's fingerprint fails — and clearing
    // would erase B's brand-new action, leaving the item granting nothing until someone
    // equips again. The winning writer's action is current for the state that actually
    // exists; the rename simply loses the race for the action's title. Leave it be.
    // …but never when the item is CHANGING HANDS. An action is private to the character it
    // was granted to, so an ownership change discards it whatever else is true — that rule
    // outranks preserving a concurrent writer's work, and the state sweep caught an earlier
    // version of this carve-out violating it.
    //
    // Review (chatgpt-codex-connector P2), correcting the previous round: this branch is
    // only ever reached by a RENAME (the sole non-equip trigger), and a rename writes the
    // item's new name regardless. So preserving the winner's action would leave the item
    // named C while permanently granting an action named B — the mismatch the rename was
    // supposed to fix, made permanent. Discarding the winner's fresh, correct action is no
    // better. Neither side can be chosen silently, so the caller is told to refetch and
    // retry, exactly as a slot conflict or an owner change already does here.
    const equipWouldArmIt = state.equipTransition;
    if (!equipWouldArmIt && !state.moved && state.freshHasAction) return { kind: 'conflict' };

    return { kind: 'clear' };
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
