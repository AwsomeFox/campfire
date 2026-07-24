/**
 * Issue #449: auth forms announce validation errors once, associate them with
 * fields, and move focus to the first invalid control (or form summary).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  AUTH_CREDENTIALS_ERROR,
  AUTH_LOCAL_DISABLED_ERROR,
  AUTH_PASSWORD_MISMATCH_ERROR,
  AUTH_RATE_LIMIT_ERROR,
} from '../../src/features/auth/authFormA11y';

async function mockSignedOutLogin(
  page: Page,
  options: { loginStatus?: number; localLoginEnabled?: boolean } = {},
): Promise<void> {
  const loginStatus = options.loginStatus ?? 401;
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        setupRequired: false,
        localLoginEnabled: options.localLoginEnabled ?? true,
        signupEnabled: false,
        oidcEnabled: false,
        oidcProviderName: null,
        version: 'auth-form-errors',
      }),
    });
  });
  await page.route('**/api/v1/me', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Unauthorized' }),
    });
  });
  await page.route('**/api/v1/auth/login', async (route) => {
    await route.fulfill({
      status: loginStatus,
      contentType: 'application/json',
      body: JSON.stringify({
        message:
          loginStatus === 401
            ? 'Invalid username or password'
            : loginStatus === 429
              ? 'Too many requests'
              : 'Local login disabled',
      }),
    });
  });
}

test.describe('auth form error accessibility (issue #449)', () => {
  test('setup password mismatch announces once, associates confirm, focuses it, keeps typed values', async ({
    page,
  }) => {
    await page.route('**/api/v1/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          setupRequired: true,
          oidcEnabled: false,
          signupEnabled: false,
          localLoginEnabled: true,
        }),
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

    const username = page.getByLabel('Username');
    const password = page.getByLabel('Password', { exact: true });
    const confirm = page.getByLabel('Confirm password', { exact: true });
    await username.fill('first-admin');
    await password.fill('correct-horse');
    await confirm.fill('wrong-battery');
    await page.getByRole('button', { name: 'Light the fire' }).click();

    const form = page.locator('form');
    const alert = form.getByRole('alert');
    await expect(alert).toHaveCount(1);
    await expect(alert).toHaveText(AUTH_PASSWORD_MISMATCH_ERROR);
    await expect(confirm).toHaveAttribute('aria-invalid', 'true');
    await expect(confirm).toHaveAccessibleDescription(AUTH_PASSWORD_MISMATCH_ERROR);
    await expect(confirm).toBeFocused();
    await expect(password).not.toHaveAttribute('aria-invalid', 'true');
    // Typed values are preserved (safe for non-credential client validation).
    await expect(username).toHaveValue('first-admin');
    await expect(password).toHaveValue('correct-horse');
    await expect(confirm).toHaveValue('wrong-battery');

    // Exclude color-contrast: the shared primary-button token is exercised
    // elsewhere; this test owns error association / focus, not palette contrast.
    const scan = await new AxeBuilder({ page })
      .include('form')
      .disableRules(['color-contrast'])
      .analyze();
    expect(scan.violations).toEqual([]);
  });

  test('login credential failure announces once, marks both fields, focuses username', async ({
    page,
  }) => {
    await mockSignedOutLogin(page, { loginStatus: 401 });
    await page.goto('/login');

    const username = page.getByLabel('Username');
    const password = page.getByLabel('Password', { exact: true });
    await username.fill('returning-player');
    await password.fill('incorrect-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    const form = page.locator('form');
    const alert = form.locator('#login-error');
    await expect(alert).toHaveText(AUTH_CREDENTIALS_ERROR);
    // One form alert (the app-root Announcer also mounts an empty role=alert).
    await expect(form.getByRole('alert')).toHaveCount(1);
    await expect(username).toHaveAttribute('aria-invalid', 'true');
    await expect(password).toHaveAttribute('aria-invalid', 'true');
    await expect(username).toHaveAttribute('aria-describedby', 'login-error');
    await expect(password).toHaveAttribute('aria-describedby', 'login-error');
    await expect(username).toBeFocused();
    await expect(username).toHaveValue('returning-player');
    await expect(password).toHaveValue('incorrect-password');
  });

  test('login rate-limit and disabled failures use a form summary without field association', async ({
    page,
  }) => {
    await mockSignedOutLogin(page, { loginStatus: 429 });
    await page.goto('/login');
    await page.getByLabel('Username').fill('returning-player');
    await page.getByLabel('Password', { exact: true }).fill('any-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    const rateAlert = page.locator('#login-error');
    await expect(rateAlert).toHaveText(AUTH_RATE_LIMIT_ERROR);
    await expect(rateAlert).toBeFocused();
    await expect(page.getByLabel('Username')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Password', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');

    await mockSignedOutLogin(page, { loginStatus: 403, localLoginEnabled: false });
    await page.goto('/login');
    await page.getByLabel('Username').fill('returning-player');
    await page.getByLabel('Password', { exact: true }).fill('any-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    const disabledAlert = page.locator('#login-error');
    await expect(disabledAlert).toHaveText(AUTH_LOCAL_DISABLED_ERROR);
    await expect(disabledAlert).toBeFocused();
    await expect(page.getByLabel('Username')).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('login keyboard submit surfaces the same accessible credential error', async ({ page }) => {
    await mockSignedOutLogin(page, { loginStatus: 401 });
    await page.goto('/login');

    const username = page.getByLabel('Username');
    const password = page.getByLabel('Password', { exact: true });
    await username.fill('keyboard-user');
    await password.fill('bad-password');
    await password.press('Enter');

    await expect(page.locator('#login-error')).toHaveText(AUTH_CREDENTIALS_ERROR);
    await expect(username).toBeFocused();
    await expect(username).toHaveAttribute('aria-invalid', 'true');
    await expect(password).toHaveAttribute('aria-invalid', 'true');
  });
});
