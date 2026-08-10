import { expect, test, type Page } from '@playwright/test';
import { Combatant, TurnWorkspace, type EncounterEvent, type EncounterWithCombatants } from '@campfire/schema';
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
 * The encounter, its combatants, its events, AND its turn workspace are fully mocked (same
 * technique as `encounter-render-containment.spec.ts`'s `openContainmentFixture`). The turn
 * workspace mock exists because of a real bug caught in review (PR #2165): `RunSessionPage`
 * fetches `GET /encounters/:id/turn` whenever the cached encounter reports `status: 'running'`,
 * and re-invalidates it on every `currentCombatantId` change — i.e. on every one of this test's
 * sampled clicks. Leaving that route unmocked sent it to the REAL backend for a combatant id
 * that only exists in this test's client-side mock, pulling real network latency/4xx noise into
 * the exact measurement this file derives a budget from. `next-turn` itself is also mocked
 * (toggles `currentCombatantId` between the first two placed combatants, exactly the shape the
 * real endpoint's response takes — see `RunSessionPage.tsx`'s `nextTurnMut`) so each click
 * exercises the real client-side mutation → cache-write → re-render path without any real
 * server round-trip's latency competing with the render cost this probe measures.
 *
 * Sampling, not a single click (review finding, PR #2165): a single measurement has no way to
 * distinguish "the render path is slow" from "this one run hit a GC pause / scheduler hiccup",
 * and a budget wide enough to absorb that ambiguity for one sample is too wide to catch anything
 * real. Instead this test performs SAMPLE_COUNT back-to-back turn-advance clicks in the SAME
 * page — the same fixture, the same browser process, the same CI runner as whatever machine
 * executes this job — logs every sample plus the p50/p95/max, and asserts the observed p95
 * against BUDGET_MS. Every CI run re-measures its own p95 on its own runner; read this test's
 * own CI log output (`[perf] turn-advance samples` / `[perf] p50/p95/max`) for the current
 * distribution rather than trusting last time's numbers.
 *
 * Entirely in-page measurement (review finding, PR #2165 — this is the second, more important
 * bug the first cut of this file had): the very first version placed the start mark via a
 * `page.evaluate` round trip, dispatched the click through Playwright's `.click()`
 * (actionability checks + a real CDP round trip), detected the turn landing with a Node-side
 * `expect(...).toHaveAttribute(...)` polling assertion, and only THEN entered the page to place
 * the end mark. All three of those — the Node→browser round trip, Playwright/CDP click
 * dispatch, and Node-side polling — sat INSIDE the measured span, so the number was dominated
 * by test-harness latency rather than app render time. That is why the very first mutation
 * check (stripping `CombatantRow`'s `memo()` entirely) barely moved the measured duration: the
 * signal was a small fraction of what was actually being timed. The sampling loop below instead
 * runs entirely inside ONE `page.evaluate` call — the start mark, the native `HTMLElement.click()`
 * dispatch, an in-page `MutationObserver` watching for the `data-current-turn` flip, the
 * double-`requestAnimationFrame` paint wait, and the end mark are all executed by the browser's
 * own JS engine with no Node↔browser round trip anywhere inside an individual sample's
 * start-to-end window. Only the OUTER call (kick off the whole loop, get the finished array
 * back) crosses the Node/browser boundary, and that crossing is outside every measured span.
 *
 * BUDGET_MS derivation — real CI numbers on the corrected (in-page, `/turn`-mocked) probe, not
 * a local-box guess and not the numbers from the harness-latency-dominated first cut (those
 * earlier numbers were discarded rather than reused once the harness-latency bug was found):
 * this exact test ran on 2026-08-10 in this repo's own `e2e-web` shard —
 * https://github.com/AwsomeFox/campfire/actions/runs/31394914742/job/93475839086 — and logged:
 *
 *   samples (ms): 93.2, 119.0, 123.9, 123.9, 134.0, 142.6, 143.9, 145.8, 147.2, 147.7, 148.2,
 *                 152.5, 155.8, 156.3, 163.0, 181.1, 192.9, 198.5, 199.4, 229.2
 *   p50=147.7ms  p95=199.4ms  max=229.2ms
 *
 * BUDGET_MS = round(BUDGET_MULTIPLIER × 199.4) = round(5 × 199.4) = 997, rounded to 1000 for a
 * clean constant. The multiplier leans generous on purpose because this derivation rests on ONE
 * CI job's ONE run — inter-run variance (a different runner instance, a noisier host, cache-cold
 * Chromium) is not something a single run's intra-run p50/p95/max can observe, only intra-run
 * jitter is. If this budget ever flakes on CI, the fix is to look at what THAT run's own
 * `[perf]` log line reports and either confirm a genuine one-off outlier or recompute BUDGET_MS
 * from a wider multi-run sample — never to silently widen it back toward "generous" without
 * that evidence.
 *
 * What this probe CANNOT catch — stated plainly, not hedged, because a green `e2e-web` here
 * must not be mistaken for containment coverage: this probe cannot detect a `CombatantRow`
 * memo-boundary regression, even a total one, at this fixture size. Re-measured specifically
 * against the CORRECTED (in-page, `/turn`-mocked) probe above — the earlier "barely moves it"
 * observation was measured against the harness-latency-dominated version and was retested
 * rather than trusted — stripping `CombatantRow`'s `memo()` wrapper entirely (so all 20 rows
 * re-render on every turn-advance instead of the 2 actually affected) was run locally twice at
 * both SAMPLE_COUNT=20 and SAMPLE_COUNT=50. At n=50:
 *
 *   memoized baseline:   p50=198.9ms  p95=324.6ms  max=338.4ms
 *   memo() stripped:     p50=202.9ms  p95=312.1ms  max=376.1ms
 *
 * The mutated distribution sits INSIDE the memoized baseline's own run-to-run spread — its p95
 * was even lower than the baseline's. Removing harness latency did not surface a signal because
 * there is no signal to surface at this size: a full row-memo-boundary removal is not a large
 * enough cost, against 20 rows and 200 static log lines, to rise above ordinary paint/layout/
 * compositing noise for a page this size. That is a verified property of this probe at this
 * fixture size, not an artifact of measurement technique. Consequently: this budget is a
 * catastrophic-regression backstop ONLY (an accidentally quadratic/exponential effect, a
 * synchronous blocking call, a runaway loop — the kind of defect that turns "a bit slower" into
 * "visibly hung"). Detecting a memo-boundary regression of any single component is entirely the
 * job of the behavioural/source-assertion containment guards (`GridOverlay.memoBoundary.spec.tsx`,
 * `BattleMap.dragContainment.spec.tsx`, `encounter-render-containment.unit.spec.ts`) — this
 * probe cannot do that job, at any budget, at this fixture size.
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

// Multiplier applied to a REAL observed CI p95 on the corrected probe (see file header and PR
// #2165's description for the exact run, samples, and full derivation) — not a round number
// picked for comfort.
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

/**
 * Minimal but schema-valid turn workspace for whichever combatant currently holds the turn
 * (review finding, PR #2165 — see file header). `RunSessionPage` renders a workspace panel off
 * this data, so an ad hoc/invalid shape risks a render error rather than just missing fields;
 * `.parse()` catches that at test-authoring time instead of as a mysterious page-load failure.
 */
function turnWorkspaceFor(combatant: Combatant, encounterId: number): TurnWorkspace {
  return TurnWorkspace.parse({
    encounterId,
    status: 'running',
    round: 1,
    current: {
      combatantId: combatant.id,
      name: combatant.name,
      kind: combatant.kind,
    },
    next: null,
    isYourTurn: true,
    canEndTurn: true,
    dmControlsTurns: false,
    requireDmTurnConfirmation: false,
    actionEconomy: [],
    movement: null,
    reactionAvailable: false,
    concentration: null,
    activeEffects: [],
    suggestedActions: [],
    startPrompts: [],
    endPrompts: [],
    spellSlots: null,
    spells: [],
  });
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
  // Review finding, PR #2165: `RunSessionPage` fetches this whenever the (mocked) encounter
  // reports `status: 'running'`, and re-invalidates it on every `currentCombatantId` change —
  // i.e. on every sampled click below. Unmocked, this hit the real backend for a synthetic
  // combatant id every sample, pulling real network latency into the timed window. Always
  // resolves for whichever combatant `encounter.currentCombatantId` currently names, read live
  // off the same mutable `encounter` the next-turn mock below updates.
  await page.route(new RegExp(`/api/v1/encounters/${encounterId}/turn$`), async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const current = encounter.combatants.find((c) => c.id === encounter.currentCombatantId) ?? combatants[0]!;
    await route.fulfill({ status: 200, contentType: 'application/json', json: turnWorkspaceFor(current, encounterId) });
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

/**
 * Runs SAMPLE_COUNT turn-advance clicks entirely inside the page (review finding, PR #2165 —
 * see file header for why a Node-side version was rejected) and returns each sample's
 * interaction-to-paint duration in milliseconds. This function's body is serialized and
 * executed by `page.evaluate`, so it only has access to the DOM/`performance`/`requestAnimationFrame`
 * globals — no Playwright, no Node.
 */
function sampleTurnAdvancesInPage({
  sampleCount,
  firstId,
  secondId,
}: {
  sampleCount: number;
  firstId: number;
  secondId: number;
}): Promise<number[]> {
  function waitForEnabled(btn: HTMLButtonElement): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!btn.disabled) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
  }

  function waitForAttribute(el: Element, name: string, value: string): Promise<void> {
    return new Promise((resolve) => {
      if (el.getAttribute(name) === value) {
        resolve();
        return;
      }
      const observer = new MutationObserver(() => {
        if (el.getAttribute(name) === value) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(el, { attributes: true, attributeFilter: [name] });
    });
  }

  function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function run(): Promise<number[]> {
    const btn = document.querySelector('[data-testid="encounter-header-next-turn"]');
    if (!(btn instanceof HTMLButtonElement)) throw new Error('next-turn button missing');

    let expectedId = firstId;
    const results: number[] = [];

    for (let sample = 0; sample < sampleCount; sample++) {
      await waitForEnabled(btn);
      expectedId = expectedId === firstId ? secondId : firstId;
      const row = document.querySelector(`[data-testid="combatant-row-${expectedId}"]`);
      if (!row) throw new Error(`combatant-row-${expectedId} missing`);

      const startMark = `cf-turn-advance-start-${sample}`;
      const endMark = `cf-turn-advance-end-${sample}`;

      // Arm the observer BEFORE dispatching the click so no mutation can be missed, then place
      // the start mark and dispatch a real native click — no Playwright actionability checks,
      // no CDP round trip, everything from here to the end mark stays inside the page.
      const landed = waitForAttribute(row, 'data-current-turn', 'true');
      performance.mark(startMark);
      btn.click();
      await landed;

      // Double requestAnimationFrame: the browser guarantees the first callback runs after the
      // frame that committed the DOM change above, and the second guarantees that frame has
      // actually been painted (not just scheduled) — the standard "wait for next paint"
      // technique, so the measured span covers the real interaction-to-paint cost.
      await nextFrame();
      await nextFrame();
      performance.mark(endMark);
      const measure = performance.measure(`cf-turn-advance-${endMark}`, startMark, endMark);
      results.push(measure.duration);
    }

    return results;
  }

  return run();
}

test.describe('encounter turn-advance interaction-to-paint budget (issue #1917 stage 4)', () => {
  test.use({ storageState: stateFor('dm') });

  test.beforeEach(async ({ page }) => {
    await restoreSeedEncounter(page);
  });

  test('advancing the turn with 20 placed tokens and a 200-event combat log paints within budget', async ({ page }) => {
    await openPerfFixture(page);

    // Fixture-readiness check only — outside every measured span, unlike the first cut of this
    // file where a Node-side assertion of the SAME shape sat inside the timed window.
    await expect(page.getByTestId('encounter-header-next-turn')).toBeEnabled();

    const durations = await page.evaluate(sampleTurnAdvancesInPage, {
      sampleCount: SAMPLE_COUNT,
      firstId: FIRST_COMBATANT_ID,
      secondId: SECOND_COMBATANT_ID,
    });

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
