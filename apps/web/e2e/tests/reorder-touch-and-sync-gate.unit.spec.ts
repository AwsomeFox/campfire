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

test.describe('reorder resync latch is REACTIVE state, and every reorder entry point consults it (issue #2116 review round 2)', () => {
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
   * `reorderResyncArmedAt` is now `useState`, and `isAwaitingReorderResyncNow` is computed
   * fresh every render from it plus `encounterReadRevision` (also state) — both reactive,
   * so a re-render always reflects the true value before any entry point acts on it.
   * `RunSessionPage.tsx` is too heavily wired to mount — see this file's top comment — so
   * the call sites are pinned by source rather than by rendering; the underlying decision
   * function itself is behaviorally unit-tested against real values in
   * `combatant-reorder.unit.spec.ts`.
   *
   * Gated on `encounterReadRevisionRef`/`encounterReadRevision` — NOT
   * `encounterQuery.dataUpdatedAt` — deliberately: `dataUpdatedAt` advances on ANY
   * `setQueryData` for this query key, including this page's own local optimistic writes
   * (an HP delta, a map/fog patch) that never round-trip to the server. Gating on it would
   * let one of those land inside the window and clear the gate while the roster was still
   * pre-reorder, reopening the exact silent-wrong-order hazard this mechanism exists to
   * close. `encounterReadRevisionRef` only advances inside `encounterQuery`'s own `queryFn`,
   * after a real fetch it started has actually resolved (guarded by
   * `signal.throwIfAborted()`) — see that ref's own doc comment a few hundred lines above.
   */
  test('reorderResyncArmedAt is useState, and isAwaitingReorderResyncNow is derived from it plus encounterReadRevision', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toContain('const [reorderResyncArmedAt, setReorderResyncArmedAt] = useState<number | null>(null);');
    expect(source).toContain('const isAwaitingReorderResyncNow = isAwaitingReorderResync(reorderResyncArmedAt, encounterReadRevision);');
    // Regression guard: this must NOT be a ref. A ref read here would silently reintroduce
    // the exact defect this describe block exists to close (no re-render on change).
    expect(source).not.toContain('const awaitingReorderResyncRef = useRef');
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
    const invalidateIndex = onSettledBlock.indexOf('invalidateEncounter(queryClient, eid);');
    expect(armIndex).toBeGreaterThan(-1);
    expect(invalidateIndex).toBeGreaterThan(-1);
    expect(armIndex).toBeLessThan(invalidateIndex);
    // Regression guard for the exact defect found in review: arming from
    // `encounterQuery.dataUpdatedAt` anywhere in this mutation would silently reopen the
    // wrong-order hazard.
    expect(fn).not.toContain('encounterQuery.dataUpdatedAt');
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
