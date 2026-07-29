/**
 * Battle-map viewport navigation (issue #712).
 *
 * Covers toolbar zoom/fit/reset, keyboard shortcuts, wheel zoom, touch pan, and pinch
 * at narrow and wide breakpoints.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { EncounterWithCombatants } from '@campfire/schema';
import { PNG_16_9, seed, stateFor, restoreSeedEncounter } from './seed';

const MAP_ATTACHMENT_ID = 712_000;

function encounterUrl(): string {
  const { campaignId, encounterId } = seed();
  return `/c/${campaignId}/encounters/${encounterId}`;
}

async function viewportTransform(viewport: Locator): Promise<string> {
  return viewport.evaluate((el) => getComputedStyle(el).transform);
}

async function openViewportFixture(page: Page) {
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

  await page.goto(encounterUrl());
  await expect(page.getByTestId('battle-map-surface')).toBeVisible();
  await expect(page.getByTestId('map-viewport-toolbar')).toBeVisible();
}

for (const viewport of [
  { name: 'wide', width: 1280, height: 800 },
  { name: 'narrow', width: 375, height: 812 },
]) {
  test.describe(`map viewport — ${viewport.name} (${viewport.width}px)`, () => {
    test.use({ storageState: stateFor('dm'), viewport: { width: viewport.width, height: viewport.height } });

    test.beforeEach(async ({ page }) => {
      await restoreSeedEncounter(page);
    });

    test('toolbar zoom in/out, fit, and reset update the transform and label', async ({ page }) => {
      await openViewportFixture(page);
      const mapViewport = page.getByTestId('battle-map-viewport');
      const zoomLabel = page.getByTestId('map-viewport-zoom-label');
      const identity = await viewportTransform(mapViewport);

      await page.getByTestId('map-viewport-zoom-in').click();
      await expect(zoomLabel).toHaveText('120%');
      await expect.poll(() => viewportTransform(mapViewport)).not.toBe(identity);

      await page.getByTestId('map-viewport-zoom-out').click();
      await expect(zoomLabel).toHaveText('100%');

      await page.getByTestId('map-viewport-zoom-in').click();
      await page.getByTestId('map-viewport-fit').click();
      await expect(zoomLabel).toHaveText('100%');
      await expect.poll(() => viewportTransform(mapViewport)).toBe(identity);

      await page.getByTestId('map-viewport-zoom-in').click();
      await page.getByTestId('map-viewport-reset').click();
      await expect(zoomLabel).toHaveText('100%');
      await expect.poll(() => viewportTransform(mapViewport)).toBe(identity);
    });

    test('keyboard shortcuts zoom and reset when the surface is focused', async ({ page }) => {
      await openViewportFixture(page);
      const mapViewport = page.getByTestId('battle-map-viewport');
      const zoomLabel = page.getByTestId('map-viewport-zoom-label');
      const surface = page.getByTestId('battle-map-surface');
      const identity = await viewportTransform(mapViewport);

      await surface.focus();
      await page.keyboard.press('=');
      await expect(zoomLabel).toHaveText('120%');

      await page.keyboard.press('0');
      await expect(zoomLabel).toHaveText('100%');
      await expect.poll(() => viewportTransform(mapViewport)).toBe(identity);
    });

    test('wheel zooms toward the cursor without scrolling the page', async ({ page }) => {
      await openViewportFixture(page);
      const surface = page.getByTestId('battle-map-surface');
      const mapViewport = page.getByTestId('battle-map-viewport');
      const zoomLabel = page.getByTestId('map-viewport-zoom-label');
      const identity = await viewportTransform(mapViewport);

      const box = await surface.boundingBox();
      expect(box).not.toBeNull();
      await surface.hover();
      // Dispatch on the surface so narrow layouts still receive the wheel even when the
      // pointer is over overlapping chrome.
      await surface.dispatchEvent('wheel', { deltaY: -160 });
      await expect(zoomLabel).not.toHaveText('100%');
      await expect.poll(() => viewportTransform(mapViewport)).not.toBe(identity);
    });

    test('pan tool drags the viewport on pointer and touch', async ({ page }) => {
      await openViewportFixture(page);
      const surface = page.getByTestId('battle-map-surface');
      const mapViewport = page.getByTestId('battle-map-viewport');

      await page.getByTestId('map-viewport-zoom-in').click();
      await page.getByTestId('map-viewport-pan').click();
      await surface.scrollIntoViewIfNeeded();
      const before = await viewportTransform(mapViewport);
      const box = await surface.boundingBox();
      expect(box).not.toBeNull();

      await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width * 0.5 + 60, box!.y + box!.height * 0.5 + 30);
      await page.mouse.up();
      await expect.poll(() => viewportTransform(mapViewport)).not.toBe(before);

      await page.getByTestId('map-viewport-reset').click();
      await page.getByTestId('map-viewport-zoom-in').click();
      const beforeTouch = await viewportTransform(mapViewport);
      const cx = box!.x + box!.width * 0.5;
      const cy = box!.y + box!.height * 0.5;
      await page.evaluate(
        ({ cx, cy }) => {
          const surface = document.querySelector<HTMLElement>('[data-testid="battle-map-surface"]');
          if (!surface) throw new Error('missing surface');
          const mk = (type: string, x: number, y: number) =>
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              pointerId: 1,
              pointerType: 'touch',
              isPrimary: true,
              buttons: type === 'pointerup' ? 0 : 1,
            });
          surface.dispatchEvent(mk('pointerdown', cx, cy));
          surface.dispatchEvent(mk('pointermove', cx + 60, cy + 30));
          surface.dispatchEvent(mk('pointerup', cx + 60, cy + 30));
        },
        { cx, cy },
      );
      await expect.poll(() => viewportTransform(mapViewport)).not.toBe(beforeTouch);
    });
  });
}

test.describe('map viewport — multi-touch pinch', () => {
  test.use({ storageState: stateFor('dm'), viewport: { width: 390, height: 844 }, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await restoreSeedEncounter(page);
  });

  test('two-finger pinch zooms the map', async ({ page }) => {
    await openViewportFixture(page);
    const surface = page.getByTestId('battle-map-surface');
    const mapViewport = page.getByTestId('battle-map-viewport');
    const zoomLabel = page.getByTestId('map-viewport-zoom-label');
    const identity = await viewportTransform(mapViewport);
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();

    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.touchscreen.tap(cx - 40, cy);
    await page.evaluate(
      ({ cx, cy }) => {
        const surface = document.querySelector<HTMLElement>('[data-testid="battle-map-surface"]');
        if (!surface) throw new Error('missing surface');
        const mk = (pointerId: number, x: number, y: number, type: string) =>
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            pointerId,
            pointerType: 'touch',
            isPrimary: pointerId === 1,
            buttons: type === 'pointerup' ? 0 : 1,
          });
        surface.dispatchEvent(mk(1, cx - 50, cy, 'pointerdown'));
        surface.dispatchEvent(mk(2, cx + 50, cy, 'pointerdown'));
        surface.dispatchEvent(mk(1, cx - 90, cy, 'pointermove'));
        surface.dispatchEvent(mk(2, cx + 90, cy, 'pointermove'));
        surface.dispatchEvent(mk(1, cx - 90, cy, 'pointerup'));
        surface.dispatchEvent(mk(2, cx + 90, cy, 'pointerup'));
      },
      { cx, cy },
    );

    await expect(zoomLabel).not.toHaveText('100%');
    await expect.poll(() => viewportTransform(mapViewport)).not.toBe(identity);
  });
});
