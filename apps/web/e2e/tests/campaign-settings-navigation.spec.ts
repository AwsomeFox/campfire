import { expect, test, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { seed, stateFor } from './seed';

const categoryNames = ['Campaign', 'Gameplay / Rules', 'AI', 'Data', 'Lifecycle'] as const;

function settingsPath(hash = ''): string {
  return `/c/${seed().campaignId}/settings${hash}`;
}

async function openAt(
  browser: Browser,
  viewport: { width: number; height: number },
  hash = '#campaign',
): Promise<{ context: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const context = await browser.newContext({ storageState: stateFor('dm'), viewport });
  const page = await context.newPage();
  await page.goto(settingsPath(hash));
  await expect(page.getByRole('heading', { level: 1, name: 'Campaign settings' })).toBeVisible();
  return { context, page };
}

test.describe('campaign settings section navigation', () => {
  test('desktop side navigation preserves hashes, history, focus, order, and landmarks', async ({ browser }) => {
    const { context, page } = await openAt(browser, { width: 1440, height: 900 });
    const navigation = page.getByRole('navigation', { name: 'Settings sections' });

    await expect(navigation).toBeVisible();
    await expect(page.locator('.settings-compact-nav')).toBeHidden();
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(navigation.getByRole('link')).toHaveCount(categoryNames.length);
    expect(await navigation.getByRole('link').allTextContents()).toEqual([...categoryNames]);

    for (const name of categoryNames) {
      await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
    }
    expect(await page.locator('.settings-category').evaluateAll((sections) => sections.map((section) => section.id))).toEqual([
      'campaign',
      'gameplay-rules',
      'ai',
      'data',
      'lifecycle',
    ]);
    expect(await page.locator('#lifecycle').evaluate((section) => section.lastElementChild?.id)).toBe('danger-zone');
    await expect(page.locator('#danger-zone')).toHaveCSS('border-left-style', 'solid');
    const accessibilityScan = await new AxeBuilder({ page }).include('.settings-page').analyze();
    expect(accessibilityScan.violations).toEqual([]);

    const gameplay = navigation.getByRole('link', { name: 'Gameplay / Rules' });
    await gameplay.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#gameplay-rules$/);
    await expect(gameplay).toHaveAttribute('aria-current', 'location');
    await expect(page.locator('#gameplay-rules')).toBeFocused();

    const ai = navigation.getByRole('link', { name: 'AI', exact: true });
    await ai.click();
    await expect(page).toHaveURL(/#ai$/);
    await expect(page.locator('#ai')).toBeFocused();

    await page.goBack();
    await expect(page).toHaveURL(/#gameplay-rules$/);
    await expect(gameplay).toHaveAttribute('aria-current', 'location');
    await expect(page.locator('#gameplay-rules')).toBeFocused();

    await page.goForward();
    await expect(page).toHaveURL(/#ai$/);
    await expect(ai).toHaveAttribute('aria-current', 'location');
    await expect(page.locator('#ai')).toBeFocused();
    await context.close();
  });

  test('direct card and delayed AI subsection links focus their target and select their category', async ({ browser }) => {
    const { context, page } = await openAt(browser, { width: 1440, height: 900 }, '#status');
    const navigation = page.getByRole('navigation', { name: 'Settings sections' });

    await expect(page.locator('#status')).toBeFocused();
    await expect(navigation.getByRole('link', { name: 'Lifecycle' })).toHaveAttribute('aria-current', 'location');

    await page.goto(settingsPath('#ai-dm-provider'));
    await expect(page.locator('#ai-dm-provider')).toBeFocused();
    await expect(navigation.getByRole('link', { name: 'AI', exact: true })).toHaveAttribute('aria-current', 'location');
    await expect(page.locator('[id="ai-dm-budget"]')).toHaveCount(1);
    await expect(page.getByRole('spinbutton', { name: 'Token budget' })).toHaveAttribute('id', 'ai-dm-budget-input');
    await context.close();
  });

  test('tablet uses a keyboard-operable compact disclosure', async ({ browser }) => {
    const { context, page } = await openAt(browser, { width: 820, height: 1180 });
    const disclosure = page.locator('.settings-compact-nav');
    const summary = disclosure.locator('summary');

    await expect(page.locator('.settings-side-nav')).toBeHidden();
    await expect(disclosure).toBeVisible();
    await expect(summary).toContainText('Jump to section: Campaign');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('open', '');

    const compactNavigation = disclosure.getByRole('navigation', { name: 'Campaign settings sections' });
    await page.keyboard.press('Tab');
    await expect(compactNavigation.getByRole('link', { name: 'Campaign', exact: true })).toBeFocused();
    const rulesLink = compactNavigation.getByRole('link', { name: 'Gameplay / Rules' });
    await rulesLink.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#gameplay-rules$/);
    await expect(page.locator('#gameplay-rules')).toBeFocused();
    await expect(disclosure).not.toHaveAttribute('open', '');
    await expect(summary).toContainText('Jump to section: Gameplay / Rules');
    await context.close();
  });

  test('mobile navigation and content reflow with 200% text without horizontal clipping', async ({ browser }) => {
    const { context, page } = await openAt(browser, { width: 375, height: 812 }, '#data');
    const disclosure = page.locator('.settings-compact-nav');

    await expect(disclosure).toBeVisible();
    await expect(disclosure.locator('summary')).toContainText('Jump to section: Data');
    await page.addStyleTag({ content: 'body { font-size: 30px !important; }' });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await disclosure.locator('summary').click();
    const links = disclosure.getByRole('link');
    for (const link of await links.all()) {
      expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await disclosure.getByRole('link', { name: 'Lifecycle' }).click();
    await expect(page).toHaveURL(/#lifecycle$/);
    await expect(page.locator('#lifecycle')).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await context.close();
  });

  test('a hashless settings route canonicalizes with replace instead of adding a history stop', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('dm'), viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`/c/${seed().campaignId}`);
    await page.goto(settingsPath());
    await expect(page).toHaveURL(/\/settings#campaign$/);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/c/${seed().campaignId}/?$`));
    await context.close();
  });
});
