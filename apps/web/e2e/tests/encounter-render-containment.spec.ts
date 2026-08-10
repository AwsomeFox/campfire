import { expect, test, type Page } from '@playwright/test';
import type { Combatant, EncounterWithCombatants } from '@campfire/schema';
import { PNG_16_9, seed, stateFor, restoreSeedEncounter } from './seed';

/**
 * Browser DOM-stability probes (issue #1917 stages 1-2). A MutationObserver watches real DOM
 * mutations on the grid-overlay subtree during an HP change and a token drag, and asserts
 * zero — a real invariant worth pinning on its own (a user-visible flicker or unwanted
 * reconciliation would show up here).
 *
 * IMPORTANT — corrected per issue #2079's measurement, do not revert this framing: these two
 * probes do NOT prove a memo boundary works, and must never be cited as if they do. On both
 * interactions scripted below, none of `GridOverlay`'s own prop VALUES change, so a memoized
 * render (skipped entirely) and an unmemoized render (runs, reconciles, produces
 * byte-identical DOM because React only touches the DOM when a value actually differs) commit
 * the exact same DOM either way. A MutationObserver watches the DOM, so it structurally cannot
 * tell those two cases apart — #2079 measured, by hand, that both probes below stay green with
 * `memo()` removed from `GridOverlay` entirely. The unit-tier source assertion
 * (`encounter-render-containment.unit.spec.ts`) catches `memo()` being deleted from the
 * source, but is equally blind to `memo()` staying in the source while failing to actually
 * bail on an unstable prop — which is exactly what shipped on `main` for the whole life of PR
 * #2078, fixed only in the #2083 follow-up. The one guard that actually exercises what a memo
 * boundary controls (render-function invocation, not DOM output) is the component-tier
 * behavioural test in `apps/web/test/component/GridOverlay.memoBoundary.spec.tsx` — see its
 * header for the full explanation and for `BattleMap.dragContainment.spec.tsx`'s stage-3
 * equivalent.
 */

const MAP_ATTACHMENT_ID = 1_917_000;

function encounterUrl(): string {
  const { campaignId, encounterId } = seed();
  return `/c/${campaignId}/encounters/${encounterId}`;
}

type Fixture = {
  page: Page;
  encounterId: number;
  firstId: number;
  secondId: number;
};

/**
 * A running encounter with a map, a calibrated grid (caller picks square or hex), and at
 * least two placed combatants with concrete HP — the minimum needed to (a) render the grid
 * overlay and token layer, and (b) apply an HP delta to one combatant without touching the
 * other. Mirrors `map-gesture-cancellation.spec.ts`'s `openGestureFixture` fixture shape.
 */
async function openContainmentFixture(page: Page, gridType: 'square' | 'hex'): Promise<Fixture> {
  const { encounterId } = seed();
  const response = await page.request.get(`/api/v1/encounters/${encounterId}`);
  expect(response.ok()).toBeTruthy();
  const original = (await response.json()) as EncounterWithCombatants;
  if (original.combatants.length < 2) throw new Error('The seeded encounter needs at least two combatants');
  const firstId = original.combatants[0]!.id;
  const secondId = original.combatants[1]!.id;

  let encounter: EncounterWithCombatants = {
    ...original,
    status: 'running',
    mapAttachmentId: MAP_ATTACHMENT_ID,
    gridSize: 10,
    gridScale: 5,
    gridUnit: 'ft',
    gridSnap: false,
    gridType,
    hexOrientation: 'pointy',
    fog: { enabled: false, revealed: [] },
    combatants: original.combatants.map((combatant, index) =>
      index === 0
        ? { ...combatant, tokenX: 25, tokenY: 25, tokenSize: 'medium' as const, hpCurrent: 20, hpMax: 20, hpTemp: 0 }
        : index === 1
          ? { ...combatant, tokenX: 65, tokenY: 60, tokenSize: 'medium' as const, hpCurrent: 15, hpMax: 15, hpTemp: 0 }
          : combatant,
    ),
  };

  await page.route(`**/api/v1/attachments/${MAP_ATTACHMENT_ID}/file`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_16_9 }),
  );
  await page.route(`**/api/v1/encounters/${encounterId}/map*`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_16_9 }),
  );
  await page.route(new RegExp(`/api/v1/encounters/${encounterId}$`), async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', json: encounter });
      return;
    }
    await route.continue();
  });
  await page.route(new RegExp(`/api/v1/encounters/${encounterId}/combatants/\\d+$`), async (route) => {
    const request = route.request();
    if (request.method() !== 'PATCH') {
      await route.continue();
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown> & { hpDelta?: number };
    const combatantId = Number(new URL(request.url()).pathname.split('/').at(-1));
    let updated: Combatant | undefined;
    encounter = {
      ...encounter,
      combatants: encounter.combatants.map((combatant) => {
        if (combatant.id !== combatantId) return combatant;
        // `hpDelta` (issue #1917 fixture fix): the real server applies this delta to
        // `hpCurrent` rather than accepting a `hpCurrent` field directly — mirror that here
        // or the mocked PATCH response silently reverts the optimistic HP change on the
        // invalidate-triggered refetch that follows every successful mutation.
        const { hpDelta, ...rest } = body;
        updated = {
          ...combatant,
          ...rest,
          ...(hpDelta != null && combatant.hpCurrent != null ? { hpCurrent: combatant.hpCurrent + hpDelta } : {}),
        } as Combatant;
        return updated;
      }),
    };
    await route.fulfill({ status: 200, contentType: 'application/json', json: updated });
  });

  await page.goto(encounterUrl());
  const layer = page.getByTestId('battle-map-layer');
  await expect(layer).toBeVisible();
  await expect.poll(async () => {
    const box = await layer.boundingBox();
    return box != null && box.width > 50 && box.height > 50;
  }).toBeTruthy();

  return { page, encounterId, firstId, secondId };
}

