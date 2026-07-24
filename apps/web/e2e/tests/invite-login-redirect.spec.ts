import { expect, test, type Page } from '@playwright/test';

/**
 * Issue #478 — existing users signing in from an invite must return to `/join/:code`.
 *
 * Covers local login (full form submit + redirect) and OIDC (SSO href carries
 * the validated return target). Expired/invalid invites still land back on the
 * join page, which shows the definitive error rather than abandoning the link.
 */

const INVITE_CODE = 'TESTCODE478';
const JOIN_PATH = `/join/${INVITE_CODE}`;
const INVITE_URL = `**/api/v1/invites/${INVITE_CODE}`;
const CAMPAIGN_NAME = 'Issue 478 Campaign';

const INVITE_PREVIEW_BODY = {
  campaignId: 478,
  campaignName: CAMPAIGN_NAME,
  role: 'player',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const ME_BODY = {
  user: {
    id: 478,
    username: 'existing',
    displayName: 'Existing User',
    serverRole: 'user',
    disabled: false,
    accentColor: null,
    textSize: 'default',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
  },
  memberships: [],
};

async function mockSignedOut(page: Page, opts: { oidcEnabled?: boolean } = {}): Promise<void> {
  const oidcEnabled = opts.oidcEnabled ?? false;
  await page.route('**/api/v1/auth/status', (route) =>
    route.fulfill({
      status: 200,
      json: {
        setupRequired: false,
        localLoginEnabled: true,
        signupEnabled: false,
        oidcEnabled,
        oidcProviderName: oidcEnabled ? 'Test IdP' : null,
        version: 'test',
      },
    }),
  );
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({ status: 401, json: { message: 'Unauthorized' } }),
  );
}

test.describe('issue #478 - invite login redirect', () => {
  test('Sign in link carries /join/:code and local login returns to the invite', async ({ page }) => {
    await mockSignedOut(page);
    await page.route(INVITE_URL, (route) => route.fulfill({ status: 200, json: INVITE_PREVIEW_BODY }));

    await page.goto(JOIN_PATH);
    await expect(page.getByRole('heading', { name: `You’re invited to ${CAMPAIGN_NAME}` })).toBeVisible();

    const signIn = page.getByRole('link', { name: 'Sign in' });
    await expect(signIn).toHaveAttribute('href', `/login?redirect=${encodeURIComponent(JOIN_PATH)}`);

    // History-preserving navigation: join remains reachable via Back.
    await signIn.click();
    await expect(page).toHaveURL(new RegExp(`/login\\?redirect=${encodeURIComponent(JOIN_PATH).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    let signedIn = false;
    await page.unroute('**/api/v1/me');
    await page.route('**/api/v1/auth/login', async (route) => {
      signedIn = true;
      await route.fulfill({ status: 200, json: ME_BODY });
    });
    await page.route('**/api/v1/me', (route) =>
      signedIn
        ? route.fulfill({ status: 200, json: ME_BODY })
        : route.fulfill({ status: 401, json: { message: 'Unauthorized' } }),
    );

    await page.getByLabel('Username').fill('existing');
    await page.getByLabel('Password', { exact: true }).fill('password123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`${JOIN_PATH.replace(/\//g, '\\/')}$`));
    await expect(page.getByRole('heading', { name: `You’re invited to ${CAMPAIGN_NAME}` })).toBeVisible();
    await expect(page.getByRole('button', { name: /Join as Existing User/i })).toBeVisible();
  });

  test('OIDC sign-in href forwards the join return target', async ({ page }) => {
    await mockSignedOut(page, { oidcEnabled: true });
    await page.route(INVITE_URL, (route) => route.fulfill({ status: 200, json: INVITE_PREVIEW_BODY }));

    await page.goto(JOIN_PATH);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login\?redirect=/);

    const sso = page.getByRole('link', { name: /Sign in with Test IdP/i });
    await expect(sso).toHaveAttribute(
      'href',
      `/api/v1/auth/oidc/login?redirect=${encodeURIComponent(JOIN_PATH)}`,
    );
  });

  test('expired invite still resumes on the join page after login (definitive error)', async ({ page }) => {
    await mockSignedOut(page);
    await page.route(INVITE_URL, (route) =>
      route.fulfill({ status: 404, json: { message: 'Not found' } }),
    );

    await page.goto(JOIN_PATH);
    const goSignIn = page.getByRole('link', { name: 'Go to sign in' });
    await expect(goSignIn).toHaveAttribute('href', `/login?redirect=${encodeURIComponent(JOIN_PATH)}`);
    await goSignIn.click();

    await page.route('**/api/v1/auth/login', (route) =>
      route.fulfill({ status: 200, json: ME_BODY }),
    );
    let authed = false;
    await page.unroute('**/api/v1/me');
    await page.route('**/api/v1/me', (route) => {
      if (!authed) return route.fulfill({ status: 401, json: { message: 'Unauthorized' } });
      return route.fulfill({ status: 200, json: ME_BODY });
    });

    await page.getByLabel('Username').fill('existing');
    await page.getByLabel('Password', { exact: true }).fill('password123');
    authed = true;
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`${JOIN_PATH.replace(/\//g, '\\/')}$`));
    await expect(
      page.getByRole('alert').filter({ hasText: /invalid or no longer active/i }),
    ).toBeVisible();
  });
});
