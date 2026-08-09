import {
  resolveEquippedActionWrite,
  shouldDeriveEquippedAction,
  type ActionProvenance,
  type EquippedActionDecision,
  type EquippedActionWrite,
} from '../../src/modules/inventory/equipped-action-decision';

/**
 * Issue #2097 — the equipped-action write decision, enumerated.
 *
 * Thirteen review rounds found this logic one unconsidered cell at a time, every one of them
 * a concurrency or state-transition case: an unrelated PATCH deriving, a fence miss leaving a
 * stale action armed, a manual action overwritten by a racing derivation, a derivation landing
 * from a superseded revision / owner / wielder / name. Each fix was correct and none made the
 * reachable state visible, so the next round found the next cell.
 *
 * This spec sweeps the FULL cross product — 1,728 states — and asserts the invariants rather
 * than a hand-picked list of scenarios. An unconsidered combination now fails a property here
 * instead of arriving as a review comment.
 */

const PROVENANCES: Array<ActionProvenance | null> = ['derived', 'manual', null];
const BOOLS = [false, true];

/** Every reachable state, filtered to the internally consistent ones. */
function allStates(): EquippedActionDecision[] {
  const out: EquippedActionDecision[] = [];
  for (const authoredProvided of BOOLS)
    for (const authoredIsAction of BOOLS)
      for (const ownerIsCharacter of BOOLS)
        for (const moved of BOOLS)
          for (const equipTransition of BOOLS)
            for (const renameOfDerivedAction of BOOLS)
              for (const existingProvenance of PROVENANCES)
                for (const freshProvenance of PROVENANCES)
                  for (const derivationInputsUnchanged of BOOLS)
                    for (const derivationProducedAction of BOOLS) {
                      // `authoredIsAction` only means anything when one was provided, and a
                      // provenance exists exactly when an action does — modelling those as
                      // free variables would sweep states the service cannot produce.
                      if (!authoredProvided && authoredIsAction) continue;
                      out.push({
                        authoredProvided,
                        authoredIsAction,
                        ownerIsCharacter,
                        moved,
                        equipTransition,
                        renameOfDerivedAction,
                        existingHasAction: existingProvenance !== null,
                        existingProvenance,
                        freshHasAction: freshProvenance !== null,
                        freshProvenance,
                        derivationInputsUnchanged,
                        derivationProducedAction,
                      });
                    }
  return out;
}

const STATES = allStates();

