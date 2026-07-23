import { expect, test, type Page, type Route } from '@playwright/test';
import { CREDS, MONSTERS } from '../global-setup';
import { seed, stateFor } from './seed';

/**
 * Issue #885 — mid-session expiry must bounce the SPA to a session-expired login
 * flow (preserving the deep link), then restart queries + SSE after reauth.
 *
 * Scenarios: background 401 during encounters, uploads, AI stream connect, and
 * campaign-events reconnect after login. Campaign 403 must NOT look like expiry.
 */

const [boss] = MONSTERS;

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockAuthStatus(page: Page) {
  await page.route('**/api/v1/auth/status', (route) =>
    fulfillJson(route, 200, {
      setupRequired: false,
      localLoginEnabled: true,
      signupEnabled: false,
      oidcEnabled: false,
      oidcProviderName: null,
      version: 'test',
    }),
  );
}

/** After first paint: every protected API/SSE response becomes a proven 401. */
async function expireProtectedApi(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/v1/auth/login') || url.includes('/api/v1/auth/status')) {
      return route.fallback();
    }
    if (url.includes('/api/v1/auth/logout')) {
      return route.fulfill({ status: 204, body: '' });
    }
    return fulfillJson(route, 401, { message: 'Unauthorized' });
  });
}

async function signInFromExpiredScreen(page: Page) {
  const localToggle = page.getByRole('button', { name: /local account|username and password/i });
  if (await localToggle.first().isVisible().catch(() => false)) {
    await localToggle.first().click();
  }
  // PasswordInput's reveal toggle also matches getByLabel('Password'); target the textbox.
  await page.getByRole('textbox', { name: 'Username' }).fill(CREDS.dm.username);
  await page.locator('#password').fill(CREDS.dm.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.describe('issue #885 - session expiry reauth', () => {
  test.use({ storageState: stateFor('dm') });

  test('encounter mutation 401 shows session-expired login and restores deep link', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    const deepLink = `/c/${campaignId}/encounters/${encounterId}`;

    await mockAuthStatus(page);
    await page.goto(deepLink);
    await expect(page.getByRole('heading', { name: 'Ambush at the Ember Hearth' })).toBeVisible();

    await expireProtectedApi(page);
    await page.getByRole('button', { name: new RegExp(`Increase ${boss.name}'s HP`) }).first().click();

    await expect(page).toHaveURL(/\/login$/);
    const banner = page.getByTestId('session-expired-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByText('Your session expired', { exact: true })).toBeVisible();

    await page.unroute('**/api/v1/**').catch(() => undefined);
    await mockAuthStatus(page);
    await signInFromExpiredScreen(page);

    await expect(page).toHaveURL(new RegExp(`${deepLink.replace(/\//g, '\\/')}$`));
    await expect(page.getByRole('heading', { name: 'Ambush at the Ember Hearth' })).toBeVisible();
  });

  test('attachment upload 401 clears identity and preserves return path', async ({ page }) => {
    const { campaignId } = seed();
    const deepLink = `/c/${campaignId}`;

    await mockAuthStatus(page);
    await page.goto(deepLink);
    const handouts = page.getByTestId('dashboard-handouts');
    await expect(handouts).toBeVisible();

    // Fail only the multipart upload path used by uploadAttachment (raw fetch).
    await page.route(`**/api/v1/campaigns/${campaignId}/attachments`, async (route) => {
      if (route.request().method() === 'POST') {
        return fulfillJson(route, 401, { message: 'Unauthorized' });
      }
      return route.fallback();
    });

    await handouts.locator('input[type="file"]').setInputFiles({
      name: 'expiry-handout.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('session-expired-banner')).toBeVisible();

    await page.unroute(`**/api/v1/campaigns/${campaignId}/attachments`).catch(() => undefined);
    await mockAuthStatus(page);
    await signInFromExpiredScreen(page);
    await expect(page).toHaveURL(new RegExp(`${deepLink.replace(/\//g, '\\/')}$`));
  });

  test('AI-DM stream 401 (not seat 403) triggers session-expired reauth', async ({ page }) => {
    const { campaignId } = seed();

    await mockAuthStatus(page);
    // Force Driver mode so Layout opens useAiDmStream, then 401 the connect.
    await page.route(`**/api/v1/campaigns/${campaignId}/ai-dm**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/ai-dm/stream')) {
        return fulfillJson(route, 401, { message: 'Unauthorized' });
      }
      if (path.endsWith('/ai-dm') && route.request().method() === 'GET') {
        return fulfillJson(route, 200, {
          campaignId,
          mode: 'driver',
          enabled: true,
          model: 'test',
          instructions: '',
          tokenBudget: 10_000,
          tokensUsed: 0,
          turnCount: 0,
          lastTurnAt: null,
          createdAt: '2026-07-22T00:00:00.000Z',
          updatedAt: '2026-07-22T00:00:00.000Z',
        });
      }
      return route.fallback();
    });

    await page.goto(`/c/${campaignId}`);
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
    await expect(page.getByTestId('session-expired-banner')).toBeVisible();
  });

  test('campaign SSE 403 does not look like session expiry', async ({ page }) => {
    const { campaignId } = seed();

    await mockAuthStatus(page);
    let eventsHits = 0;
    await page.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      eventsHits += 1;
      await fulfillJson(route, 403, { message: 'Forbidden' });
    });

    await page.goto(`/c/${campaignId}`);
    await expect(page.getByTestId('dashboard-handouts')).toBeVisible();
    await expect.poll(() => eventsHits).toBeGreaterThan(0);

    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId('session-expired-banner')).toHaveCount(0);
  });

  test('after reauth, campaign events SSE reconnects', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    const deepLink = `/c/${campaignId}/encounters/${encounterId}`;

    let streamOpens = 0;
    await page.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      streamOpens += 1;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: ': keepalive\n\n',
      });
    });

    await mockAuthStatus(page);
    await page.goto(deepLink);
    await expect(page.getByRole('heading', { name: 'Ambush at the Ember Hearth' })).toBeVisible();
    await expect.poll(() => streamOpens).toBeGreaterThan(0);

    await expireProtectedApi(page);
    await page.getByRole('button', { name: new RegExp(`Increase ${boss.name}'s HP`) }).first().click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('session-expired-banner')).toBeVisible();

    await page.unroute('**/api/v1/**').catch(() => undefined);
    streamOpens = 0;
    await page.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      streamOpens += 1;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: ': keepalive\n\n',
      });
    });
    await mockAuthStatus(page);
    await signInFromExpiredScreen(page);

    await expect(page).toHaveURL(new RegExp(`${deepLink.replace(/\//g, '\\/')}$`));
    await expect.poll(() => streamOpens).toBeGreaterThan(0);
  });
});
