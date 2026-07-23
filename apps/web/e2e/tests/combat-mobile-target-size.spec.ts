import { test, expect, request, type Locator, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';
import { CREDS } from '../global-setup';

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
      const dm = await request.newContext({ baseURL });
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
          data: { name: `Touch size ${viewport.name}` },
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

        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`/c/${campaignId}/encounters/${enc.id}`);
        await expect(page.getByRole('heading', { name: `Touch size ${viewport.name}` })).toBeVisible();

        // Death-save pips + Roll (primary combat).
        const pip = page.getByTestId('death-save-success-pips').getByRole('button').first();
        await assertMinTarget(pip, 'death-save pip');
        await assertMinTarget(page.getByRole('button', { name: 'Roll a death save' }), 'death-save Roll');

        // HP steppers + spacing between adjacent +/-.
        const hpBtn = page.getByRole('button', { name: new RegExp(`Increase Touch Target ${viewport.name}'s HP by 1`) });
        await assertMinTarget(hpBtn, 'HP +1 stepper');
        await assertStepperSpacing(page);

        // Attack / damage roll controls — DM cards stay collapsed until expanded.
        const charName = `Touch Target ${viewport.name}`;
        await page.getByRole('button', { name: new RegExp(`Expand ${charName}'s character sheet`) }).click();
        await assertMinTarget(page.getByTestId('attack-roll-control').first(), 'attack roll');
        await assertMinTarget(page.getByTestId('damage-roll-control').first(), 'damage roll');

        // Apply-bar dismiss (the ~11px ✕ the audit measured).
        await page.getByTestId('damage-roll-control').first().click();
        const dismiss = page.getByTestId('apply-damage-dismiss');
        await assertMinTarget(dismiss, 'apply-damage dismiss');

        // Map tools (were ~21px chips).
        await assertMinTarget(page.getByTestId('map-tool-move'), 'map Move tool');
        await assertMinTarget(page.getByTestId('map-tool-ping'), 'map Ping tool');
        await assertMinTarget(page.getByTestId('map-tool-reveal'), 'map Reveal tool');
      } finally {
        if (encounterId != null) await dm.delete(`/api/v1/encounters/${encounterId}`);
        if (characterId != null) await dm.delete(`/api/v1/characters/${characterId}`);
        const seedEncounterId = seed().encounterId;
        await dm.post(`/api/v1/encounters/${seedEncounterId}/reopen`).catch(() => undefined);
        await dm.dispose();
      }
    });
  }
});
