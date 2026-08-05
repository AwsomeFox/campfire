import { expect, request, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #484 — the Cast map scene mirrors the player-safe VTT: revealed fog,
 * visible tokens, and shared AoE templates; unrevealed secrets stay off-screen.
 */

const AOE_ID = 'cast-aoe-lit';
const AOE_DARK_ID = 'cast-aoe-dark';

async function patchEncounterMapFixture(
  baseURL: string,
  campaignId: number,
  encounterId: number,
  bossId: number,
  skirmisherId: number,
): Promise<void> {
  const ctx = await request.newContext({ baseURL, storageState: stateFor('dm') });
  try {
    const patch = await ctx.patch(`/api/v1/encounters/${encounterId}`, {
      data: {
        gridSize: 10,
        gridScale: 5,
        gridUnit: 'ft',
        fog: { enabled: true, revealed: [{ x: 50, y: 50, w: 50, h: 50 }] },
        aoe: [
          {
            id: AOE_DARK_ID,
            shape: 'circle',
            x: 10,
            y: 10,
            sizeFt: 10,
            angleDeg: 0,
            color: null,
            declaredByUserId: null,
          },
          {
            id: AOE_ID,
            shape: 'circle',
            x: 80,
            y: 80,
            sizeFt: 10,
            angleDeg: 0,
            color: null,
            declaredByUserId: null,
          },
        ],
      },
    });
    if (!patch.ok()) throw new Error(`encounter patch -> ${patch.status()}: ${await patch.text()}`);

    const placeBoss = await ctx.patch(`/api/v1/encounters/${encounterId}/combatants/${bossId}`, {
      data: { tokenX: 80, tokenY: 80, tokenSize: 'medium' },
    });
    if (!placeBoss.ok()) throw new Error(`place boss token -> ${placeBoss.status()}: ${await placeBoss.text()}`);

    const placeSkirmisher = await ctx.patch(`/api/v1/encounters/${encounterId}/combatants/${skirmisherId}`, {
      data: { tokenX: 10, tokenY: 10, tokenSize: 'medium' },
    });
    if (!placeSkirmisher.ok()) {
      throw new Error(`place skirmisher token -> ${placeSkirmisher.status()}: ${await placeSkirmisher.text()}`);
    }
  } finally {
    await ctx.dispose();
  }
}

test.describe('Player Display battle map (issue #484)', () => {
  test.use({ storageState: stateFor('dm'), viewport: { width: 1920, height: 1080 } });

  test('shows a revealed token while keeping Cast-only map state safe', async ({ page, baseURL }) => {
    const { campaignId, encounterId, bossId, skirmisherId } = seed();
    await patchEncounterMapFixture(baseURL!, campaignId, encounterId, bossId, skirmisherId);

    await page.addInitScript((id) => {
      localStorage.setItem(`cf.screen.scene.${id}`, 'map');
    }, campaignId);
    await page.goto(`/c/${campaignId}/screen`);

    await expect(page.getByTestId('cf-stage')).toHaveAttribute('data-scene', 'map');
    const castMap = page.getByTestId('cf-cast-battle-map');
    await expect(castMap).toBeVisible();
    await expect(page.getByTestId('battle-map-surface')).toBeVisible();
    await expect(page.getByTestId(`map-token-${bossId}`)).toBeVisible();
    await expect(page.getByTestId(`map-token-${skirmisherId}`)).toHaveCount(0);
    await expect(page.getByTestId(`map-aoe-${AOE_ID}`)).toHaveCount(0);
  });

  test('never shows fog-hidden tokens or unrevealed AoE on /screen', async ({ page, baseURL }) => {
    const { campaignId, encounterId, bossId, skirmisherId } = seed();
    await patchEncounterMapFixture(baseURL!, campaignId, encounterId, bossId, skirmisherId);

    await page.addInitScript((id) => {
      localStorage.setItem(`cf.screen.scene.${id}`, 'map');
    }, campaignId);
    await page.goto(`/c/${campaignId}/screen`);

    await expect(page.getByTestId(`map-token-${bossId}`)).toBeVisible();
    await expect(page.getByTestId(`map-token-${skirmisherId}`)).toHaveCount(0);
    await expect(page.getByTestId(`map-aoe-${AOE_DARK_ID}`)).toHaveCount(0);
  });
});
