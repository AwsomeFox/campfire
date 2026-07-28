import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #1642 — inspiration/hero points surfaced on the character sheet, real browser
 * DOM proof (the pure adapter-selection/pip-math logic is unit-tested in
 * character-special-resource.unit.spec.ts, and the MCP/REST composition end-to-end is
 * proven server-side in mcp.e2e-spec.ts's three "#1642:" tests). The seed campaign's
 * `ruleSystem` ('e2e-open5e-actions', an unregistered slug) falls back to the 5e adapter
 * (see `ruleSystemAdapter` in packages/schema), so this is a real 5e sheet — no extra
 * campaign setup needed for this half of the coverage.
 */
test.describe('character sheet surfaces inspiration (#1642)', () => {
  test.use({ storageState: stateFor('dm') });

  test('shows a card titled with the adapter\'s own resource name, and spend/restore work', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    // Adapter-driven title — "Inspiration" comes from Dnd5eAdapter.resources[].name, not
    // a hardcoded string in the component (see specialCharacterResource.ts).
    const region = page.getByRole('region', { name: 'Inspiration' });
    await expect(region).toBeVisible();

    // Fresh (never-touched) resource: adapter default max 1, fully available.
    await expect(region.getByLabel('1 of 1 — Inspiration available')).toBeVisible();
    const spend = region.getByRole('button', { name: 'Spend' });
    const restore = region.getByRole('button', { name: 'Restore' });
    await expect(spend).toBeEnabled();
    await expect(restore).toBeDisabled(); // nothing spent yet — restore has nothing to give back

    const spendReq = page.waitForResponse(
      (res) => res.url().includes(`/api/v1/characters/${navigation.characterId}/resources`) && res.request().method() === 'POST',
    );
    await spend.click();
    await spendReq;
    await expect(region.getByLabel('0 of 1 — Inspiration available')).toBeVisible();
    await expect(spend).toBeDisabled(); // none left to spend
    await expect(restore).toBeEnabled();

    const restoreReq = page.waitForResponse(
      (res) => res.url().includes(`/api/v1/characters/${navigation.characterId}/resources`) && res.request().method() === 'POST',
    );
    await restore.click();
    await restoreReq;
    await expect(region.getByLabel('1 of 1 — Inspiration available')).toBeVisible();
  });

  test('a 5e sheet never shows the OTHER system\'s resource (mutual exclusivity)', async ({ page }) => {
    // #1642's "a system declaring neither resource must not render an empty or
    // 5e-shaped widget" is covered server-side against a real Open Legend campaign in
    // mcp.e2e-spec.ts, and by unit test directly against OpenLegendAdapter — spinning
    // up a second live campaign here to re-prove the identical adapter-lookup logic
    // in the DOM would not add coverage those two don't already give with more
    // precision. What's worth a DOM check is the sibling failure mode: a 5e sheet
    // showing PF2e's card (or vice versa) because the lookup matched the wrong key.
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);
    await expect(page.getByRole('region', { name: 'Inspiration' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Hero Points' })).toHaveCount(0);
  });
});
