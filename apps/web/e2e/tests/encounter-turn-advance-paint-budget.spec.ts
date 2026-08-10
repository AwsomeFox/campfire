import { expect, test, type Page } from '@playwright/test';
import { Combatant, type EncounterEvent, type EncounterWithCombatants } from '@campfire/schema';
import { PNG_16_9, seed, stateFor, restoreSeedEncounter } from './seed';

/**
 * Interaction-to-paint perf probe (issue #1917 stage 4).
 *
 * This is deliberately NOT a render-containment probe like `encounter-render-containment.spec.ts`
 * — it does not claim to prove any single memo boundary works, and a regression here could be
 * caused by any of stages 1-3 regressing, by an unrelated slowdown elsewhere in the render path,
 * or by the browser/CI host itself. What it guards is the thing a player actually feels: how long
 * a turn-advance click takes to visibly land, under a roster/log size this issue itself specifies.
 *
 * Fixture: 20 placed map tokens (the issue's own token count) and 200 ungrouped combat-log
 * events (the issue's own event count — `chainId: null` on every event, so
 * `groupCombatLogEvents` renders exactly 200 separate log rows rather than collapsing them
 * into fewer chains). Both numbers come straight from the issue body, not tuned for this test.
 *
 * The encounter and its combatants are fully mocked (same technique as
 * `encounter-render-containment.spec.ts`'s `openContainmentFixture`): 20 real combatant rows
 * seeded via the real API would work, but replaying 200 real combat events would mean 200
 * sequential mutating HTTP round-trips just to build a fixture, which is slow and unrelated to
 * what this test measures. `next-turn` itself is also mocked (advances the local encounter
 * object exactly like the real endpoint would) so the click exercises the real client-side
 * mutation → cache-write → re-render path without a real server round-trip's own latency
 * competing with the render cost this probe cares about.
 *
 * Budget and what it can/cannot catch (measured, not guessed — see the PR description for the
 * numbers): locally this interaction completes in ~270-335ms. Removing `CombatantRow`'s
 * `memo()` wrapper entirely (so all 20 rows re-render every turn-advance instead of just the
 * two affected ones) only moves that to ~280-390ms — real and measurable, but nowhere near
 * BUDGET_MS at THIS fixture size. A single memo boundary is therefore not something this
 * specific probe, at this specific size, can be relied on to catch — that job belongs to the
 * behavioural/source-assertion guards (`GridOverlay.memoBoundary.spec.tsx`,
 * `BattleMap.dragContainment.spec.tsx`, `encounter-render-containment.unit.spec.ts`). What a
 * wide-but-not-infinite budget like this DOES catch is a qualitatively different kind of
 * regression: an accidentally quadratic/exponential effect, a synchronous blocking call, a
 * runaway loop, or anything else that would turn "a bit slower" into "visibly hung" — the kind
 * of defect where flakiness from CI variance is not a real risk because the failure is not
 * close to the line. Chosen generously on purpose for exactly that reason: a false-positive
 * failure from ordinary CI variance would train agents to stop trusting or maintaining this
 * probe, which is worse than a wide budget that still catches a catastrophic regression. It is
 * NOT a tight performance SLO and NOT a substitute for the containment guards above.
 */

const MAP_ATTACHMENT_ID = 1_917_100;
const TOKEN_COUNT = 20;
const LOG_EVENT_COUNT = 200;
const FIRST_COMBATANT_ID = 1_917_101;
const SECOND_COMBATANT_ID = 1_917_102;

// Generous on purpose — see file header for the measured baseline and what this budget can and
// cannot catch. This leaves roughly an order of magnitude of headroom over the measured local
// baseline (~270-390ms) for a loaded CI runner, GC pause, or cold JIT right after page load,
// while still failing hard on a multi-second regression.
const BUDGET_MS = 3_000;

function placedCombatant(id: number, encounterId: number, index: number, name: string): Combatant {
  return Combatant.parse({
    id,
    encounterId,
    kind: 'monster',
    name,
    initiative: TOKEN_COUNT - index,
    hpCurrent: 10,
    hpMax: 10,
    conditions: [],
    sortOrder: index,
    // Spread across a 5x4 grid (percent coordinates) so 20 tokens don't all stack on one cell.
    tokenX: 10 + (index % 5) * 20,
    tokenY: 10 + Math.floor(index / 5) * 20,
    tokenSize: 'medium',
    turnState: { used: {}, movementUsedFt: 0, concentration: null, pendingConcentrationChecks: [], delaying: false, readied: null },
  });
}

