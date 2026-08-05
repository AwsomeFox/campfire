/**
 * DM lifecycle header — the Start button's standing roster hint (issue #1933 review
 * finding). This used to be a permanently visible paragraph. Converting the reason to a
 * GatedControl hover/focus/tap bubble made it disappear for a sighted DM who never
 * hovers, and for every touch user who never taps a disabled button — exactly the group
 * this issue exists to serve. The reason must stay visible on screen at all times,
 * sourced from the same `run.gate.*` string the tooltip and screen-reader description use.
 *
 * NOTE ON THE FIXTURE, because the first version of this spec got it wrong and cost a CI
 * cycle: `POST /encounters` auto-adds every ACTIVE campaign character (see
 * `EncountersService.create` — "auto-adds every ACTIVE campaign character"), and there is
 * no flag to opt out. So a freshly created encounter in the seeded campaign is NOT empty;
 * it holds the party, unrolled. Asserting the "add at least one combatant" copy against a
 * fresh encounter therefore waits for text that can never appear. The two cases below set
 * up the roster state they actually name, rather than assuming it.
 */
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

const ADD_COMBATANT_HINT = 'Add at least one combatant before starting';
const ROLL_INITIATIVE_HINT = 'Roll initiative for all combatants before starting';

/** Create an encounter and strip the auto-added party, leaving a genuinely empty roster. */
async function createEmptyEncounter(page: import('@playwright/test').Page, campaignId: number, name: string) {
  const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
    data: { name, hidden: false },
  });
  expect(created.ok()).toBe(true);
  const id = ((await created.json()) as { id: number }).id;

  const read = await page.request.get(`/api/v1/encounters/${id}`);
  expect(read.ok()).toBe(true);
  const combatants = ((await read.json()) as { combatants?: Array<{ id: number }> }).combatants ?? [];
  for (const c of combatants) {
    const removed = await page.request.delete(`/api/v1/encounters/${id}/combatants/${c.id}`);
    expect(removed.ok()).toBe(true);
  }
  return id;
}

test.describe('DmLifecycleHeader — Start standing hint (issue #1933)', () => {
  test.use({ storageState: stateFor('dm') });

  test('an empty roster shows the "add a combatant" hint on screen with no interaction', async ({ page }) => {
    const { campaignId } = seed();
    const id = await createEmptyEncounter(page, campaignId, 'Start hint — empty roster');

    await page.goto(`/c/${campaignId}/encounters/${id}`);
    const startBtn = page.getByRole('button', { name: 'Start' });
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toBeDisabled();

    // Visible without any hover, focus, or tap — this is the standing instruction, not
    // the transient tooltip/tap-hint GatedControl otherwise owns.
    await expect(page.getByText(ADD_COMBATANT_HINT)).toBeVisible();
  });

  test('a party-filled, unrolled roster shows the "roll initiative" hint instead', async ({ page }) => {
    const { campaignId } = seed();
    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: 'Start hint — unrolled party', hidden: false },
    });
    expect(created.ok()).toBe(true);
    const id = ((await created.json()) as { id: number }).id;

    await page.goto(`/c/${campaignId}/encounters/${id}`);
    await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
    // The auto-added party makes this the operative roster step — pinned so the two
    // roster keys cannot be conflated again.
    await expect(page.getByText(ROLL_INITIATIVE_HINT)).toBeVisible();
    await expect(page.getByText(ADD_COMBATANT_HINT)).toHaveCount(0);
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
    const id = await createEmptyEncounter(page, campaignId, 'Start hint — hold raised');

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
      await expect(page.getByText(ADD_COMBATANT_HINT)).toBeVisible();
    } finally {
      // Shared campaign fixture — never leave the table paused for later specs.
      const released = await page.request.post(`/api/v1/campaigns/${campaignId}/safety/release`, {
        data: { recovery: 'resume' },
      });
      expect(released.ok()).toBe(true);
    }
  });
});
