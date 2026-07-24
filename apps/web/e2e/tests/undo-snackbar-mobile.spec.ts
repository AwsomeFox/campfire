/**
 * Undo snackbar mobile geometry (issue #794).
 *
 * After trashing a character from the party roster, the shared UndoSnackbar
 * must sit above the measured mobile tab bar, keep 44×44 Undo/Dismiss targets,
 * and wrap rather than overflow at 320px with large text. Safe-area arithmetic
 * is pinned in undo-snackbar-layout.unit.spec.ts; here we simulate a tall
 * bottom inset by inflating the tab bar's padding so the measured clearance
 * path is exercised end-to-end.
 */
import { expect, test, request, type APIRequestContext, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

const CREDS = {
  player: { username: 'player', password: 'campfire-player-pw-1' },
  dm: { username: 'dm', password: 'campfire-dm-pw-1' },
} as const;

async function login(ctx: APIRequestContext, baseURL: string, who: keyof typeof CREDS) {
  const res = await ctx.post(`${baseURL}/api/v1/auth/login`, { data: CREDS[who] });
  if (!res.ok()) {
    throw new Error(`login ${who} -> ${res.status()}: ${await res.text()}`);
  }
}

async function createCharacter(baseURL: string, name: string): Promise<number> {
  const { campaignId } = seed();
  const ctx = await request.newContext({ baseURL });
  try {
    await login(ctx, baseURL, 'player');
    const res = await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name, className: 'Fighter', level: 1 },
    });
    if (!res.ok()) throw new Error(`create character -> ${res.status()}: ${await res.text()}`);
    const body = await res.json();
    return body.id as number;
  } finally {
    await ctx.dispose();
  }
}

async function restore(baseURL: string, id: number) {
  const ctx = await request.newContext({ baseURL });
  try {
    await login(ctx, baseURL, 'dm');
    const res = await ctx.post(`/api/v1/characters/${id}/restore`);
    if (!res.ok() && res.status() !== 404) {
      throw new Error(`restore ${id} -> ${res.status()}: ${await res.text()}`);
    }
  } finally {
    await ctx.dispose();
  }
}

async function openUndoSnackbar(page: Page, name: string) {
  const { campaignId } = seed();
  await page.goto(`/c/${campaignId}/party`);
  const trigger = page.getByRole('button', { name: `Actions for ${name} (roster card)` });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Move to Trash…' }).click();
  const dialog = page.getByRole('dialog', { name: `Move ${name} to the Trash?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Move to Trash' }).click();
  const snackbar = page.getByTestId('undo-snackbar');
  await expect(snackbar).toBeVisible();
  return snackbar;
}

test.describe('Undo snackbar mobile chrome clearance (issue #794)', () => {
  test.use({ storageState: stateFor('player') });

  const name = `794 Mobile Undo ${Date.now()}`;
  let characterId = 0;

  test.beforeAll(async ({ baseURL }) => {
    characterId = await createCharacter(baseURL!, name);
  });
  test.afterAll(async ({ baseURL }) => {
    if (characterId) await restore(baseURL!, characterId);
  });

  test('sits above the tab bar with 44×44 targets at 320px and large text', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    const snackbar = await openUndoSnackbar(page, name);

    // Large text + simulated bottom safe-area (taller tab bar padding). Resize
    // republishes --cf-tabbar-content-height from the ResizeObserver / listener.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
      document.documentElement.setAttribute('data-reading-mode', 'large');
    });
    await page.addStyleTag({
      content: `
        .cf-tabbar a, .cf-tabbar button {
          padding-bottom: 34px !important;
        }
      `,
    });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect.poll(async () => {
      const snack = page.getByTestId('undo-snackbar');
      const tab = page.locator('.cf-tabbar');
      const snackBox = await snack.boundingBox();
      const tabBox = await tab.boundingBox();
      if (!snackBox || !tabBox) return false;
      return snackBox.y + snackBox.height <= tabBox.y + 1;
    }).toBe(true);

    const undo = snackbar.getByRole('button', { name: 'Undo' });
    const dismiss = snackbar.getByRole('button', { name: 'Dismiss' });
    const undoBox = await undo.boundingBox();
    const dismissBox = await dismiss.boundingBox();
    expect(undoBox, 'Undo hit target').not.toBeNull();
    expect(dismissBox, 'Dismiss hit target').not.toBeNull();
    expect(undoBox!.height).toBeGreaterThanOrEqual(44);
    expect(undoBox!.width).toBeGreaterThanOrEqual(44);
    expect(dismissBox!.height).toBeGreaterThanOrEqual(44);
    expect(dismissBox!.width).toBeGreaterThanOrEqual(44);

    const snackBox = await snackbar.boundingBox();
    expect(snackBox).not.toBeNull();
    expect(snackBox!.x).toBeGreaterThanOrEqual(-1);
    expect(snackBox!.x + snackBox!.width).toBeLessThanOrEqual(321);

    const layers = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const snack = document.querySelector('.cf-undo-snackbar');
      const tab = document.querySelector('.cf-tabbar');
      return {
        layerTab: Number.parseInt(root.getPropertyValue('--cf-layer-tabbar'), 10),
        layerDialog: Number.parseInt(root.getPropertyValue('--cf-layer-dialog'), 10),
        layerSnack: Number.parseInt(root.getPropertyValue('--cf-layer-snackbar'), 10),
        snackZ: snack ? Number.parseInt(getComputedStyle(snack).zIndex, 10) : NaN,
        tabZ: tab ? Number.parseInt(getComputedStyle(tab).zIndex, 10) : NaN,
      };
    });
    expect(layers.layerSnack).toBeGreaterThan(layers.layerDialog);
    expect(layers.layerDialog).toBeGreaterThan(layers.layerTab);
    expect(layers.snackZ).toBe(layers.layerSnack);
    expect(layers.tabZ).toBe(layers.layerTab);
  });
});
