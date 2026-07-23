import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Combatant, EncounterWithCombatants } from '@campfire/schema';
import { PNG_16_9, seed, stateFor, restoreSeedEncounter } from './seed';

type PatchCall = {
  target: 'encounter' | 'combatant';
  body: Record<string, unknown>;
};

type PointerOptions = {
  pointerId: number;
  pointerType: 'mouse' | 'pen' | 'touch';
  isPrimary: boolean;
};

const MAP_ATTACHMENT_ID = 811_000;
const AOE_ID = 'gesture-test-aoe';

function encounterUrl(): string {
  const { campaignId, encounterId } = seed();
  return `/c/${campaignId}/encounters/${encounterId}`;
}

async function dispatchPointer(
  target: Locator,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture',
  point: { xPct: number; yPct: number },
  options: PointerOptions,
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

async function openGestureFixture(page: Page) {
  const { encounterId } = seed();
  const response = await page.request.get(`/api/v1/encounters/${encounterId}`);
  expect(response.ok()).toBeTruthy();
  const original = (await response.json()) as EncounterWithCombatants;
  const tokenId = original.combatants[0]?.id;
  if (tokenId == null) throw new Error('The seeded encounter needs at least one combatant');

  let encounter: EncounterWithCombatants = {
    ...original,
    mapAttachmentId: MAP_ATTACHMENT_ID,
    gridSize: 10,
    gridScale: 5,
    gridUnit: 'ft',
    gridSnap: false,
    gridType: 'square',
    fog: { enabled: true, revealed: [] },
    aoe: [{ id: AOE_ID, shape: 'circle', x: 40, y: 40, sizeFt: 10, angleDeg: 0, color: null }],
    combatants: original.combatants.map((combatant, index) =>
      index === 0 ? { ...combatant, tokenX: 25, tokenY: 25, tokenSize: 'medium' } : combatant,
    ),
  };
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
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.push({ target: 'encounter', body });
      encounter = { ...encounter, ...body } as EncounterWithCombatants;
      await route.fulfill({ status: 200, contentType: 'application/json', json: encounter });
      return;
    }
    await route.continue();
  });
  await page.route(new RegExp(`/api/v1/encounters/${encounterId}/combatants/`), async (route) => {
    const request = route.request();
    if (request.method() !== 'PATCH') {
      await route.continue();
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    const combatantId = Number(new URL(request.url()).pathname.split('/').at(-1));
    calls.push({ target: 'combatant', body });
    let updated: Combatant | undefined;
    encounter = {
      ...encounter,
      combatants: encounter.combatants.map((combatant) => {
        if (combatant.id !== combatantId) return combatant;
        updated = { ...combatant, ...body } as Combatant;
        return updated;
      }),
    };
    await route.fulfill({ status: 200, contentType: 'application/json', json: updated });
  });

  await page.goto(encounterUrl());
  const surface = page.getByTestId('battle-map-surface');
  const token = page.getByTestId(`map-token-${tokenId}`);
  const aoe = page.getByTestId(`map-aoe-${AOE_ID}`);
  await expect(surface).toBeVisible();
  const layer = page.getByTestId('battle-map-layer');
  await expect(layer).toBeVisible();
  await expect.poll(async () => {
    const box = await layer.boundingBox();
    return box != null && box.width > 50 && box.height > 50;
  }).toBeTruthy();
  await expect(token).toBeVisible();
  await expect(aoe).toBeVisible();
  return { surface, token, aoe, calls };
}

