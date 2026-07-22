import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('public recap sharing disclosure and controls (#788)', () => {
  test.use({ storageState: stateFor('dm') });

  test('requires deliberate expiry, is member-visible, axe-clean, and mobile-safe', async ({ page, browser }) => {
    const { campaignId, navigation } = seed();
    const sessionId = navigation.sessionId;
    await page.goto(`/c/${campaignId}/sessions?session=${sessionId}`);

    const panel = page.getByTestId('recap-share-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel('Expires')).toHaveValue('7');

    // "Never" is available, but selecting it alone is not enough to mint a
    // forever capability: the explicit acknowledgement gates creation.
    await panel.getByLabel('Expires').selectOption('never');
    const createButton = panel.getByRole('button', { name: 'Create link' });
    await expect(createButton).toBeDisabled();
    const acknowledgement = panel.getByRole('checkbox', { name: /remains public until a DM revokes it/i });
    await acknowledgement.check();
    await expect(createButton).toBeEnabled();

    // Use the conservative finite default for the actual fixture.
    await panel.getByLabel('Expires').selectOption('7');
    await panel.getByLabel('Label').fill('Playwright absent players');
    const [createResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith(`/api/v1/sessions/${sessionId}/shares`) && response.request().method() === 'POST',
      ),
      createButton.click(),
    ]);
    expect(createResponse.status()).toBe(201);
    const created = await createResponse.json() as { share: { id: number } };
    await expect(panel.getByText('Playwright absent players')).toBeVisible();
    await expect(panel.getByText(/Created by dm/i)).toBeVisible();
    await expect(panel.getByText(/Opened 0 times/i)).toBeVisible();
    await expect(panel.getByLabel('Share token display prefix')).toContainText('cf_share_');

    const dmAxe = await new AxeBuilder({ page }).include('[data-testid="recap-share-panel"]').analyze();
    expect(dmAxe.violations).toEqual([]);

    const playerContext = await browser.newContext({
      storageState: stateFor('player'),
      viewport: { width: 375, height: 812 },
    });
    try {
      const playerPage = await playerContext.newPage();
      await playerPage.goto(`/c/${campaignId}/sessions?session=${sessionId}`);
      const memberPanel = playerPage.getByTestId('recap-share-panel');
      await expect(memberPanel).toBeVisible();
      await expect(memberPanel.getByText('Playwright absent players')).toBeVisible();
      await expect(memberPanel.getByText(/Created by dm/i)).toBeVisible();
      await expect(memberPanel.getByRole('button', { name: 'Create link' })).toHaveCount(0);
      await expect(memberPanel.getByRole('button', { name: 'Revoke' })).toHaveCount(0);

      const viewportWidth = await playerPage.evaluate(() => document.documentElement.clientWidth);
      const scrollWidth = await playerPage.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(viewportWidth);
      const playerAxe = await new AxeBuilder({ page: playerPage }).include('[data-testid="recap-share-panel"]').analyze();
      expect(playerAxe.violations).toEqual([]);
    } finally {
      await playerContext.close();
    }

    const oneTimeUrl = panel.locator('code').filter({ hasText: '/share/cf_share_' });
    await expect(oneTimeUrl).toBeVisible();
    const [revokeResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith(`/api/v1/sessions/${sessionId}/shares/${created.share.id}`)
        && response.request().method() === 'DELETE',
      ),
      panel.getByRole('button', { name: 'Revoke' }).click(),
    ]);
    expect(revokeResponse.ok()).toBe(true);
    await expect(oneTimeUrl).toHaveCount(0);

    await page.goto(`/c/${campaignId}/settings`);
    const settings = page.getByTestId('public-recap-sharing-settings');
    await expect(settings).toBeVisible();
    await expect(settings.getByText('enabled', { exact: true })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Disable and revoke all' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Revoke all links' })).toBeVisible();
  });
});
