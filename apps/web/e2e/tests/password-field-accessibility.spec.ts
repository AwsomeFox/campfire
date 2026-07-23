import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #868 — one accessible, password-manager-safe Show/Hide pattern across
 * authentication forms (login, setup, signup, invite join, reset, change password).
 */

async function mockSignedOut(
  page: Page,
  status: Record<string, unknown> = {
    setupRequired: false,
    localLoginEnabled: true,
    signupEnabled: true,
    oidcEnabled: false,
    oidcProviderName: null,
    version: 'password-reveal-test',
  },
): Promise<void> {
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(status),
    });
  });
  await page.route('**/api/v1/me', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Unauthorized' }),
    });
  });
}

async function expectTouchTarget(toggle: Locator): Promise<void> {
  const box = await toggle.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function expectRevealPreservesValueSelectionAndAutocomplete(
  root: Page | Locator,
  password: Locator,
  showName: string,
  hideName: string,
  autocomplete: string,
): Promise<void> {
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveAttribute('autocomplete', autocomplete);

  await password.fill('campfire-reveal-868');
  await password.evaluate((el) => {
    const input = el as HTMLInputElement;
    input.focus();
    input.setSelectionRange(3, 10);
  });

  const show = root.getByRole('button', { name: showName });
  await expect(show).toHaveAttribute('aria-pressed', 'false');
  await expectTouchTarget(show);

  await show.click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(password).toBeFocused();
  await expect(password).toHaveValue('campfire-reveal-868');
  await expect(root.getByRole('button', { name: hideName })).toHaveAttribute('aria-pressed', 'true');

  const selection = await password.evaluate((el) => {
    const input = el as HTMLInputElement;
    return { start: input.selectionStart, end: input.selectionEnd };
  });
  expect(selection).toEqual({ start: 3, end: 10 });

  await root.getByRole('button', { name: hideName }).click();
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveValue('campfire-reveal-868');
  await expect(root.getByRole('button', { name: showName })).toHaveAttribute('aria-pressed', 'false');
}

test.describe('password field accessibility (issue #868)', () => {
  // Keep auth/status and invite mocks from being shadowed by the PWA SW cache.
  test.use({ serviceWorkers: 'block' });

  test('login: keyboard reveal, 320px fit, autocomplete, and axe-clean main', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await mockSignedOut(page);
    await page.goto('/login');

    const password = page.getByLabel('Password', { exact: true });
    const show = page.getByRole('button', { name: 'Show password' });
    await expect(show).toHaveAttribute('aria-controls', 'password');

    await page.getByLabel('Username', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(password).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(show).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(password).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: 'Hide password' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(password).toHaveAttribute('type', 'password');
    await expect(show).toBeFocused();

    await expectRevealPreservesValueSelectionAndAutocomplete(
      page,
      password,
      'Show password',
      'Hide password',
      'current-password',
    );

    const widths = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(widths.content).toBeLessThanOrEqual(widths.viewport);

    const accessibilityScan = await new AxeBuilder({ page }).include('main').analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });

  test('login reveal resets when navigating away and back', async ({ page }) => {
    await mockSignedOut(page);
    await page.goto('/login');

    const password = page.getByLabel('Password', { exact: true });
    await password.fill('temporary-secret');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(password).toHaveAttribute('type', 'text');

    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/reset-password/);
    await page.getByRole('link', { name: /Back to sign in/i }).click();
    await expect(page).toHaveURL(/\/login/);

    const returned = page.getByLabel('Password', { exact: true });
    await expect(returned).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: 'Show password' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide password' })).toHaveCount(0);
  });

  test('setup, signup, reset, and invite join share the reveal contract', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });

    const status = {
      setupRequired: true,
      localLoginEnabled: true,
      signupEnabled: false,
      oidcEnabled: false,
      oidcProviderName: null as string | null,
      version: 'password-reveal-test',
    };
    await page.route('**/api/v1/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(status),
      });
    });
    await page.route('**/api/v1/me', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Unauthorized' }),
      });
    });
    await page.goto('/setup');
    await expectRevealPreservesValueSelectionAndAutocomplete(
      page,
      page.getByLabel('Password', { exact: true }),
      'Show password',
      'Hide password',
      'new-password',
    );
    await expectRevealPreservesValueSelectionAndAutocomplete(
      page,
      page.getByLabel('Confirm password', { exact: true }),
      'Show confirm password',
      'Hide confirm password',
      'new-password',
    );
    // Setup’s shell landmarks are pre-existing; scope to the auth card form.
    expect(
      (await new AxeBuilder({ page }).include('form').disableRules(['region', 'landmark-one-main', 'page-has-heading-one']).analyze())
        .violations,
    ).toEqual([]);

    status.setupRequired = false;
    status.signupEnabled = true;
    await page.goto('/signup');
    await expectRevealPreservesValueSelectionAndAutocomplete(
      page,
      page.getByLabel('Password', { exact: true }),
      'Show password',
      'Hide password',
      'new-password',
    );
    await expectRevealPreservesValueSelectionAndAutocomplete(
      page,
      page.getByLabel('Confirm password', { exact: true }),
      'Show confirm password',
      'Hide confirm password',
      'new-password',
    );

    await page.goto('/reset-password');
    await expectRevealPreservesValueSelectionAndAutocomplete(
      page,
      page.getByLabel('New password', { exact: true }),
      'Show new password',
      'Hide new password',
      'new-password',
    );

    await page.route('**/api/v1/invites/REVEAL868', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          campaignId: 868,
          campaignName: 'Reveal Campaign',
          role: 'player',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      });
    });
    await page.goto('/join/REVEAL868');
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expectRevealPreservesValueSelectionAndAutocomplete(
      page,
      page.getByLabel('Password', { exact: true }),
      'Show password',
      'Hide password',
      'new-password',
    );
    await expectRevealPreservesValueSelectionAndAutocomplete(
      page,
      page.getByLabel('Confirm password', { exact: true }),
      'Show confirm password',
      'Hide confirm password',
      'new-password',
    );
  });
});

test.describe('change password reveal (issue #868)', () => {
  test.use({ storageState: stateFor('dm') });

  test('change-password dialog keeps autocomplete and a 44px reveal control', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}`);
    await page.getByRole('button', { name: 'Change password' }).click();

    const dialog = page.getByRole('dialog', { name: 'Change password' });
    await expect(dialog).toBeVisible();

    const current = dialog.getByLabel('Current password', { exact: true });
    const next = dialog.getByLabel('New password', { exact: true });
    const confirm = dialog.getByLabel('Confirm new password', { exact: true });

    await expect(current).toHaveAttribute('autocomplete', 'current-password');
    await expect(next).toHaveAttribute('autocomplete', 'new-password');
    await expect(confirm).toHaveAttribute('autocomplete', 'new-password');

    await expectRevealPreservesValueSelectionAndAutocomplete(
      dialog,
      current,
      'Show current password',
      'Hide current password',
      'current-password',
    );
    await expectRevealPreservesValueSelectionAndAutocomplete(
      dialog,
      next,
      'Show new password',
      'Hide new password',
      'new-password',
    );
    await expectRevealPreservesValueSelectionAndAutocomplete(
      dialog,
      confirm,
      'Show confirm password',
      'Hide confirm password',
      'new-password',
    );

    const accessibilityScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });
});
