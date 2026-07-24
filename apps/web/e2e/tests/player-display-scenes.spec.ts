import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #823 — Cast is a viewport-safe broadcast scene, not an unbounded page.
 *
 * These checks pin the behaviour the actual-play / shared-TV producer depends on:
 *   - the stage never grows a scrollbar (content fits the viewport) at 1080p and
 *     a 4:3 display;
 *   - the persistent status band (encounter / round / current + next actor) stays
 *     visible across every scene swap;
 *   - a private DM cockpit switches the public scene, and a second tab follows;
 *   - a large initiative order pages the current actor's neighbours on screen and
 *     surfaces the off-screen turns on demand rather than truncating them.
 */

const DM = { username: 'dm', password: 'campfire-dm-pw-1' };

const SCENES = ['map', 'initiative', 'party', 'quests', 'intermission', 'blackout'] as const;

/** Controls auto-hide after idle — nudge the pointer so the cockpit is hittable. */
async function revealCockpit(page: Page) {
  await page.mouse.move(24, 24);
  await expect(page.getByTestId('cf-scene-picker')).toBeVisible();
}

async function selectScene(page: Page, id: (typeof SCENES)[number]) {
  await revealCockpit(page);
  await page.getByTestId(`cf-scene-btn-${id}`).click();
  await expect(page.getByTestId('cf-stage')).toHaveAttribute('data-scene', id);
}

/** The document must never scroll — the fixed stage owns all overflow. */
async function expectNoScrollbar(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      vertical: doc.scrollHeight - doc.clientHeight,
      horizontal: doc.scrollWidth - doc.clientWidth,
    };
  });
  expect(overflow.vertical, 'vertical overflow').toBeLessThanOrEqual(1);
  expect(overflow.horizontal, 'horizontal overflow').toBeLessThanOrEqual(1);
}

async function login(ctx: APIRequestContext) {
  await ctx.post('/api/v1/auth/login', { data: DM });
}

/** Reinforce the live seed fight so the initiative order spans multiple stage pages. */
async function addExtraCombatants(baseURL: string, encounterId: number, count: number): Promise<number[]> {
  const ctx = await request.newContext({ baseURL });
  const ids: number[] = [];
  try {
    await login(ctx);
    for (let i = 0; i < count; i += 1) {
      const res = await ctx.post(`/api/v1/encounters/${encounterId}/combatants`, {
        data: { kind: 'monster', name: `Cast Extra ${String(i + 1).padStart(2, '0')}`, hpMax: 10 },
      });
      if (!res.ok()) throw new Error(`add combatant -> ${res.status()}: ${await res.text()}`);
      const body = await res.json();
      ids.push(body.id as number);
      // Spread initiative below the seed monsters (boss 18 / skirmisher 7) so the
      // extras land on later pages, keeping the current actor on the anchor page.
      const patch = await ctx.patch(`/api/v1/encounters/${encounterId}/combatants/${body.id}`, {
        data: { initiative: (i % 6) + 1 },
      });
      if (!patch.ok()) throw new Error(`patch initiative -> ${patch.status()}: ${await patch.text()}`);
    }
  } finally {
    await ctx.dispose();
  }
  return ids;
}

async function removeCombatants(baseURL: string, encounterId: number, ids: number[]) {
  const ctx = await request.newContext({ baseURL });
  try {
    await login(ctx);
    for (const id of ids) {
      const res = await ctx.delete(`/api/v1/encounters/${encounterId}/combatants/${id}`);
      if (!res.ok() && res.status() !== 404) {
        throw new Error(`delete combatant ${id} -> ${res.status()}`);
      }
    }
  } finally {
    await ctx.dispose();
  }
}

