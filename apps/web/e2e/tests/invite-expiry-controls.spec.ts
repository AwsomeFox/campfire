import { expect, test, type Page } from '@playwright/test';

/**
 * Issue #821 — Invite creation: expiry and maximum-use controls.
 *
 * The server already supports `expiresInDays` and `maxUses` on invite creation;
 * this verifies the web form correctly exposes and submits them, previews the
 * policy before generation, and shows remaining uses on live links.
 */

const CAMPAIGN_ID = 821;
const INVITES_URL = `**/api/v1/campaigns/${CAMPAIGN_ID}/invites`;
const ME_URL = '**/api/v1/me';
const MEMBERS_URL = `**/api/v1/campaigns/${CAMPAIGN_ID}/members`;

const ME_BODY = {
  user: { id: 1, username: 'dm', displayName: 'Dungeon Master', serverRole: 'admin', disabled: false },
  memberships: [{ campaignId: CAMPAIGN_ID, role: 'dm' }],
};

const INVITE_STUB = {
  id: 10,
  campaignId: CAMPAIGN_ID,
  code: 'ABC123TEST',
  role: 'player',
  createdByUserId: 1,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  maxUses: 5,
  useCount: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function setupPage(page: Page) {
  await page.route(ME_URL, (route) =>
    route.fulfill({ status: 200, json: ME_BODY }),
  );
  await page.route(MEMBERS_URL, (route) =>
    route.fulfill({ status: 200, json: [{ id: 1, userId: 1, campaignId: CAMPAIGN_ID, role: 'dm', username: 'dm', displayName: 'Dungeon Master', characterId: null, disabled: false }] }),
  );
  await page.route(`**/api/v1/campaigns/${CAMPAIGN_ID}/characters`, (route) =>
    route.fulfill({ status: 200, json: [] }),
  );
  await page.route(`**/api/v1/campaigns/${CAMPAIGN_ID}/audit`, (route) =>
    route.fulfill({ status: 200, json: [] }),
  );
}

test.describe('issue #821 — invite expiry & max-use controls', () => {
  test('form shows expiry and max-use controls', async ({ page }) => {
    await setupPage(page);
    await page.route(INVITES_URL, (route) =>
      route.fulfill({ status: 200, json: [] }),
    );

    await page.goto(`/c/${CAMPAIGN_ID}/members`);

    // Expiry select is present with presets
    const expirySelect = page.locator('#invite-expiry');
    await expect(expirySelect).toBeVisible();
    await expect(expirySelect.locator('option')).toHaveCount(5);
    await expect(expirySelect.locator('option[value="end-of-today"]')).toHaveText('End of today');
    await expect(expirySelect.locator('option[value="24h"]')).toHaveText('24 hours');
    await expect(expirySelect.locator('option[value="7d"]')).toHaveText('7 days');
    await expect(expirySelect.locator('option[value="30d"]')).toHaveText('30 days');
    await expect(expirySelect.locator('option[value="custom"]')).toHaveText('Custom…');

    // Max-uses select is present with presets
    const maxUsesSelect = page.locator('#invite-max-uses');
    await expect(maxUsesSelect).toBeVisible();
    await expect(maxUsesSelect.locator('option[value="unlimited"]')).toHaveText('Unlimited');
    await expect(maxUsesSelect.locator('option[value="1"]')).toHaveText('1 use');
    await expect(maxUsesSelect.locator('option[value="5"]')).toHaveText('5 uses');
    await expect(maxUsesSelect.locator('option[value="10"]')).toHaveText('10 uses');
    await expect(maxUsesSelect.locator('option[value="custom"]')).toHaveText('Custom…');
  });

  test('custom expiry shows a date picker', async ({ page }) => {
    await setupPage(page);
    await page.route(INVITES_URL, (route) =>
      route.fulfill({ status: 200, json: [] }),
    );

    await page.goto(`/c/${CAMPAIGN_ID}/members`);

    // Initially no date input
    await expect(page.getByLabel('Custom expiry date')).toHaveCount(0);

    // Select custom
    await page.locator('#invite-expiry').selectOption('custom');

    // Date picker appears
    const datePicker = page.getByLabel('Custom expiry date');
    await expect(datePicker).toBeVisible();
    await expect(datePicker).toHaveAttribute('type', 'date');
  });

  test('custom max uses shows a number input', async ({ page }) => {
    await setupPage(page);
    await page.route(INVITES_URL, (route) =>
      route.fulfill({ status: 200, json: [] }),
    );

    await page.goto(`/c/${CAMPAIGN_ID}/members`);

    // Initially no custom number input
    await expect(page.getByLabel('Custom max uses')).toHaveCount(0);

    // Select custom max uses
    await page.locator('#invite-max-uses').selectOption('custom');

    // Number input appears
    const numberInput = page.getByLabel('Custom max uses');
    await expect(numberInput).toBeVisible();
    await expect(numberInput).toHaveAttribute('type', 'number');
    await expect(numberInput).toHaveAttribute('min', '1');
    await expect(numberInput).toHaveAttribute('max', '1000');
  });

  test('preview shows correct values', async ({ page }) => {
    await setupPage(page);
    await page.route(INVITES_URL, (route) =>
      route.fulfill({ status: 200, json: [] }),
    );

    await page.goto(`/c/${CAMPAIGN_ID}/members`);

    const preview = page.getByTestId('invite-preview');
    await expect(preview).toBeVisible();

    // Default: player, 7 days, unlimited
    await expect(preview).toContainText('Player');
    await expect(preview).toContainText('7 days');
    await expect(preview).toContainText('Unlimited');
    await expect(preview).toContainText('Anyone with this link can join');

    // Change role to viewer
    await page.locator('#invite-role').selectOption('viewer');
    await expect(preview).toContainText('Viewer');

    // Change expiry to 24h
    await page.locator('#invite-expiry').selectOption('24h');
    await expect(preview).toContainText('24 hours');

    // Change max uses to 5
    await page.locator('#invite-max-uses').selectOption('5');
    await expect(preview).toContainText('5 uses');
  });

  test('API call includes expiresInDays and maxUses', async ({ page }) => {
    await setupPage(page);
    await page.route(INVITES_URL, (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 200, json: [] });
      }
      // POST - return a created invite
      return route.fulfill({ status: 201, json: INVITE_STUB });
    });

    await page.goto(`/c/${CAMPAIGN_ID}/members`);

    // Configure: 24h expiry, 5 uses
    await page.locator('#invite-expiry').selectOption('24h');
    await page.locator('#invite-max-uses').selectOption('5');

    // Intercept the POST request
    const requestPromise = page.waitForRequest(
      (req) => req.url().includes('/invites') && req.method() === 'POST',
    );

    await page.getByRole('button', { name: 'Generate invite link' }).click();

    const request = await requestPromise;
    const body = request.postDataJSON();
    expect(body.role).toBe('player');
    expect(body.expiresInDays).toBe(1);
    expect(body.maxUses).toBe(5);
  });

  test('remaining uses displayed for active invites', async ({ page }) => {
    await setupPage(page);
    await page.route(INVITES_URL, (route) =>
      route.fulfill({ status: 200, json: [INVITE_STUB] }),
    );

    await page.goto(`/c/${CAMPAIGN_ID}/members`);

    // The invite shows "3 of 5 remaining" (maxUses 5, useCount 2 → 3 remaining)
    const inviteRow = page.getByTestId('invite-row');
    await expect(inviteRow).toBeVisible();
    const status = page.getByTestId('invite-status');
    await expect(status).toContainText('3 of 5 remaining');
  });

  test('unlimited invite shows use count instead of remaining', async ({ page }) => {
    await setupPage(page);
    const unlimitedInvite = { ...INVITE_STUB, maxUses: null, useCount: 4 };
    await page.route(INVITES_URL, (route) =>
      route.fulfill({ status: 200, json: [unlimitedInvite] }),
    );

    await page.goto(`/c/${CAMPAIGN_ID}/members`);

    const status = page.getByTestId('invite-status');
    await expect(status).toContainText('used 4×');
  });

  test('event recommendation shown for short-lived + limited presets', async ({ page }) => {
    await setupPage(page);
    await page.route(INVITES_URL, (route) =>
      route.fulfill({ status: 200, json: [] }),
    );

    await page.goto(`/c/${CAMPAIGN_ID}/members`);

    // Default: 7d + unlimited → no recommendation
    await expect(page.getByTestId('event-recommendation')).toHaveCount(0);

    // Set 24h + 5 uses → recommendation appears
    await page.locator('#invite-expiry').selectOption('24h');
    await page.locator('#invite-max-uses').selectOption('5');
    await expect(page.getByTestId('event-recommendation')).toBeVisible();
    await expect(page.getByTestId('event-recommendation')).toContainText('Recommended for events');
  });

  test('accessibility: labels and keyboard navigation', async ({ page }) => {
    await setupPage(page);
    await page.route(INVITES_URL, (route) =>
      route.fulfill({ status: 200, json: [] }),
    );

    await page.goto(`/c/${CAMPAIGN_ID}/members`);

    // All form controls have associated labels
    await expect(page.locator('label[for="invite-role"]')).toBeVisible();
    await expect(page.locator('label[for="invite-expiry"]')).toBeVisible();
    await expect(page.locator('label[for="invite-max-uses"]')).toBeVisible();

    // Preview section has aria-label
    const preview = page.getByLabel('Invite preview');
    await expect(preview).toBeVisible();

    // Tab through controls
    await page.locator('#invite-role').focus();
    await expect(page.locator('#invite-role')).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.locator('#invite-expiry')).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.locator('#invite-max-uses')).toBeFocused();
  });
});
