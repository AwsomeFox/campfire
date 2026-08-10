import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #2156 — the sheet learned to author resistances/vulnerabilities/immunities, beside
 * the existing Conditions chips. `TargetDefenses` (the action resolver's own shape) was
 * already fully modeled and applied server-side but only ever derived from a monster/NPC
 * statblock; the REST round-trip (default empty, full-snapshot PATCH replace, the 24-char
 * cap, ownership) is proven server-side in characters.e2e-spec.ts, and the resolver
 * precedence rule (a linked character's defences win over any statblock also on the row) in
 * action-resolver.spec.ts. This is the real-browser proof that the control itself renders,
 * adds, and removes a chip through that same PATCH endpoint — mirroring
 * character-exhaustion-level.spec.ts's split between unit/server and this one browser-DOM
 * check.
 */
test.describe('character sheet damage defenses (#2156)', () => {
  test.use({ storageState: stateFor('dm') });

  test('adds and removes a resistance via the Damage defenses card, persisted through the general character PATCH', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    // Scoped to the card's own data-testid throughout: the sheet already has other "Add"
    // buttons (character-vitals-rail, and #2151's character-weapon-training), so an unscoped
    // getByRole('button', { name: 'Add' }) is ambiguous — and, worse, can silently click the
    // WRONG control instead of failing outright.
    const card = page.getByTestId('character-damage-defenses');
    await expect(card.getByRole('heading', { name: 'Damage defenses' })).toBeVisible();
    await expect(card.getByText('No resistances.')).toBeVisible();
    await expect(card.getByText('No vulnerabilities.')).toBeVisible();
    await expect(card.getByText('No immunities.')).toBeVisible();

    await card.getByRole('button', { name: 'Add resistant to' }).click();
    await card.getByLabel('Damage type').fill('Fire');

    const addReq = page.waitForResponse(
      (res) => res.url().endsWith(`/api/v1/characters/${navigation.characterId}`) && res.request().method() === 'PATCH',
    );
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    await addReq;

    await expect(card.getByText('No resistances.')).toHaveCount(0);
    await expect(card.getByText('Fire', { exact: true })).toBeVisible();
    // The other two categories are untouched by adding a resistance.
    await expect(card.getByText('No vulnerabilities.')).toBeVisible();
    await expect(card.getByText('No immunities.')).toBeVisible();

    const removeReq = page.waitForResponse(
      (res) => res.url().endsWith(`/api/v1/characters/${navigation.characterId}`) && res.request().method() === 'PATCH',
    );
    await card.getByRole('button', { name: 'Remove resistant to Fire' }).click();
    await removeReq;
    await expect(card.getByText('Fire', { exact: true })).toHaveCount(0);
    await expect(card.getByText('No resistances.')).toBeVisible();
  });
});
