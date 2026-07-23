import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stateFor } from './seed';

function campaign(id: number, name: string) {
  return {
    id,
    name,
    description: '',
    status: 'active',
    currentLocationId: null,
    dangerLevel: 'low',
    dmControlsProgression: false,
    sessionCount: 0,
    latestSessionNumber: 0,
    ruleSystem: '',
    mapAttachmentId: null,
    storageQuotaBytes: null,
    deletedAt: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
  };
}

async function mockCampaignList(page: Page, campaigns: ReturnType<typeof campaign>[]) {
  await page.route('**/api/v1/campaigns', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(campaigns) });
  });
}

test.describe('admin campaign export accessibility', () => {
  test.use({ storageState: stateFor('admin') });

  test('labels loading and many-campaign states, supports keyboard selection, and is axe-clean', async ({ page }) => {
    let releaseCampaigns!: () => void;
    const campaignsReady = new Promise<void>((resolve) => {
      releaseCampaigns = resolve;
    });
    const campaigns = [campaign(101, 'Cinderhaven'), campaign(202, 'Shattered Coast'), campaign(303, 'Night Market')];

    await page.route('**/api/v1/campaigns', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await campaignsReady;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(campaigns) });
    });

    await page.goto('/admin/storage');

    const card = page.locator('.backup-export-card');
    const selector = card.getByRole('combobox', { name: 'Campaign to export' });
    await expect(card.getByText('Campaign to export')).toBeVisible();
    await expect(card.getByRole('status')).toHaveText('Loading campaigns…');
    await expect(selector).toBeDisabled();
    await expect(selector.locator('option')).toHaveText('Loading campaigns…');

    releaseCampaigns();
    await expect(selector).toBeEnabled();
    await expect(selector).toHaveValue('101');
    await expect(selector.locator('option')).toHaveCount(3);
    await expect(selector).toHaveAccessibleDescription(/Exports include DM-only campaign data/);

    const firstJson = card.getByRole('link', { name: 'Download Cinderhaven as a JSON export' });
    const firstMarkdown = card.getByRole('link', { name: 'Download Cinderhaven as a Markdown zip' });
    await expect(card.getByRole('group', { name: 'Campaign export downloads' })).toBeVisible();
    await expect(firstJson).toHaveAttribute('href', '/api/v1/campaigns/101/export?format=json');
    await expect(firstMarkdown).toHaveAttribute('href', '/api/v1/campaigns/101/export?format=mdzip');
    await expect(firstJson).toHaveAccessibleDescription(/complete, machine-readable.*DM-only campaign data/i);
    await expect(firstMarkdown).toHaveAccessibleDescription(/Readable Markdown files.*DM-only campaign data/i);

    await selector.focus();
    await expect(selector).toBeFocused();
    // Native selects use type-ahead on every desktop platform, avoiding
    // platform-specific differences in whether ArrowDown opens or commits.
    await page.keyboard.press('s');
    await expect(selector).toHaveValue('202');

    const selectedJson = card.getByRole('link', { name: 'Download Shattered Coast as a JSON export' });
    const selectedMarkdown = card.getByRole('link', { name: 'Download Shattered Coast as a Markdown zip' });
    await expect(selectedJson).toHaveAttribute('href', '/api/v1/campaigns/202/export?format=json');
    await expect(selectedMarkdown).toHaveAttribute('href', '/api/v1/campaigns/202/export?format=mdzip');

    await page.keyboard.press('Tab');
    await expect(selectedJson).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(selectedMarkdown).toBeFocused();

    const accessibilityScan = await new AxeBuilder({ page }).include('.backup-export-card').analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });

  test('represents zero campaigns without exposing enabled download actions', async ({ page }) => {
    await mockCampaignList(page, []);
    await page.goto('/admin/storage');

    const card = page.locator('.backup-export-card');
    const selector = card.getByRole('combobox', { name: 'Campaign to export' });
    await expect(selector).toBeDisabled();
    await expect(selector.locator('option')).toHaveText('No campaigns available');

    for (const action of [
      card.getByRole('link', { name: 'JSON export unavailable: no campaign is available' }),
      card.getByRole('link', { name: 'Markdown zip unavailable: no campaign is available' }),
    ]) {
      await expect(action).toHaveAttribute('aria-disabled', 'true');
      await expect(action).not.toHaveAttribute('href', /.+/);
      await expect(action).toHaveAttribute('tabindex', '-1');
    }
  });

  test('keeps one campaign and both formats truthful in a narrow reflow', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await mockCampaignList(page, [campaign(404, 'The Only Road')]);
    await page.goto('/admin/storage');

    const card = page.locator('.backup-export-card');
    const selector = card.getByRole('combobox', { name: 'Campaign to export' });
    await expect(selector).toBeEnabled();
    await expect(selector.locator('option')).toHaveCount(1);
    await expect(selector).toHaveValue('404');
    await expect(card.getByRole('link', { name: 'Download The Only Road as a JSON export' })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Download The Only Road as a Markdown zip' })).toBeVisible();

    const viewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);

    const actionBoxes = await card.getByRole('link').evaluateAll((actions) =>
      actions.map((action) => {
        const box = action.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width };
      }),
    );
    for (const box of actionBoxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(viewport.width);
      expect(box.width).toBeGreaterThan(0);
    }
  });

  test('announces campaign load errors and retries successfully', async ({ page }) => {
    let failCampaignRequests = true;
    let campaignRequestCount = 0;
    await page.route('**/api/v1/campaigns', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      campaignRequestCount += 1;
      if (failCampaignRequests) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Campaign service unavailable.' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([campaign(505, 'Recovered Realms')]),
      });
    });

    await page.goto('/admin/storage');

    const card = page.locator('.backup-export-card');
    const alert = card.getByRole('alert');
    await expect(alert).toContainText('Campaign service unavailable.');
    const retry = alert.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    await expect(card.getByRole('combobox', { name: 'Campaign to export' })).toBeDisabled();
    await expect(card.getByRole('link', { name: 'JSON export unavailable: campaigns could not be loaded' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    failCampaignRequests = false;
    await retry.focus();
    await page.keyboard.press('Enter');

    await expect(alert).toBeHidden();
    await expect(card.getByRole('combobox', { name: 'Campaign to export' })).toHaveValue('505');
    await expect(card.getByRole('link', { name: 'Download Recovered Realms as a JSON export' })).toHaveAttribute(
      'href',
      '/api/v1/campaigns/505/export?format=json',
    );
    expect(campaignRequestCount).toBeGreaterThanOrEqual(2);
  });
});
