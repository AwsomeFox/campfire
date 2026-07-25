import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #639 / #1307: the "Draft a beat with AI" affordance belongs on Storylines (the
 * surface that owns beats), not on Quests. Per-arc drafting is offered once arcs exist;
 * the page header button is only for initial drafting when the story is still empty.
 * Quests hosts "Draft a quest with AI" instead.
 */

test.describe('Storylines draft-a-beat IA (issue #639 / #1307)', () => {
  test.describe('DM sees the affordance on the owning surface', () => {
    test.use({ storageState: stateFor('dm') });

    test('Storylines offers per-arc "Draft beat with AI" when arcs exist', async ({ page }) => {
      const { campaignId } = seed();
      await page.goto(`/c/${campaignId}/storylines`);

      const headerTrigger = page.getByRole('button', { name: 'Draft a beat with AI' });
      await expect(headerTrigger).toHaveAttribute('aria-disabled', 'true');
      await expect(headerTrigger).toHaveAttribute(
        'title',
        'Use the per-arc Draft beat with AI button once you have story arcs.',
      );

      const arcTitle = `E2E arc ${Date.now()}`;
      await page.getByLabel('New arc title').fill(arcTitle);
      await page.getByRole('button', { name: '+ New arc' }).click();
      await expect(page.getByRole('heading', { name: arcTitle, level: 2 })).toBeVisible();

      const arcTrigger = page
        .getByLabel(arcTitle, { exact: true })
        .getByRole('button', { name: 'Draft beat with AI' });
      await expect(arcTrigger).toBeVisible();
      await arcTrigger.click();
      const dialog = page.getByRole('dialog', { name: 'Draft a story beat with AI' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: 'Describe the story beat you want to draft' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close AI drafting dialog' }).click();
      await expect(dialog).toBeHidden();
    });

    test('Quests offers "Draft a quest with AI" in its header', async ({ page }) => {
      const { campaignId } = seed();
      await page.goto(`/c/${campaignId}/quests`);

      await expect(page.getByRole('button', { name: 'Draft a beat with AI' })).toHaveCount(0);

      const trigger = page.getByRole('button', { name: 'Draft a quest with AI' });
      await expect(trigger).toBeVisible();

      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Draft a quest with AI' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: 'Describe the quest you want to draft' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close AI drafting dialog' }).click();
      await expect(dialog).toBeHidden();
    });
  });

  test.describe('player never sees the misplaced affordance', () => {
    test.use({ storageState: stateFor('player') });

    test('Quests has no AI drafting buttons for a player', async ({ page }) => {
      const { campaignId } = seed();
      await page.goto(`/c/${campaignId}/quests`);

      await expect(page.getByRole('button', { name: 'Draft a beat with AI' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Draft a quest with AI' })).toHaveCount(0);
    });
  });
});
