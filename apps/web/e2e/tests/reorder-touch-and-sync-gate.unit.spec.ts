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

    // The useCallback dependency array must also carry riskyBlocked, or the closure
    // would go stale and keep evaluating an old value.
    const depsMatch = fn.match(/\[canReorderCombatants,[^\]]*\],\s*\);/);
    expect(depsMatch).not.toBeNull();
    expect(depsMatch![0]).toContain('riskyBlocked');
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

    // An early return on all three, ahead of the mutate call — not merely a mention.
    const guardIndex = fn.search(/if \(reconcileBlocks \|\| riskyBlocked \|\| reorderCombatant\.isPending\) return;/);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(fn.indexOf('reorderCombatant.mutate('));

    // Stale-closure guard: each gate must appear in the dependency array too.
    const depsMatch = fn.match(/\[encounter,[^\]]*\],\s*\);/);
    expect(depsMatch).not.toBeNull();
    for (const dep of ['reconcileBlocks', 'riskyBlocked', 'reorderCombatant']) {
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
  });
});

test.describe('reorderCombatant seeds turnVersion from its own response (issue #2116)', () => {
  /**
   * `handleReorderDrop`'s guard (pinned above) opens the instant `reorderCombatant.isPending`
   * clears — the moment the POST resolves, before `onSettled`'s `invalidateEncounter` refetch
   * has round-tripped. A drag completed in that window used to CAS against whatever
   * `turnVersion` was still sitting in the query cache from before this response existed,
   * which could already be stale, 409ing a drag that had every right to succeed. Rather than
   * widen the gate to `encounterQuery.isFetching` (ruled out above — see the reorder-drop test
   * suite in this file), the fix closes the window at its source: the reorder response now
   * carries the encounter's `turnVersion` as observed by the write itself
   * (`CombatantReorderResult`, `@campfire/schema`), and `onSuccess` seeds the query cache from
   * it synchronously, ahead of `onSettled`'s refetch.
   */
  test("onSuccess writes the response's turnVersion into the encounter query cache before onSettled's refetch", () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const fnStart = source.indexOf('const reorderCombatant = useMutation({');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('\n  });', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fn = source.slice(fnStart, fnEnd);

    // A bare Combatant carries no turnVersion to seed from — the mutation must type its
    // response as the extended result the fix introduces.
    expect(fn).toContain('api.post<CombatantReorderResult>');

    const onSuccessStart = fn.indexOf('onSuccess:');
    const onSettledStart = fn.indexOf('onSettled:');
    expect(onSuccessStart).toBeGreaterThan(-1);
    expect(onSettledStart).toBeGreaterThan(onSuccessStart);
    const onSuccessBlock = fn.slice(onSuccessStart, onSettledStart);

    expect(onSuccessBlock).toContain('queryClient.setQueryData');
    expect(onSuccessBlock).toContain('queryKeys.encounter(eid)');
    // A monotonic max, not a blind overwrite — a concurrent turn-advance response landing
    // first over the network must not be regressed backward by this older read.
    expect(onSuccessBlock).toMatch(/turnVersion:\s*Math\.max\(current\.turnVersion,\s*updated\.turnVersion\)/);
  });
});

test.describe('a mid-gesture sync-gate flip does not strand the roster drag tracker (issue #2084 finding 4)', () => {
  test("rosterDragReorder's `enabled` folds in reconcileBlocks and riskyBlocked, so the hook's own enabled-transition reset actually fires for the roster", () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    // `buildReorderControls`' `busy` (pinned above) already withholds `dragHandleProps`
    // on the row when these gates trip — but withholding props off an element that
    // stays MOUNTED only drops the DOM listeners; it tells `useCombatantDragReorder`
    // nothing. The hook only resets an in-progress gesture (issue #2084 finding 4) when
    // its OWN `enabled` argument goes false, so that argument — not just `busy` — must
    // carry the same gates. This is a REGRESSION guard, not the mechanism itself: the
    // mechanism is `useCombatantDragReorder`'s own enabled-transition effect, unit-tested
    // directly in `test/component/useCombatantDragReorder.spec.tsx`.
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
  });
});
