/**
 * Source-scan regression coverage for two PR #2074 review findings that live in
 * `RunSessionPage.tsx`, a page component too heavily wired (router, query client, SSE,
 * dozens of context values) to mount in a component test — the same constraint that
 * makes `initiative-strip-scroll.unit.spec.ts` and `color-vision-assist.unit.spec.ts`
 * source-scan rather than render.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

test.describe('initiative strip drag surface confinement (issue #2074 review finding 2)', () => {
  test('touchAction: none is confined to the small drag handle, not the whole scrollable tile', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const stripStart = source.indexOf('function InitiativeStrip');
    expect(stripStart).toBeGreaterThan(-1);
    const stripEnd = source.indexOf('function hpLogActorId', stripStart);
    expect(stripEnd).toBeGreaterThan(stripStart);
    const initiativeStrip = source.slice(stripStart, stripEnd);

    // Exactly one LIVE touchAction: 'none' assignment in the whole component — on the
    // handle (matches the trailing comma of an actual style property; excludes this
    // test's own prose match against the explanatory code comment above it). Two (or a
    // touchAction on the outer tile) would mean the swipe-vs-drag regression is back: a
    // finger swipe anywhere on the tile would drag instead of scrolling the strip.
    const touchActionNoneCount = (initiativeStrip.match(/touchAction: 'none',/g) ?? []).length;
    expect(touchActionNoneCount).toBe(1);

    // The handle itself: small, aria-hidden (keyboard/AT users reorder via ReorderMenu
    // elsewhere), and the one element wired to the drag hook.
    const handleStart = initiativeStrip.indexOf('data-testid={`initiative-strip-drag-handle-${c.id}`}');
    expect(handleStart).toBeGreaterThan(-1);
    const handleBlockEnd = initiativeStrip.indexOf('</span>', handleStart);
    const handleBlock = initiativeStrip.slice(handleStart - 200, handleBlockEnd);
    expect(handleBlock).toMatch(/touchAction: 'none'/);
    expect(handleBlock).toMatch(/\.\.\.dragReorder\.handleProps\(c\.id\)/);

    // The outer tile (data-testid initiative-strip-tile-*) no longer carries
    // touchAction or the drag handle props directly.
    const tileStart = initiativeStrip.indexOf('data-testid={`initiative-strip-tile-${c.id}`}');
    expect(tileStart).toBeGreaterThan(-1);
    const tileStyleEnd = initiativeStrip.indexOf('ref={(el) => {', tileStart);
    const tileStyleBlock = initiativeStrip.slice(tileStart, tileStyleEnd);
    expect(tileStyleBlock).not.toMatch(/touchAction/);
    expect(tileStyleBlock).not.toMatch(/dragReorder\.handleProps/);
  });
});

test.describe('reorder busy consults the live-sync gate (issue #2074 review finding 3)', () => {
  test('buildReorderControls\' busy value includes riskyBlocked, matching every other write control on the row', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const fnStart = source.indexOf('const buildReorderControls = useCallback(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('const autoScrollSkipped', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fn = source.slice(fnStart, fnEnd);

    const busyLineMatch = fn.match(/busy:\s*([^,]+),/);
    expect(busyLineMatch).not.toBeNull();
    const busyExpression = busyLineMatch![1];
    expect(busyExpression).toContain('riskyBlocked');
    // Issue #2116 review round 2: without this, the drag handle and ReorderMenu stay
    // visibly enabled while a reorder's resync is outstanding, silently swallowing a
    // click/drop with no feedback. See the dedicated describe block below.
    expect(busyExpression).toContain('isAwaitingReorderResyncNow');

    // The useCallback dependency array must also carry riskyBlocked, or the closure
    // would go stale and keep evaluating an old value.
    const depsMatch = fn.match(/\[canReorderCombatants,[^\]]*\],\s*\);/);
    expect(depsMatch).not.toBeNull();
    expect(depsMatch![0]).toContain('riskyBlocked');
    expect(depsMatch![0]).toContain('isAwaitingReorderResyncNow');
  });

  /**
   * Review round 2 on PR #2074. Gating `buildReorderControls` above covered the roster
   * row's drag handle and menu, but `InitiativeStrip` funnels into the SAME
   * `handleReorderDrop` mutation and was handed `canReorder={canEditEncounter}` — the
   * DM/not-ended check alone. During an SSE outage that disabled every other
   * conflict-prone write on the page, a strip drag still reached the server, and a
   * second drag could start before the first was confirmed.
   *
   * Two entry points to one write, gated separately, is what let them drift. These pin
   * the gate on the shared write path (so a future third entry point inherits it) AND on
   * the strip's own affordance (so the control is withdrawn rather than silently
   * swallowing the drop).
   */
  test('handleReorderDrop — the write path BOTH entry points share — refuses while blocked or in flight', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const fnStart = source.indexOf('const handleReorderDrop = useCallback(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('const rosterDragReorder', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fn = source.slice(fnStart, fnEnd);

    // An early return on all four, ahead of the mutate call — not merely a mention.
    // Issue #2116 added the fourth condition (`isAwaitingReorderResyncNow`, see the
    // describe block below); the other three predate it (issue #2074).
    const guardIndex = fn.search(
      /if \(reconcileBlocks \|\| riskyBlocked \|\| reorderCombatant\.isPending \|\| isAwaitingReorderResyncNow\) return;/,
    );
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(fn.indexOf('reorderCombatant.mutate('));

    // Stale-closure guard: each gate must appear in the dependency array too.
    const depsMatch = fn.match(/\[encounter,[^\]]*\],\s*\);/);
    expect(depsMatch).not.toBeNull();
    for (const dep of ['reconcileBlocks', 'riskyBlocked', 'reorderCombatant', 'isAwaitingReorderResyncNow']) {
      expect(depsMatch![0]).toContain(dep);
    }
  });

  test('the initiative strip\'s canReorder withdraws the affordance during an outage, not just the drop', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    // Anchored to a JSX attribute on its own line. `handleReorderDrop`'s comment above
    // quotes the OLD `canReorder={canEditEncounter}` to explain what changed, and an
    // unanchored match found THAT first and read the pre-fix expression — this assertion
    // failed against the very fix it exists to pin. Prose naming the old code is exactly
    // what a source scan must not mistake for the code.
    const propMatch = source.match(/^\s*canReorder=\{([^}]+)\}$/m);
    expect(propMatch).not.toBeNull();
    const expression = propMatch![1];
    expect(expression).toContain('canEditEncounter');
    expect(expression).toContain('!reconcileBlocks');
    expect(expression).toContain('!riskyBlocked');
    // Issue #2116 review round 2.
    expect(expression).toContain('!isAwaitingReorderResyncNow');
  });
});