describe('resolveEquippedActionWrite — the whole reachable state (#2097)', () => {
  it('sweeps the whole cross product', () => {
    // 8 booleans x 2 provenance triples, less the states where `authoredIsAction` is set
    // without `authoredProvided` (which the service cannot produce).
    const full = 2 ** 8 * 3 * 3;
    const impossible = 2 ** 6 * 3 * 3;
    expect(STATES.length).toBe(full - impossible);
    expect(STATES.length).toBe(1728);
  });

  it('always returns exactly one of the four writes', () => {
    const kinds = new Set(STATES.map((s) => resolveEquippedActionWrite(s).kind));
    expect([...kinds].sort()).toEqual(['authored', 'clear', 'conflict', 'derived', 'leave']);
  });

  // ---- the invariants every round of review was really about ----

  it("NEVER overwrites a human's action that is already on the row", () => {
    // The promise the whole editor rests on. The single exception is a move: the
    // ownership-change rule discards the previous owner's action regardless of who wrote it,
    // because that action was private to them.
    for (const s of STATES) {
      const write = resolveEquippedActionWrite(s);
      const wouldReplace = write.kind === 'derived';
      const freshIsManual = s.freshHasAction && s.freshProvenance === 'manual';
      if (freshIsManual && !s.moved) expect(wouldReplace).toBe(false);
    }
  });

  it('never writes a derivation that is out of date or empty', () => {
    for (const s of STATES) {
      if (resolveEquippedActionWrite(s).kind !== 'derived') continue;
      expect(s.derivationInputsUnchanged).toBe(true);
      expect(s.derivationProducedAction).toBe(true);
    }
  });

  it('never resurrects an action a human explicitly removed mid-flight', () => {
    // Review (chatgpt-codex-connector P2): a rename-only request changes no fingerprint
    // input, so a concurrent `PATCH { equippedAction: null }` would otherwise pass every
    // check and put back exactly what the user just deleted.
    for (const s of STATES) {
      if (!shouldDeriveEquippedAction(s)) continue;
      if (s.moved || s.equipTransition || !s.existingHasAction || s.freshHasAction) continue;
      expect(resolveEquippedActionWrite(s).kind).toBe('leave');
    }
  });

  it('a stale derivation NEVER destroys an action that is already there', () => {
    // The invariant three review rounds converged on. Whoever wrote the row's action passed
    // their own fences against the state they saw; ours was computed against state that has
    // moved. Neither keeping nor discarding theirs can be chosen silently, so the caller
    // retries. Excluded: a MOVE (the action is private to its character and an ownership
    // change discards it regardless) and a concurrent human action or removal, both of which
    // outrank this derivation outright.
    for (const s of STATES) {
      if (!shouldDeriveEquippedAction(s)) continue;
      // Only when the INPUTS moved. A derivation whose inputs are still current and simply
      // produced nothing is replacing its own action with nothing, which is correct — see
      // the clear-on-empty case below.
      if (s.derivationInputsUnchanged || s.moved || !s.freshHasAction) continue;
      if (s.freshProvenance === 'manual') continue; // a human's action wins outright — `leave`
      expect(resolveEquippedActionWrite(s).kind).toBe('conflict');
    }
  });

  it('a current derivation that produced nothing clears, rather than conflicting', () => {
    // The accepted snapshot stops describing a weapon: nobody raced us, the row's action is
    // the one we set out to replace, and replacing it with nothing is the point.
    for (const s of STATES) {
      if (!shouldDeriveEquippedAction(s)) continue;
      if (!s.derivationInputsUnchanged || s.derivationProducedAction) continue;
      const concurrentManual = !s.moved && s.freshHasAction && s.freshProvenance === 'manual';
      const humanRemovedIt = !s.moved && !s.equipTransition && s.existingHasAction && !s.freshHasAction;
      if (concurrentManual || humanRemovedIt) continue;
      expect(resolveEquippedActionWrite(s).kind).toBe('clear');
    }
  });

  it('never leaves a stale action in place once a derivation was attempted', () => {
    // The round-10 defect: a fence miss that SKIPPED the write while the transaction went on
    // to equip the item, arming mechanics computed from inputs the row no longer had. When a
    // derivation runs and cannot land, the pair is cleared — unless a human's action arrived
    // concurrently, which outranks both.
    for (const s of STATES) {
      if (!shouldDeriveEquippedAction(s)) continue;
      const write = resolveEquippedActionWrite(s);
      const staleOrEmpty = !s.derivationInputsUnchanged || !s.derivationProducedAction;
      const concurrentManual = !s.moved && s.freshHasAction && s.freshProvenance === 'manual';
      // A rename-only request arms nothing, so it leaves the winner's action alone rather
      // than clearing — see the case above. This invariant is about the EQUIP path, which is
      // the one that would otherwise go on to arm stale mechanics.
      // A stale derivation only CLEARS when there is nothing of anyone else's to protect —
      // otherwise it conflicts (above) or defers to a human's action/removal.
      const someoneElsesWork = !s.derivationInputsUnchanged && !s.moved && s.freshHasAction;
      const humanRemovedIt = !s.moved && !s.equipTransition && s.existingHasAction && !s.freshHasAction;
      if (staleOrEmpty && !concurrentManual && !someoneElsesWork && !humanRemovedIt) expect(write.kind).toBe('clear');
    }
  });

  it('never leaves an action on an item that is not character-owned', () => {
    // A party-stash item can never carry one; the server rejects an authored action for one
    // outright, so only the derive/clear/leave paths reach here.
    for (const s of STATES) {
      if (s.ownerIsCharacter || s.authoredProvided) continue;
      const write = resolveEquippedActionWrite(s);
      expect(write.kind).not.toBe('derived');
      if (s.moved) expect(write.kind).toBe('clear');
    }
  });

  it('clears on every ownership change that does not author or derive', () => {
    // A move never resolves to `leave` or `conflict`: the action is private to the character
    // it was granted to, so an ownership change always disposes of it one way or the other.
    for (const s of STATES) {
      if (!s.moved || s.authoredProvided) continue;
      const write = resolveEquippedActionWrite(s);
      expect(['clear', 'derived']).toContain(write.kind);
    }
  });

  it('only ever conflicts when there is a competing action, and never on a move', () => {
    for (const s of STATES) {
      if (resolveEquippedActionWrite(s).kind !== 'conflict') continue;
      // Never on a move: an ownership change always disposes of the action itself.
      expect(s.moved).toBe(false);
      // And only when someone else's work is actually at stake.
      expect(s.freshHasAction).toBe(true);
      // Specifically because the inputs moved — never merely because it produced nothing.
      expect(s.derivationInputsUnchanged).toBe(false);
    }
  });

  it("an explicit action from the caller always wins, and null always clears", () => {
    for (const s of STATES) {
      if (!s.authoredProvided) continue;
      expect(resolveEquippedActionWrite(s).kind).toBe(s.authoredIsAction ? 'authored' : 'clear');
    }
  });

  it('touches nothing when the request neither authors, derives, nor moves', () => {
    // The round-3 defect in reverse: an unrelated PATCH (notes, qty, icon) must be inert.
    for (const s of STATES) {
      if (s.authoredProvided || s.moved || shouldDeriveEquippedAction(s)) continue;
      expect(resolveEquippedActionWrite(s).kind).toBe('leave');
    }
  });

  it('only ever derives when something actually triggered a derivation', () => {
    for (const s of STATES) {
      if (resolveEquippedActionWrite(s).kind !== 'derived') continue;
      expect(s.equipTransition || s.renameOfDerivedAction).toBe(true);
      expect(s.ownerIsCharacter).toBe(true);
    }
  });
});

