import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

async function contextInTimezone(browser: Browser, timezoneId: string): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: test.info().project.use.baseURL as string,
    storageState: stateFor('dm'),
    timezoneId,
  });
}

async function openRecapForm(page: Page) {
  await page.goto(`/c/${seed().campaignId}/sessions`);
  await page.getByRole('button', { name: /^\+ Add recap$/ }).click();
  const date = page.getByLabel('Played on');
  await expect(date).toBeVisible();
  return date;
}

test.describe('new recap local date', () => {
  test('defaults from the local calendar day at UTC-12 and UTC+14', async ({ browser }) => {
    const instant = new Date('2026-07-22T10:30:00.000Z');
    const cases = [
      { timezoneId: 'Etc/GMT+12', expected: '2026-07-21' },
      { timezoneId: 'Pacific/Kiritimati', expected: '2026-07-23' },
    ];

    for (const { timezoneId, expected } of cases) {
      const context = await contextInTimezone(browser, timezoneId);
      const page = await context.newPage();
      await page.clock.install({ time: instant });
      const date = await openRecapForm(page);
      await expect(date).toHaveValue(expected);
      await context.close();
    }
  });

  test('updates an untouched open form when the local day crosses midnight', async ({ browser }) => {
    const context = await contextInTimezone(browser, 'America/New_York');
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-03-08T04:59:30.000Z') });

    const date = await openRecapForm(page);
    await expect(date).toHaveValue('2026-03-07');
    await page.clock.fastForward(60_000);
    await expect(date).toHaveValue('2026-03-08');

    await context.close();
  });

  test('preserves an explicit date across midnight and stays accessible on mobile', async ({ browser }) => {
    const context = await contextInTimezone(browser, 'America/New_York');
    const page = await context.newPage();
    await page.setViewportSize({ width: 320, height: 720 });
    await page.clock.install({ time: new Date('2026-11-02T04:59:30.000Z') });

    const date = await openRecapForm(page);
    await expect(date).toHaveValue('2026-11-01');

    const title = page.getByLabel('Title');
    await title.focus();
    await page.keyboard.press('Tab');
    await expect(date).toBeFocused();
    await date.fill('2026-12-24');
    await page.clock.fastForward(60_000);
    await expect(date).toHaveValue('2026-12-24');

    const card = page.getByRole('heading', { name: /Add recap/ }).locator('..');
    const scan = await new AxeBuilder({ page }).include('.new-recap-form').analyze();
    expect(scan.violations).toEqual([]);
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await context.close();
  });
});
