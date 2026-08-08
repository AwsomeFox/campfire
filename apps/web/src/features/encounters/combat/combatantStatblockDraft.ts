import type { CombatantStatblock } from '@campfire/schema';

/**
 * Issue #1992 — a real concurrency guard for the whole-statblock combatant PATCH
 * (`CombatantStatblockEditor`'s in-row editor). `patchCombatant` used to send a plain,
 * token-less PATCH on every keystroke, so two concurrent whole-statblock saves silently
 * last-write-won.
 *
 * PR #1983 (issue #1909) tried to close this same gap and produced five consecutive
 * review-caught regressions (no token; token but no debounce, 409ing at typing speed; a
 * token re-read right before send, defeating the CAS check entirely; a per-combatant
 * cache going stale from unrelated writes; a debounce-timer draft leak across an
 * encounter switch) — full narrative in issue #1992 and PR #2027's history. This module
 * is the pure state machine behind the fix that finally closed it, after several more
 * review rounds on top of that:
 *   - One PATCH per edit session (on blur), not per keystroke — see `dirty` below.
 *   - The base value is captured ONCE, when a fresh (non-dirty) statblock arrives from
 *     the server (`external`), and reused UNCHANGED through send — never refreshed at
 *     dispatch time. While a local edit is uncommitted (`dirty`), an `external` update is
 *     ignored rather than clobbering the draft or silently advancing its base.
 *   - No timer/queue exists to leak a stale draft across an encounter switch: a commit
 *     attempt fires synchronously from the blur event itself, and a `useEffect` cleanup
 *     in `CombatantRow` flushes one last attempt on unmount.
 *   - `revision`, bumped on every `edit`: `accepted` only clears `dirty` when its
 *     revision still matches the CURRENT one — an edit made while an EARLIER revision's
 *     write was still in flight is not silently marked done by that write resolving.
 *   - An in-flight-revision ref in `CombatantRow` stops a blur immediately followed by an
 *     unmount from sending the same draft twice.
 *   - `commitStatblock` is gated by `syncBlocked`, matching every sibling write control
 *     in that file, and flushes automatically once the gate lifts.
 *   - A rejected write (or one skipped by the sync gate) leaves `dirty` alone rather than
 *     letting the settle-triggered `external` refetch silently discard the draft.
 *
 * Round 4 (escalated by the user after a Devin finding): every fix above still pinned the
 * ENCOUNTER-WIDE `updatedAt` as the CAS token. But EVERY combatant write anywhere in that
 * encounter bumps it, so an HP tick, a condition change, or a different combatant's
 * resource pip — during an ordinary live session, more or less anything — would 409 an
 * in-progress statblock edit, and because a rejected write dispatches nothing, every retry
 * resent the SAME now-permanently-stale token: unsavable without a reload. Moved the
 * pinned token to a PER-COMBATANT revision (`combatants.updatedAt`) instead — narrower,
 * but still a proxy for "something about this row changed," not for "the statblock
 * changed."
 *
 * Round 5 (Devin, again): that per-combatant token is STILL the wrong thing to guard a
 * statblock edit with, for the same underlying reason one level deeper — it also advances
 * on an hp tick, a condition change, or a token move on THIS SAME combatant, none of which
 * touch the statblock at all. A monster taking damage mid-edit reproduced the identical
 * permanent-dead-end shape as round 3→4's bug. The fix this time drops the row-revision
 * proxy entirely: `baseStatblock` below pins the STATBLOCK CONTENT this draft started
 * from, sent back as `expectedStatblock` (checked server-side against the row's current
 * `statblockJson` by value, not by any timestamp). An hp/condition/position write cannot
 * change that stored value, so it structurally cannot invalidate the edit — only a
 * genuine concurrent statblock write can. Every mechanism from the rounds above (revision
 * gating for edit-during-flight, in-flight dedupe, the sync gate, the rejection/dirty
 * handling) is unchanged; only WHAT is captured/compared as the base is different, and
 * `external`-while-`dirty` staying a no-op is now correct for a stronger reason than
 * before: it no longer needs to "catch up" a token that unrelated activity keeps moving,
 * because the guarded value (the statblock itself) simply isn't affected by that activity.
 *
 * Round 6 (coordinator review): the per-combatant token (`combatants.updated_at` /
 * `expectedCombatantUpdatedAt`, round 4's fix) was removed from the codebase entirely
 * rather than kept "for other callers" — it had shipped with no sender anywhere in this
 * client and no reader anywhere but its own doc comments, and its own write coverage
 * never matched the "any write to this combatant" guarantee it claimed (the action
 * resolver, sheet mirror, turn-state resets, token batches, and effect ticking all write
 * combat state to the row without advancing it). This module and `statblock` never used
 * it for anything real — `expectedStatblock` was always its only actual consumer.
 *
 * Round 8 (Devin, after round 7's separate encounterId-on-navigation fix): the CONTENT
 * guard above is correct, but "dedupe only the SAME in-flight revision" was not. Blur ->
 * refocus -> edit -> blur, all inside one round-trip, sent a SECOND write whose
 * `expectedStatblock` was still the pre-FIRST-write content — the user's own earlier save
 * was rejected as if it were a third party's. Because a rejected write leaves `dirty`
 * alone (by design, since round 1) and `external` was unconditionally ignored while
 * dirty, the stale base could never refresh: the same permanent-dead-end shape every
 * prior round produced, just from a third cause. Two changes close it:
 *   - `CombatantRow.commitStatblock` now defers ANY commit while another is already in
 *     flight for this row — not merely one for the SAME revision — so at most one
 *     statblock write is ever outstanding. A newer edit made during that window stays
 *     `dirty` and is sent automatically once the outstanding write is CONFIRMED
 *     ACCEPTED, rebased on the base that acceptance just confirmed. This removes the
 *     self-conflict by construction: two of THIS client's own writes for the same row
 *     can no longer race each other at all.
 *   - A REJECTED write (a genuine conflict, now that self-conflict is structurally
 *     impossible) sets `needsRebase` below. The next `external` update — already
 *     triggered unconditionally by `combatantPatch.onSettled`, win or lose — is allowed
 *     to refresh `baseStatblock` even while `dirty`, but ONLY `baseStatblock`: `draft`
 *     and `dirty` are untouched, and nothing is auto-resent. Auto-resending here would
 *     silently overwrite the genuine other writer's change with no new decision from the
 *     user — exactly the bug this whole guard exists to prevent; see
 *     `CombatantRow.commitStatblock`'s doc for why that auto-flush is keyed off
 *     acceptance, never rejection. The user keeps their unsaved edit and can save it
 *     again (another edit, or simply blurring the field again) without reloading the
 *     page; if a genuine third party's change is still there, that resend can still
 *     silently replace it — this fix guarantees the edit is SAVABLE again, not that a
 *     true concurrent edit is merged.
 *
 * `accepted` also now guards against an out-of-order confirmation (`baseRevision`
 * below): with commits fully serialized per row, two of this client's OWN writes can no
 * longer overlap, but a stale confirmation for an already-superseded revision arriving
 * late must still not regress `baseStatblock` back to content the store has moved past.
 *
 * Round 9 (Devin, on round 8's own recovery path): "the next `external` may re-seed
 * `baseStatblock` after a rejection" was correct, but incomplete — it said nothing about
 * what happens NEXT. Once that rebase lands, the draft is `dirty` again with a base that
 * now matches the OTHER writer's content, so `statblockPatchForCommit` produces a patch
 * the server's content-compare ACCEPTS — even though the draft itself is still the
 * user's stale, unmodified, already-rejected content. `CombatantRow` has THREE paths that
 * call `commitStatblock`: the blur handler, and two fully automatic ones (the unmount
 * flush and the sync-gate-lift flush). Only sending on a genuine user action was already
 * the stated rule (see round 8's note above: "waits for an explicit new user action") —
 * but it was only ever enforced by NOT wiring an auto-flush to `rejected` specifically;
 * nothing stopped the TWO PRE-EXISTING automatic flushes (unmount, sync-gate-lift, both
 * predating this rejection path) from firing anyway and silently resending the untouched
 * draft the instant the rebase completed.
 *
 * `awaitingReedit` below closes it in one place: set the moment the round-8 rebase
 * itself lands (dirty, needsRebase clearing), cleared by a genuine `edit` (the user is
 * actively engaged again) or once a write is confirmed `accepted`. `CombatantRow` passes
 * every call site's trigger explicitly (`'explicit'` for the blur handler, `'automatic'`
 * for the unmount/sync-gate-lift/queued-after-accept flushes); `commitStatblock` is the
 * ONE place that checks `awaitingReedit` against that trigger, so this is enforced once,
 * for all three flush paths, rather than requiring each call site to remember to check.
 */

