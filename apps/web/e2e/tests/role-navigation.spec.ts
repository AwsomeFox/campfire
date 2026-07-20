import { test, expect, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Role-appropriate navigation + login-per-role smoke (issue #81).
 *
 * Each captured storageState is a real cookie session, so a bare `goto` lands
 * already authenticated — that alone smoke-tests login for every role. Then we
 * assert the sidebar reflects the campaign role: the DM gets the "Dungeon
 * master" section (Members/Settings/…); a player/viewer do not, and their role
 * badge reads correctly. Server-admin gating is checked on /admin directly.
 */

async function openCampaign(page: Page) {
  const { campaignId } = seed();
  await page.goto(`/c/${campaignId}`);
  // The role badge in the sidebar footer proves we're authed + inside the campaign.
  await expect(page.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();
}

test.describe('DM navigation', () => {
  test.use({ storageState: stateFor('dm') });

  test('DM sees the Dungeon master section and role badge', async ({ page }) => {
    await openCampaign(page);
    await expect(page.getByText('Dungeon master', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Members' })).toBeVisible();
    await expect(page.getByText('DM', { exact: true }).first()).toBeVisible();
  });
});

test.describe('player navigation', () => {
  test.use({ storageState: stateFor('player') });

  test('player has no DM tools and reads as Player', async ({ page }) => {
    await openCampaign(page);
    await expect(page.getByText('Dungeon master', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Members' })).toHaveCount(0);
    await expect(page.getByText('Player', { exact: true }).first()).toBeVisible();
  });
});

test.describe('viewer navigation', () => {
  test.use({ storageState: stateFor('viewer') });

  test('viewer has no DM tools and reads as Viewer', async ({ page }) => {
    await openCampaign(page);
    await expect(page.getByText('Dungeon master', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Members' })).toHaveCount(0);
    await expect(page.getByText('Viewer', { exact: true }).first()).toBeVisible();
  });
});

test.describe('server-admin console gating', () => {
  test('admin reaches the server admin console', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFor('admin') });
    const page = await ctx.newPage();
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: /Server admin/ })).toBeVisible();
    await ctx.close();
  });

  test('a non-admin is refused the server admin console', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFor('player') });
    const page = await ctx.newPage();
    await page.goto('/admin');
    await expect(page.getByText('Server admins only')).toBeVisible();
    await ctx.close();
  });
});
