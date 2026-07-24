import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Responsive page headers (issue #707).
 *
 * Crowded list hubs must keep a visible primary action at ≥44×44 CSS px, park
 * secondary actions in an accessible overflow menu on narrow / high-zoom
 * viewports, and reflow without horizontal scrolling at the 320px / 400%-zoom
 * equivalent (plus landscape + large text).
 */

async function assertNoHorizontalOverflow(page: Page, maxWidth: number) {
  const metrics = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.viewportWidth).toBeLessThanOrEqual(maxWidth);
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
}

async function assertMinTarget(locator: ReturnType<Page['locator']>, label: string) {
  const box = await locator.boundingBox();
  expect(box, label).not.toBeNull();
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(44);
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(44);
}

test.describe('responsive page headers', () => {
  test.use({ storageState: stateFor('dm') });

  test('Party header stacks at 320px with 44px primary and overflow secondary', async ({ page }) => {
    const { campaignId } = seed();
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`/c/${campaignId}/party`);

    const header = page.getByTestId('page-header');
    await expect(header.getByRole('heading', { name: 'Party' })).toBeVisible();

    const primary = header.getByTestId('page-header-primary').getByRole('button', { name: '+ New character' });
    await expect(primary).toBeVisible();
    await assertMinTarget(primary, 'New character');

    // Secondary "Award XP" collapses into the overflow menu on narrow layouts.
    await expect(header.getByTestId('page-header-overflow')).toBeVisible();
    await expect(header.getByTestId('page-header-secondary-inline')).toBeHidden();
    await assertMinTarget(header.getByTestId('page-header-overflow'), 'More actions');

    await header.getByTestId('page-header-overflow').click();
    const menu = page.getByTestId('page-header-overflow-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Award XP/ })).toBeVisible();
    await assertMinTarget(menu.getByRole('menuitem', { name: /Award XP/ }), 'Award XP menuitem');

    // Menu stays inside the viewport.
    const menuBox = await menu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(320);

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(header.getByTestId('page-header-overflow')).toBeFocused();

    await assertNoHorizontalOverflow(page, 320);
  });

  test('Sessions header keeps primary visible and parks Trash in overflow at high zoom', async ({ page }) => {
    const { campaignId } = seed();
    // 1280 CSS px → 320 CSS px is the WCAG 400% reflow equivalent.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 720,
      deviceScaleFactor: 4,
      mobile: false,
    });
    await page.goto(`/c/${campaignId}/sessions`);

    const header = page.getByTestId('page-header');
    const primary = header.getByTestId('page-header-primary').getByRole('button', { name: '+ Add recap' });
    await expect(primary).toBeVisible();
    await assertMinTarget(primary, 'Add recap');

    await header.getByTestId('page-header-overflow').click();
    const menu = page.getByTestId('page-header-overflow-menu');
    await expect(menu.getByRole('menuitem', { name: 'Trash' })).toBeVisible();

    await assertNoHorizontalOverflow(page, 320);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(4);

    const accessibilityScan = await new AxeBuilder({ page }).include('[data-testid="page-header"]').analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });

  test('Locations card header reflows long labels in landscape with large text', async ({ page }) => {
    const { campaignId } = seed();
    await page.setViewportSize({ width: 640, height: 360 });
    await page.goto(`/c/${campaignId}/locations`);

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
      document.documentElement.setAttribute('data-reading-mode', 'large');
    });

    const header = page.getByTestId('page-header');
    await expect(header.getByRole('heading', { name: /World/ })).toBeVisible();
    await expect(header.getByText('· Locations')).toBeVisible();

    // 640 CSS px is above the 40rem (640px) inline breakpoint at default root
    // font size, but large text + long translated labels still must not force
    // document-level horizontal scroll.
    const primary = header.getByRole('button', { name: '+ New location' });
    await expect(primary).toBeVisible();
    await assertMinTarget(primary, 'New location');

    await assertNoHorizontalOverflow(page, 640);
  });

  test('wide Party header shows secondary inline and hides overflow', async ({ page }) => {
    const { campaignId } = seed();
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`/c/${campaignId}/party`);

    const header = page.getByTestId('page-header');
    await expect(header.getByTestId('page-header-secondary-inline')).toBeVisible();
    await expect(header.getByRole('button', { name: /Award XP/ })).toBeVisible();
    await expect(header.getByTestId('page-header-overflow')).toBeHidden();
    await assertMinTarget(header.getByRole('button', { name: '+ New character' }), 'New character wide');
    await assertMinTarget(header.getByRole('button', { name: /Award XP/ }), 'Award XP wide');
  });
});
