import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #639: the "Draft a beat with AI" affordance belongs on Storylines (the
 * surface that owns beats), not on Quests. The seed campaign enables the AI-DM seat
 * in co_dm mode with budget, so for the DM the button renders exactly where the
 * owning surface puts it — and is absent from the wrong surface. A player never sees
 * Storylines at all (it's DM-only), so the player scope only needs to confirm Quests
 * doesn't carry the misplaced button either.
 */

test.describe('Storylines draft-a-beat IA (issue #639)', () => {
  test.describe('DM sees the affordance on the owning surface', () => {
    test.use({ storageState: stateFor('dm') });

    test('Storylines offers "Draft a beat with AI" in its header', async ({ page }) => {
      const { campaignId } = seed();
      await page.goto(`/c/${campaignId}/storylines`);

      const trigger = page.getByRole('button', { name: 'Draft a beat with AI' });
      await expect(trigger).toBeVisible();

      // Opening the dialog confirms it drafts a story beat (the Storylines entity),
      // not a quest — the noun in the prompt label and the dialog title both match.
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Draft a story beat with AI' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: 'Describe the story beat you want to draft' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close AI drafting dialog' }).click();
      await expect(dialog).toBeHidden();
    });

    test('Quests no longer hosts the beat-drafting affordance', async ({ page }) => {
      const { campaignId } = seed();
      await page.goto(`/c/${campaignId}/quests`);

      // The mis-targeted button is gone — Quests is about quests, not beats.
      await expect(page.getByRole('button', { name: 'Draft a beat with AI' })).toHaveCount(0);
      // No other draft-with-AI button snuck in to replace it (no "quest" target exists yet).
      await expect(page.getByRole('button', { name: /Draft .* with AI/i })).toHaveCount(0);
    });
  });

  test.describe('player never sees the misplaced affordance', () => {
    test.use({ storageState: stateFor('player') });

    test('Quests has no beat-drafting button for a player', async ({ page }) => {
      const { campaignId } = seed();
      await page.goto(`/c/${campaignId}/quests`);

      await expect(page.getByRole('button', { name: 'Draft a beat with AI' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Draft .* with AI/i })).toHaveCount(0);
    });
  });
});
