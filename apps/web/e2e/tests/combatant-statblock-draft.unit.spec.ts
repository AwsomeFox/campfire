/**
 * Unit tests for the whole-statblock combatant PATCH concurrency guard (issue #1992).
 *
 * These pin the pure state machine behind `CombatantRow`'s save-on-blur statblock
 * editor against the exact five regressions PR #1983 (issue #1909) hit trying to
 * solve this same problem — see combatantStatblockDraft.ts's module doc for the
 * full narrative — plus every review finding on this PR (#2027):
 *   - a rejected write must not silently discard the draft;
 *   - an edit must survive a switch away even without a blur;
 *   - a confirmation for an EARLIER revision must not clear `dirty` for a newer,
 *     still-uncommitted edit made while that earlier write was in flight (Devin),
 *     but must still refresh the base that later edit will send (Kilo);
 *   - a blur immediately followed by an unmount must not send the same draft twice
 *     (Devin);
 *   - the write must be gated by the sync gate like every sibling write control
 *     (Copilot);
 *   - round 4: the base must be a PER-COMBATANT token, not the encounter-wide one
 *     (Devin) — since superseded by round 5 below;
 *   - round 5: even a per-combatant REVISION token is the wrong granularity for this
 *     specific field — it advances on an hp/condition/position write to this same
 *     combatant too, which never touches the statblock. The base is now the
 *     STATBLOCK'S OWN CONTENT (`baseStatblock`), sent back as `expectedStatblock`;
 *     the exact end-to-end reproduction (edit + an hp tick on the SAME monster +
 *     successful save) is a server-side REST test in encounters.e2e-spec.ts, since
 *     it exercises the real content-compare guard, not just this reducer.
 *   - round 8 (Devin): a THIRD cause of the same permanent-dead-end shape — two of
 *     this client's OWN commits (blur -> refocus -> edit -> blur, inside one
 *     round-trip) raced each other, so the second carried the SAME stale
 *     `expectedStatblock` as the first still in flight and was rejected as a
 *     conflict with the user's own prior save. Commits are now fully serialized per
 *     row (at most one in flight; a newer edit queues and is sent — rebased — only
 *     once the outstanding write is confirmed accepted), `accepted` is guarded
 *     against an out-of-order confirmation regressing the base, and a genuinely
 *     REJECTED write now flags the draft so the next `external` refresh can re-seed
 *     `baseStatblock` — a real conflict is savable again without a page reload.
 *
 * TODO(#2033): the source-scan tests below (`commitStatblock`'s wiring and the
 * effects around it) are the first candidates to convert to actually RENDERING
 * `CombatantRow` once #2025's component-render harness lands, rather than
 * pattern-matching its source text. Convert deliberately rather than losing the
 * coverage in a future refactor that just deletes the now-stale string match.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { defaultCombatantStatblock } from '@campfire/schema';
import {
  initialStatblockDraftState,
  statblockDraftReducer,
  statblockPatchForCommit,
  type StatblockDraftState,
} from '../../src/features/encounters/combat/combatantStatblockDraft';

const ROW = resolve(__dirname, '../../src/features/encounters/combat/CombatantRow.tsx');

const base = defaultCombatantStatblock();
const withNotes = (notes: string) => ({ ...base, notes });

/**
 * Extract a balanced `{ ... }` block starting at the first `{` at or after `fromIndex`,
 * inclusive of both braces (issue #1992 review, Kilo finding 5). A fixed-indentation
 * `indexOf('\n  }', start)` slice — the previous approach — silently mis-extracts on any
 * reformatting or a differently-indented nested block, and a source-scan test that starts
 * checking the wrong text without failing loudly is worse than one with no coverage at all.
 * Counting raw `{`/`}` characters is sufficient for the small, English-comment-only
 * functions these tests inspect (no stray brace inside a string/comment in this file).
 */
function extractBalancedBlock(src: string, fromIndex: number): string {
  const openIdx = src.indexOf('{', fromIndex);
  if (openIdx === -1) throw new Error(`no opening brace found at or after index ${fromIndex}`);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(fromIndex, i + 1);
    }
  }
  throw new Error('unbalanced braces: reached end of file before depth returned to 0');
}

/** `extractBalancedBlock`, anchored at a function's exact signature text. */
function extractFunctionSource(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`could not find ${JSON.stringify(signature)} in source`);
  return extractBalancedBlock(src, start);
}

/**
 * The body of the FIRST `useEffect(() => { ... }` found after a unique anchor comment,
 * balanced by brace count (not a fixed-length slice) — Kilo finding 5 applies equally here.
 */
