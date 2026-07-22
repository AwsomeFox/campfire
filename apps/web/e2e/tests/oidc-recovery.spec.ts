import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const SUPPORT_REFERENCE = 'A1B2C3D4E5F60718';

const CATEGORY_CASES = [
  ['cancelled', 'SSO sign-in was cancelled'],
  ['flow_expired', 'Your sign-in session expired'],
  ['state_pkce_mismatch', 'Campfire could not verify this sign-in'],
  ['provider_unavailable', 'SSO is unavailable right now'],
  ['client_token_failure', 'SSO could not complete sign-in'],
  ['missing_claims', 'Your SSO account is missing required information'],
  ['group_denied', 'This account is not allowed to sign in'],
  ['account_disabled', 'Your Campfire account is disabled'],
] as const;

async function mockSignedOutStatus(page: Page, localLoginEnabled: boolean): Promise<void> {
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        setupRequired: false,
        localLoginEnabled,
        signupEnabled: false,
        oidcEnabled: true,
        oidcProviderName: 'Private Provider Name',
        version: 'test',
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
}

test.describe('OIDC recovery page', () => {
  for (const [category, title] of CATEGORY_CASES) {
    test(`renders safe, fixed copy for ${category}`, async ({ page }) => {
      await mockSignedOutStatus(page, true);
      await page.goto(`/login/sso-error?category=${category}&ref=${SUPPORT_REFERENCE}`);

      const heading = page.getByRole('heading', { level: 1, name: title });
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      await expect(page.getByText(SUPPORT_REFERENCE)).toBeVisible();
      await expect(page.getByRole('link', { name: 'Try SSO again' })).toHaveAttribute(
        'href',
        '/api/v1/auth/oidc/login',
      );
      await expect(page.getByText(/Private Provider Name|code-|state-|access-|PROVIDER_PRIVATE/)).toHaveCount(0);
    });
  }

  test('is keyboard-complete, axe-clean, mobile-safe, and opens available local login directly', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await mockSignedOutStatus(page, true);
    await page.goto(`/login/sso-error?category=flow_expired&ref=${SUPPORT_REFERENCE}`);

    const heading = page.getByRole('heading', { level: 1, name: 'Your sign-in session expired' });
    const retry = page.getByRole('link', { name: 'Try SSO again' });
    const local = page.getByRole('link', { name: 'Sign in with username and password' });
    await expect(heading).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(retry).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(local).toBeFocused();

    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
    for (const action of [retry, local]) {
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    const accessibilityScan = await new AxeBuilder({ page }).include('main').analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await local.click();
    await expect(page).toHaveURL(/\/login\?local=1$/);
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
  });

  test('does not show a local-login affordance when public status says it is unavailable', async ({ page }) => {
    await mockSignedOutStatus(page, false);
    await page.goto(`/login/sso-error?category=provider_unavailable&ref=${SUPPORT_REFERENCE}`);
    await expect(page.getByRole('link', { name: 'Try SSO again' })).toBeVisible();
    await expect(page.getByRole('link', { name: /username and password/i })).toHaveCount(0);
  });

  test('does not reflect unknown categories or malformed references into the UI', async ({ page }) => {
    await mockSignedOutStatus(page, false);
    await page.goto('/login/sso-error?category=PROVIDER_PRIVATE_PAYLOAD&ref=state-secret-value');
    await expect(page.getByRole('heading', { level: 1, name: 'SSO could not complete sign-in' })).toBeVisible();
    await expect(page.getByText('unavailable')).toBeVisible();
    await expect(page.getByText(/PROVIDER_PRIVATE_PAYLOAD|state-secret-value/)).toHaveCount(0);
  });

  test('preserves the existing successful callback redirect to the authenticated app', async ({ page }) => {
    await page.route('**/api/v1/auth/oidc/callback**', async (route) => {
      await route.fulfill({ status: 302, headers: { location: '/' }, body: '' });
    });
    await page.route('**/api/v1/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          setupRequired: false,
          localLoginEnabled: true,
          signupEnabled: false,
          oidcEnabled: true,
          oidcProviderName: null,
          version: 'test',
        }),
      });
    });
    await page.route('**/api/v1/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 99,
            username: 'oidc-success',
            displayName: 'OIDC Success',
            serverRole: 'user',
            disabled: false,
            accentColor: null,
            textSize: 'default',
            createdAt: '2026-07-22T00:00:00.000Z',
            updatedAt: '2026-07-22T00:00:00.000Z',
          },
          memberships: [],
        }),
      });
    });
    await page.route('**/api/v1/campaigns', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/api/v1/auth/oidc/callback?code=not-rendered&state=not-rendered');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
    await expect(page.getByText(/not-rendered/)).toHaveCount(0);
  });
});
