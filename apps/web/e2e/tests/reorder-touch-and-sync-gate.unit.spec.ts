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