describe('shouldDeriveEquippedAction (#2097)', () => {
  const base = {
    ownerIsCharacter: true,
    moved: false,
    equipTransition: true,
    renameOfDerivedAction: false,
    authoredProvided: false,
    existingHasAction: false,
    existingProvenance: null as ActionProvenance | null,
  };

  // One row per rule, so a change of intent has to change a named expectation.
  const table: Array<[string, Partial<typeof base>, boolean]> = [
    ['an equip with no action yet', {}, true],
    ['an equip re-deriving over a derived action', { existingHasAction: true, existingProvenance: 'derived' }, true],
    ['an equip refusing to touch a manual action', { existingHasAction: true, existingProvenance: 'manual' }, false],
    ['a move-and-equip discarding the old owner’s manual action', { moved: true, existingHasAction: true, existingProvenance: 'manual' }, true],
    ['a rename of a derived action', { equipTransition: false, renameOfDerivedAction: true }, true],
    ['a rename with no derivation trigger at all', { equipTransition: false, renameOfDerivedAction: false }, false],
    ['an equip onto the party stash', { ownerIsCharacter: false }, false],
    ['an equip where the caller authored their own action', { authoredProvided: true }, false],
  ];

  it.each(table)('%s', (_label, patch, expected) => {
    expect(shouldDeriveEquippedAction({ ...base, ...patch })).toBe(expected);
  });
});

describe('the decision is total and pure (#2097)', () => {
  it('never throws across the whole state space', () => {
    for (const s of STATES) expect(() => resolveEquippedActionWrite(s)).not.toThrow();
  });

  it('is deterministic — the same state always decides the same way', () => {
    for (const s of STATES) {
      const first: EquippedActionWrite = resolveEquippedActionWrite(s);
      expect(resolveEquippedActionWrite({ ...s })).toEqual(first);
    }
  });
});
