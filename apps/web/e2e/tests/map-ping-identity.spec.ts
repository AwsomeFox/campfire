import { expect, test, type Locator, type Page } from '@playwright/test';
import type { EncounterWithCombatants, MapPing } from '@campfire/schema';
import { PNG_16_9, seed, stateFor, restoreSeedEncounter } from './seed';
import { MAP_PING_TAP_MAX_MS } from '../../src/features/encounters/mapPingTap';

/**
 * Issue #1937: per-user ping color identity + long-press/right-click intent menu.
 *
 * Send-side coverage follows the exact fixture convention `map-ping-tap.spec.ts`
 * (issue #809) established: mock the seeded encounter's GET and intercept the
 * `POST .../ping` route to capture exactly what the client sent, rather than
 * asserting on the rendered marker DOM (this suite has never asserted the ping
 * marker's visual appearance — only its published payload — and this file keeps
 * that boundary). `mapPingTap.ts` itself and its own unit tests are untouched;
 * this file only exercises the NEW long-press/right-click wiring in BattleMap.tsx.
 */

type PointerOptions = {
  pointerId: number;
  pointerType: 'mouse' | 'pen' | 'touch';
  isPrimary: boolean;
};

const MAP_ATTACHMENT_ID = 1_937_000;

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
  button: 0 | 2 = 0,
) {
  await target.evaluate(
    (element, event) => {
      const surface = document.querySelector<HTMLElement>('[data-testid="battle-map-surface"]');
      if (!surface) throw new Error('Battle-map surface is missing');
      const rect = surface.getBoundingClientRect();
      element.dispatchEvent(
        new PointerEvent(event.type, {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width * event.xRatio + event.offsetX,
          clientY: rect.top + rect.height * event.yRatio + event.offsetY,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary,
          button: event.button,
          buttons:
            event.type === 'pointerup' ||
            event.type === 'pointercancel' ||
            event.type === 'lostpointercapture'
              ? 0
              : event.button === 2
                ? 2
                : 1,
        }),
      );
    },
    { type, ...point, ...options, offsetX: clientOffsetPx.x, offsetY: clientOffsetPx.y, button },
  );
}

async function dispatchContextMenu(target: Locator, point: { xRatio: number; yRatio: number }) {
  await target.evaluate(
    (element, event) => {
      const surface = document.querySelector<HTMLElement>('[data-testid="battle-map-surface"]');
      if (!surface) throw new Error('Battle-map surface is missing');
      const rect = surface.getBoundingClientRect();
      element.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width * event.xRatio,
          clientY: rect.top + rect.height * event.yRatio,
          button: 2,
        }),
      );
    },
    point,
  );
}

/**
 * A real right-click's full event sequence — pointerdown(button=2) then contextmenu
 * then pointerup(button=2) — at the same point, matching a real browser (issue #1937):
 * the secondary button must never arm a plain-tap ping gesture, only the dedicated
 * contextmenu handler may open the intent menu.
 */
async function rightClickAt(target: Locator, point: { xRatio: number; yRatio: number }, pointerId: number) {
  const mouse = { pointerId, pointerType: 'mouse', isPrimary: true } as const;
  await dispatchPointer(target, 'pointerdown', point, mouse, { x: 0, y: 0 }, 2);
  await dispatchContextMenu(target, point);
  await dispatchPointer(target, 'pointerup', point, mouse, { x: 0, y: 0 }, 2);
}

async function settleNoPing(page: Page, pings: MapPing[], expectedCount: number) {
  await page.waitForTimeout(100);
  expect(pings).toHaveLength(expectedCount);
}

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
      { timeout: 10_000, intervals: [100, 250, 500, 1000] },
    )
    .toBeTruthy();
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
  await waitForStableBounds(layer);
  // The intent menu renders `position: fixed` at the pointer's own clientX/clientY
  // (issue #1937), so — unlike a synthetic dispatchPointer tap, which never needs
  // the point to be on-screen — a REAL Playwright .click() on a menu item needs
  // that anchor point to actually be within the viewport. The surface commonly
  // sits partly below the fold at the default 1280x720 viewport, so bring it
  // fully into view once, up front, for every test in this file.
  await surface.scrollIntoViewIfNeeded();
  await waitForStableBounds(layer);
  return { surface, pings };
}

