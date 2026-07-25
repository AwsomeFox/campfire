import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { restoreSeedEncounter, seed, stateFor } from './seed';

/**
 * Issue #476 — Encounter accessibility: map mode pressed state, Add Combatant
 * tab semantics, contextual remove labels, and visible difficulty help.
 */
test.use({ storageState: stateFor('dm') });

const ADD_TAB_IDS = [
  'add-combatant-tab-manual',
  'add-combatant-tab-compendium',
  'add-combatant-tab-party',
  'add-combatant-tab-npc',
] as const;
const ADD_PANEL_IDS = [
  'add-combatant-panel-manual',
  'add-combatant-panel-compendium',
  'add-combatant-panel-party',
  'add-combatant-panel-npc',
] as const;

async function openSeedEncounter(page: import('@playwright/test').Page) {
  const { campaignId, encounterId } = seed();
  await restoreSeedEncounter(page);
  await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
  await expect(page.getByRole('heading', { name: 'Ambush at the Ember Hearth' })).toBeVisible();
}

test.describe('Encounter accessibility (#476)', () => {
  test('map toolbar exposes pressed state and passes axe', async ({ page }) => {
    await openSeedEncounter(page);

    const toolbar = page.getByTestId('map-toolbar');
    await expect(toolbar).toHaveAttribute('role', 'toolbar');
    await expect(toolbar).toHaveAttribute('aria-label', 'Map tools');

    const move = page.getByTestId('map-tool-move');
    const ping = page.getByTestId('map-tool-ping');
    await expect(move).toHaveAttribute('aria-pressed', 'true');
    await expect(ping).toHaveAttribute('aria-pressed', 'false');

    await ping.click();
    await expect(ping).toHaveAttribute('aria-pressed', 'true');
    await expect(move).toHaveAttribute('aria-pressed', 'false');

    const axe = await new AxeBuilder({ page }).include('[data-testid="map-toolbar"]').analyze();
    expect(axe.violations).toEqual([]);
  });

  test('Add Combatant tabs expose tablist semantics and keyboard navigation', async ({ page }) => {
    await openSeedEncounter(page);

    const tablist = page.getByTestId('add-combatant-tabs');
    await expect(tablist).toHaveAttribute('role', 'tablist');
    await expect(tablist).toHaveAttribute('aria-label', 'Add combatant');

    const tabs = tablist.getByRole('tab');
    await expect(tabs).toHaveCount(4);
    await expect(tabs).toHaveText(['Manual', 'Compendium', 'Party', 'NPC']);

    await expect(page.locator('#add-combatant-tab-manual')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#add-combatant-tab-manual')).toHaveAttribute('tabindex', '0');
    await expect(page.locator('#add-combatant-tab-compendium')).toHaveAttribute('tabindex', '-1');

    for (let i = 0; i < ADD_TAB_IDS.length; i += 1) {
      await expect(page.locator(`#${ADD_TAB_IDS[i]}`)).toHaveAttribute('aria-controls', ADD_PANEL_IDS[i]);
      await expect(page.locator(`#${ADD_PANEL_IDS[i]}`)).toHaveAttribute('role', 'tabpanel');
      await expect(page.locator(`#${ADD_PANEL_IDS[i]}`)).toHaveAttribute('aria-labelledby', ADD_TAB_IDS[i]);
    }

    const manualTab = page.locator('#add-combatant-tab-manual');
    await manualTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#add-combatant-tab-compendium')).toBeFocused();
    await expect(page.locator('#add-combatant-tab-compendium')).toHaveAttribute('aria-selected', 'true');

    const axe = await new AxeBuilder({ page }).include('[data-testid="add-combatant-tabs"]').analyze();
    expect(axe.violations).toEqual([]);
  });

  test('difficulty help is visible and focusable without hover', async ({ page }) => {
    await openSeedEncounter(page);

    const badge = page.getByTestId('difficulty-badge');
    await expect(badge).toBeVisible();

    const toggle = page.getByTestId('difficulty-help-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const panel = page.getByTestId('difficulty-help-panel');
    await expect(panel).toBeVisible();
    await expect(panel).not.toBeEmpty();

    const axe = await new AxeBuilder({ page }).include('[data-testid="difficulty-badge"]').analyze();
    expect(axe.violations).toEqual([]);
  });

  test('remove combatant buttons expose contextual accessible names', async ({ page }) => {
    await openSeedEncounter(page);

    const removeButtons = page.getByRole('button', { name: /^Remove / });
    await expect(removeButtons.first()).toBeVisible();
    const names = await removeButtons.evaluateAll((els) =>
      els.map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? ''),
    );
    for (const name of names) {
      expect(name).toMatch(/^Remove /);
      expect(name).not.toBe('✕');
    }
  });
});
