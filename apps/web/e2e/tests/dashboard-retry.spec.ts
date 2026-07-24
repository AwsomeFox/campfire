import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #691 — dashboard Retry must re-issue the failed request.
 *
 * HandoutsCard and RegionMap previously wired `onRetry={() => setError(null)}`,
 * which hid the alert without contacting the server. These cases drive a first
 * failure, click Retry, and assert a second network attempt.
 */

async function pinSeedLocation(page: Page, locationId: number, mapX = 40, mapY = 40) {
  const res = await page.context().request.patch(`/api/v1/locations/${locationId}`, {
    data: { mapX, mapY },
  });
  expect(res.ok()).toBeTruthy();
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function ensureCampaignMap(page: Page, campaignId: number) {
  const upload = await page.context().request.post(`/api/v1/campaigns/${campaignId}/attachments`, {
    multipart: {
      kind: 'map',
      file: {
        name: 'world-691.png',
        mimeType: 'image/png',
        buffer: TINY_PNG,
      },
    },
  });
  expect(upload.ok()).toBeTruthy();
  const attachment = await upload.json();
  const patch = await page.context().request.patch(`/api/v1/campaigns/${campaignId}`, {
    data: { mapAttachmentId: attachment.id },
  });
  expect(patch.ok()).toBeTruthy();
}

test.describe('issue #691 - dashboard error retry', () => {
  test.use({ storageState: stateFor('dm') });

  test('HandoutsCard Retry re-fetches attachments after a transient failure', async ({ page }) => {
    const { campaignId } = seed();
    const attachmentsUrl = `**/api/v1/campaigns/${campaignId}/attachments`;

    let attempts = 0;
    await page.route(attachmentsUrl, async (route) => {
      if (route.request().method() !== 'GET') {
        return route.fallback();
      }
      attempts += 1;
      if (attempts === 1) {
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Handouts temporarily unavailable' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.goto(`/c/${campaignId}`);

    const handouts = page.getByTestId('dashboard-handouts');
    await expect(handouts).toBeVisible();
    const alert = handouts.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Handouts temporarily unavailable|Couldn't load handouts/i);

    const retry = alert.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    expect(attempts).toBe(1);

    await retry.click();
    await expect.poll(() => attempts).toBe(2);
    await expect(handouts.getByRole('alert')).toHaveCount(0);
    await expect(handouts.getByText(/No handouts yet/i)).toBeVisible();
  });

  test('RegionMap Retry re-issues the failed pin save', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await ensureCampaignMap(page, campaignId);
    await pinSeedLocation(page, navigation.locationId);

    let pinAttempts = 0;
    await page.route(`**/api/v1/locations/${navigation.locationId}`, async (route) => {
      if (route.request().method() !== 'PATCH') {
        return route.fallback();
      }
      pinAttempts += 1;
      if (pinAttempts === 1) {
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Pin save unavailable' }),
        });
      }
      return route.fallback();
    });

    await page.goto(`/c/${campaignId}`);
    const mapCard = page.getByTestId('dashboard-map');
    await expect(mapCard).toBeVisible();

    await mapCard.getByRole('button', { name: /Move .+ pin/ }).first().click();
    const xInput = mapCard.getByLabel('Horizontal position (%)');
    await expect(xInput).toBeVisible();
    await xInput.fill('55');
    await mapCard.getByRole('button', { name: 'Save' }).click();

    const alert = mapCard.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Pin save unavailable|Couldn't move the pin/i);
    expect(pinAttempts).toBe(1);

    const retry = alert.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    await retry.click();

    await expect.poll(() => pinAttempts).toBe(2);
    await expect(mapCard.getByRole('alert')).toHaveCount(0);
  });

  test('RegionMap map-uploader error clears a stale pin Retry action', async ({ page }) => {
    const { campaignId, navigation } = seed();
    // Clear any map left by prior cases so DmMapUploader (not MapUploadButton) owns the input.
    const clearMap = await page.context().request.patch(`/api/v1/campaigns/${campaignId}`, {
      data: { mapAttachmentId: null },
    });
    expect(clearMap.ok()).toBeTruthy();
    await pinSeedLocation(page, navigation.locationId);

    let pinAttempts = 0;
    await page.route(`**/api/v1/locations/${navigation.locationId}`, async (route) => {
      if (route.request().method() !== 'PATCH') {
        return route.fallback();
      }
      pinAttempts += 1;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Pin save unavailable' }),
      });
    });

    await page.goto(`/c/${campaignId}`);
    const mapCard = page.getByTestId('dashboard-map');
    await expect(mapCard).toBeVisible();

    await mapCard.getByRole('button', { name: /Move .+ pin/ }).first().click();
    await mapCard.getByLabel('Horizontal position (%)').fill('55');
    await mapCard.getByRole('button', { name: 'Save' }).click();

    const alert = mapCard.getByRole('alert');
    await expect(alert).toContainText(/Pin save unavailable|Couldn't move the pin/i);
    await expect(alert.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(pinAttempts).toBe(1);

    // Validation failure updates the alert via onError but must not keep the pin retry.
    const gif = Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      'base64',
    );
    await mapCard.locator('input[type="file"]').setInputFiles({
      name: 'not-a-map.gif',
      mimeType: 'image/gif',
      buffer: gif,
    });

    await expect(alert).toContainText(/Unsupported file type/i);
    await expect(alert.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    expect(pinAttempts).toBe(1);
  });
});
