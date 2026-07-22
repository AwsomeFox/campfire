import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stateFor } from './seed';

const RULE_PACKS = [
  {
    id: 901,
    name: 'Pathfinder Second Edition with an intentionally long reflow label',
    slug: 'pf2e',
    version: '2.0',
    license: 'ORC',
    sourceUrl: 'https://example.test/pf2e',
    installedAt: '2026-07-22T00:00:00.000Z',
    entryCount: 1234,
    usageCount: 0,
  },
  {
    id: 902,
    name: 'Open Legend',
    slug: 'open-legend',
    version: '1.0',
    license: 'CC BY-SA',
    sourceUrl: 'https://example.test/open-legend',
    installedAt: '2026-07-22T00:00:00.000Z',
    entryCount: 321,
    usageCount: 0,
  },
] as const;

async function mockRulePacks(page: Page) {
  await page.route('**/api/v1/rules/packs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(RULE_PACKS),
    });
  });
}

test.describe('new campaign dialog accessibility', () => {
  test.use({ storageState: stateFor('admin') });

  test('supports keyboard open, steps, Escape discard confirmation, and trigger focus restoration', async ({ page }) => {
    await mockRulePacks(page);
    let campaignCreates = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/campaigns') {
        campaignCreates += 1;
      }
    });

    await page.goto('/');
    const hubHeading = page.getByRole('heading', { name: 'Your campaigns' });
    const trigger = page.getByRole('button', { name: 'New campaign' });
    await trigger.focus();
    await page.keyboard.press('Enter');

    let dialog = page.getByRole('dialog', { name: 'New campaign' });
    const name = dialog.getByRole('textbox', { name: 'Name' });
    const progress = dialog.getByRole('list', { name: 'Campaign setup progress' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(name).toBeFocused();
    await expect(progress.locator('[aria-current="step"]')).toContainText('Details');
    await expect(dialog.getByRole('status')).toHaveText('Step 1 of 2: Details');
    await expect.poll(() => hubHeading.evaluate((element) => element.closest('[inert]') !== null)).toBe(true);

    const detailsScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(detailsScan.violations).toEqual([]);

    // Pristine Escape closes immediately and useDialog returns focus to the tile.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect.poll(() => hubHeading.evaluate((element) => element.closest('[inert]') !== null)).toBe(false);

    // Reopen and exercise the complete dirty-state path with keyboard only.
    await page.keyboard.press('Enter');
    dialog = page.getByRole('dialog', { name: 'New campaign' });
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeFocused();
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Keyboard campaign');
    await expect(dialog.getByRole('button', { name: 'Discard campaign', exact: true })).toBeVisible();

    const next = dialog.getByRole('button', { name: /Next: rule system/ });
    const returnToCampaigns = dialog.getByRole('button', { name: 'Discard campaign and return to campaigns' });
    await next.focus();
    await page.keyboard.press('Tab');
    await expect(returnToCampaigns).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(next).toBeFocused();
    await page.keyboard.press('Enter');

    const systemHeading = dialog.getByRole('heading', { name: 'Rule system' });
    await expect(systemHeading).toBeFocused();
    await expect(progress.locator('[aria-current="step"]')).toContainText('Rule system');
    await expect(dialog.getByRole('status')).toHaveText('Step 2 of 2: Rule system');

    const pack = dialog.getByRole('button', { name: /Pathfinder Second Edition/ });
    await expect(pack).toHaveAttribute('aria-pressed', 'false');
    await pack.focus();
    await page.keyboard.press('Space');
    await expect(pack).toHaveAttribute('aria-pressed', 'true');

    const systemScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(systemScan.violations).toEqual([]);

    await page.keyboard.press('Escape');
    const confirmation = page.getByRole('alertdialog', { name: 'Discard new campaign?' });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole('button', { name: 'Keep editing' })).toBeFocused();
    await expect(confirmation.getByText(/details and rule-system choice have not been saved/i)).toBeVisible();

    const confirmationScan = await new AxeBuilder({ page }).include('[role="alertdialog"]').analyze();
    expect(confirmationScan.violations).toEqual([]);

    // Escape is the safe action inside the confirmation and restores focus to the active step.
    await page.keyboard.press('Escape');
    await expect(confirmation).toBeHidden();
    await expect(systemHeading).toBeFocused();

    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog', { name: 'Discard new campaign?' })
      .getByRole('button', { name: 'Discard campaign' })
      .click();
    await expect(page.getByRole('dialog', { name: 'New campaign' })).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect.poll(() => hubHeading.evaluate((element) => element.closest('[inert]') !== null)).toBe(false);
    expect(campaignCreates).toBe(0);
  });

  test('keeps controls reachable without horizontal overflow on mobile and at 200% reflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await mockRulePacks(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'New campaign' }).click();

    const dialog = page.getByRole('dialog', { name: 'New campaign' });
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Responsive campaign');
    await dialog.getByRole('button', { name: /Next: rule system/ }).click();
    await expect(dialog.getByRole('button', { name: /Pathfinder Second Edition/ })).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    for (const control of [
      dialog.getByRole('button', { name: /Pathfinder Second Edition/ }),
      dialog.getByRole('button', { name: 'Create campaign' }),
      dialog.getByRole('button', { name: 'Back' }),
    ]) {
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    const mobileScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(mobileScan.violations).toEqual([]);

    // A 1280px desktop viewport exposes 640 CSS px at 200% browser zoom.
    await page.setViewportSize({ width: 640, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    const create = dialog.getByRole('button', { name: 'Create campaign' });
    await create.scrollIntoViewIfNeeded();
    const createBox = await create.boundingBox();
    expect(createBox).not.toBeNull();
    expect(createBox!.x + createBox!.width).toBeLessThanOrEqual(640);
  });
});