test.describe('reorder resync latch is REACTIVE state, correctly ordered against the rendered encounter (issue #2116 review rounds 2-6)', () => {
  /**
   * Review round 2 on #2116: the round-1 fix gated on a plain `useRef`. A ref mutation does
   * NOT cause a re-render, so `buildReorderControls`'s `busy` and `InitiativeStrip`'s
   * `canReorder` (both pinned above to now include `isAwaitingReorderResyncNow`) kept
   * evaluating their LAST-rendered value — the controls stayed visibly enabled while
   * `handleReorderDrop` silently refused the write underneath. A click, drag, or
   * keyboard move-up/down looked accepted and did nothing: exactly the "recoverable,
   * visible 409 traded for a silent no-op" trade issue #2116 explicitly rejects for
   * `encounterQuery.isFetching`, just rarer and therefore harder to diagnose.
   *
   * `reorderResyncArmedAt` is now `useState`, so a re-render always reflects the true value
   * before any entry point acts on it — not a live comparison against `encounterReadRevision`
   * on every render (round 5: that state can tick before the `encounter` object a component
   * actually renders catches up), and the clearing effect's own dependency is neither
   * `encounterReadRevision` (round 5) nor `encounter` itself (round 6: TanStack's structural
   * sharing can leave `encounter`'s reference unchanged forever when a reorder fails without
   * changing server state) — see that effect's own doc comment in `RunSessionPage.tsx` for the
   * full reasoning, cross-checked against `@tanstack/query-core`'s actual source.
   * `RunSessionPage.tsx` is too heavily wired to mount — see this file's top comment — so
   * the call sites are pinned by source rather than by rendering; the underlying decision
   * function itself is behaviorally unit-tested against real values in
   * `combatant-reorder.unit.spec.ts`.
   */
  test('reorderResyncArmedAt is useState, and isAwaitingReorderResyncNow reads it directly (not a live revision comparison)', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toContain('const [reorderResyncArmedAt, setReorderResyncArmedAt] = useState<number | null>(null);');
    // Review round 5: computing `isAwaitingReorderResyncNow` as a LIVE call to
    // `isAwaitingReorderResync(reorderResyncArmedAt, encounterReadRevision)` on every render
    // reintroduces the race — `encounterReadRevision` (state) is bumped inside `queryFn`
    // BEFORE TanStack Query's cache-update-and-notify step publishes the new `encounter` a
    // component actually renders, so a render could see the bumped revision but the still-stale
    // `encounter`. The exposed gate must instead just read whether `reorderResyncArmedAt` has
    // been cleared yet — see the clearing-effect tests below for where that decision now lives.
    expect(source).toContain('const isAwaitingReorderResyncNow = reorderResyncArmedAt !== null;');
    expect(source).not.toContain('isAwaitingReorderResync(reorderResyncArmedAt, encounterReadRevision)');
    // Regression guard: this must NOT be a ref. A ref read here would silently reintroduce
    // the exact defect this describe block exists to close (no re-render on change).
    expect(source).not.toContain('const awaitingReorderResyncRef = useRef');
  });

  /**
   * Review rounds 5 and 6 (Codex, confirmed both times), pulling in OPPOSITE directions —
   * which is exactly why the effect's dependency array has to satisfy both at once, and why
   * these two tests exist side by side:
   *
   * - Round 5: `encounterReadRevisionRef`/`encounterReadRevision` are bumped SYNCHRONOUSLY
   *   inside `encounterQuery`'s `queryFn`, before that async function returns — strictly
   *   BEFORE TanStack's own separate cache-update-and-notify step publishes the new
   *   `encounter` a component renders. Depending on `encounterReadRevision` lets a render see
   *   the bumped revision but the still-stale `encounter` — releasing the gate too EARLY.
   * - Round 6: depending on `encounter`'s object reference instead gets the gate STUCK armed
   *   forever when a reorder fails without changing server state (e.g. the server refuses a
   *   move of the current combatant) — the follow-up GET returns a payload identical to what's
   *   cached, and `@tanstack/query-core`'s `replaceEqualDeep` preserves the OLD `encounter`
   *   reference on a full deep-equal match, so an effect keyed on `encounter` never re-fires.
   *
   * The fix depends on `encounterQuery.dataUpdatedAt` instead — a TanStack-native field
   * published atomically with `data` (so it can't arrive in an earlier render, unlike our own
   * `encounterReadRevision` state) that also advances on EVERY completed fetch regardless of
   * whether the resulting reference changed (so it can't get stuck the way `encounter` can).
   * `encounterReadRevisionRef.current`, read INSIDE the now-correctly-triggered effect, is
   * still what distinguishes a real completed GET from a local optimistic write (verified
   * against `@tanstack/query-core`'s source: `setQueryData` ALSO bumps `dataUpdatedAt`, so
   * that field alone cannot make the distinction — it is a wake-up trigger here, never the
   * comparison itself).
   */
  test("the clearing effect depends on encounterQuery.dataUpdatedAt — NOT encounterReadRevision (round 5) and NOT encounter (round 6) — and still checks encounterReadRevisionRef.current inside", () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const stateStart = source.indexOf('const [reorderResyncArmedAt, setReorderResyncArmedAt] = useState<number | null>(null);');
    expect(stateStart).toBeGreaterThan(-1);
    const effectEnd = source.indexOf('\n  }, [encounterQuery.dataUpdatedAt, reorderResyncArmedAt]);', stateStart);
    expect(effectEnd).toBeGreaterThan(stateStart);
    const block = source.slice(stateStart, effectEnd);

    // Round 5 regression guard: the revision STATE must not be a dependency (it can advance
    // in an earlier render than the `encounter` it's meant to certify).
    expect(block).not.toContain('[encounterReadRevision]');
    expect(block).not.toContain(', encounterReadRevision]');
    // Round 6 regression guard: `encounter`'s reference must not be the (sole) dependency
    // either (structural sharing can leave it unchanged forever on an unchanged payload).
    expect(block).not.toContain('[encounter,');
    expect(block).not.toContain('[encounter]');
    // The gating COMPARISON is still the ref, not `dataUpdatedAt` itself (round 3's mistake).
    expect(block).toMatch(
      /if \(reorderResyncArmedAt !== null && !isAwaitingReorderResync\(reorderResyncArmedAt, encounterReadRevisionRef\.current\)\) \{/,
    );
    expect(block).toContain('setReorderResyncArmedAt(null);');
  });

  /**
   * Round 6's concrete deadlock, pinned directly: `reorderCombatant`'s `onSettled` arms the
   * latch on EVERY settle, success or failure (`onSettled` has no `_err` branch that skips
   * it) — so a reorder rejected by the server (learns nothing changed) must still be able to
   * release the latch once the resulting no-op refetch completes, even though its payload,
   * and therefore `encounter`'s reference, may be byte-identical to what was already cached.
   */
  test("onSettled arms the latch unconditionally (both success and failure), which is exactly why the clearing dependency cannot require encounter's reference to change", () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const fnStart = source.indexOf('const reorderCombatant = useMutation({');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('\n  });', fnStart);
    const fn = source.slice(fnStart, fnEnd);
    const onSettledStart = fn.indexOf('onSettled:');
    expect(onSettledStart).toBeGreaterThan(-1);
    // `onSettled`'s signature ignores the error argument (`_err`) — it does not branch away
    // from arming the latch on a failed reorder. It destructures `encounterId` too (issue
    // #2116 review round 7) — see the describe block below for why.
    expect(fn.slice(onSettledStart, onSettledStart + 90)).toMatch(/onSettled:\s*\(_data,\s*_err,\s*\{\s*combatantId,\s*encounterId\s*\}\)/);
  });

  test('reorderCombatant.onSettled arms the state with the read-revision baseline, before invalidateEncounter', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const fnStart = source.indexOf('const reorderCombatant = useMutation({');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('\n  });', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fn = source.slice(fnStart, fnEnd);

    // A bare Combatant response — issue #2116's review found the previous CombatantReorderResult
    // response-shape change could never carry a fresher turnVersion than the CAS the caller
    // already sent, so it was reverted; there is no server-side response-shape change here.
    expect(fn).toContain('api.post<Combatant>(');

    const onSettledStart = fn.indexOf('onSettled:');
    expect(onSettledStart).toBeGreaterThan(-1);
    const onSettledBlock = fn.slice(onSettledStart);
    const armIndex = onSettledBlock.indexOf('setReorderResyncArmedAt(encounterReadRevisionRef.current);');
    // Issue #2116 review round 7: invalidates the write's OWN encounter (from variables), not
    // the bare `eid` identifier — see the describe block below for the full defect.
    const invalidateIndex = onSettledBlock.indexOf('invalidateEncounter(queryClient, encounterId);');
    expect(armIndex).toBeGreaterThan(-1);
    expect(invalidateIndex).toBeGreaterThan(-1);
    expect(armIndex).toBeLessThan(invalidateIndex);
    // Regression guard for the exact defect found in review: arming from
    // `encounterQuery.dataUpdatedAt` anywhere in this mutation would silently reopen the
    // wrong-order hazard.
    expect(fn).not.toContain('encounterQuery.dataUpdatedAt');
    // Regression guard for review round 7: `eid` (this callback's own, potentially STALE
    // closure — see the describe block below) must never be the invalidation target again.
    expect(onSettledBlock.slice(0, onSettledBlock.indexOf('\n  });'))).not.toContain('invalidateEncounter(queryClient, eid)');
  });

  test('the eid-change reset effect clears reorderResyncArmedAt via its state setter, not a ref write', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const effectStart = source.indexOf("activeEncounterIdRef.current = eid;\n    setPendingCombatantUndo(null);");
    expect(effectStart).toBeGreaterThan(-1);
    const effectEnd = source.indexOf('\n  }, [eid]);', effectStart);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const block = source.slice(effectStart, effectEnd);
    expect(block).toContain('setReorderResyncArmedAt(null);');
  });
});

