import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Route } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('AI provider safe removal', () => {
  test.use({ storageState: stateFor('admin') });

  test('server removal is keyboard-safe, stale-safe, persistently announced, and axe-clean', async ({ page }) => {
    const originalKey = 'pw-server-removal-key-never-render-7551';
    const rotatedKey = 'pw-server-removal-rotated-never-render-7552';
    const put = await page.request.put('/api/v1/settings/ai-provider', {
      data: { providerType: 'openai', model: 'gpt-removal-ui', apiKey: originalKey },
    });
    expect(put.ok()).toBeTruthy();

    await page.goto('/admin/ai');
    const review = page.getByRole('button', { name: 'Review removal' });
    await expect(review).toBeVisible();
    await review.focus();
    await page.keyboard.press('Enter');

    let dialog = page.getByRole('dialog', { name: 'Remove server default?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/removing the server default/i)).toContainText('openai / gpt-removal-ui');
    await expect(dialog.getByText(/The stored API key will be permanently deleted/)).toContainText(
      'cannot display, restore, or recover',
    );
    await expect(dialog.getByText(/Affected campaigns/)).toBeVisible();
    await expect(dialog.getByText(/AI becomes disabled/).first()).toBeVisible();
    await expect(page.getByText(originalKey)).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Remove server default' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

    const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(accessibility.violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(review).toBeFocused();

    // Hold the destructive request to make the persistent pending announcement observable,
    // then fail it. The dialog and active provider must remain intact.
    await review.click();
    dialog = page.getByRole('dialog', { name: 'Remove server default?' });
    let releaseFailure: (() => void) | undefined;
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const failDelete = async (route: Route) => {
      if (route.request().method() !== 'DELETE') {
        await route.continue();
        return;
      }
      await failureGate;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Synthetic removal failure' }),
      });
    };
    await page.route('**/api/v1/settings/ai-provider', failDelete);
    await dialog.getByRole('button', { name: 'Remove server default' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Removing the server default…');
    await expect(dialog.getByRole('button', { name: 'Working…' })).toBeDisabled();
    releaseFailure?.();
    await expect(dialog.getByRole('alert')).toContainText('Synthetic removal failure');
    await expect(dialog.getByRole('alert')).toContainText('current configuration is still active');
    await expect(dialog).toBeVisible();
    expect((await page.request.get('/api/v1/settings/ai-provider')).ok()).toBeTruthy();
    await page.unroute('**/api/v1/settings/ai-provider', failDelete);

    // Change the target after the reviewed preview. The server rejects the stale
    // revision, the UI refreshes the authoritative preview, and the rotated row remains.
    const rotate = await page.request.put('/api/v1/settings/ai-provider', {
      data: { providerType: 'anthropic', model: 'claude-removal-ui', apiKey: rotatedKey },
    });
    expect(rotate.ok()).toBeTruthy();
    await dialog.getByRole('button', { name: 'Remove server default' }).click();
    await expect(dialog.getByRole('alert')).toContainText('impact changed');
    await expect(dialog.getByText(/removing the server default/i)).toContainText('anthropic / claude-removal-ui');
    const active = await page.request.get('/api/v1/settings/ai-provider');
    expect(await active.json()).toMatchObject({ providerType: 'anthropic', model: 'claude-removal-ui' });
    await expect(page.getByText(rotatedKey)).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Remove server default' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Server default removed successfully.');
    const removed = await page.request.get('/api/v1/settings/ai-provider');
    expect((await removed.text()).trim()).toBe('');
  });

  test('campaign override previews server fallback and confirms by touch in a mobile viewport', async ({ page, browser }) => {
    const { campaignId } = seed();
    const serverKey = 'pw-mobile-server-fallback-never-render-7553';
    const serverPut = await page.request.put('/api/v1/settings/ai-provider', {
      data: { providerType: 'openai', model: 'gpt-mobile-fallback', apiKey: serverKey },
    });
    expect(serverPut.ok()).toBeTruthy();

    const context = await browser.newContext({
      storageState: stateFor('dm'),
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const mobile = await context.newPage();
    const campaignKey = 'pw-mobile-anthropic-key-never-render-7554';
    const campaignPut = await mobile.request.put(`/api/v1/campaigns/${campaignId}/ai-provider`, {
      data: { providerType: 'anthropic', model: 'claude-mobile-current', apiKey: campaignKey },
    });
    expect(campaignPut.ok()).toBeTruthy();

    await mobile.goto(`/c/${campaignId}/settings`);
    await mobile.getByRole('button', { name: /Advanced: override provider for this campaign/ }).tap();
    const form = mobile.getByTestId('ai-provider-form-campaign');
    const review = form.getByRole('button', { name: 'Review removal' });
    await expect(review).toBeVisible();
    const reviewBox = await review.boundingBox();
    expect(reviewBox?.height).toBeGreaterThanOrEqual(44);
    await review.tap();

    const dialog = mobile.getByRole('dialog', { name: 'Remove campaign override?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/removing the campaign override/i)).toContainText('anthropic / claude-mobile-current');
    await expect(dialog.getByText(/Falls back to the server default/)).toContainText('openai / gpt-mobile-fallback');
    await expect(dialog.getByText(/Budget and usage are unchanged/)).toBeVisible();
    await expect(mobile.getByText(campaignKey)).toHaveCount(0);
    await expect(mobile.getByText(serverKey)).toHaveCount(0);

    for (const buttonName of ['Cancel', 'Remove campaign override']) {
      const box = await dialog.getByRole('button', { name: buttonName }).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
    const viewport = await mobile.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox?.y).toBeGreaterThanOrEqual(0);
    expect((dialogBox?.y ?? 0) + (dialogBox?.height ?? 0)).toBeLessThanOrEqual(844);
    const accessibility = await new AxeBuilder({ page: mobile }).include('[role="dialog"]').analyze();
    expect(accessibility.violations).toEqual([]);

    await dialog.getByRole('button', { name: 'Remove campaign override' }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(form.getByRole('status')).toHaveText('Campaign override removed successfully.');
    const effective = await mobile.request.get(`/api/v1/campaigns/${campaignId}/ai-provider/effective`);
    expect(await effective.json()).toMatchObject({ source: 'server', providerType: 'openai', model: 'gpt-mobile-fallback' });
    await context.close();

    const preview = await page.request.get('/api/v1/settings/ai-provider/removal-impact');
    expect(preview.ok()).toBeTruthy();
    const cleanup = await page.request.delete('/api/v1/settings/ai-provider', {
      data: { impactRevision: (await preview.json()).impactRevision },
    });
    expect(cleanup.ok()).toBeTruthy();
  });
});