export type StatblockDraftState = {
  draft: CombatantStatblock;
  /** The statblock content this draft is confirmed to currently match on the server —
   * sent back as `expectedStatblock` so the server can reject only a write that would
   * clobber someone else's actual statblock edit, never one that merely followed an
   * unrelated write to the same row (hp/condition/position). */
  baseStatblock: CombatantStatblock;
  /** True from the first uncommitted edit until its OWN revision is confirmed accepted. */
  dirty: boolean;
  /** Bumped by every `edit` — lets a confirmation for an EARLIER revision be told apart
   * from a newer, still-uncommitted edit made while that earlier write was in flight. */
  revision: number;
  /** The revision whose CONFIRMED (`accepted`) write produced the current
   * `baseStatblock` — 0 until the first write is ever confirmed. Guards `accepted`
   * against an out-of-order confirmation: an earlier revision's response arriving AFTER
   * a later one has already advanced the base must not regress it back to stale
   * content (round 8). */
  baseRevision: number;
  /** True from a REJECTED write until the next `external` update re-seeds
   * `baseStatblock` from real current content (round 8). A rejection means the base
   * this draft was comparing against is now known-stale — but the draft itself must
   * stay exactly as the user left it, so only `baseStatblock` is refreshed, never
   * `draft`, and nothing is sent automatically; see the module doc for why. */
  needsRebase: boolean;
  /** True from the moment a round-8 rebase lands (a rejected write's base gets re-seeded
   * by `external` while still `dirty`) until a genuine user action clears it — a further
   * `edit`, or a write that reaches `accepted` (round 9). While true, `commitStatblock`
   * refuses to send from an AUTOMATIC trigger (unmount flush, sync-gate-lift flush): the
   * draft is still the user's original, already-rejected content, now paired with a base
   * that matches a genuine OTHER writer's change, so an automatic resend would silently
   * overwrite it. An EXPLICIT trigger (the user actually blurring the field) is always
   * allowed through regardless of this flag — that is the "new user action" the module
   * doc requires, even without a further `edit`. */
  awaitingReedit: boolean;
};