test.describe('reorder settlement is scoped to the encounter the write belongs to, not whichever is on screen when it lands (issue #2116 review round 7)', () => {
  /**
   * `RunSessionPage` is reused across encounters — its route carries no `key={encounterId}`
   * (see `app/router.tsx`), so navigating the DM from encounter A to encounter B re-renders
   * this same component instance instead of remounting it. `useMutation`'s effect calls
   * `observer.setOptions(options)` on every render, and `MutationObserver.setOptions`
   * (`@tanstack/query-core`) splices those newest options straight into an in-flight
   * `Mutation` instance whenever it is still pending — so `onSettled`, if it closed over
   * `eid` directly, would run with WHICHEVER encounter is on screen when the request
   * finishes, not the one the completed write actually belongs to. That would re-arm the
   * NEW encounter's resync latch (disabling its reorder affordances for a drag it never
   * made) and invalidate the NEW encounter's cache instead of the one that actually changed.
   *
   * This describe block only pins that the wiring reads `encounterId` from the mutation's
   * OWN variables rather than the `eid` closure, and gates arming through the real
   * `shouldArmReorderResyncLatch`. The mechanism itself — that `useMutation` really does
   * splice a later render's options into an in-flight mutation — is proven against the real,
   * unmodified `@tanstack/react-query` + `@tanstack/query-core` (not source-scanned) in
   * `test/component/RunSessionPage.reorderCrossEncounterSettlement.spec.tsx`, which drives the
   * actual race and asserts on its real DOM/query-cache outcome; `shouldArmReorderResyncLatch`
   * itself is unit-tested against real values in `combatant-reorder.unit.spec.ts`.
   */
  test('mutationFn takes encounterId as a variable and builds the URL from it, not from the eid closure', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const fnStart = source.indexOf('const reorderCombatant = useMutation({');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('\n  });', fnStart);
    const fn = source.slice(fnStart, fnEnd);

    const mutationFnStart = fn.indexOf('mutationFn:');
    expect(mutationFnStart).toBeGreaterThan(-1);
    const onMutateStart = fn.indexOf('onMutate:', mutationFnStart);
    expect(onMutateStart).toBeGreaterThan(mutationFnStart);
    const mutationFnBlock = fn.slice(mutationFnStart, onMutateStart);

    expect(mutationFnBlock).toContain('encounterId: number');
    expect(mutationFnBlock).toContain('`${API}/encounters/${encounterId}/combatants/${combatantId}/reorder`');
    // Regression guard: the URL must not be built from the outer `eid` — that closure is
    // exactly what review round 7 found unsafe.
    expect(mutationFnBlock).not.toContain('`${API}/encounters/${eid}/combatants/${combatantId}/reorder`');
  });

  test("onSettled guards arming through the real shouldArmReorderResyncLatch, comparing the write's own encounterId against activeEncounterIdRef.current — never a bare `===` re-derived inline", () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toContain(
      "import { afterCombatantIdForMoveDown, afterCombatantIdForMoveUp, isAwaitingReorderResync, reorderMenuTargets, shouldArmReorderResyncLatch } from './combatantReorder';",
    );

    const fnStart = source.indexOf('const reorderCombatant = useMutation({');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('\n  });', fnStart);
    const fn = source.slice(fnStart, fnEnd);
    const onSettledStart = fn.indexOf('onSettled:');
    const onSettledBlock = fn.slice(onSettledStart);

    expect(onSettledBlock).toContain('if (shouldArmReorderResyncLatch(encounterId, activeEncounterIdRef.current)) {');
    // Regression guard: arming must not be unconditional again (round 7's exact regression —
    // the shape review found before this round's fix).
    expect(onSettledBlock.indexOf('setReorderResyncArmedAt(encounterReadRevisionRef.current);')).toBeGreaterThan(
      onSettledBlock.indexOf('if (shouldArmReorderResyncLatch('),
    );
  });

  test('handleReorderDrop passes encounterId: eid at the moment of the drag — the one point where eid is guaranteed current', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const callSite = source.indexOf('reorderCombatant.mutate({ combatantId, afterCombatantId, expectedTurnVersion: encounter.turnVersion, encounterId: eid });');
    expect(callSite).toBeGreaterThan(-1);

    // `eid` must be in handleReorderDrop's own dependency array, or a stale closure could
    // keep authoring the wrong `encounterId` after navigation.
    const depsStart = source.indexOf('[encounter, reorderCombatant, reconcileBlocks, riskyBlocked, isAwaitingReorderResyncNow, eid]', callSite);
    expect(depsStart).toBeGreaterThan(callSite);
  });
});

