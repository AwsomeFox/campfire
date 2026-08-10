import { expect, request, test } from '@playwright/test';
import type { MapObject } from '@campfire/schema';
import { restoreSeedEncounter, seed, stateFor } from './seed';

async function expectOk(response: { ok(): boolean; status(): number; text(): Promise<string> }, operation: string) {
  if (!response.ok()) throw new Error(`${operation} -> ${response.status()}: ${await response.text()}`);
}

// Issue #1308 acceptance criteria: DM can place/move/label/delete a game-icon-based set
// piece, it persists across reload, and a dmOnly object never reaches a non-DM client.
test.describe('map objects (#1308)', () => {
  test.use({ storageState: stateFor('dm') });

  test('DM places a set piece via the panel, it renders on the map, and survives a reload', async ({ page, baseURL }) => {
    const { campaignId, encounterId, mapAttachmentId } = seed();
    const dm = await request.newContext({ baseURL, storageState: stateFor('dm') });
    // The panel generates its own id client-side (crypto.randomUUID) — captured once the
    // placement response arrives, used only for best-effort cleanup if a later assertion throws.
    let createdId: string | undefined;

    try {
      await restoreSeedEncounter(page);
      const setup = await dm.patch(`/api/v1/encounters/${encounterId}`, {
        data: { mapAttachmentId, gridSize: 10, gridScale: 5, gridUnit: 'ft', fog: { enabled: false, revealed: [] } },
      });
      await expectOk(setup, 'set map fixture');

      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(page.getByTestId('battle-map-surface')).toBeVisible();

      // The "Set pieces" panel lives in the Table tab alongside the other DM prep tools.
      await page.getByTestId('encounter-vtt-tab-table').click();
      await expect(page.getByTestId('map-objects-panel')).toBeVisible();

      await page.getByTestId('map-objects-panel').getByLabel('Choose icon').click();
      await page.getByLabel('Search icons').fill('chest');
      await page.locator('[data-icon-slug="chest"]').first().click();
      await page.getByTestId('map-objects-panel').getByLabel('Label').fill('E2E trapped chest');

      const placed = page.waitForResponse((response) =>
        response.request().method() === 'POST' && response.url().endsWith(`/api/v1/encounters/${encounterId}/map-objects`),
      );
      await page.getByTestId('map-objects-panel').getByRole('button', { name: 'Add' }).click();
      const placeResponse = await placed;
      expect(placeResponse.status()).toBe(201);
      const created = (await placeResponse.json()) as MapObject;
      createdId = created.id;
      expect(created).toMatchObject({ label: 'E2E trapped chest', iconSlug: 'chest', dmOnly: false });

      // Renders on the map itself (MapObjectsOverlay), not just the management list.
      await expect(page.getByTestId(`map-object-${created.id}`)).toBeVisible();

      // Reload — the acceptance criterion's literal scenario: place -> reload -> still visible.
      await page.reload();
      await page.getByTestId('encounter-vtt-tab-table').click();
      await expect(page.getByTestId(`map-object-${created.id}`)).toBeVisible();
      await expect(page.getByTestId(`map-object-row-${created.id}`)).toBeVisible();

      // Move + relabel via the same row fields, then delete.
      const row = page.getByTestId(`map-object-row-${created.id}`);
      const moved = page.waitForResponse((response) =>
        response.request().method() === 'PATCH' && response.url().endsWith(`/api/v1/encounters/${encounterId}/map-objects/${created.id}`),
      );
      await row.getByLabel('X %').fill('70');
      await row.getByLabel('X %').blur();
      const moveResponse = await moved;
      expect(moveResponse.status()).toBe(200);
      expect(((await moveResponse.json()) as MapObject).x).toBe(70);

      const removed = page.waitForResponse((response) =>
        response.request().method() === 'DELETE' && response.url().endsWith(`/api/v1/encounters/${encounterId}/map-objects/${created.id}`),
      );
      await row.getByRole('button', { name: 'Delete' }).click();
      expect((await removed).status()).toBe(200);
      await expect(page.getByTestId(`map-object-${created.id}`)).toHaveCount(0);
      createdId = undefined; // already deleted through the normal flow above
    } finally {
      // Best-effort cleanup in case an assertion failed before the in-test delete ran —
      // this fixture (encounter/campaign) is shared across e2e spec files.
      if (createdId) await dm.delete(`/api/v1/encounters/${encounterId}/map-objects/${createdId}`).catch(() => undefined);
      await dm.dispose();
    }
  });

  test('a dmOnly set piece never reaches a player client', async ({ page, browser, baseURL }) => {
    const { campaignId, encounterId, mapAttachmentId } = seed();
    const dm = await request.newContext({ baseURL, storageState: stateFor('dm') });
    const objectId = `e2e-secret-${Date.now()}`;

    try {
      await restoreSeedEncounter(page);
      await expectOk(
        await dm.patch(`/api/v1/encounters/${encounterId}`, {
          data: { mapAttachmentId, fog: { enabled: false, revealed: [] } },
        }),
        'set map fixture',
      );
      await expectOk(
        await dm.post(`/api/v1/encounters/${encounterId}/map-objects`, {
          data: { id: objectId, label: 'Secret ambush trigger', iconSlug: 'trap', x: 40, y: 40, dmOnly: true },
        }),
        'place dmOnly object',
      );

      const playerContext = await browser.newContext({ storageState: stateFor('player') });
      try {
        const playerPage = await playerContext.newPage();
        await playerPage.goto(`/c/${campaignId}/encounters/${encounterId}`);
        await expect(playerPage.getByTestId('battle-map-surface')).toBeVisible();
        await expect(playerPage.getByTestId(`map-object-${objectId}`)).toHaveCount(0);

        const encounterRes = await playerPage.request.get(`/api/v1/encounters/${encounterId}`);
        expect(encounterRes.ok()).toBe(true);
        const body = await encounterRes.text();
        expect(body).not.toContain(objectId);
        expect(body).not.toContain('Secret ambush trigger');
      } finally {
        await playerContext.close();
      }

      // The DM still sees it.
      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(page.getByTestId('battle-map-surface')).toBeVisible();
      await expect(page.getByTestId(`map-object-${objectId}`)).toBeVisible();
    } finally {
      await dm.delete(`/api/v1/encounters/${encounterId}/map-objects/${objectId}`).catch(() => undefined);
      await dm.dispose();
    }
  });
});
