import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #646 — Character sheet Play vs Build/Profile tabs in the browser.
 *
 * Verifies compact section nav, persisted/URL tab state, deep-link focus, and
 * that Play hides build-only blocks (mobile scroll reduction).
 *
 * The persistent vitals rail (HP / conditions / rests) is deliberately outside both
 * tabpanels — see CharacterPage's module comment — so it is asserted page-wide rather
 * than inside the Play panel.
 */

test.describe('Character sheet Play vs Build tabs (#646)', () => {
  test.use({ storageState: stateFor('dm') });

  test('exposes tablist semantics and toggles panels without stacking both stacks', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    const tablist = page.getByRole('tablist', { name: 'Character sheet sections' });
    await expect(tablist).toBeVisible();
    const tabs = tablist.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    await expect(tabs).toHaveText([/Play/, /Build & profile/]);

    const playPanel = page.getByTestId('character-sheet-panel-play');
    const buildPanel = page.getByTestId('character-sheet-panel-build');
    await expect(playPanel).toBeVisible();
    await expect(buildPanel).toBeHidden();
    await expect(playPanel.getByRole('heading', { name: 'Actions' })).toBeVisible();
    await expect(page.getByTestId('character-xp')).toBeHidden();
    // The vitals rail lives OUTSIDE both tabpanels (design template's play surface), so
    // HP stays on screen while you read Build — it is not a Play-only block.
    await expect(page.getByRole('heading', { name: 'Hit points & Defenses' })).toBeVisible();

    await tablist.getByRole('tab', { name: /Build & profile/ }).click();
    await expect(page).toHaveURL(/tab=build/);
    await expect(buildPanel).toBeVisible();
    await expect(playPanel).toBeHidden();
    await expect(page.getByTestId('character-xp')).toBeVisible();
    await expect(playPanel.getByRole('heading', { name: 'Actions' })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Hit points & Defenses' })).toBeVisible();

    await tablist.getByRole('tab', { name: /^Play/ }).click();
    await expect(page).not.toHaveURL(/tab=build/);
    await expect(playPanel).toBeVisible();
    await expect(buildPanel).toBeHidden();
  });

  test('deep-link focus opens the owning tab and scroll target', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}?focus=xp`);

    await expect(page).toHaveURL(/tab=build/);
    await expect(page.getByTestId('character-sheet-panel-build')).toBeVisible();
    await expect(page.getByTestId('character-xp')).toBeVisible();
    await expect(page.locator('#character-section-xp')).toBeVisible();
  });

  test('persists the selected tab across reloads', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    await page.getByRole('tab', { name: /Build & profile/ }).click();
    await expect(page).toHaveURL(/tab=build/);

    await page.reload();
    await expect(page.getByTestId('character-sheet-panel-build')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Build & profile/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('tablist is keyboard-operable and axe-clean on a touch viewport', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    const playTab = page.locator('#character-sheet-tab-play');
    await playTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#character-sheet-tab-build')).toBeFocused();
    await expect(page).toHaveURL(/tab=build/);

    const results = await new AxeBuilder({ page })
      .include('[data-testid="character-sheet-tabs"]')
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
