/**
 * ConfirmDialog hit targets above mobile chrome (issue #791).
 *
 * Opens a destructive confirmation on a campaign route that shows the sticky
 * header + bottom tab bar, then proves:
 *   - the backdrop stacks above tab bar / header (elementFromPoint)
 *   - chrome clicks hit the backdrop (dismiss) rather than navigating tabs
 *   - #root is inert (background removed from the a11y / pointer tree)
 * Covers 320px and a safe-area-padded tab bar; desktop stacking is covered by
 * the same portal + z-index contracts in dialog-layering.unit.spec.ts.
 */
import { expect, test, request, type APIRequestContext, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

const CREDS = {
  player: { username: 'player', password: 'campfire-player-pw-1' },
} as const;

async function login(ctx: APIRequestContext, baseURL: string) {
  await ctx.post(`${baseURL}/api/v1/auth/login`, { data: CREDS.player });
}

async function createCharacter(baseURL: string, name: string): Promise<number> {
  const { campaignId } = seed();
  const ctx = await request.newContext({ baseURL });
  await login(ctx, baseURL);
  const res = await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
    data: { name, className: 'Fighter', level: 1 },
  });
  if (!res.ok()) throw new Error(`create character -> ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  await ctx.dispose();
  return body.id as number;
}

async function trashCharacter(baseURL: string, id: number) {
  const ctx = await request.newContext({ baseURL });
  await login(ctx, baseURL);
  const res = await ctx.delete(`/api/v1/characters/${id}`);
  await ctx.dispose();
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`trash ${id} -> ${res.status()}: ${await res.text()}`);
  }
}

async function openTrashConfirm(page: Page, name: string) {
  const { campaignId } = seed();
  await page.goto(`/c/${campaignId}/party`);
  const trigger = page.getByRole('button', { name: `Actions for ${name} (roster card)` });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Move to Trash…' }).click();
  const dialog = page.getByRole('dialog', { name: `Move ${name} to the Trash?` });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('ConfirmDialog above mobile chrome (issue #791)', () => {
  test.use({ storageState: stateFor('player') });

  const name = `791 Layer ${Date.now()}`;
  let characterId = 0;

  test.beforeAll(async ({ baseURL }) => {
    characterId = await createCharacter(baseURL!, name);
  });
  test.afterAll(async ({ baseURL }) => {
    if (characterId) await trashCharacter(baseURL!, characterId);
  });

  test('backdrop wins hit tests over tab bar / header at 320px with safe-area', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    const dialog = await openTrashConfirm(page, name);
    const partyUrl = page.url();

    // Inflate tab-bar bottom padding to simulate a home-indicator safe-area.
    await page.addStyleTag({
      content: `
        .cf-tabbar a, .cf-tabbar button {
          padding-bottom: 34px !important;
        }
      `,
    });

    const hit = await page.evaluate(() => {
      const tab = document.querySelector('.cf-tabbar');
      const header = document.querySelector('header');
      const backdrop = document.querySelector('.dialog-backdrop');
      const root = document.getElementById('root');
      if (!tab || !header || !backdrop || !root) {
        return { ok: false as const, reason: 'missing chrome or backdrop' };
      }
      const tabBox = tab.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();
      const tabX = tabBox.left + tabBox.width / 2;
      const tabY = tabBox.top + Math.min(12, tabBox.height / 2);
      const headerX = headerBox.left + Math.min(24, headerBox.width / 2);
      const headerY = headerBox.top + headerBox.height / 2;
      const atTab = document.elementFromPoint(tabX, tabY);
      const atHeader = document.elementFromPoint(headerX, headerY);
      return {
        ok: true as const,
        tabHitBackdrop: Boolean(atTab?.closest('.dialog-backdrop')),
        headerHitBackdrop: Boolean(atHeader?.closest('.dialog-backdrop')),
        rootInert: root.hasAttribute('inert'),
        dialogInert: Boolean(document.querySelector('[role="dialog"]')?.closest('[inert]')),
        portalParent: backdrop.parentElement?.tagName ?? null,
        layerTab: Number.parseInt(
          getComputedStyle(document.documentElement).getPropertyValue('--cf-layer-tabbar'),
          10,
        ),
        layerDialog: Number.parseInt(
          getComputedStyle(document.documentElement).getPropertyValue('--cf-layer-dialog'),
          10,
        ),
        backdropZ: Number.parseInt(getComputedStyle(backdrop).zIndex, 10),
        tabZ: Number.parseInt(getComputedStyle(tab).zIndex, 10),
      };
    });

    expect(hit.ok, hit.ok ? undefined : hit.reason).toBe(true);
    if (!hit.ok) return;

    expect(hit.portalParent).toBe('BODY');
    expect(hit.layerDialog).toBeGreaterThan(hit.layerTab);
    expect(hit.backdropZ).toBe(hit.layerDialog);
    expect(hit.tabZ).toBe(hit.layerTab);
    expect(hit.tabHitBackdrop).toBe(true);
    expect(hit.headerHitBackdrop).toBe(true);
    expect(hit.rootInert).toBe(true);
    expect(hit.dialogInert).toBe(false);

    // A click over the tab bar must hit the backdrop (dismiss), not navigate tabs.
    const tabBox = await page.locator('.cf-tabbar').boundingBox();
    expect(tabBox).not.toBeNull();
    await page.mouse.click(tabBox!.x + tabBox!.width / 2, tabBox!.y + 8);
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(partyUrl);
  });
});
