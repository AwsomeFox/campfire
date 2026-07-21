import { test, expect, type Page } from '@playwright/test';
import { MONSTERS } from '../global-setup';
import { seed, stateFor } from './seed';

/**
 * Combat tracker cross-role checks (issue #81):
 *  - DM: exact turn/initiative + HP math renders, and the DM-only run controls
 *    (Start/Roll initiative/Next turn/End/Cast) are present.
 *  - player & viewer: a monster's exact HP is redacted to a coarse band, and the
 *    DM-only controls + per-combatant edit controls are absent (the silent
 *    permission-drift the audit called out).
 */

const [boss, skirmisher] = MONSTERS;

function encounterUrl(): string {
  const { campaignId, encounterId } = seed();
  return `/c/${campaignId}/encounters/${encounterId}`;
}

async function openEncounter(page: Page) {
  await page.goto(encounterUrl());
  await expect(page.getByRole('heading', { name: 'Ambush at the Ember Hearth' })).toBeVisible();
}

test.describe('combat tracker — DM view', () => {
  test.use({ storageState: stateFor('dm') });

  test('renders exact initiative, HP math, running state and DM controls', async ({ page }) => {
    await openEncounter(page);

    // Fight is running (seeded via /start) — status + round render.
    await expect(page.getByText('Running', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/Round\s*1/)).toBeVisible();

    // Both monsters present with exact HP "current / max" (issue #81 HP math).
    await expect(page.getByText(boss.name).first()).toBeVisible();
    await expect(page.getByText(`${boss.hpMax} / ${boss.hpMax}`)).toBeVisible();
    await expect(page.getByText(`${skirmisher.hpMax} / ${skirmisher.hpMax}`)).toBeVisible();

    // Exact initiative is editable by the DM (aria-labelled number inputs).
    await expect(page.getByLabel(`Initiative for ${boss.name}`)).toHaveValue(String(boss.initiative));
    await expect(page.getByLabel(`Initiative for ${skirmisher.name}`)).toHaveValue(String(skirmisher.initiative));

    // DM-only run controls exist.
    await expect(page.getByRole('button', { name: 'Next turn →' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'End', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '📺 Cast' })).toBeVisible();
  });
});

test.describe('combat tracker — non-DM views', () => {
  for (const role of ['player', 'viewer'] as const) {
    test.describe(role, () => {
      test.use({ storageState: stateFor(role) });

      test('monster HP is redacted to a band and no DM controls show', async ({ page }) => {
        await openEncounter(page);

        // The monster is visible in the order...
        await expect(page.getByText(boss.name).first()).toBeVisible();
        // ...but its exact HP number is NOT — the client shows a coarse band label.
        await expect(page.getByText(`${boss.hpMax} / ${boss.hpMax}`)).toHaveCount(0);
        await expect(page.getByText('Healthy').first()).toBeVisible();

        // Initiative is read-only (span, not an input) for non-DM.
        await expect(page.getByLabel(`Initiative for ${boss.name}`)).toHaveCount(0);

        // None of the DM-only run controls render.
        await expect(page.getByRole('button', { name: 'Next turn →' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'End', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '📺 Cast' })).toHaveCount(0);
      });
    });
  }
});
