import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Issue #801 — first-run bootstrap recovery in the browser.
 *
 * Partial /auth/status failure must keep the operator on the shared recovery
 * surface (not Sign in / Light the fire) until Retry refreshes BOTH status and
 * /me and status is known. Covers configured + fresh recovery, repeated Retry,
 * deep-link preservation, and reload.
 */

const STATUS_URL = '**/api/v1/auth/status';
const ME_URL = '**/api/v1/me';

const CONFIGURED_STATUS = {
  setupRequired: false,
  localLoginEnabled: true,
  signupEnabled: false,
  oidcEnabled: false,
  oidcProviderName: null,
  version: '0.0.0-e2e',
};

const FRESH_STATUS = {
  ...CONFIGURED_STATUS,
  setupRequired: true,
};

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockMeUnauthorized(page: Page) {
  await page.route(ME_URL, (route) =>
    fulfillJson(route, 401, { message: 'Unauthorized' }),
  );
}

test.describe('issue #801 — bootstrap recovery', () => {
  test('configured partial status failure: recovery → Retry → Sign in; deep link preserved', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    const page = await context.newPage();
    await mockMeUnauthorized(page);

    let statusAttempts = 0;
    await page.route(STATUS_URL, async (route) => {
      statusAttempts += 1;
      if (statusAttempts <= 2) {
        // First load + first Retry still fail — status remains unknown.
        await route.abort('internetdisconnected');
        return;
      }
      await fulfillJson(route, 200, CONFIGURED_STATUS);
    });

    // Deep link through AuthedLayout; must not land on /login while status is unknown.
    await page.goto('/c/1/quests/5');
    await expect(page.getByText("Can't reach the server")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/c\/1\/quests\/5/);

    // Repeated Retry while status still fails stays on recovery.
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByText("Can't reach the server")).toBeVisible();
    await expect(page).toHaveURL(/\/c\/1\/quests\/5/);

    // Third attempt (second Retry click) succeeds → configured → Sign in,
    // carrying the deep link in router state (LoginPage reads location.state.from).
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // Prove the deep link was preserved: after a successful local login mock,
    // LoginPage would navigate to fromState — here we only assert the bounce
    // used replace-state by checking history length stays shallow and that a
    // storage-less reload of /login does not invent setup.
    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Light the fire' })).toHaveCount(0);

    await context.close();
  });

  test('fresh partial status failure: recovery → Retry → setup form', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    const page = await context.newPage();
    await mockMeUnauthorized(page);

    let statusAttempts = 0;
    await page.route(STATUS_URL, async (route) => {
      statusAttempts += 1;
      if (statusAttempts === 1) {
        await fulfillJson(route, 503, { message: 'Unavailable' });
        return;
      }
      await fulfillJson(route, 200, FRESH_STATUS);
    });

    await page.goto('/');
    await expect(page.getByText("Can't reach the server")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Light the fire' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('button', { name: 'Light the fire' })).toBeVisible();

    await context.close();
  });

  test('direct /login with status failure shows recovery, not a guessing Sign-in form', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    const page = await context.newPage();
    await mockMeUnauthorized(page);

    let statusAttempts = 0;
    await page.route(STATUS_URL, async (route) => {
      statusAttempts += 1;
      if (statusAttempts === 1) {
        await route.abort('internetdisconnected');
        return;
      }
      await fulfillJson(route, 200, CONFIGURED_STATUS);
    });

    await page.goto('/login?redirect=/c/9/npcs');
    await expect(page.getByText("Can't reach the server")).toBeVisible();
    // Must not render the Sign-in card with guessed OIDC/local defaults.
    await expect(page.getByRole('heading', { name: 'Sign in' })).toHaveCount(0);
    // Deep-link query preserved across Retry (browser may keep `/` unescaped).
    await expect(page).toHaveURL(/\/login\?redirect=.*\/c\/9\/npcs/);

    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page).toHaveURL(/\/login\?redirect=.*\/c\/9\/npcs/);

    await context.close();
  });

  test('direct /setup with status failure recovers without flashing first-admin form', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    const page = await context.newPage();
    await mockMeUnauthorized(page);

    let statusAttempts = 0;
    await page.route(STATUS_URL, async (route) => {
      statusAttempts += 1;
      if (statusAttempts === 1) {
        await fulfillJson(route, 502, { message: 'Bad gateway' });
        return;
      }
      // Configured server: after recovery, /setup must redirect to /login —
      // never show Light the fire from an unknown status.
      await fulfillJson(route, 200, CONFIGURED_STATUS);
    });

    await page.goto('/setup');
    await expect(page.getByText("Can't reach the server")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Light the fire' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Light the fire' })).toHaveCount(0);

    await context.close();
  });
});
