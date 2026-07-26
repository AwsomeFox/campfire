import { expect, test, type Page } from '@playwright/test';
import { stateFor } from './seed';

/**
 * Issue #539 — the New Campaign wizard must persist the selected rule pack on
 * POST (atomic create) and must not navigate when that write fails.
 */

const E2E_PACK_NAME = 'E2E Open5e action fixtures';
const E2E_PACK_SLUG = 'e2e-open5e-actions';

async function routeEmptyRulePacks(page: Page) {
  await page.route('**/api/v1/rules/packs', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

async function openRulesetStepWithEmptyPacks(page: Page, campaignName: string) {
  await routeEmptyRulePacks(page);
  await page.goto('/?newCampaign=1');
  await page.getByLabel('Name').fill(campaignName);
  await page.getByRole('button', { name: /Next: rule system/ }).click();
  await expect(page.getByText('No rule systems are installed on this server yet.')).toBeVisible();
}

test.describe('New campaign rule system persistence (#539)', () => {
  test.use({ storageState: stateFor('dm') });

  test('POST includes ruleSystem and settings reflect the installed pack', async ({ page }) => {
    const campaignName = `E2E539 persist ${Date.now()}`;

    await page.goto('/?newCampaign=1');
    await page.getByLabel('Name').fill(campaignName);
    await page.getByRole('button', { name: /Next: rule system/ }).click();
    await page.getByRole('radio', { name: E2E_PACK_NAME }).click();

    const createReq = page.waitForRequest(
      (req) =>
        req.url().includes('/api/v1/campaigns') &&
        req.method() === 'POST' &&
        (req.postDataJSON() as { ruleSystem?: string })?.ruleSystem === E2E_PACK_SLUG,
    );
    const createRes = page.waitForResponse(
      (res) => res.url().includes('/api/v1/campaigns') && res.request().method() === 'POST' && res.status() === 201,
    );

    await page.getByRole('button', { name: 'Create campaign' }).click();
    await createReq;
    const response = await createRes;
    const body = (await response.json()) as { id: number; ruleSystem: string };
    expect(body.ruleSystem).toBe(E2E_PACK_SLUG);

    await expect(page).toHaveURL(new RegExp(`/c/${body.id}$`));

    await page.goto(`/c/${body.id}/settings`);
    const ruleCard = page.locator('.card').filter({ hasText: 'Rule system' }).first();
    await expect(ruleCard.getByText(E2E_PACK_NAME, { exact: true })).toBeVisible();
    await expect(ruleCard.getByText('pack installed')).toBeVisible();

    await page.request.delete(`/api/v1/campaigns/${body.id}`).catch(() => {});
  });

  test('a failed ruleset create shows an error and keeps the wizard open', async ({ page }) => {
    const failMessage = 'E2E539 simulated ruleSystem write failure';

    await page.route('**/api/v1/campaigns', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const payload = route.request().postDataJSON() as { ruleSystem?: string };
      if (!payload?.ruleSystem) return route.continue();
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: failMessage, statusCode: 400 }),
      });
    });

    await page.goto('/?newCampaign=1');
    await page.getByLabel('Name').fill(`E2E539 fail ${Date.now()}`);
    await page.getByRole('button', { name: /Next: rule system/ }).click();
    await page.getByRole('radio', { name: E2E_PACK_NAME }).click();
    await page.getByRole('button', { name: 'Create campaign' }).click();

    await expect(page.getByText(failMessage)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'New campaign' })).toBeVisible();
    await expect(page).not.toHaveURL(/\/c\/\d+$/);
    await expect(page.getByRole('button', { name: 'Create campaign' })).toBeEnabled();
  });

  test('homebrew create discloses fallbacks and omits ruleSystem instead of assigning 5e', async ({ page }) => {
    const campaignName = `E2E508 homebrew ${Date.now()}`;
    await openRulesetStepWithEmptyPacks(page, campaignName);

    await expect(page.getByRole('radio', { name: /None \/ homebrew/ })).toBeVisible();
    await expect(page.getByText('Before you create with None / homebrew')).toBeVisible();
    await expect(page.getByText('does not select a 5e rules pack')).toBeVisible();
    await expect(page.getByText('D&D Beyond import:', { exact: true })).toBeVisible();
    await expect(page.getByText('Change later in Settings')).toBeVisible();

    const createReq = page.waitForRequest((req) => {
      if (!req.url().includes('/api/v1/campaigns') || req.method() !== 'POST') return false;
      const payload = req.postDataJSON() as { ruleSystem?: string };
      return !Object.prototype.hasOwnProperty.call(payload, 'ruleSystem');
    });
    const createRes = page.waitForResponse(
      (res) => res.url().includes('/api/v1/campaigns') && res.request().method() === 'POST' && res.status() === 201,
    );

    await page.getByRole('button', { name: 'Create campaign' }).click();
    await createReq;
    const response = await createRes;
    const body = (await response.json()) as { id: number; ruleSystem: string };
    expect(body.ruleSystem).toBe('');

    await page.request.delete(`/api/v1/campaigns/${body.id}`).catch(() => {});
  });
});

test.describe('New campaign empty-pack guidance (#508)', () => {
  test('server admins get the setup route plus explicit homebrew consequences', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('admin') });
    const page = await context.newPage();
    await openRulesetStepWithEmptyPacks(page, 'E2E508 admin empty packs');

    const rulesLink = page.getByRole('link', { name: 'Server admin → Rule systems' });
    await expect(rulesLink).toHaveAttribute('href', '/admin/rules?returnTo=%2F%3FnewCampaign%3D1');
    await expect(page.getByRole('radio', { name: /None \/ homebrew/ })).toBeVisible();
    await expect(page.getByText('Before you create with None / homebrew')).toBeVisible();
    await expect(page.getByText('Combat math:', { exact: true })).toBeVisible();
    await expect(page.getByText('Encounter generation:', { exact: true })).toBeVisible();
    await expect(page.getByText('AI rules context:', { exact: true })).toBeVisible();

    await context.close();
  });

  test('non-admin DMs get ask-admin copy without an admin link', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('dm') });
    const page = await context.newPage();
    await openRulesetStepWithEmptyPacks(page, 'E2E508 dm empty packs');

    await expect(page.getByText('Ask a server admin to install a rule system', { exact: false })).toBeVisible();
    await expect(page.getByText('Suggested request:', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Server admin → Rule systems' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /None \/ homebrew/ })).toBeVisible();

    await context.close();
  });
});
