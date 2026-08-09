import { expect, test, type Locator, type Page } from '@playwright/test';
import type { EncounterWithCombatants, MapPing } from '@campfire/schema';
import { PNG_16_9, seed, stateFor, restoreSeedEncounter } from './seed';
import { MAP_PING_TAP_SLOP_PX } from '../../src/features/encounters/mapPingTap';

/**
 * Issue #809: encounter battle-map ping publishes only after a completed tap.
 * Covers palm/secondary cancel, interrupted taps, drag-away, ordinary mouse/touch,
 * and keyboard / screen-reader activation.
 */

type PointerOptions = {
  pointerId: number;
  pointerType: 'mouse' | 'pen' | 'touch';
  isPrimary: boolean;
};

const MAP_ATTACHMENT_ID = 809_000;

function encounterUrl(): string {
  const { campaignId, encounterId } = seed();
  return `/c/${campaignId}/encounters/${encounterId}`;
}

async function dispatchPointer(
  target: Locator,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture',
  point: { xRatio: number; yRatio: number },
  options: PointerOptions,
  clientOffsetPx = { x: 0, y: 0 },
) {
  await target.evaluate(
    (element, event) => {
      const layer = document.querySelector<HTMLElement>('[data-testid="battle-map-layer"]');
      if (!layer) throw new Error('Battle-map layer is missing');
      const rect = layer.getBoundingClientRect();
      element.dispatchEvent(
        new PointerEvent(event.type, {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width * event.xRatio + event.offsetX,
          clientY: rect.top + rect.height * event.yRatio + event.offsetY,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary,
          button: 0,
          buttons:
            event.type === 'pointerup' ||
            event.type === 'pointercancel' ||
            event.type === 'lostpointercapture'
              ? 0
              : 1,
        }),
      );
    },
    { type, ...point, ...options, offsetX: clientOffsetPx.x, offsetY: clientOffsetPx.y },
  );
}

async function settleNoPing(page: Page, pings: MapPing[], expectedCount: number) {
  await page.waitForTimeout(100);
  expect(pings).toHaveLength(expectedCount);
}

/**
 * Poll until an element's rendered box stops moving/resizing across two reads
 * a beat apart (issue #1954). The fixture's own setup — and, later, a ping's
 * mutation settling — can leave a smooth-scroll (e.g. the initiative strip's
 * current-turn item scrolling itself into view on every re-render) still in
 * flight. A tap dispatched mid-scroll computes its `clientX`/`clientY` from
 * whatever rect is live at that instant, so two events in the same gesture
 * (arm, then release) can disagree about where the surface actually is.
 * Waiting for stability — not just presence — removes the race, the same
 * `expect.poll` idiom `encounter-active-row-scroll.spec.ts` already uses.
 */
async function waitForStableBounds(locator: Locator): Promise<void> {
  let last: { x: number; y: number; width: number; height: number } | null = null;
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        if (!box) return false;
        const stable =
          last != null &&
          Math.abs(box.x - last.x) < 0.1 &&
          Math.abs(box.y - last.y) < 0.1 &&
          Math.abs(box.width - last.width) < 0.1 &&
          Math.abs(box.height - last.height) < 0.1;
        last = box;
        return stable;
      },
      // Explicit, not the library default (issue #1954 review): two reads
      // must land a real beat apart for "stable" to mean anything, and that
      // must not silently change out from under this test on a Playwright
      // upgrade.
      { timeout: 10_000, intervals: [100, 250, 500, 1000] },
    )
    .toBeTruthy();
}

/**
 * Dispatch the arming pointerdown of a tap and, in the same synchronous
 * browser tick, read the surface and map-layer rects it used to compute
 * `clientX`/`clientY` — then derive the map-percent that press should land
 * at from those exact rects (issue #1954). This is the same geometry
 * `pointerToMapPercent` (mapRenderedBounds.ts) resolves against, read
 * straight off the already-rendered layer element (whose CSS box literally
 * *is* the app's current `mapRect`), so the expectation is computed from the
 * same reality the app acted on rather than a hardcoded value that can drift
 * if layout is still settling between when the test aims the tap and when it
 * asserts.
 */