/** Installs a MutationObserver on `testId`'s subtree and returns a getter for its record count. */
async function observeMutations(page: Page, testId: string): Promise<() => Promise<number>> {
  await page.evaluate((id) => {
    const target = document.querySelector(`[data-testid="${id}"]`);
    if (!target) throw new Error(`observeMutations: no element with data-testid="${id}"`);
    const w = window as unknown as { __mutationCounts?: Record<string, number> };
    w.__mutationCounts ??= {};
    w.__mutationCounts[id] = 0;
    const observer = new MutationObserver((records) => {
      w.__mutationCounts![id] += records.length;
    });
    observer.observe(target, { childList: true, attributes: true, characterData: true, subtree: true });
  }, testId);
  return () =>
    page.evaluate((id) => (window as unknown as { __mutationCounts?: Record<string, number> }).__mutationCounts?.[id] ?? 0, testId);
}

test.describe('encounter render containment (issue #1917 stages 1-2)', () => {
  test.use({ storageState: stateFor('dm') });

  test.beforeEach(async ({ page }) => {
    await restoreSeedEncounter(page);
  });

  test('an HP change to one combatant records zero mutations in the grid-overlay SVG subtree', async ({ page }) => {
    const { firstId, secondId } = await openContainmentFixture(page, 'square');
    const grid = page.getByTestId('battle-map-grid');
    await expect(grid).toBeVisible();

    const getMutationCount = await observeMutations(page, 'battle-map-grid');

    // Increase the SECOND combatant's HP by 1 — a real user interaction (the row's +1
    // stepper), not a direct API call, so it exercises the same render path a player's
    // click does, optimistic update included.
    const row = page.getByTestId(`combatant-row-${secondId}`);
    await row.getByRole('button', { name: /^Increase .* HP by 1 /, exact: false }).click();

    // The optimistic update lands synchronously (`onMutate` calls `setQueryData` before
    // the mocked PATCH round-trips), so the row's own HP text is the signal that the
    // relevant re-render has already happened before we read the observer's tally.
    await expect(row.getByText('16 / 15')).toBeVisible();

    expect(await getMutationCount()).toBe(0);
    // Sanity: the OTHER row (whose HP did not change) must still show its original value —
    // confirms this really was a scoped HP change, not a fixture bug that happened to
    // leave the grid alone for an unrelated reason.
    await expect(page.getByTestId(`combatant-row-${firstId}`).getByText('20 / 20')).toBeVisible();
  });

  test('a scripted token drag leaves the hex grid polygons untouched', async ({ page }) => {
    const { firstId } = await openContainmentFixture(page, 'hex');
    const grid = page.getByTestId('battle-map-grid-hex');
    await expect(grid).toBeVisible();
    const polygonCountBefore = await grid.locator('polygon').count();
    expect(polygonCountBefore).toBeGreaterThan(0);

    const getMutationCount = await observeMutations(page, 'battle-map-grid-hex');
    // Sanity control: also observe the dragged token's OWN layer. If the observer
    // mechanism itself were broken (never armed, wrong selector, etc.), grid mutations
    // would read zero for the wrong reason. The dragged token moving is the one thing in
    // this scenario that MUST mutate, so a nonzero count here is the proof the harness
    // is capturing real DOM churn, not silently observing nothing.
    const tokenLayerCount = await observeMutations(page, 'battle-map-layer');

    const token = page.getByTestId(`map-token-${firstId}`);
    const surface = page.getByTestId('battle-map-surface');
    await surface.evaluate(() => undefined); // ensure surface is attached before bounding-box reads in dispatch
    const mouse = { pointerId: 1, pointerType: 'mouse', isPrimary: true } as const;
    const dispatch = async (type: 'pointerdown' | 'pointermove' | 'pointerup', xPct: number, yPct: number) => {
      await token.evaluate(
        (element, event) => {
          const surfaceEl = document.querySelector<HTMLElement>('[data-testid="battle-map-surface"]');
          if (!surfaceEl) throw new Error('Battle-map surface is missing');
          const rect = surfaceEl.getBoundingClientRect();
          element.dispatchEvent(
            new PointerEvent(event.type, {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + rect.width * event.xPct,
              clientY: rect.top + rect.height * event.yPct,
              pointerId: event.pointerId,
              pointerType: event.pointerType,
              isPrimary: event.isPrimary,
              button: 0,
              buttons: event.type === 'pointerup' ? 0 : 1,
            }),
          );
        },
        { type, xPct, yPct, ...mouse },
      );
    };

    await dispatch('pointerdown', 0.25, 0.25);
    await dispatch('pointermove', 0.3, 0.28);
    await dispatch('pointermove', 0.35, 0.32);
    await dispatch('pointermove', 0.4, 0.36);
    await dispatch('pointerup', 0.4, 0.36);

    expect(await getMutationCount()).toBe(0);
    const polygonCountAfter = await grid.locator('polygon').count();
    expect(polygonCountAfter).toBe(polygonCountBefore);
    // Sanity control (see comment above `tokenLayerCount`): the dragged token itself DID
    // move, so the wider layer must show a nonzero mutation count — proof this is a real
    // "grid stayed still while its neighbour moved" result, not an inert observer.
    expect(await tokenLayerCount()).toBeGreaterThan(0);
  });
});
