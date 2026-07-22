import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #702 — the "Roll initiative" cockpit control must reflect the roster's
 * actual need instead of always offering a no-op click:
 *
 *  - When every combatant already has an initiative, the button is disabled (the
 *    server now treats this as a no-op: no write, no audit, no broadcast).
 *  - When the roster is partial (some combatants at null initiative), the label
 *    becomes "Roll remaining (N)" and reports how many still need rolling.
 *
 * The shared seeded encounter (Ambush at the Ember Hearth) is fully rolled and
 * running, so it doubles as the "fully rolled" fixture; the partial and empty
 * states are spun up in-test via the API.
 */

test.use({ storageState: stateFor('dm') });

function encounterUrl(campaignId: number, encounterId: number): string {
  return `/c/${campaignId}/encounters/${encounterId}`;
}

async function createEncounter(page: Page, campaignId: number, name: string): Promise<number> {
  const res = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name } });
  expect(res.ok()).toBe(true);
  return (await res.json()).id;
}

async function addMonster(page: Page, encounterId: number, name: string, hpMax = 10): Promise<number> {
  const res = await page.request.post(`/api/v1/encounters/${encounterId}/combatants`, {
    data: { kind: 'monster', name, hpMax },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).id;
}

test.describe('roll-initiative button states (issue #702)', () => {
  test('fully-rolled running encounter: button is disabled and labeled "Roll initiative"', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    await page.goto(encounterUrl(campaignId, encounterId));
    await expect(page.getByRole('heading', { name: 'Ambush at the Ember Hearth' })).toBeVisible();

    // Every combatant already has an initiative, so the control is disabled — no
    // no-op roll can be fired from the cockpit.
    const rollButton = page.getByRole('button', { name: /^Roll initiative$/ });
    await expect(rollButton).toBeVisible();
    await expect(rollButton).toBeDisabled();
    await expect(rollButton).toHaveAttribute('title', 'All combatants already have initiative');
  });

  test('partial preparing roster: button reads "Roll remaining (N)" and is enabled', async ({ page }) => {
    const { campaignId } = seed();
    const encounterId = await createEncounter(page, campaignId, 'Partial Prep Fight');

    // The encounter auto-adds the active party, all at null initiative. Add one
    // more monster so the "remaining" count is unambiguous, then pin one combatant
    // to prove the label tracks the null-only count, not the roster size.
    const getRes = await page.request.get(`/api/v1/encounters/${encounterId}`);
    const combatants = (await getRes.json()).combatants as Array<{ id: number }>;
    await page.request.patch(`/api/v1/encounters/${encounterId}/combatants/${combatants[0].id}`, { data: { initiative: 5 } });
    await addMonster(page, encounterId, 'Unset Orc');

    await page.goto(encounterUrl(campaignId, encounterId));
    await expect(page.getByRole('heading', { name: 'Partial Prep Fight' })).toBeVisible();

    // Recompute the expected remaining count from server truth so the assertion
    // doesn't hard-code the party size (which varies with seed fixtures).
    const fresh = (await (await page.request.get(`/api/v1/encounters/${encounterId}`)).json()).combatants as Array<{
      initiative: number | null;
    }>;
    const remaining = fresh.filter((c) => c.initiative === null).length;
    expect(remaining).toBeGreaterThan(0);

    const rollButton = page.getByRole('button', { name: new RegExp(`^Roll remaining \\(${remaining}\\)$`) });
    await expect(rollButton).toBeVisible();
    await expect(rollButton).toBeEnabled();
  });

  test('fully-rolled preparing roster: button is disabled', async ({ page }) => {
    const { campaignId } = seed();
    const encounterId = await createEncounter(page, campaignId, 'All Rolled Prep Fight');

    // Roll everyone via the API so the roster is fully set before the page loads.
    const rolled = await page.request.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
    expect(rolled.ok()).toBe(true);

    await page.goto(encounterUrl(campaignId, encounterId));
    await expect(page.getByRole('heading', { name: 'All Rolled Prep Fight' })).toBeVisible();

    const rollButton = page.getByRole('button', { name: /^Roll initiative$/ });
    await expect(rollButton).toBeVisible();
    await expect(rollButton).toBeDisabled();
  });
});
