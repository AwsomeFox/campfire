import { test, expect } from '@playwright/test';
import { CREDS } from '../global-setup';
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
      localStorage.removeItem('cf.authUserId');
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
    // Mint a disposable session for this context. Logging out the shared
    // global-setup session would invalidate player.json for unrelated specs
    // running later in the same CI shard.
    const login = await context.request.post('/api/v1/auth/login', { data: CREDS.player });
    expect(login.ok()).toBeTruthy();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    const { campaignId } = seed();
    await pageA.goto(`/c/${campaignId}`);
    await pageB.goto(`/c/${campaignId}`);

    await expect(pageA.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();
    await expect(pageB.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();

    // Drive the real application contract: logout invalidates the cookie and
    // clears the sentinel that peer tabs observe.
    await pageA.getByRole('button', { name: 'Sign out' }).click();

    // Tab B automatically updates auth state and redirects to /login
    await expect(pageB).toHaveURL(/\/login/);

    await context.close();
  });
});
