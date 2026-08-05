/**
 * The safety-hold mirror's refresh paths on the encounter run page (issue #1933 review).
 *
 * `safetyHoldActive` gates Start / Next turn / Undo turn / End turn — the same writes the
 * server rejects via `assertNoSafetyHold`. A stale mirror therefore produces the exact
 * failure the gating exists to prevent: the server refuses the write and the UI cannot say
 * why. `useTableSafety` polls every 20s, so every gap below is bounded by a poll interval
 * rather than being permanent — which is precisely why it is easy to miss in manual testing
 * and worth pinning.
 *
 * There are three ways the page learns a hold changed, and the first two shipped missing:
 *
 *  1. A delivered `safety.hold` frame. It is campaign-wide (no `encounterId`), so it fell
 *     into `onEvent`'s encounter-id filter and was dropped — same shape as the #421
 *     character-frame bug, and it must be handled ahead of that filter for the same reason.
 *  2. The stream was down while someone else raised or released the hold. No frame exists to
 *     deliver on reconnect, so the catch-up refetch has to ask for it explicitly.
 *  3. Parser recovery with the connection still up — same argument as (2).
 *
 * Follows this repo's Playwright "unit" convention (source-assertion, no browser / no seeded
 * backend — see action-use-system-math-notice.unit.spec.ts). Asserted against the source
 * because these are React callbacks with no rendered surface of their own: the observable
 * consequence is a control's enabled state up to 20 seconds later, which a browser spec
 * cannot pin without either sleeping through a poll interval or stubbing the very query
 * whose invalidation is the thing under test.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_SESSION_FILE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

/** The body of a single `useCallback(() => { ... }, [deps])` starting at `label`. */
function callbackBody(code: string, label: string): string {
  const start = code.indexOf(label);
  expect(start, `${label} must exist in RunSessionPage`).toBeGreaterThan(-1);
  return code.slice(start, start + 1200);
}

test.describe('RunSessionPage table-safety catch-up (issue #1933)', () => {
  test('every path that can learn of a hold change invalidates the safety query', () => {
    const code = readFileSync(RUN_SESSION_FILE, 'utf8');

    // (1) The live frame, handled BEFORE the encounter-id filter that would drop it.
    const holdBranch = code.indexOf("event.type === 'safety.hold'");
    const encounterFilter = code.indexOf("event.type !== 'encounter.updated'");
    expect(holdBranch, 'the safety.hold branch must exist').toBeGreaterThan(-1);
    expect(encounterFilter).toBeGreaterThan(-1);
    expect(holdBranch).toBeLessThan(encounterFilter);
    expect(code.slice(holdBranch, encounterFilter)).toMatch(/invalidateTableSafety\(queryClient, cid\)/);

    // (2) and (3): the two catch-up paths, where a hold change produced no deliverable frame.
    expect(callbackBody(code, 'onReconnect: useCallback')).toMatch(/invalidateTableSafety\(queryClient, cid\)/);
    expect(callbackBody(code, 'onStreamRecovery: useCallback')).toMatch(/invalidateTableSafety\(queryClient, cid\)/);
  });
});
