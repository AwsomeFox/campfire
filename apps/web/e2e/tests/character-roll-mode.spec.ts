import AxeBuilder from '@axe-core/playwright';
import { test, expect, request } from '@playwright/test';
import { seed, stateFor } from './seed';
import { CREDS } from '../global-setup';

/**
 * Issue #713 / #1853 — expose Roll Mode Context Menu & Chooser
 * at character sheet roll controls.
 */

test.describe('Character sheet roll-mode context menu (issues #713 / #1853)', () => {
  test.use({ storageState: stateFor('player') });

  let characterId = 0;
  const name = `1853 Roll-mode PC ${Date.now()}`;

  test.beforeAll(async ({ baseURL }) => {
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.player });
    try {
      const me = await (await ctx.get('/api/v1/me')).json();
      const playerUserId = String(me.user.id);
      const res = await ctx.post(`/api/v1/campaigns/${seed().campaignId}/characters`, {
        data: {
          name,
          className: 'Fighter',
          level: 5,
          ownerUserId: playerUserId,
          ac: 16,
          hpCurrent: 30,
          hpMax: 30,
          stats: { STR: 18, DEX: 14, CON: 16, INT: 10, WIS: 12, CHA: 8 },
          saveProficiencies: ['STR'],
          skills: { Athletics: 'proficient' },
        },
      });
      if (!res.ok()) throw new Error(`create character -> ${res.status()}: ${await res.text()}`);
      const body = await res.json();
      characterId = body.id as number;
    } finally {
      await ctx.dispose();
    }
  });

  test.afterAll(async ({ baseURL }) => {
    if (!characterId) return;
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    try {
      await ctx.delete(`/api/v1/characters/${characterId}`);
    } finally {
      await ctx.dispose();
    }
  });

  test('a touch or mouse user can trigger a roll context menu', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/characters/${characterId}`);

    // Wait for the saving throws card to render (uses data-testid on the Card)
    const savesCard = page.locator('[data-testid="character-saving-throws"]');
    await expect(savesCard).toBeVisible({ timeout: 20000 });

    // Target a RollContextMenu button by its aria-label pattern "Roll ... save (...)"
    const rollBtn = savesCard.locator('button[aria-label*="save"]').first();
    await expect(rollBtn).toBeVisible({ timeout: 10000 });

    // Right-click opens the context menu (portalled to body with role="menu")
    await rollBtn.click({ button: 'right' });
    const menu = page.locator('[role="menu"]');
    await expect(menu).toBeVisible({ timeout: 5000 });

    // Options include Advantage and Disadvantage menuitem buttons
    await expect(menu.locator('[role="menuitem"]', { hasText: /Advantage/i })).toBeVisible();
    await expect(menu.locator('[role="menuitem"]', { hasText: /Disadvantage/i })).toBeVisible();
  });

  test('the shift keyboard shortcut triggers advantage roll', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/characters/${characterId}`);

    const savesCard = page.locator('[data-testid="character-saving-throws"]');
    await expect(savesCard).toBeVisible({ timeout: 20000 });

    // Target a RollContextMenu button by its aria-label pattern
    const rollBtn = savesCard.locator('button[aria-label*="save"]').first();
    await expect(rollBtn).toBeVisible({ timeout: 10000 });

    const [rollRequest] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/roll') &&
          res.request().method() === 'POST',
      ),
      rollBtn.click({ modifiers: ['Shift'] }),
    ]);
    expect(rollRequest.status()).toBeLessThan(300);
  });

  test('roll controls are axe-clean', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/characters/${characterId}`);

    const savesCard = page.locator('[data-testid="character-saving-throws"]');
    await expect(savesCard).toBeVisible({ timeout: 20000 });

    const results = await new AxeBuilder({ page })
      .include('[data-testid="character-saving-throws"]')
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
