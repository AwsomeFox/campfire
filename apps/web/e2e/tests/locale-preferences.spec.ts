import { expect, test } from '@playwright/test';
import { LANG_STORAGE_KEY, SYSTEM_LOCALE, serializeLocalePreference } from '../../src/i18n/locale';
import { seed, stateFor } from './seed';

test('Preferences keeps catalog language separate from System formatting across reload and browser changes', async ({ browser }) => {
  const frenchContext = await browser.newContext({
    storageState: stateFor('player'),
    locale: 'fr-FR',
  });
  const page = await frenchContext.newPage();
  const language = page.getByLabel('Display language');

  await page.goto('/preferences');

  // First load is implicitly System but does not write a detector result.
  await expect(language).toHaveValue(SYSTEM_LOCALE);
  expect(await page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY)).toBeNull();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

  // A tampered form value must not be persisted as a locale the app cannot render.
  await language.evaluate((element) => {
    const option = document.createElement('option');
    option.value = 'fr-FR';
    option.textContent = 'Unsupported';
    element.append(option);
    element.value = option.value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(await page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY)).toBeNull();

  // An unsupported French catalog falls back to English while dates stay French.
  await page.goto(`/c/${seed().campaignId}/sessions`);
  await expect(page.getByText('21 juil. 2026', { exact: true }).first()).toBeVisible();

  // A runtime browser-language event updates mounted formatting surfaces too.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'de-DE' });
    window.dispatchEvent(new Event('languagechange'));
  });
  await expect(page.getByText('21. Juli 2026', { exact: true }).first()).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'fr-FR' });
    window.dispatchEvent(new Event('languagechange'));
  });
  await expect(page.getByText('21 juil. 2026', { exact: true }).first()).toBeVisible();

  // Explicit English changes regional formatting and records a deliberate override.
  await page.goto('/preferences');
  await language.selectOption('en');
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY))
    .toBe(serializeLocalePreference('en'));
  await page.goto(`/c/${seed().campaignId}/sessions`);
  await expect(page.getByText('Jul 21, 2026', { exact: true }).first()).toBeVisible();

  // System is itself explicit, survives reload, and does not change the rendered catalog.
  await page.goto('/preferences');
  await language.selectOption(SYSTEM_LOCALE);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY))
    .toBe(serializeLocalePreference(SYSTEM_LOCALE));
  await page.reload();
  await expect(language).toHaveValue(SYSTEM_LOCALE);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  const systemState = await frenchContext.storageState();
  await frenchContext.close();

  // The persisted mode follows a different browser locale on the next load.
  const germanContext = await browser.newContext({ storageState: systemState, locale: 'de-DE' });
  const germanPage = await germanContext.newPage();
  await germanPage.goto('/preferences');
  await expect(germanPage.getByLabel('Display language')).toHaveValue(SYSTEM_LOCALE);
  await germanPage.goto(`/c/${seed().campaignId}/sessions`);
  await expect(germanPage.getByText('21. Juli 2026', { exact: true }).first()).toBeVisible();
  await germanContext.close();
});