export type StatblockDraftAction =
  /** Fresh server truth arrived (initial mount, or after a settled write). */
  | { type: 'external'; statblock: CombatantStatblock }
  /** A local, not-yet-saved edit (mirrors `CombatantStatblockEditor`'s onChange). */
  | { type: 'edit'; statblock: CombatantStatblock }
  /** The write for `revision` was confirmed accepted; `statblock` is exactly what THAT
   * write sent (captured at commit time, not re-read from current state), which the
   * server has now confirmed is the row's stored value. */
  | { type: 'accepted'; revision: number; statblock: CombatantStatblock }
  /** The write for `revision` was REJECTED (`STALE_WRITE`) — a genuine conflict, since
   * round 8's serialization rules out this being one of this draft's own earlier sends.
   * Carries no statblock: the server told us what we sent does NOT match, not what IS
   * stored — that arrives separately via the settle-triggered `external`. */
  | { type: 'rejected'; revision: number };

export function initialStatblockDraftState(statblock: CombatantStatblock): StatblockDraftState {
  return {
    draft: statblock,
    baseStatblock: statblock,
    dirty: false,
    revision: 0,
    baseRevision: 0,
    needsRebase: false,
    awaitingReedit: false,
  };
}

export function statblockDraftReducer(state: StatblockDraftState, action: StatblockDraftAction): StatblockDraftState {
  switch (action.type) {
    case 'external':
      // A dirty draft holds an uncommitted (or rejected-and-not-yet-retried) edit — a
      // write to a DIFFERENT combatant (or an unrelated field on THIS one) must not
      // silently discard it, nor advance the base it will send. The ONE deliberate
      // exception (round 8): a REJECTED write sets `needsRebase`, and this refresh is
      // exactly the recovery path that clears it — but it still only ever touches
      // `baseStatblock`, never `draft`, so the user's in-progress edit is unaffected.
      // Round 9: THIS is also the exact moment `awaitingReedit` turns on — the base now
      // matches a genuine other writer's content, paired with the user's untouched,
      // already-rejected draft, so an AUTOMATIC resend (not a fresh user action) must be
      // refused until one of the module doc's two escape hatches applies.
      if (state.dirty) {
        if (!state.needsRebase) return state;
        return { ...state, baseStatblock: action.statblock, needsRebase: false, awaitingReedit: true };
      }
      return {
        draft: action.statblock,
        baseStatblock: action.statblock,
        dirty: false,
        revision: state.revision,
        baseRevision: state.baseRevision,
        needsRebase: false,
        awaitingReedit: false,
      };
    case 'edit':
      // Round 9: a genuine new edit is one of the two things that clears `awaitingReedit`
      // (the other is a write reaching `accepted`, below) — the user is actively engaged
      // with the field again, a fresh decision distinct from an automatic flush blindly
      // resending what they left behind.
      return { ...state, draft: action.statblock, dirty: true, revision: state.revision + 1, awaitingReedit: false };
    case 'accepted': {
      // Round 8: an out-of-order confirmation (an earlier revision's response arriving
      // after a later one already advanced the base) is a no-op — the base must never
      // regress to content the store has already moved past.
      if (action.revision <= state.baseRevision) return state;
      // The write really did land, and the server has confirmed `action.statblock` is now
      // the row's stored value — true regardless of whether a NEWER edit has since been
      // made. Always adopt it as the fresh base; only clear `dirty` when this confirmation
      // covers the draft CURRENTLY held (its revision still matches). Round 9: a landed
      // write also always clears `awaitingReedit` — the base is now fully in sync, so
      // there is nothing left to guard an automatic flush against.
      const next = { ...state, baseStatblock: action.statblock, baseRevision: action.revision, needsRebase: false, awaitingReedit: false };
      if (action.revision !== state.revision) return next;
      return { ...next, dirty: false };
    }
    case 'rejected':
      // Round 8: leave `draft`/`dirty`/`revision` exactly as they were (same as a
      // rejection has always behaved) — the only new effect is flagging the base as
      // stale so the next `external` can recover it. See the module doc for the full
      // reasoning and what this does and does not restore for the user. `awaitingReedit`
      // is untouched here on purpose (round 9): it is set by the REBASE (`external`), not
      // by the rejection itself, and if it was already true from an earlier cycle it must
      // stay true — nothing about a second rejection is a fresh user action.
      return { ...state, needsRebase: true };
    default:
      return state;
  }
}

/** The PATCH body to send for this state, or null when there is nothing uncommitted to save. */
export function statblockPatchForCommit(
  state: StatblockDraftState,
): { statblock: CombatantStatblock; expectedStatblock: CombatantStatblock; revision: number } | null {
  if (!state.dirty) return null;
  return { statblock: state.draft, expectedStatblock: state.baseStatblock, revision: state.revision };
}
