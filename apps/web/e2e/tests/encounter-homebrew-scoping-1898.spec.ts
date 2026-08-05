import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';

/**
 * Issue #1898 — campaign homebrew must resolve through the encounter screen's read
 * paths, not just its write path. Before this issue, `GET /rules/entries/:id` and
 * `GET /rules/search` were global-only, so:
 *   - the in-encounter compendium picker's search never listed a campaign's own
 *     homebrew (it calls /rules/search with `pack` + the campaign's ruleSystem);
 *   - dropping a homebrew monster onto the "Add combatant" panel 404'd (it
 *     re-resolves the drag payload's id via /rules/entries/:id);
 *   - `CombatantStatblock` 404'd fetching a homebrew-linked combatant's statblock
 *     mid-fight.
 *
 * This spec drives the real backend (a homebrew monster created via the seeded DM's
 * own API session) and a real browser against the seeded "Ambush" encounter, whose
 * campaign has a `ruleSystem` configured (`e2e-open5e-actions`) — the exact shape
 * that also reproduces the pack+campaignId AND bug found in review (a `pack` filter
 * must not exclude homebrew, since homebrew lives under a separate internal pack).
 */

const STATBLOCK_DATA = {
  type: 'Aberration',
  size: 'Medium',
  challengeRating: 2,
  armorClass: 14,
  hitPoints: 33,
  speed: { walk: 30, unit: 'feet' },
  abilityScores: { strength: 13, dexterity: 14, constitution: 12, intelligence: 10, wisdom: 11, charisma: 9 },
  actions: [{ name: 'Tendril Lash', desc: 'One target takes 2d6 bludgeoning damage.' }],
};

function encounterUrl(): string {
  const { campaignId, encounterId } = seed();
  return `/c/${campaignId}/encounters/${encounterId}`;
}

/** Creates a campaign-homebrew monster via the DM's own authenticated session. */
async function createHomebrewMonster(
  page: Page,
  campaignId: number,
  name: string,
  slug: string,
): Promise<number> {
  const res = await page.request.post(`/api/v1/campaigns/${campaignId}/homebrew`, {
    data: {
      slug,
      name,
      type: 'monster',
      summary: 'Playwright fixture (issue #1898).',
      body: '',
      data: STATBLOCK_DATA,
      rightsStatus: 'private_original',
    },
  });
  if (!res.ok()) throw new Error(`POST campaign homebrew -> ${res.status()}: ${await res.text()}`);
  return (await res.json()).id;
}

test.describe('encounter homebrew scoping (issue #1898)', () => {
  test.use({ storageState: stateFor('dm') });

  test('in-encounter picker search returns the homebrew entry with its badge', async ({ page }) => {
    const { campaignId } = seed();
    const name = `PW Picker Homebrew ${Date.now()}`;
    await createHomebrewMonster(page, campaignId, name, `pw-picker-homebrew-${Date.now()}`);

    await restoreSeedEncounter(page);
    await page.goto(encounterUrl());
    await expect(page.getByRole('heading', { name: 'Ambush at the Ember Hearth' })).toBeVisible();

    await page.getByRole('tab', { name: 'Compendium' }).click();
    await page.getByLabel('Search monsters and hazards in the compendium').fill(name);

    // The campaign's seeded ruleSystem means this search sends BOTH `pack` and
    // `campaignId` (RunSessionPage.tsx's AddCombatantPanel) — the exact combination
    // that silently dropped homebrew before the ruleScopeCondition fix.
    const resultRow = page.getByRole('button', { name });
    await expect(resultRow).toBeVisible();
    await expect(resultRow.getByTestId('homebrew-badge')).toBeVisible();
    await expect(resultRow.getByTestId('homebrew-badge')).toHaveText(/Homebrew/i);
  });

  test('dragging a homebrew monster onto the panel adds the combatant, and its statblock renders in-fight', async ({
    page,
  }) => {
    const { campaignId } = seed();
    const name = `PW Drop Homebrew ${Date.now()}`;
    const entryId = await createHomebrewMonster(page, campaignId, name, `pw-drop-homebrew-${Date.now()}`);

    await restoreSeedEncounter(page);
    await page.goto(encounterUrl());
    await expect(page.getByRole('heading', { name: 'Ambush at the Ember Hearth' })).toBeVisible();

    const dropzone = page.getByTestId('add-combatant-dropzone');
    await expect(dropzone).toBeVisible();

    // Synthesizes the native drop the compendium page's draggable monster/hazard
    // cards produce (CompendiumPage.tsx sets this exact MIME payload on dragstart).
    // A real cross-page HTML5 drag can't be driven in one Playwright page, but the
    // production code under test — addDroppedRuleEntry — only ever sees the dropped
    // DataTransfer, so dispatching it directly onto the real drop target exercises
    // the same code path a genuine drag would.
    await dropzone.evaluate(
      (el, payload) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('application/x-campfire-rule-entry', JSON.stringify(payload));
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      },
      { id: entryId, name, type: 'monster' },
    );

    // The combatant is actually added — this is the acceptance criterion.
    // addDroppedRuleEntry re-resolves the dropped id via GET /rules/entries/:id?campaignId=,
    // which 404'd before this issue's fix; a 404 sets a `role="alert"` error and returns
    // WITHOUT calling onAdded(), so the combatant would never reach the tracker — this
    // positive assertion is definitive on its own.
    const combatantRow = page.getByText(name, { exact: true });
    await expect(combatantRow).toBeVisible();

    // CombatantStatblock renders a homebrew statblock in-fight (same GET route,
    // same campaignId threading): open its disclosure and assert real content,
    // not the "Couldn't load the statblock." failure state.
    const statblockToggle = page.getByRole('button', { name: /Statblock/ });
    await expect(statblockToggle).toBeVisible();
    await statblockToggle.click();
    await expect(page.getByText("Couldn't load the statblock.")).not.toBeVisible();
    const statblockRegion = page.getByRole('region', { name: 'Creature statblock' });
    await expect(statblockRegion).toBeVisible();
    // Scoped to the statblock region itself — the page also shows "33" elsewhere (the
    // initiative strip's and the combatant row's own current/max HP), which made an
    // unscoped page-wide getByText('33') ambiguous (strict-mode violation) even though
    // the statblock had genuinely rendered.
    await expect(statblockRegion.getByText('Hit Points', { exact: false })).toBeVisible();
    await expect(statblockRegion).toContainText('33');
  });
});
