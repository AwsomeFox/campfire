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

    test('arc and beat AI editors show current content and submit an update target id', async ({ page }) => {
      const { campaignId } = seed();
      const suffix = Date.now();
      const arcResponse = await page.request.post(`/api/v1/campaigns/${campaignId}/arcs`, {
        data: { title: `Rewrite arc ${suffix}`, summary: 'The original arc summary.' },
      });
      expect(arcResponse.ok()).toBeTruthy();
      const arc = await arcResponse.json() as { id: number; title: string; summary: string };
      const beatResponse = await page.request.post(`/api/v1/arcs/${arc.id}/beats`, {
        data: { title: `Rewrite beat ${suffix}`, body: 'The original beat body.' },
      });
      expect(beatResponse.ok()).toBeTruthy();
      const beat = await beatResponse.json() as { id: number; title: string; body: string };
      let submitted: Record<string, unknown> | null = null;

      await page.route(`**/api/v1/campaigns/${campaignId}/ai-dm/draft`, async (route) => {
        submitted = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            target: 'beat',
            provider: 'mock',
            model: 'mock-1',
            entityType: 'story_beat',
            proposalIds: [1311],
            proposals: [{
              id: 1311,
              campaignId,
              entityType: 'story_beat',
              entityId: beat.id,
              action: 'update',
              payload: { title: 'Rewritten beat', body: 'Rewritten body.' },
              snapshot: { id: beat.id, title: beat.title, body: beat.body },
              baseUpdatedAt: '2026-08-08T00:00:00.000Z',
              baseSnapshotHash: 'hash',
              proposer: 'AI DM (mock-1)',
              proposerUserId: `ai-dm:${campaignId}`,
              proposerToken: null,
              generationProvenance: null,
              status: 'pending',
              resolvedBy: '',
              note: '',
              createdAt: '2026-08-08T00:00:00.000Z',
              updatedAt: '2026-08-08T00:00:00.000Z',
            }],
            tokensUsed: 42,
            tokenBudget: 1000,
            budgetRemaining: 958,
          }),
        });
      });

      try {
        await page.goto(`/c/${campaignId}/storylines`);
        const arcSection = page.locator(`#entity-arc-${arc.id}`);
        const beatSection = page.locator(`#entity-beat-${beat.id}`);
        await expect(arcSection.getByRole('button', { name: 'Edit with AI' }).first()).toBeVisible();

        await beatSection.getByRole('button', { name: 'Edit with AI' }).click();
        const dialog = page.getByRole('dialog', { name: 'Edit story beat with AI' });
        await expect(dialog.getByLabel('Title')).toHaveValue(beat.title);
        await expect(dialog.getByLabel('Body')).toHaveValue('The original beat body.');
        await dialog.getByLabel('Rewrite instructions').fill('Make the choice more dangerous.');
        await dialog.getByRole('button', { name: 'File rewrite proposal' }).click();

        await expect(dialog.getByText('Filed 1 pending proposal for review.')).toBeVisible();
        expect(submitted).toEqual({
          target: 'beat',
          entityId: beat.id,
          prompt: 'Make the choice more dangerous.',
        });
      } finally {
        await page.request.delete(`/api/v1/arcs/${arc.id}`).catch(() => undefined);
      }
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