test.describe('battle-map ping identity + intent menu (issue #1937)', () => {
  test.use({ storageState: stateFor('dm') });

  test.beforeEach(async ({ page }) => {
    await restoreSeedEncounter(page);
  });

  test('a plain tap keeps sending label: null, and now also sends a non-null hashed color', async ({ page }) => {
    const { surface, pings } = await openPingFixture(page);
    const spot = { xRatio: 0.3, yRatio: 0.4 };
    const mouse = { pointerId: 1, pointerType: 'mouse', isPrimary: true } as const;

    await dispatchPointer(surface, 'pointerdown', spot, mouse);
    await dispatchPointer(surface, 'pointerup', spot, mouse);
    await expect.poll(() => pings.length).toBe(1);
    expect(pings[0].label).toBeNull();
    expect(typeof pings[0].color).toBe('string');
    expect(pings[0].color).toMatch(/^#[0-9a-f]{6}$/i);
    // senderId/senderName are never client-set — the server stamps them (issue #869/#1636).
    expect(pings[0].senderId).toBeNull();
    expect(pings[0].senderName).toBeNull();
  });

  test('a hold past the tap window opens the intent menu instead of publishing; choosing Danger sends a labeled ping', async ({ page }) => {
    const { surface, pings } = await openPingFixture(page);
    const spot = { xRatio: 0.4, yRatio: 0.5 };
    const touch = { pointerId: 51, pointerType: 'touch', isPrimary: true } as const;

    await dispatchPointer(surface, 'pointerdown', spot, touch);
    // Nothing sent, and nothing menu-visible, until the tap window elapses.
    await settleNoPing(page, pings, 0);
    await expect(page.getByTestId('map-ping-intent-menu')).toHaveCount(0);

    await page.waitForTimeout(MAP_PING_TAP_MAX_MS + 150);
    const menu = page.getByTestId('map-ping-intent-menu');
    await expect(menu).toBeVisible();
    // The held pointer never also published a plain ping once the menu opened.
    expect(pings).toHaveLength(0);

    await page.getByTestId('map-ping-intent-danger').click();
    await expect.poll(() => pings.length).toBe(1);
    expect(pings[0].label).toBe('Danger');
    expect(typeof pings[0].color).toBe('string');
    await expect(menu).toHaveCount(0);

    // The pointer that was still down when the menu opened does not leave a stray
    // armed gesture behind — releasing it now publishes nothing further.
    await dispatchPointer(surface, 'pointerup', spot, touch);
    await settleNoPing(page, pings, 1);
  });

  test('right-click opens the intent menu directly; choosing Look sends a labeled ping', async ({ page }) => {
    const { surface, pings } = await openPingFixture(page);
    const spot = { xRatio: 0.2, yRatio: 0.6 };

    await rightClickAt(surface, spot, 101);
    const menu = page.getByTestId('map-ping-intent-menu');
    await expect(menu).toBeVisible();
    expect(pings).toHaveLength(0);

    await page.getByTestId('map-ping-intent-look').click();
    await expect.poll(() => pings.length).toBe(1);
    expect(pings[0].label).toBe('Look');
  });

  test('right-click never also arms a plain-tap ping — the button-2 pointerdown/up around it publishes nothing', async ({ page }) => {
    const { surface, pings } = await openPingFixture(page);
    const spot = { xRatio: 0.5, yRatio: 0.5 };

    // Full real-browser sequence: pointerdown(button=2) -> contextmenu -> pointerup(button=2).
    // If the secondary button ever armed a tap gesture, this pointerup would decide
    // publish/cancel through decideMapPingTapRelease and could send an unintended ping.
    await rightClickAt(surface, spot, 102);
    await expect(page.getByTestId('map-ping-intent-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('map-ping-intent-menu')).toHaveCount(0);
    // Nothing published by the pointerdown/up around the right-click, or by opening/dismissing the menu.
    await settleNoPing(page, pings, 0);
  });

  test('button-2 pointerdown/up alone (no contextmenu in between) still never publishes a ping', async ({ page }) => {
    // Isolates the pointerdown-side guard from onSurfaceContextMenu's own defensive
    // cancelActiveGesture() call: some environments could suppress or delay the native
    // contextmenu event after a right-button press, so the tap-arming logic itself must
    // never treat the secondary button as a candidate tap — independent of whether a
    // contextmenu event ever arrives.
    const { surface, pings } = await openPingFixture(page);
    const spot = { xRatio: 0.5, yRatio: 0.5 };
    const mouse = { pointerId: 103, pointerType: 'mouse', isPrimary: true } as const;

    await dispatchPointer(surface, 'pointerdown', spot, mouse, { x: 0, y: 0 }, 2);
    await dispatchPointer(surface, 'pointerup', spot, mouse, { x: 0, y: 0 }, 2);
    await expect(page.getByTestId('map-ping-intent-menu')).toHaveCount(0);
    await settleNoPing(page, pings, 0);
  });

  test('Escape dismisses the intent menu without sending a ping', async ({ page }) => {
    const { surface, pings } = await openPingFixture(page);
    const spot = { xRatio: 0.35, yRatio: 0.35 };
    const touch = { pointerId: 61, pointerType: 'touch', isPrimary: true } as const;

    await dispatchPointer(surface, 'pointerdown', spot, touch);
    await page.waitForTimeout(MAP_PING_TAP_MAX_MS + 150);
    await expect(page.getByTestId('map-ping-intent-menu')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('map-ping-intent-menu')).toHaveCount(0);
    await settleNoPing(page, pings, 0);
  });

  test('an outside pointerdown dismisses the intent menu without sending a ping', async ({ page }) => {
    const { surface, pings } = await openPingFixture(page);
    const spot = { xRatio: 0.35, yRatio: 0.35 };
    const touch = { pointerId: 71, pointerType: 'touch', isPrimary: true } as const;

    await dispatchPointer(surface, 'pointerdown', spot, touch);
    await page.waitForTimeout(MAP_PING_TAP_MAX_MS + 150);
    await expect(page.getByTestId('map-ping-intent-menu')).toBeVisible();

    // A pointerdown far outside the surface and the menu itself.
    await page.mouse.click(2, 2);
    await expect(page.getByTestId('map-ping-intent-menu')).toHaveCount(0);
    await settleNoPing(page, pings, 0);
  });
});
