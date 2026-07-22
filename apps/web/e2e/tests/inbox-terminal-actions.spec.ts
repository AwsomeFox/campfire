import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('scribe inbox terminal actions', () => {
  test.use({ storageState: stateFor('dm') });

  test('awaits a slow resolve and suppresses same-tick double activation', async ({ browser, page }) => {
    const { campaignId } = seed();
    const player = await browser.newContext({ storageState: stateFor('player') });
    const body = `Slow inbox action ${Date.now()}`;
    const submitted = await player.request.post(`/api/v1/campaigns/${campaignId}/inbox`, { data: { body } });
    expect(submitted.ok()).toBe(true);
    const item = await submitted.json();
    await player.close();

    let resolveCalls = 0;
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    let holdRefresh = false;
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    await page.route(`**/api/v1/notes/${item.id}/resolve`, async (route) => {
      resolveCalls += 1;
      await requestGate;
      await route.continue();
    });
    await page.route(`**/api/v1/campaigns/${campaignId}/inbox*`, async (route) => {
      if (holdRefresh) {
        refreshCalls += 1;
        await refreshGate;
      }
      await route.continue();
    });

    await page.goto(`/c/${campaignId}/inbox`);
    const row = page.getByText(body, { exact: true }).locator('xpath=ancestor::section');
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Resolve →' }).click();

    const resolve = row.getByRole('button', { name: 'Resolve', exact: true });
    // Fire twice in one browser task, before React can render `disabled`. The
    // synchronous guard must still permit only one callback/request.
    await resolve.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });

    await expect.poll(() => resolveCalls).toBe(1);
    await expect(resolve).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Dismiss', exact: true })).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Collapse', exact: true })).toBeDisabled();
    await expect(row.getByRole('textbox')).toBeDisabled();
    await expect(row.getByRole('combobox')).toBeDisabled();

    // Let the terminal POST settle, but hold both refresh GETs that are still
    // part of the Promise-returning callback. The row must remain busy through
    // this second, post-success phase as well.
    holdRefresh = true;
    releaseRequest();
    await expect.poll(() => refreshCalls).toBeGreaterThanOrEqual(2);
    await expect(resolve).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Dismiss', exact: true })).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Collapse', exact: true })).toBeDisabled();

    releaseRefresh();
    await expect(row).toHaveCount(0);
    expect(resolveCalls).toBe(1);
  });
});