test.describe('a mid-gesture sync-gate flip does not strand the roster drag tracker (issue #2084 finding 4)', () => {
  test("rosterDragReorder's `enabled` folds in reconcileBlocks, riskyBlocked, and isAwaitingReorderResyncNow, so the hook's own enabled-transition reset actually fires for the roster", () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    // `buildReorderControls`' `busy` (pinned above) already withholds `dragHandleProps`
    // on the row when these gates trip — but withholding props off an element that
    // stays MOUNTED only drops the DOM listeners; it tells `useCombatantDragReorder`
    // nothing. The hook only resets an in-progress gesture (issue #2084 finding 4) when
    // its OWN `enabled` argument goes false, so that argument — not just `busy` — must
    // carry the same gates. This is a REGRESSION guard, not the mechanism itself: the
    // mechanism is `useCombatantDragReorder`'s own enabled-transition effect, unit-tested
    // directly in `test/component/useCombatantDragReorder.spec.tsx`.
    //
    // `isAwaitingReorderResyncNow` (issue #2116 review round 2) joins the same gate: if a
    // reorder's own resync arms mid-gesture, an in-progress drag must be reset too, not
    // just left disabled for the NEXT gesture.
    const fnStart = source.indexOf('const rosterDragReorder = useCombatantDragReorder({');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('});', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fn = source.slice(fnStart, fnEnd);

    const enabledLineMatch = fn.match(/enabled:\s*([^,]+),/);
    expect(enabledLineMatch).not.toBeNull();
    const enabledExpression = enabledLineMatch![1];
    expect(enabledExpression).toContain('reconcileBlocks');
    expect(enabledExpression).toContain('riskyBlocked');
    expect(enabledExpression).toContain('isAwaitingReorderResyncNow');
  });
});