test.describe('Player Display broadcast scenes (issue #823)', () => {
  test.use({ storageState: stateFor('dm'), viewport: { width: 1920, height: 1080 } });

  test('keeps the persistent status band visible and never scrolls at 1080p', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/screen`);

    const band = page.getByTestId('cf-status-band');
    await expect(page.getByRole('heading', { name: 'E2E — Cinderhaven' })).toBeVisible();
    await expect(band).toBeVisible();
    // Live combat context is on the band regardless of the active scene.
    await expect(page.getByTestId('cf-status-round')).toContainText('Round');
    await expect(page.getByTestId('cf-status-current')).toContainText('Now');
    await expect(page.getByTestId('cf-status-next')).toContainText('Next');

    // Every non-blackout scene keeps the band and fits the viewport.
    for (const scene of SCENES) {
      await selectScene(page, scene);
      await expect(page.getByTestId(`cf-scene-${scene}`)).toBeVisible();
      if (scene === 'blackout') {
        await expect(band).toHaveCount(0);
      } else {
        await expect(band).toBeVisible();
      }
      await expectNoScrollbar(page);
    }
  });

  test('lets the DM cockpit drive the public scene, and a second tab follows', async ({ page, context }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/screen`);
    await selectScene(page, 'party');

    // A separate public display tab (same origin → shared storage) follows the
    // cockpit selection through the standard cross-tab storage event.
    const publicTab = await context.newPage();
    await publicTab.setViewportSize({ width: 1920, height: 1080 });
    await publicTab.goto(`/c/${campaignId}/screen`);
    await expect(publicTab.getByTestId('cf-stage')).toHaveAttribute('data-scene', 'party');

    await selectScene(page, 'quests');
    await expect(publicTab.getByTestId('cf-stage')).toHaveAttribute('data-scene', 'quests');
    await expectNoScrollbar(publicTab);
    await publicTab.close();
  });

  test('pages a large initiative order and surfaces off-screen actors on demand', async ({ page, baseURL }) => {
    const { campaignId, encounterId } = seed();
    const extraIds = await addExtraCombatants(baseURL!, encounterId, 12);
    try {
      await page.goto(`/c/${campaignId}/screen`);
      await selectScene(page, 'initiative');

      // The order is 14 deep but only a single page's worth is on the stage.
      await expect(page.getByTestId('cf-init-page')).toContainText('of 14');
      const rows = page.locator('.cf-scene-initiative .cf-init');
      await expect(rows).toHaveCount(8);
      // The current actor (highest initiative) anchors the first page.
      await expect(page.locator('.cf-scene-initiative .cf-init.current')).toBeVisible();
      await expect(page.getByTestId('cf-status-current')).toContainText('Goblin Boss');

      const firstPage = await rows.locator('.cf-init-name').allInnerTexts();

      // Stepping the cockpit page control reveals the turns that were off-screen.
      await revealCockpit(page);
      await page.getByTestId('cf-scene-next-page').click();
      await expect
        .poll(async () => (await rows.locator('.cf-init-name').allInnerTexts()).join('|'))
        .not.toBe(firstPage.join('|'));
      const secondPage = await rows.locator('.cf-init-name').allInnerTexts();
      const surfaced = secondPage.filter((name) => !firstPage.includes(name));
      expect(surfaced.length).toBeGreaterThan(0);

      // The status band stays put while the body pages.
      await expect(page.getByTestId('cf-status-band')).toBeVisible();
      await expectNoScrollbar(page);
    } finally {
      await removeCombatants(baseURL!, encounterId, extraIds);
    }
  });
});

test.describe('Player Display broadcast scenes on a 4:3 display (issue #823)', () => {
  test.use({ storageState: stateFor('dm'), viewport: { width: 1024, height: 768 } });

  test('fits a 4:3 viewport without a scrollbar and still switches scenes', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/screen`);
    await expect(page.getByTestId('cf-status-band')).toBeVisible();
    await expectNoScrollbar(page);

    // A 4:3 stage aspect is a producer option; both aspects letterbox cleanly.
    await revealCockpit(page);
    await page.getByTestId('cf-aspect-btn-4-3').click();
    await expect(page.getByTestId('cf-stage')).toHaveAttribute('data-aspect', '4:3');
    await expectNoScrollbar(page);

    await selectScene(page, 'quests');
    await expect(page.getByTestId('cf-scene-quests')).toBeVisible();
    await expect(page.getByTestId('cf-status-band')).toBeVisible();
    await expectNoScrollbar(page);
  });
});
