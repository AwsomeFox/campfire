import { test, expect, request, type Locator, type Page } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';
import { CREDS } from '../global-setup';
import { openCockpitTab } from '../lib/encounterCockpit';

/**
 * Issue #428 — at phone widths, encounter combat + map controls must meet
 * WCAG 2.2 target-size minimums (primary actions ≥ 44×44 CSS px).
 */

const VIEWPORTS = [
  { name: '320', width: 320, height: 720 },
  { name: '375', width: 375, height: 812 },
  { name: '390', width: 390, height: 844 },
  { name: '430', width: 430, height: 932 },
] as const;

async function assertMinTarget(locator: Locator, label: string, min = 44) {
  await expect(locator, `${label} should be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} bounding box`).not.toBeNull();
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(min);
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(min);
}

async function assertStepperSpacing(page: Page) {
  const steppers = page.getByTestId('hp-steppers').locator('button');
  const count = await steppers.count();
  expect(count).toBeGreaterThanOrEqual(2);
  const a = await steppers.nth(0).boundingBox();
  const b = await steppers.nth(1).boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  const gap = b!.x - (a!.x + a!.width);
  expect(gap, 'adjacent HP steppers need mistap spacing').toBeGreaterThanOrEqual(6);
}

test.describe('encounter mobile combat/map target sizes (#428)', () => {
  test.use({ storageState: stateFor('dm') });

  for (const viewport of VIEWPORTS) {
    test(`primary combat + map controls are ≥44×44 at ${viewport.name}px`, async ({ page }) => {
      const { baseURL, campaignId } = seed();
      const dm = await request.newContext({ baseURL, storageState: stateFor('dm') });
      let characterId: number | null = null;
      let encounterId: number | null = null;

      try {
        await dm.post('/api/v1/auth/login', { data: CREDS.dm });

        // One live fight per campaign (#744) — park the seed Ambush while we drill.
        const live = await (await dm.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
        for (const e of live as { id: number }[]) {
          await dm.post(`/api/v1/encounters/${e.id}/end`);
        }

        const character = await (
          await dm.post(`/api/v1/campaigns/${campaignId}/characters`, {
            data: {
              name: `Touch Target ${viewport.name}`,
              species: 'Human',
              className: 'Fighter',
              level: 3,
              ac: 16,
              hpCurrent: 28,
              hpMax: 28,
              stats: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 8 },
              actions: [{ name: 'Longsword', kind: 'melee', toHit: '+5', damage: '1d8+3 slashing', notes: '' }],
            },
          })
        ).json();
        characterId = character.id;

        const encRes = await dm.post(`/api/v1/campaigns/${campaignId}/encounters`, {
          data: { name: `Touch size ${viewport.name}`, hidden: false },
        });
        expect(encRes.ok(), `create encounter: ${await encRes.text()}`).toBeTruthy();
        const enc = await encRes.json();
        encounterId = enc.id as number;

        const rollRes = await dm.post(`/api/v1/encounters/${enc.id}/roll-initiative`);
        expect(rollRes.ok(), `roll initiative: ${await rollRes.text()}`).toBeTruthy();
        const startRes = await dm.post(`/api/v1/encounters/${enc.id}/start`);
        expect(startRes.ok(), `start encounter: ${await startRes.text()}`).toBeTruthy();
        const mapRes = await dm.post(`/api/v1/encounters/${enc.id}/generate-map`, {
          data: { kind: 'dungeon', seed: '428' },
        });
        expect(mapRes.ok(), `generate map: ${await mapRes.text()}`).toBeTruthy();

        // Drop the PC to 0 HP / dying so death-save pips render.
        const combatant = (enc.combatants as Array<{ id: number; characterId: number | null }>).find(
          (c) => c.characterId === characterId,
        );
        expect(combatant).toBeTruthy();
        const hpRes = await dm.patch(`/api/v1/encounters/${enc.id}/combatants/${combatant!.id}`, {
          data: { hpSet: 0, deathSaveSuccesses: 1, deathSaveFailures: 1 },
        });
        expect(hpRes.ok(), `drop HP: ${await hpRes.text()}`).toBeTruthy();

        // Add a simple condition so the condition chip remove button can be measured.
        const condRes = await dm.patch(`/api/v1/encounters/${enc.id}/combatants/${combatant!.id}`, {
          data: { addConditions: ['Prone'] },
        });
        expect(condRes.ok(), `add condition: ${await condRes.text()}`).toBeTruthy();

        await dm.post(`/api/v1/encounters/${enc.id}/start`).catch(() => undefined);

        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`/c/${campaignId}/encounters/${enc.id}`);
        // TurnWorkspace is the cockpit's Turn tab; the roster is Party. This drill
        // measures controls from both, so it walks the tabs explicitly.
        await expect(page.getByRole('heading', { name: `Touch size ${viewport.name}` })).toBeVisible();
        // Roster controls (pips, HP steppers, condition chips) are the Party tab; the
        // action-economy controls further down are the Turn tab. Walk both.
        await openCockpitTab(page, 'party');

        const charName = `Touch Target ${viewport.name}`;
        const charRow = page.locator('[data-testid^="combatant-row-"]').filter({ hasText: charName });

        // Death-save pips + Roll (primary combat) — scope to this test's PC so parallel
        // shard pollution (other unconscious combatants) cannot trip strict mode.
        const pip = charRow.getByTestId('death-save-success-pips').getByRole('button').first();
        await assertMinTarget(pip, 'death-save pip');
        await assertMinTarget(charRow.getByRole('button', { name: 'Roll a death save' }), 'death-save Roll');

        // HP steppers + spacing between adjacent +/-.
        const hpBtn = page.getByRole('button', { name: new RegExp(`Increase Touch Target ${viewport.name}'s HP by 1`) });
        await assertMinTarget(hpBtn, 'HP +1 stepper');
        await assertStepperSpacing(page);

        // The active actor auto-opens; otherwise expand the DM card before measuring controls.
        const expandSheet = page.getByRole('button', { name: new RegExp(`Expand ${charName}'s character sheet`) });
        if (await expandSheet.count()) await expandSheet.click();
        await assertMinTarget(page.getByTestId('attack-roll-control').first(), 'attack roll');
        await assertMinTarget(page.getByTestId('damage-roll-control').first(), 'damage roll');

        // Roll-result toast dismiss (replaces the old inline apply-bar dismiss).
        await page.getByTestId('damage-roll-control').first().click();
        const rollToast = page.getByTestId('roll-result-toast');
        await expect(rollToast).toBeVisible();
        await assertMinTarget(rollToast.getByTestId('roll-result-toast-dismiss'), 'roll-result toast dismiss');

        // Map tools (were ~21px chips).
        await assertMinTarget(page.getByTestId('map-tool-move'), 'map Move tool');
        await assertMinTarget(page.getByTestId('map-tool-ping'), 'map Ping tool');
        await assertMinTarget(page.getByTestId('map-tool-reveal'), 'map Reveal tool');

        // Initiative input + clear roll order.
        await assertMinTarget(charRow.getByRole('spinbutton', { name: `Initiative for ${charName}` }), 'initiative input');
        await assertMinTarget(charRow.getByRole('button', { name: `Clear ${charName} roll order` }), 'clear initiative');

        // Condition chip remove (Prone added before page load).
        await assertMinTarget(charRow.getByRole('button', { name: 'Remove Prone' }), 'condition chip remove');

        // Action-economy use/undo controls in the turn workspace.
        await openCockpitTab(page, 'turn');
        const workspace = page.getByTestId('turn-workspace');
        await assertMinTarget(workspace.getByRole('button', { name: 'Use' }).first(), 'action-economy use');
        await assertMinTarget(workspace.getByRole('button', { name: 'Undo' }).first(), 'action-economy undo');

        // Add-combatant tab bar — each tab must be a 44×44 target.
        await openCockpitTab(page, 'party');
        const addTabs = page.getByTestId('add-combatant-tabs').locator('button');
        const tabCount = await addTabs.count();
        expect(tabCount).toBeGreaterThanOrEqual(2);
        for (let i = 0; i < tabCount; i++) {
          await assertMinTarget(addTabs.nth(i), `add-combatant tab ${i}`);
        }

        // Condition editor: opening it should fit within the viewport at 320px.
        await charRow.getByRole('button', { name: '+ condition' }).click();

        // New quick-condition flow: first opens the quick-chip view
        const quickForm = page.getByText('Quick condition:').first().locator('..');
        await expect(quickForm).toBeVisible();

        // Then we open the full form
        await quickForm.getByRole('button', { name: 'More options…' }).click();

        const conditionForm = page.getByText('Add a structured condition instance.').first().locator('..');
        await expect(conditionForm).toBeVisible();
        const formBox = await conditionForm.boundingBox();
        expect(formBox).not.toBeNull();
        expect(formBox!.x, 'condition editor left edge').toBeGreaterThanOrEqual(0);
        expect(formBox!.x + formBox!.width, 'condition editor right edge').toBeLessThanOrEqual(viewport.width);
      } finally {
        // End before delete so a failed DELETE cannot leave a RUNNING fight that
        // blocks restoreSeedEncounter's /reopen (ENCOUNTER_ALREADY_RUNNING, #744).
        if (encounterId != null) {
          await dm.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
          await dm.delete(`/api/v1/encounters/${encounterId}`);
        }
        if (characterId != null) await dm.delete(`/api/v1/characters/${characterId}`);
        await restoreSeedEncounter(page);
        await dm.dispose();
      }
    });
  }
});
