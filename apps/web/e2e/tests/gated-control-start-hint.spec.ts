/**
 * DM lifecycle header — the Start button's standing roster hint (issue #1933 review
 * finding). This used to be a permanently visible paragraph. Converting the reason to a
 * GatedControl hover/focus/tap bubble made it disappear for a sighted DM who never
 * hovers, and for every touch user who never taps a disabled button — exactly the group
 * this issue exists to serve. The reason must stay visible on screen at all times,
 * sourced from the same `run.gate.*` string the tooltip and screen-reader description use.
 */
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('DmLifecycleHeader — Start standing hint (issue #1933)', () => {
  test.use({ storageState: stateFor('dm') });

  test('an empty roster shows the "add a combatant" hint on screen with no interaction', async ({ page }) => {
    const { campaignId } = seed();
    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: 'Start hint — empty roster', hidden: false },
    });
    expect(created.ok()).toBe(true);
    const id = ((await created.json()) as { id: number }).id;

    await page.goto(`/c/${campaignId}/encounters/${id}`);
    const startBtn = page.getByRole('button', { name: 'Start' });
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toBeDisabled();

    // Visible without any hover, focus, or tap — this is the standing instruction, not
    // the transient tooltip/tap-hint GatedControl otherwise owns.
    await expect(page.getByText('Add at least one combatant before starting')).toBeVisible();
  });

  /**
   * Review round 2: the first fix restored the paragraph but sourced it from
   * `startGateReason`'s single winning key, and that resolver ranks a safety hold above the
   * roster. So raising an X-Card deleted the setup instruction from the screen — the one
   * moment a DM is most likely to be looking at a dead Start button and wondering why.
   *
   * The hold is raised over the real REST route (not a stubbed store), so this exercises the
   * same state the gate actually reads. The transient reason stays tooltip-only by design;
   * what must survive is the standing roster instruction.
   */
  test('the roster hint survives a table safety hold, which outranks it in the gate', async ({ page }) => {
    const { campaignId } = seed();
    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: 'Start hint — hold raised', hidden: false },
    });
    expect(created.ok()).toBe(true);
    const id = ((await created.json()) as { id: number }).id;

    const raised = await page.request.post(`/api/v1/campaigns/${campaignId}/safety/hold`, {
      data: { anonymous: true },
    });
    expect(raised.ok()).toBe(true);

    try {
      await page.goto(`/c/${campaignId}/encounters/${id}`);
      const startBtn = page.getByRole('button', { name: 'Start' });
      await expect(startBtn).toBeVisible();
      await expect(startBtn).toBeDisabled();

      // Still on screen with zero interaction, even though `startGateReason` is now
      // returning 'safetyHold' for the button's own tooltip/aria reason.
      await expect(page.getByText('Add at least one combatant before starting')).toBeVisible();
    } finally {
      // Shared campaign fixture — never leave the table paused for later specs.
      const released = await page.request.post(`/api/v1/campaigns/${campaignId}/safety/release`, {
        data: { recovery: 'resume' },
      });
      expect(released.ok()).toBe(true);
    }
  });
});
