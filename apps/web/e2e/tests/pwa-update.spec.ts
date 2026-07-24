import { expect, test } from '@playwright/test';
import { stateFor } from './seed';

/**
 * Issue #515 — PWA updates: notify users when a new version is ready,
 * guard against forced reloads during in-flight actions/forms, recover from update failures,
 * and display client and server versions in Admin status UI.
 */
test.describe('Issue #515 - PWA updates and recovery', () => {
  test.use({ storageState: stateFor('admin') });

  test('displays Update ready banner with Reload now and After session', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Simulate SW update available
    await page.evaluate(() => {
      (window as unknown as { setPwaStateForTesting: (st: unknown) => void }).setPwaStateForTesting({
        needRefresh: true,
        deferred: false,
      });
    });

    const banner = page.getByTestId('pwa-update-banner');
    await expect(banner).toBeVisible();
    await expect(page.getByTestId('pwa-reload-now')).toBeVisible();
    await expect(page.getByTestId('pwa-dismiss')).toBeVisible();

    // Click "After session" / dismiss
    await page.getByTestId('pwa-dismiss').click();
    await expect(banner).toBeHidden();
  });

  test('guards against reload while in-flight action or dirty form is active', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Simulate SW update available & in-flight action active
    await page.evaluate(() => {
      (window as unknown as { setPwaStateForTesting: (st: unknown) => void }).setPwaStateForTesting({
        needRefresh: true,
        deferred: false,
      });
      (window as unknown as { registerInFlightAction: () => void }).registerInFlightAction();
    });

    const banner = page.getByTestId('pwa-update-banner');
    await expect(banner).toBeVisible();

    // Click Reload now while action is in flight
    await page.getByTestId('pwa-reload-now').click();

    // Should display warning and remain blocked
    const warning = page.getByTestId('pwa-blocked-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Action or form submission in progress');

    // Reset guard
    await page.evaluate(() => {
      (window as unknown as { resetReloadGuard: () => void }).resetReloadGuard();
    });
  });

  test('displays SW error banner with Clear cache & reload recovery button', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Simulate SW update error
    await page.evaluate(() => {
      (window as unknown as { setPwaStateForTesting: (st: unknown) => void }).setPwaStateForTesting({
        updateError: 'Failed to update service worker script',
      });
    });

    const errorBanner = page.getByTestId('pwa-update-error');
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText('Service worker registration or update failed');
    await expect(page.getByTestId('pwa-clear-cache-reload')).toBeVisible();
  });

  test('admin status UI displays both client and server versions', async ({ page }) => {
    await page.goto('/admin');
    await page.waitForLoadState('domcontentloaded');

    const clientVer = page.getByTestId('client-version');
    const serverVer = page.getByTestId('server-version');

    await expect(clientVer).toBeVisible();
    await expect(serverVer).toBeVisible();
    await expect(clientVer).toContainText('Client: v');
    await expect(serverVer).toContainText('Server: v');
  });
});
