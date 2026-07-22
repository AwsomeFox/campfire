import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('Multi-Tab Sign-Out', () => {
  test.use({ storageState: stateFor('player') });

  test('clearing auth token/user in Tab A automatically redirects Tab B to login', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('player') });
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    const { campaignId } = seed();
    await pageA.goto(`/c/${campaignId}`);
    await pageB.goto(`/c/${campaignId}`);

    await expect(pageA.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();
    await expect(pageB.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();

    // Clear auth state in Tab A
    await pageA.evaluate(() => {
      localStorage.removeItem('cf.user');
    });

    // Tab B automatically detects sign-out via 'storage' listener and redirects to /login
    await expect(pageB).toHaveURL(/\/login/);

    await context.close();
  });

  test('calling localStorage.clear() in Tab A automatically redirects Tab B to login', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('player') });
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    const { campaignId } = seed();
    await pageA.goto(`/c/${campaignId}`);
    await pageB.goto(`/c/${campaignId}`);

    await expect(pageA.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();
    await expect(pageB.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();

    // Clear all localStorage in Tab A
    await pageA.evaluate(() => {
      localStorage.clear();
    });

    // Tab B automatically detects sign-out via 'storage' listener and redirects to /login
    await expect(pageB).toHaveURL(/\/login/);

    await context.close();
  });

  test('logging out in Tab A automatically redirects Tab B to login', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('player') });
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    const { campaignId } = seed();
    await pageA.goto(`/c/${campaignId}`);
    await pageB.goto(`/c/${campaignId}`);

    await expect(pageA.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();
    await expect(pageB.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();

    // Trigger logout in Tab A via localStorage clear + API call or evaluate
    await pageA.evaluate(async () => {
      await fetch('/api/v1/auth/logout', { method: 'POST' });
      localStorage.removeItem('cf.user');
    });

    // Tab B automatically updates auth state and redirects to /login
    await expect(pageB).toHaveURL(/\/login/);

    await context.close();
  });
});
