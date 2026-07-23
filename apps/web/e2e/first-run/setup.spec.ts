import { expect, test } from '@playwright/test';

const ADMIN = {
  username: 'first-run-admin',
  displayName: 'First Run Admin',
  password: 'campfire-first-run-admin-1',
} as const;

test('first admin reaches the campaign hub without reload or stale auth routes', async ({ page, browser, baseURL }) => {
  let setupStarted = false;
  const postSetupAuthReads = new Set<string>();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/api/v1/auth/setup') {
      setupStarted = true;
    } else if (
      setupStarted &&
      request.method() === 'GET' &&
      (url.pathname === '/api/v1/me' || url.pathname === '/api/v1/auth/status')
    ) {
      postSetupAuthReads.add(url.pathname);
    }
  });

  // A known previous history entry lets us prove setup completion replaces
  // /setup instead of leaving the sensitive bootstrap form on the Back stack.
  await page.goto('/healthz');
  await page.goto('/login');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Campfire' })).toBeVisible();

  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Display name').fill(ADMIN.displayName);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByLabel('Confirm password', { exact: true }).fill(ADMIN.password);

  const setupResponse = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/auth/setup') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Light the fire' }).click();
  expect((await setupResponse).ok()).toBe(true);

  // No page.reload(): both auth contexts must refresh in-app before the router
  // can render the authenticated campaign hub.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
  await expect(page.getByText('No campaigns yet — light the first fire.')).toBeVisible();
  await expect(
    page.getByText(/Follow a campaign invite, or ask a DM or server admin to add your account/),
  ).toBeVisible();
  expect(postSetupAuthReads).toEqual(new Set(['/api/v1/me', '/api/v1/auth/status']));

  await page.goBack();
  await expect(page).toHaveURL(/\/healthz$/);

  // An authenticated admin cannot reopen either public auth form. Both guards
  // replace the auth route with the campaign hub.
  await page.goto('/setup');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();

  await page.goto('/login');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();

  // Once configured, a signed-out visitor who guesses /setup is sent to the
  // ordinary login screen rather than seeing the first-admin form. Hold /me
  // briefly to prove the configured route renders a neutral state while auth
  // identity is still loading instead of flashing the sensitive setup form.
  const signedOut = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const signedOutPage = await signedOut.newPage();
  await signedOutPage.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setupRequired: false, oidcEnabled: false, signupEnabled: false }),
    });
  });
  let releaseMe!: () => void;
  const meGate = new Promise<void>((resolve) => {
    releaseMe = resolve;
  });
  await signedOutPage.route('**/api/v1/me', async (route) => {
    await meGate;
    await route.continue();
  });
  await signedOutPage.goto('/setup');
  await expect(signedOutPage.getByText('Checking your session…')).toBeVisible();
  await expect(signedOutPage.getByRole('button', { name: 'Light the fire' })).toHaveCount(0);
  releaseMe();
  await expect(signedOutPage).toHaveURL(/\/login$/);
  await expect(signedOutPage.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await signedOut.close();
});

test('OIDC login uses neutral SSO branding and truthful account-versus-campaign copy', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const page = await context.newPage();
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
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Unauthorized' }) });
  });

  await page.goto('/login');
  await expect(page.getByRole('link', { name: 'Sign in with SSO' })).toBeVisible();
  await expect(page.getByText('SSO creates your Campfire account.')).toBeVisible();
  await expect(page.getByText('Campaign access and DM, player, or viewer roles are assigned inside Campfire.')).toBeVisible();
  await expect(page.getByText(/Authentik|Roles come from your campaign groups/)).toHaveCount(0);
  await context.close();
});

test('OIDC login uses the configured provider display name', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        setupRequired: false,
        localLoginEnabled: true,
        signupEnabled: false,
        oidcEnabled: true,
        oidcProviderName: 'Keycloak',
        version: 'test',
      }),
    });
  });
  await page.route('**/api/v1/me', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Unauthorized' }) });
  });

  await page.goto('/login');
  await expect(page.getByRole('link', { name: 'Sign in with Keycloak' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in with SSO' })).toHaveCount(0);
  await context.close();
});

test('successful setup exits safely when the auth-status cache refresh fails', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const page = await context.newPage();
  let configured = false;
  let configuredStatusReads = 0;

  await page.route('**/api/v1/auth/status', async (route) => {
    if (!configured) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ setupRequired: true, oidcEnabled: false, signupEnabled: false }),
      });
      return;
    }

    configuredStatusReads += 1;
    if (configuredStatusReads === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'temporary status failure' }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setupRequired: false, oidcEnabled: false, signupEnabled: false }),
    });
  });
  await page.route('**/api/v1/auth/setup', async (route) => {
    configured = true;
    await route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/v1/me', async (route) => {
    if (!configured) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Unauthorized' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 1,
          username: 'fallback-admin',
          displayName: 'Fallback Admin',
          serverRole: 'admin',
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
  await page.route('**/api/v1/notifications**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('/setup');
  await page.getByLabel('Username').fill('fallback-admin');
  await page.getByLabel('Password', { exact: true }).fill('campfire-fallback-admin-1');
  await page.getByLabel('Confirm password', { exact: true }).fill('campfire-fallback-admin-1');
  await page.getByRole('button', { name: 'Light the fire' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
  expect(configuredStatusReads).toBeGreaterThanOrEqual(2);
  await context.close();
});

test('a browser that loses a concurrent setup claim exits the stale first-run form', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const page = await context.newPage();
  let competingSetupCompleted = false;

  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        setupRequired: !competingSetupCompleted,
        localLoginEnabled: true,
        oidcEnabled: false,
        signupEnabled: false,
      }),
    });
  });
  await page.route('**/api/v1/auth/setup', async (route) => {
    competingSetupCompleted = true;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Setup already completed' }),
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
  await page.getByLabel('Username').fill('setup-race-loser');
  await page.getByLabel('Password', { exact: true }).fill('campfire-race-loser-1');
  await page.getByLabel('Confirm password', { exact: true }).fill('campfire-race-loser-1');

  const setupResponse = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/auth/setup') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Light the fire' }).click();
  expect((await setupResponse).status()).toBe(409);

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Light the fire' })).toHaveCount(0);
  await context.close();
});
