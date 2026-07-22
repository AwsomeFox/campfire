import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

async function typography(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontSize: Number.parseFloat(style.fontSize),
      lineHeight: Number.parseFloat(style.lineHeight),
      width: element.getBoundingClientRect().width,
    };
  });
}

async function expectNoPageOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

test.describe('semantic reading preferences', () => {
  test.use({ storageState: stateFor('player') });

  test('uses native radio semantics, keyboard selection, a live preview, mobile reflow, and axe', async ({ page }) => {
    await page.goto('/preferences');

    const defaultRadio = page.getByRole('radio', { name: /^Default/ });
    const comfortableRadio = page.getByRole('radio', { name: /^Comfortable/ });
    const largeRadio = page.getByRole('radio', { name: /^Large/ });
    const preview = page.getByTestId('reading-preview');
    const sample = preview.locator('p');

    await expect(defaultRadio).toBeChecked();
    const base = await typography(sample);
    expect(base.fontSize).toBe(15);
    expect(base.lineHeight).toBe(24);

    await defaultRadio.focus();
    await page.keyboard.press('ArrowRight');
    await expect(comfortableRadio).toBeChecked();
    await expect(preview).toHaveAttribute('data-preview-reading-mode', 'comfortable');
    const comfortable = await typography(sample);
    expect(comfortable.fontSize).toBe(16);
    expect(comfortable.lineHeight).toBeCloseTo(27.2, 1);
    expect(comfortable.width).toBeLessThanOrEqual((await preview.boundingBox())!.width);

    await page.keyboard.press('ArrowRight');
    await expect(largeRadio).toBeChecked();
    const large = await typography(sample);
    expect(large.fontSize).toBe(18);
    expect(large.lineHeight).toBe(31.5);

    const accessibility = await new AxeBuilder({ page }).include('main').analyze();
    expect(accessibility.violations).toEqual([]);

    await page.setViewportSize({ width: 375, height: 812 });
    await expectNoPageOverflow(page);
    const optionBoxes = await page.locator('.reading-option').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().width));
    expect(Math.max(...optionBoxes) - Math.min(...optionBoxes)).toBeLessThan(1);
    await test.info().attach('reading-preferences-mobile', {
      body: await page.getByRole('group', { name: 'Reading comfort' }).screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
  });

  test('persists across reload and does not bleed to another signed-in user', async ({ browser, page }) => {
    await page.goto('/preferences');
    await page.getByRole('radio', { name: /^Large/ }).check();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/v1/me/preferences') && response.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    await expect(page.locator('html')).toHaveAttribute('data-reading-mode', 'large');

    await page.reload();
    await expect(page.getByRole('radio', { name: /^Large/ })).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-reading-mode', 'large');

    const dmContext = await browser.newContext({ storageState: stateFor('dm') });
    const dmPage = await dmContext.newPage();
    await dmPage.goto('/preferences');
    await expect(dmPage.getByRole('radio', { name: /^Default/ })).toBeChecked();
    await expect(dmPage.locator('html')).not.toHaveAttribute('data-reading-mode', /.+/);
    await dmContext.close();

    // Restore the shared player fixture for later serial specs.
    await page.getByRole('radio', { name: /^Default/ }).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-reading-mode', /.+/);
  });

  test('enlarges reading surfaces without resizing controls or map geometry across core routes', async ({ page }) => {
    const fixture = seed();
    const preference = await page.request.patch('/api/v1/me/preferences', { data: { textSize: 'large' } });
    expect(preference.ok()).toBe(true);

    await page.goto(`/c/${fixture.campaignId}`);
    await expect(page.locator('html')).toHaveAttribute('data-reading-mode', 'large');
    const dashboardReading = await typography(page.locator('.reading-surface').first());
    const dashboardControl = await typography(page.locator('.btn').first());
    expect(dashboardReading.fontSize).toBe(18);
    expect(dashboardControl.fontSize).toBeLessThan(dashboardReading.fontSize);
    const map = page.getByTestId('dashboard-map');
    const largeMapBox = await map.boundingBox();
    await page.locator('html').evaluate((root) => root.removeAttribute('data-reading-mode'));
    const defaultMapBox = await map.boundingBox();
    const defaultControl = await typography(page.locator('.btn').first());
    expect(defaultControl.fontSize).toBe(dashboardControl.fontSize);
    expect(defaultMapBox?.width).toBeCloseTo(largeMapBox!.width, 0);
    expect(defaultMapBox?.height).toBeCloseTo(largeMapBox!.height, 0);
    await page.locator('html').evaluate((root) => root.setAttribute('data-reading-mode', 'large'));

    await page.goto(`/c/${fixture.campaignId}/sessions?session=${fixture.navigation.sessionId}`);
    const recap = page.locator('.cf-prose').first();
    await expect(recap).toBeVisible();
    const recapType = await typography(recap);
    expect(recapType.fontSize).toBe(18);
    expect(recapType.lineHeight).toBe(31.5);

    await page.goto(`/c/${fixture.campaignId}/characters/${fixture.navigation.characterId}`);
    expect((await typography(page.locator('.reading-surface').first())).fontSize).toBe(18);
    expect((await typography(page.locator('.btn').first())).fontSize).toBeLessThan(18);

    // 1280px at 200% browser zoom has a 640 CSS-pixel layout viewport.
    await page.setViewportSize({ width: 640, height: 800 });
    await expectNoPageOverflow(page);

    // WCAG 1.4.10's 1280px-at-400% equivalent: a 320 CSS-pixel viewport.
    await page.setViewportSize({ width: 320, height: 800 });
    await expectNoPageOverflow(page);
    await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
    await expectNoPageOverflow(page);
    expect((await typography(page.locator('.reading-surface').first())).fontSize).toBe(18);

    await test.info().attach('large-reading-400-percent-reflow', {
      body: await page.screenshot({ fullPage: false, animations: 'disabled' }),
      contentType: 'image/png',
    });

    const reset = await page.request.patch('/api/v1/me/preferences', { data: { textSize: 'default' } });
    expect(reset.ok()).toBe(true);
  });
});