function extractEffectAfter(src: string, anchorComment: string): string {
  const anchor = src.indexOf(anchorComment);
  if (anchor === -1) throw new Error(`could not find anchor comment ${JSON.stringify(anchorComment)}`);
  const effectStart = src.indexOf('useEffect(() => {', anchor);
  if (effectStart === -1) throw new Error('no useEffect(() => { found after the anchor comment');
  return extractBalancedBlock(src, effectStart);
}

test.describe('combatantStatblockDraft — issue #1992', () => {
  test('nothing to commit when the draft has not been edited', () => {
    const state = initialStatblockDraftState(base);
    expect(statblockPatchForCommit(state)).toBeNull();
  });

  test('a single edit commits with the base statblock the draft was read against', () => {
    let state = initialStatblockDraftState(base);
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('first edit') });
    const patch = statblockPatchForCommit(state);
    expect(patch).toEqual({ statblock: withNotes('first edit'), expectedStatblock: base, revision: 1 });
  });

  // Regression #1 (failure mode #2/#4 from #1983): two successive edits to the SAME
  // combatant from the SAME client must both succeed. Each edit's base must be the
  // statblock produced by the PREVIOUS edit's own successful write — never a stale one,
  // and never one latched forever regardless of what actually landed.
  test('two successive edits from the same client both carry a valid, chained base', () => {
    let state = initialStatblockDraftState(base);

    // Edit 1 — commit reads the base it was given.
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('edit one') });
    const firstPatch = statblockPatchForCommit(state);
    expect(firstPatch?.expectedStatblock).toEqual(base);
    // The write is confirmed, carrying exactly what it sent.
    state = statblockDraftReducer(state, { type: 'accepted', revision: firstPatch!.revision, statblock: firstPatch!.statblock });
    expect(statblockPatchForCommit(state)).toBeNull();
    expect(state.baseStatblock).toEqual(withNotes('edit one'));

    // Edit 2 — must use "edit one" (from edit 1's OWN success) as its base, not the
    // original `base` (that would 409 forever — failure mode #4) and not some other
    // stale value.
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('edit two') });
    const secondPatch = statblockPatchForCommit(state);
    expect(secondPatch).toEqual({ statblock: withNotes('edit two'), expectedStatblock: withNotes('edit one'), revision: 2 });
  });

  // Regression #2 (failure mode #3 from #1983): a concurrent OTHER writer's change
  // must not be silently overwritten. The draft's base must stay pinned to what it
  // actually started from — even once a fresher statblock becomes visible from
  // elsewhere — so a genuine conflict still fails the server's content-compare guard
  // instead of being silently laundered through a base re-read right before send.
  //
  // Round 5 note: this discard is correct for a STRONGER reason now than in round 4.
  // Before, `external` had to stay blocked while dirty because the pinned value was a
  // proxy token that unrelated writes kept advancing — accepting an external refresh
  // mid-edit risked adopting someone else's proxy-token bump as if it were this draft's
  // own. Now the pinned value IS the guarded content itself: an unrelated write (hp,
  // condition, position) never produces an `external` dispatch with different statblock
  // content in the first place (CombatantRow's effect only fires off `combatant.statblock`
  // reference changes), so there is nothing to "catch up" — dropping `external` while
  // dirty simply preserves the in-progress edit, with no correctness cost either way.
  test('a concurrent external statblock update during an uncommitted edit does not launder the base', () => {
    let state = initialStatblockDraftState(base);
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('my in-progress edit') });

    // Another writer's concurrent statblock change lands and is observed (e.g. a
    // background poll) WHILE this edit is still uncommitted.
    const beforeExternal: StatblockDraftState = state;
    state = statblockDraftReducer(state, {
      type: 'external',
      statblock: withNotes('someone else already changed this'),
    });

    // The uncommitted draft and its original base must be UNCHANGED — dropping the
    // concurrent external update rather than clobbering the local edit or adopting
    // its content as this draft's base.
    expect(state).toEqual(beforeExternal);

    const patch = statblockPatchForCommit(state);
    expect(patch).toEqual({ statblock: withNotes('my in-progress edit'), expectedStatblock: base, revision: 1 });
    // `base` no longer matches the server's current statblock ("someone else already
    // changed this") — sending this patch 409s via the server's content-compare guard
    // instead of overwriting the concurrent writer's edit. (Server-side behavior for this
    // exact combination is covered by apps/server/test/encounters.e2e-spec.ts.)
  });

  // Regression #3 (failure mode #1/#5 from #1983): no debounce/queue exists to strand
  // an edit across a navigation. `statblockPatchForCommit` is a pure, synchronous
  // function of the CURRENT reducer state — there is no timer, no queued draft, and
  // no closed-over encounter id that a later navigation could race. Blur fires the
  // commit inline in the same tick the state already holds the right encounter's draft.
  test('commit is a pure synchronous read of current state — nothing queued to strand on navigation', () => {
    let state = initialStatblockDraftState(base);
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('about to switch encounters') });
    // Calling this twice in a row (as an immediate blur-then-unmount would) is
    // deterministic and side-effect-free: it never depends on a timer having fired.
    expect(statblockPatchForCommit(state)).toEqual(statblockPatchForCommit(state));
    expect(statblockPatchForCommit(state)?.statblock.notes).toBe('about to switch encounters');
  });

  test('an external update while NOT dirty resyncs both the draft and its base statblock', () => {
    let state = initialStatblockDraftState(base);
    state = statblockDraftReducer(state, { type: 'external', statblock: withNotes('fresh from server') });
    expect(state).toEqual({
      draft: withNotes('fresh from server'),
      baseStatblock: withNotes('fresh from server'),
      dirty: false,
      revision: 0,
      baseRevision: 0,
      needsRebase: false,
      awaitingReedit: false,
    });
  });

  // Coordinator review (#2027) — a rejected write (most commonly the server's own
  // STALE_WRITE 409, since a stale expectedStatblock is exactly what a genuine conflict
  // produces) must not silently discard the draft. `CombatantRow.commitStatblock` only
  // dispatches `accepted` once the write is CONFIRMED to have landed. This test models
  // exactly that call sequence and proves the draft survives the settle-triggered
  // `external` refetch that follows ANY outcome (RunSessionPage's
  // `combatantPatch.onSettled` invalidates unconditionally) WITHOUT that refetch being
  // allowed to rebase — that only happens once `rejected` has actually been dispatched
  // (round 8, see the test below for the full recovery path).
  test('a rejected write is NOT marked accepted, so the draft survives the settle-triggered refetch', () => {
    let state = initialStatblockDraftState(base);
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('my edit, about to be rejected') });
    const sentPatch = statblockPatchForCommit(state);
    expect(sentPatch).toEqual({ statblock: withNotes('my edit, about to be rejected'), expectedStatblock: base, revision: 1 });

    // The write 409s (STALE_WRITE), but nothing has told the reducer that yet (models a
    // refetch racing ahead of the mutation's own `.then`, or simply isolates this half of
    // the sequence): a bare `external` while dirty and NOT flagged `needsRebase` is still
    // the routine "ignore it" no-op — the draft survives untouched.
    const beforeRefetch = state;
    state = statblockDraftReducer(state, {
      type: 'external',
      statblock: base, // the server's actual current statblock — unchanged, since the write never landed
    });

    // The draft (and dirty flag) must be UNCHANGED — the refetch must not clobber it.
    expect(state).toEqual(beforeRefetch);
    expect(statblockPatchForCommit(state)).toEqual({
      statblock: withNotes('my edit, about to be rejected'),
      expectedStatblock: base,
      revision: 1,
    });
  });

  // Round 8 (Devin) — the full recovery path for a GENUINE conflict: `CombatantRow`
  // dispatches `rejected` for a 409'd write, which flags `needsRebase`. The very next
  // `external` (from the settle-triggered refetch that follows EVERY outcome) is then
  // let through even though the draft is still dirty — but it can only ever touch
  // `baseStatblock`, never `draft`: the user's in-progress edit and its `dirty` flag are
  // byte-for-byte unchanged. This is what makes the edit SAVABLE again without a reload;
  // it does not, by itself, resend anything — see the plain no-op test above for the
  // contrasting "rejected never dispatched" case this replaces the dead end from.
  test('a rejected write recovers via the next external refresh, without touching the in-progress draft', () => {
    let state = initialStatblockDraftState(base);
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('my edit, about to be rejected') });
    const sentPatch = statblockPatchForCommit(state);
    expect(sentPatch?.expectedStatblock).toEqual(base);

    // The write 409s — CombatantRow dispatches `rejected` (not nothing) for this outcome.
    state = statblockDraftReducer(state, { type: 'rejected', revision: sentPatch!.revision });
    expect(state.dirty).toBe(true);
    expect(state.draft).toEqual(withNotes('my edit, about to be rejected'));
    expect(state.baseStatblock).toEqual(base); // not yet refreshed
    expect(state.needsRebase).toBe(true);

    // combatantPatch's onSettled fires unconditionally and invalidates the encounter query;
    // the resulting refetch delivers what is ACTUALLY stored now — a genuine other writer's
    // change, distinct from both `base` and the local draft.
    state = statblockDraftReducer(state, { type: 'external', statblock: withNotes('a genuine other writer already changed this') });

    // The base is re-seeded — the recovery this round closes — but the user's own
    // in-progress edit is completely untouched: same draft, still dirty, `needsRebase`
    // cleared (nothing left to recover).
    expect(state.dirty).toBe(true);
    expect(state.draft).toEqual(withNotes('my edit, about to be rejected'));
    expect(state.needsRebase).toBe(false);
    expect(state.baseStatblock).toEqual(withNotes('a genuine other writer already changed this'));

    // The NEXT commit attempt (another edit + blur, or simply blurring again) now sends
    // against the TRUE current content — no reload was ever required to get here.
    expect(statblockPatchForCommit(state)).toEqual({
      statblock: withNotes('my edit, about to be rejected'),
      expectedStatblock: withNotes('a genuine other writer already changed this'),
      revision: 1,
    });
  });

  // Review round 2 (Devin, folded with Kilo) — the deeper version of the rejection finding:
  // an edit made WHILE an earlier revision's write is still in flight must not be marked
  // done by that earlier write resolving. Sequence: blur sends draft A (revision 1) -> user
  // re-focuses and types draft B (revision 2, still dirty) -> A's write resolves ok. `accepted`
  // for revision 1 must NOT clear dirty (B was never sent) and must NOT touch the draft
  // (still B) — but it DOES know for certain the stored statblock genuinely is now what A
  // sent, so it still refreshes `baseStatblock` for B's eventual send (Kilo's point: the two
  // only compose correctly together — revision-gating alone would leave B's base stale
  // forever, still pointing at the pre-A value).
  test('accepted for an EARLIER revision does not clear dirty or touch a newer draft, but still refreshes its base statblock', () => {
    let state = initialStatblockDraftState(base);
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('draft A') });
    const draftAPatch = statblockPatchForCommit(state); // revision 1, sent, now in flight
    expect(draftAPatch?.revision).toBe(1);

    // User re-focuses and edits again before A's response arrives.
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('draft B') });
    expect(state.revision).toBe(2);
    expect(state.draft).toEqual(withNotes('draft B'));

    // A's write now resolves ok, confirming revision 1 specifically, carrying exactly what
    // that commit sent.
    state = statblockDraftReducer(state, { type: 'accepted', revision: draftAPatch!.revision, statblock: draftAPatch!.statblock });

    // B is still dirty and still the current draft — A's confirmation does not cover it.
    expect(state.dirty).toBe(true);
    expect(state.draft).toEqual(withNotes('draft B'));
    // But the base DID advance to "draft A" — B's eventual send compares against the true
    // current stored value, not the stale original `base`, so it does not spuriously 409
    // against a conflict that never really happened.
    expect(state.baseStatblock).toEqual(withNotes('draft A'));
    expect(statblockPatchForCommit(state)).toEqual({ statblock: withNotes('draft B'), expectedStatblock: withNotes('draft A'), revision: 2 });
  });

  // Review round 2 (Kilo finding 4, isolated) — even in the simple, non-chained case,
  // `accepted` must adopt the write's own confirmed statblock, not merely clear `dirty`
  // and leave the OLD base in place (which would silently under-report the row's true
  // stored content to the NEXT edit session, even after a clean accept).
  test('accepted in the simple (non-chained) case still adopts the sent statblock as the new base', () => {
    let state = initialStatblockDraftState(base);
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('only edit') });
    state = statblockDraftReducer(state, { type: 'accepted', revision: 1, statblock: withNotes('only edit') });
    expect(state).toEqual({
      draft: withNotes('only edit'),
      baseStatblock: withNotes('only edit'),
      dirty: false,
      revision: 1,
      baseRevision: 1,
      needsRebase: false,
      awaitingReedit: false,
    });
  });

  // Round 8 (Devin, defense in depth) — with commits now fully serialized per row (see the
  // component-wiring test below), two of THIS client's own writes can no longer overlap, so
  // this exact sequence is no longer reachable through `CombatantRow.commitStatblock`. The
  // reducer still guards it directly: an out-of-order confirmation (an EARLIER revision's
  // response arriving AFTER a LATER one already advanced the base) must not regress
  // `baseStatblock` back to content the store has already moved past.
  test('an out-of-order accepted confirmation does not regress the base', () => {
    let state = initialStatblockDraftState(base);
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('draft A') });
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('draft B') });
    expect(state.revision).toBe(2);

    // The LATER revision's response arrives FIRST (out of order).
    state = statblockDraftReducer(state, { type: 'accepted', revision: 2, statblock: withNotes('draft B') });
    expect(state.dirty).toBe(false);
    expect(state.baseStatblock).toEqual(withNotes('draft B'));
    expect(state.baseRevision).toBe(2);

    // The EARLIER revision's response arrives LATE, after the base has already moved past
    // it — this must be a complete no-op, not a regression back to "draft A".
    const beforeStaleAccept = state;
    state = statblockDraftReducer(state, { type: 'accepted', revision: 1, statblock: withNotes('draft A') });
    expect(state).toEqual(beforeStaleAccept);
    expect(state.baseStatblock).toEqual(withNotes('draft B'));
    expect(state.baseRevision).toBe(2);
  });

  // Coordinator review (#2027) — the reducer tests above prove the STATE MACHINE is correct
  // in isolation; they do not prove `CombatantRow.commitStatblock` actually calls it that way.
  // This asserts the component wiring itself: `accepted` is dispatched only from inside the
  // awaited outcome, carrying the revision and statblock that were actually sent — not
  // unconditionally right after firing the write (the exact shape of the round-1 defect).
  test("CombatantRow's commitStatblock dispatches 'accepted' only from a confirmed, awaited outcome, carrying the sent revision and statblock", () => {
    const src = readFileSync(ROW, 'utf8');
    const commitStatblockFn = extractFunctionSource(src, "function commitStatblock(trigger: 'explicit' | 'automatic') {");

    // The write result is captured and awaited via .then — not fired and forgotten.
    expect(commitStatblockFn).toMatch(/const result = onPatchCombatant\?\.\(/);
    expect(commitStatblockFn).toMatch(/result\.then\(/);
    // `accepted` is dispatched INSIDE that .then callback, conditioned on the outcome, and
    // carries patch.revision and patch.statblock (exactly what THIS call sent) — never as a
    // bare statement right after the onPatchCombatant call (the round-1 defective shape),
    // and never a hardcoded revision or a value re-read from current state.
    const thenIndex = commitStatblockFn.indexOf('.then(');
    const acceptedIndex = commitStatblockFn.indexOf("type: 'accepted'");
    expect(acceptedIndex).toBeGreaterThan(thenIndex);
    expect(commitStatblockFn).toMatch(
      /if \(outcome\.ok\) dispatchStatblockDraft\(\{ type: 'accepted', revision: patch\.revision, statblock: patch\.statblock \}\);/,
    );
    // Guards against the round-1 defective shape directly: dispatching accepted as the very
    // next statement after firing the write (no await, no outcome check) must NOT be present.
    expect(commitStatblockFn).not.toMatch(/onPatchCombatant\?\.\([^;]*\);\s*dispatchStatblockDraft\(\{ type: 'accepted'/);
  });

  // Round 8 (Devin) — a blur immediately followed by refocus-edit-blur inside one
  // round-trip (or a blur immediately followed by an unmount) must both defer to ANY
  // outstanding write, not merely one for the SAME revision — the round-2 shape this
  // replaces let a genuinely NEWER revision send immediately, carrying the same stale
  // `expectedStatblock` as the write still in flight, which is exactly the self-conflict
  // bug this round closes. The in-flight slot is released once the outstanding write
  // settles (success OR failure), never permanently.
  test('commitStatblock defers ANY commit while another is already in flight for this row, regardless of revision', () => {
    const src = readFileSync(ROW, 'utf8');
    const commitStatblockFn = extractFunctionSource(src, "function commitStatblock(trigger: 'explicit' | 'automatic') {");

    expect(commitStatblockFn).toMatch(/if \(inFlightRef\.current\) return;/);
    expect(commitStatblockFn).toMatch(/inFlightRef\.current = true;/);
    // The skip check must run BEFORE this call claims the in-flight slot — reversing the
    // order would make every call skip itself.
    const skipIndex = commitStatblockFn.indexOf('if (inFlightRef.current) return;');
    const claimIndex = commitStatblockFn.indexOf('inFlightRef.current = true;');
    expect(skipIndex).toBeGreaterThan(-1);
    expect(claimIndex).toBeGreaterThan(skipIndex);
    // The in-flight flag is released once the outstanding write settles (success or
    // failure) — otherwise a rejected or accepted write would permanently block any
    // FUTURE resend for this row.
    expect(commitStatblockFn).toMatch(/inFlightRef\.current = false;/);
    // The round-2 per-revision dedupe (which explicitly let a NEWER revision through) must
    // be gone — this exact string would only reappear via a revert of round 8's fix.
    expect(commitStatblockFn).not.toMatch(/inFlightRevisionRef/);

    const ref = readFileSync(ROW, 'utf8');
    expect(ref).toMatch(/const inFlightRef = useRef\(false\);/);
  });

  // Round 9 (Devin, finding 2) — `onPatchCombatant`'s type permits an absent callback or a
  // `void` return, in which case there is no promise to release the in-flight slot. The
  // flag must only ever be claimed AFTER confirming a real, thenable result exists —
  // claiming it first (as round 8 did) and relying on `result?.then` to release it left the
  // flag stuck `true` forever whenever the callback doesn't return a promise.
  test('commitStatblock only claims the in-flight slot when onPatchCombatant actually returns a promise', () => {
    const src = readFileSync(ROW, 'utf8');
    const commitStatblockFn = extractFunctionSource(src, "function commitStatblock(trigger: 'explicit' | 'automatic') {");

    // The result is captured, checked for existence, and ONLY THEN claims the slot — never
    // the other way around.
    const resultIndex = commitStatblockFn.indexOf('const result = onPatchCombatant?.(');
    const guardIndex = commitStatblockFn.indexOf('if (!result) return;');
    const claimIndex = commitStatblockFn.indexOf('inFlightRef.current = true;');
    expect(resultIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(resultIndex);
    expect(claimIndex).toBeGreaterThan(guardIndex);
    // `.then` is called unconditionally on `result` (no `?.`) — only reachable once the
    // guard above has already ruled out `undefined`/`void`, so this is not a silent no-op.
    expect(commitStatblockFn).toMatch(/result\.then\(/);
    expect(commitStatblockFn).not.toMatch(/result\?\.then\(/);
  });

  // Round 9 (Devin, finding 1) — the recovery path round 8 added (`external` re-seeding
  // `baseStatblock` after a rejection) was only ever meant to unblock an EXPLICIT save, not
  // to let an AUTOMATIC flush silently resend the user's stale, already-rejected draft the
  // instant the base catches up to a genuine other writer's content. `commitStatblock` must
  // refuse an automatic trigger while `awaitingReedit` is set, and this must be enforced in
  // commitStatblock itself (the one place all three flush paths — blur, unmount, sync-gate
  // lift — go through), not duplicated per call site.
  test('commitStatblock refuses an AUTOMATIC trigger while awaitingReedit is set, but always allows an explicit one', () => {
    const src = readFileSync(ROW, 'utf8');
    const commitStatblockFn = extractFunctionSource(src, "function commitStatblock(trigger: 'explicit' | 'automatic') {");

    expect(commitStatblockFn).toMatch(
      /if \(statblockDraftState\.awaitingReedit && trigger !== 'explicit'\) return;/,
    );
    // This gate must run BEFORE the write is ever sent.
    const gateIndex = commitStatblockFn.indexOf("if (statblockDraftState.awaitingReedit && trigger !== 'explicit') return;");
    const sendIndex = commitStatblockFn.indexOf('onPatchCombatant?.(');
    expect(gateIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(gateIndex);

    // The signature takes an explicit trigger — there is no default that could let a call
    // site silently fall back to "allowed".
    expect(src).toMatch(/function commitStatblock\(trigger: 'explicit' \| 'automatic'\) \{/);

    // The three automatic flush call sites all pass 'automatic'; the blur handler (the one
    // genuine user action) passes 'explicit'. If any automatic path stopped passing
    // 'automatic' explicitly, this would catch it (a bare `commitStatblockRef.current();`
    // with no argument would be a TypeScript error, but confirm the actual source too).
    const automaticCallCount = (src.match(/commitStatblockRef\.current\('automatic'\)/g) ?? []).length;
    expect(automaticCallCount).toBe(3); // baseRevision auto-flush, unmount flush, sync-gate-lift flush
    expect(src).toMatch(/commitStatblock\('explicit'\)/);
  });

  // Round 9 (Devin, finding 1) — the real sequence the finding describes, at the reducer
  // level: a save is rejected, the settle-triggered refetch delivers the OTHER writer's
  // content and rebases the base (round 8's recovery path) — `awaitingReedit` must turn
  // on at EXACTLY that point (not before: a bare `rejected` alone must not set it, since
  // the module doc requires the FLAG to track "rebased AND not re-edited since", not
  // merely "rejected"), stay on across further external no-ops, and clear the moment a
  // genuine edit happens. This is deliberately a reducer-only test, not a re-implementation
  // of `commitStatblock`'s send/no-send decision — that decision (an AUTOMATIC trigger
  // must refuse to send while this flag is true; an EXPLICIT one always may) is pinned
  // separately, against the REAL source, by the preceding source-scan test; a hand-rolled
  // copy of that same conditional here would just be restating it, not verifying it.
  test('awaitingReedit turns on exactly at the round-8 rebase and clears on a genuine edit, across the real sequence', () => {
    let state = initialStatblockDraftState(base);
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('my edit, about to be rejected') });
    const sentPatch = statblockPatchForCommit(state)!;
    expect(state.awaitingReedit).toBe(false);

    // Rejected — NOT yet the rebase; `awaitingReedit` must still be false here (it is the
    // REBASE that sets it, not the rejection itself — see the reducer's `rejected` case).
    state = statblockDraftReducer(state, { type: 'rejected', revision: sentPatch.revision });
    expect(state.needsRebase).toBe(true);
    expect(state.awaitingReedit).toBe(false);

    // The settle-triggered refetch delivers the OTHER writer's content and rebases —
    // `awaitingReedit` turns on HERE, while the draft/dirty are completely untouched.
    state = statblockDraftReducer(state, { type: 'external', statblock: withNotes('a genuine other writer already changed this') });
    expect(state.dirty).toBe(true);
    expect(state.draft).toEqual(withNotes('my edit, about to be rejected'));
    expect(state.awaitingReedit).toBe(true);
    // The content is fully ready to send (a real `statblockPatchForCommit` call proves
    // this, since `commitStatblock` calls this same function) — it is ONLY the source-scan-
    // verified trigger gate in `commitStatblock` that must refuse an automatic send here.
    expect(statblockPatchForCommit(state)).toEqual({
      statblock: withNotes('my edit, about to be rejected'),
      expectedStatblock: withNotes('a genuine other writer already changed this'),
      revision: sentPatch.revision,
    });

    // A further external no-op (another unrelated write elsewhere) must not clear the flag
    // early — it should stay armed until a genuine edit.
    state = statblockDraftReducer(state, { type: 'external', statblock: withNotes('yet another unrelated writer') });
    expect(state.awaitingReedit).toBe(true);

    // Once a further genuine edit happens, `awaitingReedit` clears — the OTHER escape
    // hatch the module doc describes, alongside an explicit trigger.
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('a further edit after the rebase') });
    expect(state.awaitingReedit).toBe(false);
  });

  // Round 8 (Devin) — the other half of serialization: once the outstanding write is
  // CONFIRMED ACCEPTED, a newer edit queued behind it (still `dirty`) must be flushed
  // automatically, rebased on the base that acceptance just confirmed — this is what
  // makes "two rapid commits within one round-trip both succeed" true end to end, not
  // merely "the second one doesn't corrupt anything." The flush must be keyed off
  // `baseRevision` (only `accepted` advances it) and gated on nothing still being in
  // flight — never keyed off a rejection, which must NOT auto-resend (see the dedicated
  // rejection-recovery test above for why).
  test('commitStatblock auto-flushes a queued newer edit once (and only once) the outstanding write is accepted', () => {
    const src = readFileSync(ROW, 'utf8');
    const flushEffect = extractEffectAfter(src, 'Issue #1992 review (Devin, round 8): once an outstanding write is CONFIRMED ACCEPTED');

    expect(flushEffect).toMatch(/if \(statblockDraftState\.dirty && !inFlightRef\.current\) \{/);
    // Round 9: this flush is explicitly marked AUTOMATIC (see the awaitingReedit tests
    // above for why the distinction matters) — not a bare, ambiguous call.
    expect(flushEffect).toMatch(/commitStatblockRef\.current\('automatic'\);/);
    // The effect's dependency array is exactly `[statblockDraftState.baseRevision]` — not
    // `dirty` and not the whole draft state — so it does not re-fire on every keystroke or
    // on a rejection, only on the specific event that means "a write of ours just landed".
    const src2 = readFileSync(ROW, 'utf8');
    expect(src2).toMatch(/\}, \[statblockDraftState\.baseRevision\]\);/);
  });

  // Round 8 (Devin) — end-to-end model of "two rapid commits within one round-trip both
  // succeed", chaining the ACTUAL reducer transitions `commitStatblock` would produce in
  // this exact order (edit -> commit A sent, in flight -> edit again while A is still
  // outstanding -> A confirmed accepted -> the auto-flush effect above sends B, rebased on
  // what A's acceptance just confirmed -> B confirmed accepted). Both saves land; neither
  // is ever rejected as a conflict with the user's own prior write.
  test('two rapid commits within one round-trip both succeed (end-to-end reducer sequence)', () => {
    let state = initialStatblockDraftState(base);

    // Commit A: user edits and blurs. `commitStatblock` sends this, claiming the in-flight
    // slot (modeled here by simply not sending anything else until A resolves).
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('commit A') });
    const patchA = statblockPatchForCommit(state)!;
    expect(patchA.expectedStatblock).toEqual(base);

    // Before A's response arrives, the user refocuses and edits again, then blurs. Because
    // `inFlightRef.current` is still true, `commitStatblock` returns immediately WITHOUT
    // sending — this second edit only ever reaches the reducer as an `edit`, never as a
    // second in-flight PATCH racing the first.
    state = statblockDraftReducer(state, { type: 'edit', statblock: withNotes('commit B') });
    expect(state.dirty).toBe(true);
    expect(state.revision).toBe(2);

    // A's write resolves ok. `accepted` fires for revision 1, refreshing the base to
    // exactly what A sent — B is still dirty (its own revision doesn't match) but its
    // eventual send is now correctly rebased.
    state = statblockDraftReducer(state, { type: 'accepted', revision: patchA.revision, statblock: patchA.statblock });
    expect(state.dirty).toBe(true);
    expect(state.baseStatblock).toEqual(withNotes('commit A'));

    // The auto-flush effect (keyed on `baseRevision`, asserted by source scan above) now
    // sends B — this is the actual PATCH `commitStatblock` would construct at this point.
    const patchB = statblockPatchForCommit(state)!;
    expect(patchB).toEqual({ statblock: withNotes('commit B'), expectedStatblock: withNotes('commit A'), revision: 2 });
    // Critically, B's `expectedStatblock` matches what is NOW actually stored (A's
    // content) — the server's content-compare accepts it. Under the round-2 defect this
    // round replaces, B would instead have carried `base` (the ORIGINAL pre-A content)
    // and been rejected as a conflict with the user's own first save.
    expect(patchB.expectedStatblock).not.toEqual(base);

    // B's write also resolves ok.
    state = statblockDraftReducer(state, { type: 'accepted', revision: patchB.revision, statblock: patchB.statblock });
    expect(state.dirty).toBe(false);
    expect(state.baseStatblock).toEqual(withNotes('commit B'));
  });

  // Review round 2 (Copilot) — every other write control in this file is disabled while
  // `syncBlocked`; the statblock save-on-blur was not. It must skip sending (not drop the
  // draft) while blocked, and flush automatically once the gate lifts rather than stranding
  // the edit until the user happens to touch the field again.
  test('commitStatblock is gated by syncBlocked and flushes automatically once the gate lifts', () => {
    const src = readFileSync(ROW, 'utf8');
    const commitStatblockFn = extractFunctionSource(src, "function commitStatblock(trigger: 'explicit' | 'automatic') {");

    // Gated early, before anything is sent or claimed as in-flight — and the draft/`dirty`
    // are untouched by returning here (no dispatch on this path).
    expect(commitStatblockFn).toMatch(/if \(syncBlocked\) return;/);
    const syncBlockedIndex = commitStatblockFn.indexOf('if (syncBlocked) return;');
    const sendIndex = commitStatblockFn.indexOf('onPatchCombatant?.(');
    expect(syncBlockedIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(syncBlockedIndex);

    // A dedicated effect flushes a pending draft on the blocked -> clear transition only
    // (not on mount, not while it stays blocked or stays clear).
    const unblockEffect = extractEffectAfter(src, 'Issue #1992 review (Copilot): once the sync gate LIFTS');
    expect(unblockEffect).toMatch(/if \(wasSyncBlockedRef\.current && !syncBlocked\) \{/);
    // Round 9: AUTOMATIC, not a bare call — see the awaitingReedit tests above.
    expect(unblockEffect).toMatch(/commitStatblockRef\.current\('automatic'\);/);
    expect(src).toMatch(/const wasSyncBlockedRef = useRef\(syncBlocked\);/);
  });

  // Coordinator review (#2027) — an edit queued just before switching away (e.g. encounter
  // navigation, which swaps every CombatantRow's `key` and unmounts the old encounter's
  // rows) must not be silently LOST. Save-on-blur has no timer/queue to leak across that
  // switch (see the module doc), but nothing fires `commitStatblock` at all unless
  // something explicitly does — this asserts that wiring exists: an unmount effect flushes
  // one last attempt via an always-latest ref (not a stale mount-time closure, which would
  // otherwise send a stale draft/base pair against a stale onPatchCombatant callback).
  test('CombatantRow flushes a pending statblock edit on unmount via an always-latest ref', () => {
    const src = readFileSync(ROW, 'utf8');
    expect(src).toMatch(/const commitStatblockRef = useRef\(commitStatblock\);/);
    expect(src).toMatch(/commitStatblockRef\.current = commitStatblock;/);
    // Isolate the specific unmount-flush effect by its anchor comment, brace-balanced rather
    // than a fixed-length slice (Kilo finding 5).
    const unmountEffect = extractEffectAfter(src, 'Issue #1992 review: flush one last save attempt on unmount');
    // The cleanup calls the REF, not `commitStatblock` directly — a direct call in a
    // `useEffect(() => { return () => commitStatblock(); }, [])` cleanup would close over the
    // function instance from the render that registered the effect (empty deps means it never
    // re-registers), which is stale by the time of an eventual unmount.
    expect(unmountEffect).toMatch(/return \(\) => \{/);
    // Round 9: AUTOMATIC, not a bare call — see the awaitingReedit tests above.
    expect(unmountEffect).toMatch(/commitStatblockRef\.current\('automatic'\);/);
  });
});
