import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

test.use({ storageState: stateFor('player') });

interface TestWindow extends Window {
  __diceAnnouncements?: string[];
  __diceObserver?: MutationObserver;
}

async function watchAnnouncements(page: Page) {
  await page.evaluate(() => {
    // Prefer the app-root announcer test id — other polite sr-only regions (dialogs,
    // pickers) can otherwise steal the first querySelector match.
    const live =
      document.querySelector<HTMLElement>('[data-testid="app-announcer-polite"]')
      ?? document.querySelector<HTMLElement>('.sr-only[aria-live="polite"][aria-atomic="true"]');
    if (!live) throw new Error('Polite app announcer was not found');
    const target = window as TestWindow;
    target.__diceObserver?.disconnect();
    target.__diceAnnouncements = [];
    target.__diceObserver = new MutationObserver(() => {
      const message = live.textContent?.trim();
      if (message) target.__diceAnnouncements?.push(message);
    });
    target.__diceObserver.observe(live, { childList: true, characterData: true, subtree: true });
  });
}

async function announcements(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as TestWindow).__diceAnnouncements ?? [])]);
}

async function waitForAnnouncement(page: Page, text: string) {
  await expect.poll(async () => (await announcements(page)).some((message) => message.includes(text))).toBe(true);
}

test.describe('shared dice log accessibility — remote clients (#590)', () => {
  test('announces a remote roll once with roller, expression, total, and outcome', async ({ page: viewerPage, browser }) => {
    const { campaignId } = seed();
    const dmContext = await browser.newContext({ storageState: stateFor('dm') });
    const dmPage = await dmContext.newPage();

    try {
      await viewerPage.goto(`/c/${campaignId}`);
      const log = viewerPage.getByTestId('shared-dice-log');
      await expect(log).toHaveAttribute('role', 'log');
      await expect(log).toHaveAttribute('aria-live', 'off');
      await watchAnnouncements(viewerPage);

      const rolled = await dmPage.request.post(`/api/v1/campaigns/${campaignId}/roll`, {
        data: { expr: '1d4+5', label: 'Stealth check' },
      });
      expect(rolled.ok()).toBe(true);
      const body = (await rolled.json()) as { total: number; expr: string };
      await waitForAnnouncement(viewerPage, 'Stealth check');
      await waitForAnnouncement(viewerPage, body.expr);
      await waitForAnnouncement(viewerPage, String(body.total));
      await expect(log).toContainText('Stealth check');

      const afterFirst = await announcements(viewerPage);
      expect(afterFirst.filter((message) => /Rolled|rolled/i.test(message) && message.includes(String(body.total)))).toHaveLength(1);

      // Poll refetch must not re-announce the same roll id.
      await viewerPage.waitForResponse((res) => res.url().includes(`/api/v1/campaigns/${campaignId}/rolls`) && res.request().method() === 'GET');
      await expect.poll(async () => (await announcements(viewerPage)).filter((message) => /Rolled|rolled/i.test(message) && message.includes(String(body.total))).length).toBe(1);
    } finally {
      await dmContext.close();
    }
  });

  test('local submit does not double-announce when the poll returns the same roll', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}`);
    const log = page.getByTestId('shared-dice-log');
    await expect(log).toBeVisible();
    // CatchUpPanel (and similar) also speak into the polite region — watch only
    // after the dashboard has settled so those do not satisfy the poll first.
    await expect(page.getByTestId('shared-dice-log')).toBeVisible();
    await page.getByTestId('shared-dice-log').scrollIntoViewIfNeeded();
    await page.locator('details.dice-advanced summary').click();
    await page.getByLabel('Dice expression').fill('1d20');
    await watchAnnouncements(page);
    await page.locator('details.dice-advanced').getByRole('button', { name: 'Roll' }).click();
    // Wait specifically for a dice announcement — not catch-up / other polite chatter.
    await expect
      .poll(async () => (await announcements(page)).some((message) => /Rolled|rolled/i.test(message)))
      .toBe(true);
    const afterRoll = await announcements(page);
    const totalLine = afterRoll.find((message) => /Rolled|rolled/i.test(message)) ?? '';
    expect(totalLine.length).toBeGreaterThan(0);
    await page.waitForResponse((res) => res.url().includes(`/api/v1/campaigns/${campaignId}/rolls`) && res.request().method() === 'GET');
    const afterPoll = await announcements(page);
    expect(afterPoll.filter((message) => message === totalLine)).toHaveLength(1);
  });
});