/** 200 ungrouped events (no `chainId`) so the combat log renders 200 separate rows. */
function syntheticEvents(encounterId: number): EncounterEvent[] {
  return Array.from({ length: LOG_EVENT_COUNT }, (_, i) => ({
    id: i + 1,
    encounterId,
    round: 1 + Math.floor(i / TOKEN_COUNT),
    type: 'damage',
    actor: `Perf Mob ${(i % TOKEN_COUNT) + 1}`,
    target: `Perf Mob ${((i + 1) % TOKEN_COUNT) + 1}`,
    actorId: null,
    targetId: null,
    detail: `took ${(i % 6) + 1} damage.`,
    chainId: null,
    parentEventId: null,
    phase: null,
    performedBy: null,
    metadata: {},
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
}

async function openPerfFixture(page: Page): Promise<{ encounterId: number }> {
  const { encounterId } = seed();
  const response = await page.request.get(`/api/v1/encounters/${encounterId}`);
  expect(response.ok()).toBeTruthy();
  const original = (await response.json()) as EncounterWithCombatants;

  const combatants = [
    placedCombatant(FIRST_COMBATANT_ID, encounterId, 0, 'Perf Mob 1'),
    placedCombatant(SECOND_COMBATANT_ID, encounterId, 1, 'Perf Mob 2'),
    ...Array.from({ length: TOKEN_COUNT - 2 }, (_, i) =>
      placedCombatant(FIRST_COMBATANT_ID + 2 + i, encounterId, i + 2, `Perf Mob ${i + 3}`),
    ),
  ];

  let encounter: EncounterWithCombatants = {
    ...original,
    status: 'running',
    mapAttachmentId: MAP_ATTACHMENT_ID,
    gridSize: 10,
    gridScale: 5,
    gridUnit: 'ft',
    gridSnap: false,
    gridType: 'square',
    fog: { enabled: false, revealed: [] },
    round: 1,
    currentCombatantId: FIRST_COMBATANT_ID,
    combatants,
  };

  const events = syntheticEvents(encounterId);

  await page.route(`**/api/v1/attachments/${MAP_ATTACHMENT_ID}/file`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_16_9 }),
  );
  await page.route(`**/api/v1/encounters/${encounterId}/map*`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_16_9 }),
  );
  await page.route(new RegExp(`/api/v1/encounters/${encounterId}$`), async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', json: encounter });
      return;
    }
    await route.continue();
  });
  await page.route(new RegExp(`/api/v1/encounters/${encounterId}/events$`), async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', json: events });
  });
  // Mocked the same way `next-turn` itself would behave for a two-combatant-turn-order
  // roster: advance `currentCombatantId` from the first placed combatant to the second and
  // hand back the updated encounter, exactly what the real endpoint's response shape is
  // (`EncounterWithCombatants`) — see `RunSessionPage.tsx`'s `nextTurnMut`. This keeps the
  // click exercising the real client mutation → cache-write → re-render path without a real
  // server round-trip's own latency competing with the render cost this probe measures.
  await page.route(new RegExp(`/api/v1/encounters/${encounterId}/next-turn$`), async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    encounter = { ...encounter, currentCombatantId: SECOND_COMBATANT_ID };
    await route.fulfill({ status: 200, contentType: 'application/json', json: encounter });
  });

  await page.goto(`/c/${original.campaignId}/encounters/${encounterId}`);
  const layer = page.getByTestId('battle-map-layer');
  await expect(layer).toBeVisible();
  await expect.poll(async () => {
    const box = await layer.boundingBox();
    return box != null && box.width > 50 && box.height > 50;
  }).toBeTruthy();
  await expect(page.getByTestId(`map-token-${FIRST_COMBATANT_ID}`)).toBeVisible();
  await expect(page.getByTestId(`combatant-row-${FIRST_COMBATANT_ID}`)).toBeVisible();

  return { encounterId };
}

test.describe('encounter turn-advance interaction-to-paint budget (issue #1917 stage 4)', () => {
  test.use({ storageState: stateFor('dm') });

  test.beforeEach(async ({ page }) => {
    await restoreSeedEncounter(page);
  });

  test('advancing the turn with 20 placed tokens and a 200-event combat log paints within budget', async ({ page }) => {
    await openPerfFixture(page);

    const nextTurnBtn = page.getByTestId('encounter-header-next-turn');
    await expect(nextTurnBtn).toBeEnabled();

    await page.evaluate(() => performance.mark('cf-turn-advance-start'));
    await nextTurnBtn.click();

    // The visible signal that the turn actually advanced — the same attribute
    // `encounter-active-row-scroll.spec.ts` polls on.
    await expect(page.getByTestId(`combatant-row-${SECOND_COMBATANT_ID}`)).toHaveAttribute('data-current-turn', 'true');

    // Double requestAnimationFrame: the browser guarantees the first callback runs after
    // the frame that committed the DOM change above, and the second guarantees that frame
    // has actually been painted (not just scheduled) — the standard "wait for next paint"
    // technique, so the measured span covers the real interaction-to-paint cost rather than
    // stopping at DOM commit.
    const durationMs = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              performance.mark('cf-turn-advance-end');
              const measure = performance.measure('cf-turn-advance', 'cf-turn-advance-start', 'cf-turn-advance-end');
              resolve(measure.duration);
            });
          });
        }),
    );

    expect(durationMs).toBeLessThan(BUDGET_MS);
  });
});
