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
 * what this test measures. `next-turn` itself is also mocked (toggles `currentCombatantId`
 * between the first two placed combatants, exactly the shape the real endpoint's response
 * takes — see `RunSessionPage.tsx`'s `nextTurnMut`) so each click exercises the real
 * client-side mutation → cache-write → re-render path without a real server round-trip's own
 * latency competing with the render cost this probe measures.
 *
 * Sampling, not a single click (review finding, PR #2165): a single measurement has no way to
 * distinguish "the render path is slow" from "this one run hit a GC pause / scheduler hiccup",
 * and a budget wide enough to absorb that ambiguity for one sample is too wide to catch anything
 * real (see the coordinator review this file's git history references). Instead this test
 * performs SAMPLE_COUNT back-to-back turn-advance clicks in the SAME page — the same fixture,
 * the same browser process, the same CI runner as whatever machine executes this job — logs
 * every sample plus the p50/p95/max, and asserts the observed p95 against BUDGET_MS. That
 * turns "chosen generously to avoid flake" into "chosen as an explicit multiplier over a
 * distribution measured on the actual hardware running the assertion" — CI variance no longer
 * has to be guessed at from a local dev box, because every CI run re-measures its own p95 on
 * its own runner. Read this test's own CI log output (`[perf] turn-advance samples` /
 * `[perf] p50/p95/max`) for the current distribution rather than trusting last time's numbers.
 *
 * BUDGET_MS derivation — real CI numbers, not a local-box guess (review finding, PR #2165):
 * this exact test (the SAMPLE_COUNT-sample version below) ran on 2026-08-10 in this repo's own
 * `e2e-web` shard —
 * https://github.com/AwsomeFox/campfire/actions/runs/31391517583/job/93464517384 — and logged:
 *
 *   samples (ms): 129.3, 152.3, 154.4, 163.9, 172.0, 173.7, 173.8, 175.6, 177.8, 182.1, 185.2,
 *                 190.6, 192.8, 193.4, 194.5, 195.9, 199.5, 201.3, 201.6, 243.9
 *   p50=182.1ms  p95=201.6ms  max=243.9ms
 *
 * BUDGET_MS = round(BUDGET_MULTIPLIER × 201.6) = round(5 × 201.6) = 1008, rounded to 1000 for a
 * clean constant. Multiplier 5 (not the 4 an earlier cut of this file used before real CI data
 * existed) is deliberately a little more generous than the tightest defensible number, because
 * this derivation rests on ONE CI job's ONE run — inter-run variance (a different runner
 * instance, a noisier host, cache-cold Chromium download) is not something a single run's
 * intra-run p50/p95/max can observe, only intra-run jitter is. If this budget ever flakes on
 * CI, the fix is to look at what THAT run's own `[perf]` log line reports and either confirm
 * it was a genuine one-off outlier or recompute BUDGET_MS from a wider multi-run sample —
 * never to silently widen it back toward "generous" without that evidence.
 *
 * 1000ms is tight enough that a regression on the order the mutation evidence in PR #2165
 * demonstrated (stripping one component's `memo()` wrapper — a measured ~1.1-1.4x slowdown at
 * this fixture size, well under 1000ms either way) would still not reliably trip it — that job,
 * as documented above, belongs to the behavioural/source-assertion guards, not this probe — but
 * tight enough (real p95 × 5, not real p95 × ~15 as the previous 3000ms constant amounted to)
 * to catch a qualitatively different kind of regression: an accidentally quadratic/exponential
 * effect, a synchronous blocking call, or a runaway loop — the kind of defect where flakiness
 * from ordinary CI variance is not a real risk because the failure is not close to the line. It
 * is NOT a tight performance SLO and NOT a substitute for the containment guards named above.
 */

const MAP_ATTACHMENT_ID = 1_917_100;
const TOKEN_COUNT = 20;
const LOG_EVENT_COUNT = 200;
const FIRST_COMBATANT_ID = 1_917_101;
const SECOND_COMBATANT_ID = 1_917_102;

// Sample count for the in-run distribution (see file header). 20 gives p95 a real 19th-of-20
// sample to point at (not just "the max of 3") while keeping the added wall time (roughly
// SAMPLE_COUNT x a few hundred ms) comfortably inside this suite's per-test timeout.
const SAMPLE_COUNT = 20;

// Multiplier applied to a REAL observed CI p95 (see file header for the exact run, samples, and
// full derivation) — not a round number picked for comfort. 1000 = round(5 x 201.6ms).
const BUDGET_MULTIPLIER = 5;
const BUDGET_MS = 1_000;

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
  // roster: toggle `currentCombatantId` between the first two placed combatants and hand back
  // the updated encounter, exactly what the real endpoint's response shape is
  // (`EncounterWithCombatants`) — see `RunSessionPage.tsx`'s `nextTurnMut`. Toggling (rather
  // than advancing through all 20) lets this test drive SAMPLE_COUNT clicks in a two-row loop
  // without needing a 20-long turn order; each click still exercises the real client mutation
  // → cache-write → re-render path without a real server round-trip's own latency competing
  // with the render cost this probe measures.
  await page.route(new RegExp(`/api/v1/encounters/${encounterId}/next-turn$`), async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    encounter = {
      ...encounter,
      currentCombatantId: encounter.currentCombatantId === FIRST_COMBATANT_ID ? SECOND_COMBATANT_ID : FIRST_COMBATANT_ID,
    };
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
    let expectedCurrentId = FIRST_COMBATANT_ID;
    const durations: number[] = [];

    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
      await expect(nextTurnBtn).toBeEnabled();
      expectedCurrentId = expectedCurrentId === FIRST_COMBATANT_ID ? SECOND_COMBATANT_ID : FIRST_COMBATANT_ID;
      const startMark = `cf-turn-advance-start-${sample}`;
      const endMark = `cf-turn-advance-end-${sample}`;

      await page.evaluate((mark) => performance.mark(mark), startMark);
      await nextTurnBtn.click();

      // The visible signal that the turn actually advanced — the same attribute
      // `encounter-active-row-scroll.spec.ts` polls on.
      await expect(page.getByTestId(`combatant-row-${expectedCurrentId}`)).toHaveAttribute('data-current-turn', 'true');

      // Double requestAnimationFrame: the browser guarantees the first callback runs after
      // the frame that committed the DOM change above, and the second guarantees that frame
      // has actually been painted (not just scheduled) — the standard "wait for next paint"
      // technique, so the measured span covers the real interaction-to-paint cost rather than
      // stopping at DOM commit.
      const durationMs = await page.evaluate(
        ({ startMark, endMark }) =>
          new Promise<number>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                performance.mark(endMark);
                const measure = performance.measure(`cf-turn-advance-${endMark}`, startMark, endMark);
                resolve(measure.duration);
              });
            });
          }),
        { startMark, endMark },
      );
      durations.push(durationMs);
    }

    const sorted = [...durations].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
    const p50 = percentile(0.5);
    const p95 = percentile(0.95);
    const max = sorted[sorted.length - 1]!;

    // Node-side console.log (not page.evaluate) — lands directly in this job's CI log output
    // for whoever next needs to re-derive BUDGET_MS (see file header). Every individual sample
    // is included, not just the summary, so a single outlier is visible rather than smeared
    // into an average.
    console.log(`[perf] turn-advance samples (ms): ${sorted.map((d) => d.toFixed(1)).join(', ')}`);
    console.log(`[perf] p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms budget=${BUDGET_MS}ms (${BUDGET_MULTIPLIER}x p95 basis)`);

    expect(p95).toBeLessThan(BUDGET_MS);
  });
});
