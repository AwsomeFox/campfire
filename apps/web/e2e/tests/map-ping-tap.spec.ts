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
  await page.getByRole('button', { name: 'Ping', exact: true }).click();
  await expect(surface).toHaveAttribute('role', 'button');
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
    await dispatchPointer(surface, 'pointerdown', mouseSpot, mouse);
    await settleNoPing(page, pings, 0);
    await dispatchPointer(surface, 'pointerup', mouseSpot, mouse);
    await dispatchPointer(surface, 'lostpointercapture', mouseSpot, mouse);
    await dispatchPointer(surface, 'pointerup', mouseSpot, mouse);
    await expect.poll(() => pings.length).toBe(1);
    expect(pings[0].x).toBeCloseTo(30, 1);
    expect(pings[0].y).toBeCloseTo(40, 1);

    const touchSpot = { xRatio: 0.7, yRatio: 0.55 };
    const touch = { pointerId: 12, pointerType: 'touch', isPrimary: true } as const;
    await dispatchPointer(surface, 'pointerdown', touchSpot, touch);
    await dispatchPointer(surface, 'pointerup', touchSpot, touch, { x: MAP_PING_TAP_SLOP_PX, y: 0 });
    await expect.poll(() => pings.length).toBe(2);
    expect(pings[1].x).toBeCloseTo(70, 1);
    expect(pings[1].y).toBeCloseTo(55, 1);
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
    await expect(surface).toHaveAttribute('aria-label', 'Ping the map center for everyone');
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
