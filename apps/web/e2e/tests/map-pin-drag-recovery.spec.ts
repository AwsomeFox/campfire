import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Location } from '@campfire/schema';
import { seed, stateFor } from './seed';

type PatchCall = {
  locationId: number;
  body: Record<string, unknown>;
};

type PointerOptions = {
  pointerId: number;
  pointerType: 'mouse' | 'pen' | 'touch';
  isPrimary: boolean;
};

/** Tiny 1×1 PNG so RegionMap renders the image-pin drag surface (not the SVG fallback). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function dispatchPointer(
  target: Locator,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture',
  point: { xPct: number; yPct: number },
  options: PointerOptions,
) {
  await target.evaluate(
    (element, event) => {
      const surface = document.querySelector<HTMLElement>('[data-testid="region-map-surface"]');
      if (!surface) throw new Error('Region-map surface is missing');
      const rect = surface.getBoundingClientRect();
      element.dispatchEvent(
        new PointerEvent(event.type, {
          bubbles: true,
          cancelable: true,
          // Resolve viewport coordinates at dispatch time. A mutation may reflow the page between
          // gestures; reusing an earlier bounding box would no longer describe final map coords.
          clientX: rect.left + rect.width * event.xPct,
          clientY: rect.top + rect.height * event.yPct,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary,
          button: 0,
          buttons: event.type === 'pointerup' || event.type === 'pointercancel' ? 0 : 1,
        }),
      );
    },
    { type, ...point, ...options },
  );
}

async function settleNoPatch(page: Page, calls: PatchCall[], expectedCount: number) {
  await page.waitForTimeout(100);
  expect(calls).toHaveLength(expectedCount);
}

async function openPinDragFixture(page: Page) {
  const { campaignId, navigation } = seed();
  const locationId = navigation.locationId;

  // Ensure the campaign has a map image so pins render on the drag surface.
  const upload = await page.request.post(`/api/v1/campaigns/${campaignId}/attachments`, {
    multipart: {
      kind: 'map',
      file: { name: 'world.png', mimeType: 'image/png', buffer: TINY_PNG },
    },
  });
  expect(upload.ok()).toBeTruthy();
  const attachment = (await upload.json()) as { id: number };
  const campaignPatch = await page.request.patch(`/api/v1/campaigns/${campaignId}`, {
    data: { mapAttachmentId: attachment.id },
  });
  expect(campaignPatch.ok()).toBeTruthy();

  const locRes = await page.request.get(`/api/v1/locations/${locationId}`);
  expect(locRes.ok()).toBeTruthy();
  let location: Location = {
    ...((await locRes.json()) as Location),
    mapX: 25,
    mapY: 25,
  };
  const seedPin = await page.request.patch(`/api/v1/locations/${locationId}`, {
    data: { mapX: 25, mapY: 25 },
  });
  expect(seedPin.ok()).toBeTruthy();

  const calls: PatchCall[] = [];

  await page.addInitScript(() => {
    // Synthetic PointerEvents are not registered as active hardware pointers by Chromium, so its
    // native capture methods reject them. The component still receives the exact pointer stream;
    // tests dispatch lostpointercapture explicitly where that browser transition is under test.
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

  await page.route(`**/api/v1/attachments/${attachment.id}/file**`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG }),
  );
  await page.route(`**/api/v1/locations/${locationId}`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', json: location });
      return;
    }
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.push({ locationId, body });
      location = { ...location, ...body } as Location;
      await route.fulfill({ status: 200, contentType: 'application/json', json: location });
      return;
    }
    await route.continue();
  });

  await page.goto(`/c/${campaignId}`);
  const mapCard = page.getByTestId('dashboard-map');
  const surface = page.getByTestId('region-map-surface');
  const pin = page.getByTestId(`map-pin-${locationId}`);
  await expect(mapCard).toBeVisible();
  await expect(surface).toBeVisible();
  await expect(pin).toBeVisible();
  return { surface, pin, calls, locationId, campaignId };
}

test.describe('RegionMap pin drag ownership and cancellation (#808)', () => {
  test.use({ storageState: stateFor('dm') });

  test('normal mouse, stylus, and touch releases commit exactly one final-coordinate PATCH', async ({ page }) => {
    const { pin, calls } = await openPinDragFixture(page);

    const start = { xPct: 0.25, yPct: 0.25 };
    const end = { xPct: 0.7, yPct: 0.6 };
    const mouse = { pointerId: 1, pointerType: 'mouse', isPrimary: true } as const;
    await dispatchPointer(pin, 'pointerdown', start, mouse);
    await dispatchPointer(pin, 'pointermove', end, mouse);
    await dispatchPointer(pin, 'pointerup', end, mouse);
    await dispatchPointer(pin, 'lostpointercapture', end, mouse);
    await dispatchPointer(pin, 'pointerup', end, mouse);
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].body.mapX).toBeCloseTo(70);
    expect(calls[0].body.mapY).toBeCloseTo(60);

    const penStart = { xPct: 0.7, yPct: 0.6 };
    const penEnd = { xPct: 0.4, yPct: 0.35 };
    const pen = { pointerId: 7, pointerType: 'pen', isPrimary: true } as const;
    await dispatchPointer(pin, 'pointerdown', penStart, pen);
    await dispatchPointer(pin, 'pointermove', penEnd, pen);
    await dispatchPointer(pin, 'pointerup', penEnd, pen);
    await dispatchPointer(pin, 'lostpointercapture', penEnd, pen);
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1].body.mapX).toBeCloseTo(40);
    expect(calls[1].body.mapY).toBeCloseTo(35);

    const touchStart = { xPct: 0.4, yPct: 0.35 };
    const touchEnd = { xPct: 0.55, yPct: 0.8 };
    const touch = { pointerId: 12, pointerType: 'touch', isPrimary: true } as const;
    await dispatchPointer(pin, 'pointerdown', touchStart, touch);
    await dispatchPointer(pin, 'pointermove', touchEnd, touch);
    await dispatchPointer(pin, 'pointerup', touchEnd, touch);
    await dispatchPointer(pin, 'lostpointercapture', touchEnd, touch);
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2].body.mapX).toBeCloseTo(55);
    expect(calls[2].body.mapY).toBeCloseTo(80);

    await expect.poll(() => page.evaluate(
      () => (window as unknown as { __releasedPointerIds: number[] }).__releasedPointerIds,
    )).toEqual([1, 7, 12]);
  });

  test('pointer cancellation, premature capture loss, visibility/background, and rotation roll the pin back with zero PATCHes', async ({ page }) => {
    const { surface, pin, calls } = await openPinDragFixture(page);
    const primaryTouch = { pointerId: 21, pointerType: 'touch', isPrimary: true } as const;

    const start = { xPct: 0.25, yPct: 0.25 };
    const end = { xPct: 0.75, yPct: 0.55 };
    await dispatchPointer(pin, 'pointerdown', start, primaryTouch);
    await dispatchPointer(pin, 'pointermove', end, primaryTouch);
    await expect.poll(() => pin.evaluate((element) => (element as HTMLElement).style.left)).not.toBe('25%');
    await dispatchPointer(pin, 'pointercancel', end, primaryTouch);
    await expect.poll(() => pin.evaluate((element) => (element as HTMLElement).style.left)).toBe('25%');
    await expect.poll(() => surface.evaluate((el) => (el as HTMLElement).style.touchAction || '')).toBe('');
    await settleNoPatch(page, calls, 0);

    // Unrelated taps after cancellation must not mutate the location.
    const rogueTap = { pointerId: 99, pointerType: 'touch', isPrimary: true } as const;
    await dispatchPointer(surface, 'pointerdown', end, rogueTap);
    await dispatchPointer(surface, 'pointerup', end, rogueTap);
    await settleNoPatch(page, calls, 0);

    const pen = { pointerId: 22, pointerType: 'pen', isPrimary: true } as const;
    await dispatchPointer(pin, 'pointerdown', start, pen);
    await dispatchPointer(pin, 'pointermove', end, pen);
    await dispatchPointer(pin, 'lostpointercapture', end, pen);
    await expect.poll(() => pin.evaluate((element) => (element as HTMLElement).style.left)).toBe('25%');
    await settleNoPatch(page, calls, 0);

    const hideTouch = { pointerId: 23, pointerType: 'touch', isPrimary: true } as const;
    await dispatchPointer(pin, 'pointerdown', start, hideTouch);
    await dispatchPointer(pin, 'pointermove', end, hideTouch);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => pin.evaluate((element) => (element as HTMLElement).style.left)).toBe('25%');
    await settleNoPatch(page, calls, 0);

    // Resume (visible again) then an unrelated tap still must not save the cancelled drag.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await dispatchPointer(surface, 'pointerup', end, hideTouch);
    await settleNoPatch(page, calls, 0);

    const pageHideTouch = { pointerId: 24, pointerType: 'touch', isPrimary: true } as const;
    await dispatchPointer(pin, 'pointerdown', start, pageHideTouch);
    await dispatchPointer(pin, 'pointermove', end, pageHideTouch);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect.poll(() => pin.evaluate((element) => (element as HTMLElement).style.left)).toBe('25%');
    await settleNoPatch(page, calls, 0);

    const rotateTouch = { pointerId: 25, pointerType: 'touch', isPrimary: true } as const;
    await dispatchPointer(pin, 'pointerdown', start, rotateTouch);
    await dispatchPointer(pin, 'pointermove', end, rotateTouch);
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await expect.poll(() => pin.evaluate((element) => (element as HTMLElement).style.left)).toBe('25%');
    await settleNoPatch(page, calls, 0);
  });

  test('a second touch cannot move or finish a pin drag owned by the first touch', async ({ page }) => {
    const { surface, pin, calls } = await openPinDragFixture(page);
    const owner = { pointerId: 31, pointerType: 'touch', isPrimary: true } as const;
    const second = { pointerId: 32, pointerType: 'touch', isPrimary: false } as const;
    const roguePrimary = { pointerId: 32, pointerType: 'touch', isPrimary: true } as const;

    const start = { xPct: 0.25, yPct: 0.25 };
    const ownerEnd = { xPct: 0.6, yPct: 0.65 };
    const secondEnd = { xPct: 0.9, yPct: 0.9 };
    await dispatchPointer(pin, 'pointerdown', start, owner);
    await dispatchPointer(pin, 'pointermove', ownerEnd, owner);
    await dispatchPointer(surface, 'pointerdown', secondEnd, second);
    await dispatchPointer(surface, 'pointermove', secondEnd, second);
    await dispatchPointer(surface, 'pointerup', secondEnd, second);
    await dispatchPointer(surface, 'pointerup', secondEnd, roguePrimary);
    await settleNoPatch(page, calls, 0);
    // Preview still follows the owning pointer, not the second finger.
    await expect.poll(() => pin.evaluate((element) => (element as HTMLElement).style.left)).toBe('60%');
    await dispatchPointer(pin, 'pointerup', ownerEnd, owner);
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].body.mapX).toBeCloseTo(60);
    expect(calls[0].body.mapY).toBeCloseTo(65);
  });

  test('two-finger input after cancellation leaves the location unmutated', async ({ page }) => {
    const { surface, pin, calls } = await openPinDragFixture(page);
    const first = { pointerId: 41, pointerType: 'touch', isPrimary: true } as const;
    const second = { pointerId: 42, pointerType: 'touch', isPrimary: false } as const;
    const start = { xPct: 0.25, yPct: 0.25 };
    const end = { xPct: 0.8, yPct: 0.7 };

    await dispatchPointer(pin, 'pointerdown', start, first);
    await dispatchPointer(pin, 'pointermove', end, first);
    await dispatchPointer(pin, 'pointercancel', end, first);
    await expect.poll(() => pin.evaluate((element) => (element as HTMLElement).style.left)).toBe('25%');

    await dispatchPointer(surface, 'pointerdown', end, second);
    await dispatchPointer(surface, 'pointermove', { xPct: 0.9, yPct: 0.9 }, second);
    await dispatchPointer(surface, 'pointerup', { xPct: 0.9, yPct: 0.9 }, second);
    await dispatchPointer(pin, 'pointerup', end, first);
    await settleNoPatch(page, calls, 0);
  });

  test('route unmount drops an active pin drag without PATCHing', async ({ page }) => {
    const { pin, calls, campaignId } = await openPinDragFixture(page);
    const touch = { pointerId: 51, pointerType: 'touch', isPrimary: true } as const;
    await dispatchPointer(pin, 'pointerdown', { xPct: 0.25, yPct: 0.25 }, touch);
    await dispatchPointer(pin, 'pointermove', { xPct: 0.75, yPct: 0.65 }, touch);
    await page.goto(`/c/${campaignId}/locations`);
    await settleNoPatch(page, calls, 0);
  });
});
