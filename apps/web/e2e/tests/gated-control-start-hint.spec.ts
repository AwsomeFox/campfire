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
});