async function dispatchArmingPointerDown(
  target: Locator,
  point: { xRatio: number; yRatio: number },
  options: PointerOptions,
): Promise<{ x: number; y: number }> {
  return target.evaluate(
    (element, event) => {
      const layer = document.querySelector<HTMLElement>('[data-testid="battle-map-layer"]');
      if (!layer) throw new Error('Battle-map layer is missing');
      const layerRect = layer.getBoundingClientRect();
      const clientX = layerRect.left + layerRect.width * event.xRatio;
      const clientY = layerRect.top + layerRect.height * event.yRatio;
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary,
          button: 0,
          buttons: 1,
        }),
      );
      return {
        x: Math.max(0, Math.min(100, ((clientX - layerRect.left) / layerRect.width) * 100)),
        y: Math.max(0, Math.min(100, ((clientY - layerRect.top) / layerRect.height) * 100)),
      };
    },
    {
      xRatio: point.xRatio,
      yRatio: point.yRatio,
      pointerId: options.pointerId,
      pointerType: options.pointerType,
      isPrimary: options.isPrimary,
    },
  );
}

async function openPingFixture(page: Page) {
  const { encounterId } = seed();
  const response = await page.request.get(`/api/v1/encounters/${encounterId}`);
  expect(response.ok()).toBeTruthy();
  const original = (await response.json()) as EncounterWithCombatants;

  const encounter: EncounterWithCombatants = {
    ...original,
    status: 'running',
    mapAttachmentId: MAP_ATTACHMENT_ID,
    gridSize: 10,
    gridScale: 5,
    gridUnit: 'ft',
    gridSnap: false,
    gridType: 'square',
    fog: null,
    aoe: [],
  };
  const pings: MapPing[] = [];

  await page.addInitScript(() => {
    Object.defineProperty(window, '__releasedPointerIds', {
      configurable: true,
      value: [] as number[],
    });
    Object.defineProperties(Element.prototype, {
      setPointerCapture: { configurable: true, value: () => undefined },
      releasePointerCapture: {
        configurable: true,
        value(this: Element, pointerId: number) {
          (window as unknown as { __releasedPointerIds: number[] }).__releasedPointerIds.push(pointerId);
          this.dispatchEvent(new PointerEvent('lostpointercapture', {
            bubbles: true,
            pointerId,
            isPrimary: true,
          }));
        },
      },
      hasPointerCapture: { configurable: true, value: () => true },
    });
  });

  await page.route(`**/api/v1/attachments/${MAP_ATTACHMENT_ID}/file`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_16_9 }),
  );
  await page.route(`**/api/v1/encounters/${encounterId}/map*`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_16_9 }),
  );
  await page.route(`**/api/v1/encounters/${encounterId}`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', json: encounter });
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/v1/encounters/${encounterId}/ping`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as MapPing;
    pings.push(body);
    await route.fulfill({ status: 201, contentType: 'application/json', json: { ok: true } });
  });

  await page.goto(encounterUrl());
  const surface = page.getByTestId('battle-map-surface');
  await expect(surface).toBeVisible();
  const layer = page.getByTestId('battle-map-layer');
  await expect(layer).toBeVisible();
  await expect.poll(async () => {
    const box = await layer.boundingBox();
    return box != null && box.width > 50 && box.height > 50;
  }).toBeTruthy();
  await waitForStableBounds(layer);
  await page.getByRole('button', { name: 'Ping', exact: true }).click();
  await expect(surface).toHaveAttribute('role', 'button');
  // Focusing the tool button can itself retrigger layout (e.g. a live
  // scroll-into-view elsewhere on the page) — settle once more before any
  // test starts aiming taps at this surface (issue #1954).
  await waitForStableBounds(layer);
  return { surface, pings };
}

test.describe('battle-map ping tap completion', () => {
  test.use({ storageState: stateFor('dm') });

  test.beforeEach(async ({ page }) => {
    await restoreSeedEncounter(page);
  });

  test('ordinary mouse and touch taps publish exactly one ping at the press coordinates', async ({ page }) => {
    const { surface, pings } = await openPingFixture(page);

    const mouseSpot = { xRatio: 0.3, yRatio: 0.4 };
    const mouse = { pointerId: 1, pointerType: 'mouse', isPrimary: true } as const;
    const mouseExpected = await dispatchArmingPointerDown(surface, mouseSpot, mouse);
    await settleNoPing(page, pings, 0);
    await dispatchPointer(surface, 'pointerup', mouseSpot, mouse);
    await dispatchPointer(surface, 'lostpointercapture', mouseSpot, mouse);
    await dispatchPointer(surface, 'pointerup', mouseSpot, mouse);
    await expect.poll(() => pings.length).toBe(1);
    // Independent oracle (issue #1954 review): deriving the expectation from
    // the same geometry used to aim the tap made the test self-consistent —
    // a systematic offset in the rendered map layer would shift the derived
    // value and the published ping together, so a `toBeCloseTo(..., 0)` check
    // (±0.5) could still pass at up to ~0.49pp of real drift. Taps are aimed at
    // ratios of the RENDERED MAP LAYER (the cockpit's surface fills the canvas
    // and letterboxes a 16:9 map inside it, so surface ratios are not map
    // percentages), which means the derived value must land within the same
    // precision-1 tolerance as the ping-vs-derived comparison below, or a
    // genuine geometry regression would slip through undetected.
    expect(mouseExpected.x).toBeCloseTo(30, 1);
    expect(mouseExpected.y).toBeCloseTo(40, 1);
    expect(pings[0].x).toBeCloseTo(mouseExpected.x, 1);
    expect(pings[0].y).toBeCloseTo(mouseExpected.y, 1);

    // The first ping's mutation settling re-renders the page and can
    // retrigger layout (issue #1954) — settle again before aiming the next
    // tap so its down/up pair reads a stationary rect throughout.
    await waitForStableBounds(page.getByTestId('battle-map-layer'));

    const touchSpot = { xRatio: 0.7, yRatio: 0.55 };
    const touch = { pointerId: 12, pointerType: 'touch', isPrimary: true } as const;
    const touchExpected = await dispatchArmingPointerDown(surface, touchSpot, touch);
    // Deliberately inside the slop budget with headroom, not sitting on it.
    // `mapPingTapDistancePx` uses Math.hypot and cancels above the threshold, so a
    // release at exactly MAP_PING_TAP_SLOP_PX has zero tolerance for the residual
    // vertical drift waitForStableBounds still permits — sqrt(slop² + dy²) > slop for
    // any dy > 0, which would re-introduce the timeout this spec exists to prevent.
    // The exact boundary is covered by map-ping-tap.unit.spec.ts; here the point is
    // that an ordinary tap with a little movement still publishes.
    await dispatchPointer(surface, 'pointerup', touchSpot, touch, { x: MAP_PING_TAP_SLOP_PX - 4, y: 0 });
    await expect.poll(() => pings.length).toBe(2);
    // Same independent-oracle reasoning as the mouse tap above.
    expect(touchExpected.x).toBeCloseTo(70, 1);
    expect(touchExpected.y).toBeCloseTo(55, 1);
    expect(pings[1].x).toBeCloseTo(touchExpected.x, 1);
    expect(pings[1].y).toBeCloseTo(touchExpected.y, 1);
  });

  test('pointerdown alone never publishes; cancel and capture-loss drop the armed tap', async ({ page }) => {
    const { surface, pings } = await openPingFixture(page);
    const spot = { xRatio: 0.45, yRatio: 0.5 };
    const touch = { pointerId: 21, pointerType: 'touch', isPrimary: true } as const;

    await dispatchPointer(surface, 'pointerdown', spot, touch);
    await settleNoPing(page, pings, 0);

    await dispatchPointer(surface, 'pointercancel', spot, touch);
    await settleNoPing(page, pings, 0);

    const again = { pointerId: 22, pointerType: 'touch', isPrimary: true } as const;
    await dispatchPointer(surface, 'pointerdown', spot, again);
    await dispatchPointer(surface, 'lostpointercapture', spot, again);
    await settleNoPing(page, pings, 0);
    await dispatchPointer(surface, 'pointerup', spot, again);
    await settleNoPing(page, pings, 0);
  });

  test('drag-away past tap slop cancels without publishing', async ({ page }) => {
    const { surface, pings } = await openPingFixture(page);
    const start = { xRatio: 0.4, yRatio: 0.4 };
    const touch = { pointerId: 31, pointerType: 'touch', isPrimary: true } as const;

    await dispatchPointer(surface, 'pointerdown', start, touch);
    await dispatchPointer(surface, 'pointermove', start, touch, { x: MAP_PING_TAP_SLOP_PX + 2, y: 0 });
    await dispatchPointer(surface, 'pointerup', start, touch, { x: MAP_PING_TAP_SLOP_PX + 2, y: 0 });
    await settleNoPing(page, pings, 0);
  });

  test('palm / secondary touch cancels an armed ping and never publishes either contact', async ({ page }) => {
    const { surface, pings } = await openPingFixture(page);
    const owner = { pointerId: 41, pointerType: 'touch', isPrimary: true } as const;
    const palm = { pointerId: 42, pointerType: 'touch', isPrimary: false } as const;
    const start = { xRatio: 0.35, yRatio: 0.35 };
    const palmSpot = { xRatio: 0.8, yRatio: 0.8 };

    await dispatchPointer(surface, 'pointerdown', start, owner);
    await dispatchPointer(surface, 'pointerdown', palmSpot, palm);
    await dispatchPointer(surface, 'pointerup', palmSpot, palm);
    await dispatchPointer(surface, 'pointerup', start, owner);
    await settleNoPing(page, pings, 0);

    // A lone secondary contact never arms a ping either.
    await dispatchPointer(surface, 'pointerdown', palmSpot, palm);
    await dispatchPointer(surface, 'pointerup', palmSpot, palm);
    await settleNoPing(page, pings, 0);
  });

  test('keyboard / screen-reader activation publishes one center ping', async ({ page }) => {
    const { surface, pings } = await openPingFixture(page);

    await surface.focus();
    await expect(surface).toBeFocused();
    // Issue #2047 widened this label to advertise the Shift+Enter intent-menu path, since a
    // keyboard user has no other way to discover it. Kept as an exact-string assertion
    // rather than relaxed to `toContain` — the whole point of asserting the label is that a
    // screen-reader user hears a specific, complete sentence, and a substring check would
    // stop noticing if the rest of it were dropped.
    await expect(surface).toHaveAttribute(
      'aria-label',
      'Ping the map center for everyone. Shift+Enter opens the Look, Danger, or Move here menu. Viewport: +/− to zoom, 0 to reset, arrow keys to pan when zoomed.',
    );
    await page.keyboard.press('Enter');
    await expect.poll(() => pings.length).toBe(1);
    expect(pings[0].x).toBe(50);
    expect(pings[0].y).toBe(50);

    await page.keyboard.press('Space');
    await expect.poll(() => pings.length).toBe(2);
    expect(pings[1].x).toBe(50);
    expect(pings[1].y).toBe(50);
  });

  test('held Enter/Space key-repeat does not spam additional center pings', async ({ page }) => {
    const { surface, pings } = await openPingFixture(page);

    await surface.focus();
    await surface.evaluate((element) => {
      for (const key of ['Enter', ' '] as const) {
        element.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, repeat: false }),
        );
        element.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, repeat: true }),
        );
        element.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, repeat: true }),
        );
      }
    });

    await expect.poll(() => pings.length).toBe(2);
    expect(pings.every((ping) => ping.x === 50 && ping.y === 50)).toBe(true);
    await page.waitForTimeout(100);
    expect(pings).toHaveLength(2);
  });
});