test.describe('battle-map gesture ownership and cancellation', () => {
  test.use({ storageState: stateFor('dm') });

  test.beforeEach(async ({ page }) => {
    await restoreSeedEncounter(page);
  });

  test('normal mouse, stylus, and touch releases commit exactly one final-coordinate PATCH', async ({ page }) => {
    const { surface, token, aoe, calls } = await openGestureFixture(page);

    const tokenStart = { xPct: 0.25, yPct: 0.25 };
    const tokenEnd = { xPct: 0.7, yPct: 0.6 };
    const mouse = { pointerId: 1, pointerType: 'mouse', isPrimary: true } as const;
    await dispatchPointer(token, 'pointerdown', tokenStart, mouse);
    await dispatchPointer(token, 'pointermove', tokenEnd, mouse);
    await dispatchPointer(token, 'pointerup', tokenEnd, mouse);
    await dispatchPointer(token, 'lostpointercapture', tokenEnd, mouse);
    await dispatchPointer(token, 'pointerup', tokenEnd, mouse);
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].target).toBe('combatant');
    expect((calls[0].body as { tokenX: number }).tokenX).toBeCloseTo(70, 1);
    expect((calls[0].body as { tokenY: number }).tokenY).toBeCloseTo(60, 1);

    const aoeStart = { xPct: 0.4, yPct: 0.4 };
    const aoeEnd = { xPct: 0.65, yPct: 0.3 };
    const pen = { pointerId: 7, pointerType: 'pen', isPrimary: true } as const;
    await dispatchPointer(aoe, 'pointerdown', aoeStart, pen);
    await dispatchPointer(aoe, 'pointermove', aoeEnd, pen);
    await dispatchPointer(aoe, 'pointerup', aoeEnd, pen);
    await dispatchPointer(aoe, 'lostpointercapture', aoeEnd, pen);
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1].target).toBe('encounter');
    const completedAoe = (calls[1].body.aoe as Array<{ id: string; x: number; y: number }>)[0];
    expect(completedAoe).toMatchObject({ id: AOE_ID });
    expect(completedAoe.x).toBeCloseTo(65, 1);
    expect(completedAoe.y).toBeCloseTo(30, 1);

    await page.getByRole('button', { name: 'Reveal', exact: true }).click();
    const fogStart = { xPct: 0.1, yPct: 0.15 };
    const fogEnd = { xPct: 0.55, yPct: 0.75 };
    const touch = { pointerId: 12, pointerType: 'touch', isPrimary: true } as const;
    await dispatchPointer(surface, 'pointerdown', fogStart, touch);
    await dispatchPointer(surface, 'pointermove', fogEnd, touch);
    await dispatchPointer(surface, 'pointerup', fogEnd, touch);
    await dispatchPointer(surface, 'lostpointercapture', fogEnd, touch);
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2].target).toBe('encounter');
    const completedFog = calls[2].body.fog as { enabled: boolean; revealed: Array<{ x: number; y: number; w: number; h: number }> };
    expect(completedFog.enabled).toBe(true);
    expect(completedFog.revealed).toHaveLength(1);
    expect(completedFog.revealed[0].x).toBeCloseTo(10, 1);
    expect(completedFog.revealed[0].y).toBeCloseTo(15, 1);
    expect(completedFog.revealed[0].w).toBeCloseTo(45, 1);
    expect(completedFog.revealed[0].h).toBeCloseTo(60, 1);

    await expect.poll(() => page.evaluate(
      () => (window as unknown as { __releasedPointerIds: number[] }).__releasedPointerIds,
    )).toEqual([1, 7, 12]);

    // A release may be the only event carrying the final coordinate. The ruler must use it even
    // when no final pointermove was delivered, while remaining visible for reading.
    await page.getByRole('button', { name: 'Measure', exact: true }).click();
    const measureStart = { xPct: 0.2, yPct: 0.2 };
    const measureEnd = { xPct: 0.6, yPct: 0.35 };
    const measurePointer = { pointerId: 13, pointerType: 'mouse', isPrimary: true } as const;
    await dispatchPointer(surface, 'pointerdown', measureStart, measurePointer);
    await dispatchPointer(surface, 'pointerup', measureEnd, measurePointer);
    const ruler = page.getByTestId('map-ruler-line');
    const finalRulerPoint = await ruler.evaluate((line) => ({
      x: Number(line.getAttribute('x2')?.replace('%', '')),
      y: Number(line.getAttribute('y2')?.replace('%', '')),
    }));
    expect(finalRulerPoint.x).toBeCloseTo(60, 1);
    expect(finalRulerPoint.y).toBeCloseTo(35, 1);
    await expect.poll(() => page.evaluate(
      () => (window as unknown as { __releasedPointerIds: number[] }).__releasedPointerIds,
    )).toEqual([1, 7, 12, 13]);
  });

  test('pointer cancellation, premature capture loss, visibility/background, and rotation roll previews back with zero PATCHes', async ({ page }) => {
    const { surface, token, aoe, calls } = await openGestureFixture(page);
    const primaryTouch = { pointerId: 21, pointerType: 'touch', isPrimary: true } as const;

    const tokenStart = { xPct: 0.25, yPct: 0.25 };
    const tokenEnd = { xPct: 0.75, yPct: 0.55 };
    await dispatchPointer(token, 'pointerdown', tokenStart, primaryTouch);
    await dispatchPointer(token, 'pointermove', tokenEnd, primaryTouch);
    await dispatchPointer(token, 'pointercancel', tokenEnd, primaryTouch);
    await expect.poll(() => token.evaluate((element) => (element as HTMLElement).style.left)).toBe('25%');
    await settleNoPatch(page, calls, 0);

    const aoeStart = { xPct: 0.4, yPct: 0.4 };
    const aoeEnd = { xPct: 0.7, yPct: 0.2 };
    const pen = { pointerId: 22, pointerType: 'pen', isPrimary: true } as const;
    await dispatchPointer(aoe, 'pointerdown', aoeStart, pen);
    await dispatchPointer(aoe, 'pointermove', aoeEnd, pen);
    await dispatchPointer(aoe, 'lostpointercapture', aoeEnd, pen);
    await expect.poll(() => aoe.evaluate((element) => (element as HTMLElement).style.left)).toBe('40%');
    await settleNoPatch(page, calls, 0);

    await page.getByRole('button', { name: 'Reveal', exact: true }).click();
    const fogStart = { xPct: 0.1, yPct: 0.1 };
    const fogEnd = { xPct: 0.6, yPct: 0.6 };
    const fogTouch = { pointerId: 23, pointerType: 'touch', isPrimary: true } as const;
    await dispatchPointer(surface, 'pointerdown', fogStart, fogTouch);
    await dispatchPointer(surface, 'pointermove', fogEnd, fogTouch);
    await expect(page.getByTestId('map-fog-preview')).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByTestId('map-fog-preview')).toHaveCount(0);
    await settleNoPatch(page, calls, 0);

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    });
    const pageHideTouch = { pointerId: 24, pointerType: 'touch', isPrimary: true } as const;
    await dispatchPointer(surface, 'pointerdown', fogStart, pageHideTouch);
    await dispatchPointer(surface, 'pointermove', fogEnd, pageHideTouch);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect(page.getByTestId('map-fog-preview')).toHaveCount(0);
    await settleNoPatch(page, calls, 0);

    const rotateTouch = { pointerId: 25, pointerType: 'touch', isPrimary: true } as const;
    await dispatchPointer(surface, 'pointerdown', fogStart, rotateTouch);
    await dispatchPointer(surface, 'pointermove', fogEnd, rotateTouch);
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await expect(page.getByTestId('map-fog-preview')).toHaveCount(0);
    await settleNoPatch(page, calls, 0);
  });

  test('a second touch cannot move or finish token, AoE, or fog gestures owned by the first touch', async ({ page }) => {
    const { surface, token, aoe, calls } = await openGestureFixture(page);
    const owner = { pointerId: 31, pointerType: 'touch', isPrimary: true } as const;
    const second = { pointerId: 32, pointerType: 'touch', isPrimary: false } as const;
    const roguePrimary = { pointerId: 32, pointerType: 'touch', isPrimary: true } as const;

    const tokenStart = { xPct: 0.25, yPct: 0.25 };
    const ownerEnd = { xPct: 0.6, yPct: 0.65 };
    const secondEnd = { xPct: 0.9, yPct: 0.9 };
    await dispatchPointer(token, 'pointerdown', tokenStart, owner);
    await dispatchPointer(token, 'pointermove', ownerEnd, owner);
    await dispatchPointer(surface, 'pointerdown', secondEnd, second);
    await dispatchPointer(surface, 'pointermove', secondEnd, second);
    await dispatchPointer(surface, 'pointerup', secondEnd, second);
    await dispatchPointer(surface, 'pointerup', secondEnd, roguePrimary);
    await settleNoPatch(page, calls, 0);
    await dispatchPointer(token, 'pointerup', ownerEnd, owner);
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].target).toBe('combatant');
    expect(calls[0].body.tokenX).toBeCloseTo(60, 1);
    expect(calls[0].body.tokenY).toBeCloseTo(65, 1);

    const aoeStart = { xPct: 0.4, yPct: 0.4 };
    const aoeOwnerEnd = { xPct: 0.55, yPct: 0.25 };
    await dispatchPointer(aoe, 'pointerdown', aoeStart, owner);
    await dispatchPointer(aoe, 'pointermove', aoeOwnerEnd, owner);
    await dispatchPointer(surface, 'pointerup', secondEnd, second);
    await dispatchPointer(surface, 'pointerup', secondEnd, roguePrimary);
    await settleNoPatch(page, calls, 1);
    await dispatchPointer(aoe, 'pointerup', aoeOwnerEnd, owner);
    await expect.poll(() => calls.length).toBe(2);
    const ownedAoe = (calls[1].body.aoe as Array<{ id: string; x: number; y: number }>)[0];
    expect(ownedAoe).toMatchObject({ id: AOE_ID });
    expect(ownedAoe.x).toBeCloseTo(55, 1);
    expect(ownedAoe.y).toBeCloseTo(25, 1);

    await page.getByRole('button', { name: 'Reveal', exact: true }).click();
    const fogStart = { xPct: 0.2, yPct: 0.2 };
    const fogOwnerEnd = { xPct: 0.5, yPct: 0.7 };
    await dispatchPointer(surface, 'pointerdown', fogStart, owner);
    await dispatchPointer(surface, 'pointermove', fogOwnerEnd, owner);
    await dispatchPointer(surface, 'pointerup', secondEnd, second);
    await dispatchPointer(surface, 'pointerup', secondEnd, roguePrimary);
    await settleNoPatch(page, calls, 2);
    await dispatchPointer(surface, 'pointerup', fogOwnerEnd, owner);
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2].target).toBe('encounter');
    const ownedFog = calls[2].body.fog as { revealed: Array<{ x: number; y: number; w: number; h: number }> };
    expect(ownedFog.revealed).toHaveLength(1);
    expect(ownedFog.revealed[0].x).toBeCloseTo(20, 1);
    expect(ownedFog.revealed[0].y).toBeCloseTo(20, 1);
    expect(ownedFog.revealed[0].w).toBeCloseTo(30, 1);
    expect(ownedFog.revealed[0].h).toBeCloseTo(50, 1);
  });

  for (const gesture of ['token', 'aoe', 'fog'] as const) {
    test(`route unmount drops an active ${gesture} preview without PATCHing`, async ({ page }) => {
      const { surface, token, aoe, calls } = await openGestureFixture(page);
      const { campaignId } = seed();
      const touch = { pointerId: 41, pointerType: 'touch', isPrimary: true } as const;
      const start = gesture === 'token' ? { xPct: 0.25, yPct: 0.25 } : gesture === 'aoe' ? { xPct: 0.4, yPct: 0.4 } : { xPct: 0.15, yPct: 0.15 };
      const end = { xPct: 0.75, yPct: 0.65 };
      const target = gesture === 'token' ? token : gesture === 'aoe' ? aoe : surface;

      if (gesture === 'fog') await page.getByRole('button', { name: 'Reveal', exact: true }).click();
      await dispatchPointer(target, 'pointerdown', start, touch);
      await dispatchPointer(target, 'pointermove', end, touch);
      await page.goto(`/c/${campaignId}`);
      await settleNoPatch(page, calls, 0);
    });
  }
});
