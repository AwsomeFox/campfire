import { expect, request, test } from '@playwright/test';
import type { AoeTemplate, CampaignMember } from '@campfire/schema';
import { restoreSeedEncounter, seed, stateFor } from './seed';

async function expectOk(response: { ok(): boolean; status(): number; text(): Promise<string> }, operation: string) {
  if (!response.ok()) throw new Error(`${operation} -> ${response.status()}: ${await response.text()}`);
}

test.describe('player-declared AoE templates (#1913)', () => {
  test.use({ storageState: stateFor('player') });

  test('a player places a cone without server-owned attribution, while the DM can attribute and clear it', async ({ page, browser, baseURL }) => {
    const { campaignId, encounterId, mapAttachmentId } = seed();
    const dm = await request.newContext({ baseURL, storageState: stateFor('dm') });
    let viewerMember: CampaignMember | undefined;

    try {
      await restoreSeedEncounter(page);
      const membersResponse = await dm.get(`/api/v1/campaigns/${campaignId}/members`);
      await expectOk(membersResponse, 'list campaign members');
      viewerMember = ((await membersResponse.json()) as CampaignMember[]).find((member) => member.username === 'viewer');
      if (!viewerMember) throw new Error('The E2E fixture needs a viewer member');

      const setup = await dm.patch(`/api/v1/encounters/${encounterId}`, {
        data: {
          mapAttachmentId,
          gridSize: 10,
          gridScale: 5,
          gridUnit: 'ft',
          fog: { enabled: false, revealed: [] },
          aoe: [],
        },
      });
      await expectOk(setup, 'set map fixture');

      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(page.getByTestId('battle-map-surface')).toBeVisible();

      const created = page.waitForResponse((response) =>
        response.request().method() === 'POST'
        && response.url().endsWith(`/api/v1/encounters/${encounterId}/aoe-templates`),
      );
      await page.getByTitle('Add a cone').click();
      const createResponse = await created;
      expect(createResponse.status()).toBe(201);
      const declaration = createResponse.request().postDataJSON() as Record<string, unknown>;
      expect(declaration).not.toHaveProperty('declaredByUserId');
      const template = (await createResponse.json()) as AoeTemplate;
      expect(template).toMatchObject({ shape: 'cone', declaredByUserId: expect.any(String) });

      // The server's player view must project templates through fog before the second player's
      // browser receives the encounter. Promoting the seeded viewer provides an independent,
      // real authenticated player session without introducing a new fixture account.
      const promote = await dm.patch(`/api/v1/campaigns/${campaignId}/members/${viewerMember.id}`, {
        data: { role: 'player' },
      });
      await expectOk(promote, 'promote second player');
      const hideTemplate = await dm.patch(`/api/v1/encounters/${encounterId}`, {
        data: { fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 20, h: 20 }] } },
      });
      await expectOk(hideTemplate, 'hide player template behind fog');

      const secondPlayer = await browser.newContext({ storageState: stateFor('viewer') });
      try {
        const secondPlayerPage = await secondPlayer.newPage();
        await secondPlayerPage.goto(`/c/${campaignId}/encounters/${encounterId}`);
        await expect(secondPlayerPage.getByTestId('battle-map-surface')).toBeVisible();
        await expect(secondPlayerPage.getByTestId(`map-aoe-${template.id}`)).toHaveCount(0);
      } finally {
        await secondPlayer.close();
      }

      const dmBrowser = await browser.newContext({ storageState: stateFor('dm') });
      try {
        const dmPage = await dmBrowser.newPage();
        await dmPage.goto(`/c/${campaignId}/encounters/${encounterId}`);
        const dmTemplate = dmPage.getByTestId(`map-aoe-${template.id}`);
        await expect(dmTemplate).toBeVisible();
        await expect(dmTemplate).toHaveAttribute('aria-label', /declared by player/i);

        const removed = dmPage.waitForResponse((response) =>
          response.request().method() === 'DELETE'
          && response.url().endsWith(`/api/v1/encounters/${encounterId}/aoe-templates/${template.id}`),
        );
        await dmPage.getByRole('button', { name: 'Clear player templates' }).click();
        expect((await removed).status()).toBe(200);
        await expect(dmTemplate).toHaveCount(0);
      } finally {
        await dmBrowser.close();
      }
    } finally {
      if (viewerMember) {
        const restoreViewer = await dm.patch(`/api/v1/campaigns/${campaignId}/members/${viewerMember.id}`, {
          data: { role: 'viewer' },
        });
        await expectOk(restoreViewer, 'restore viewer role');
      }
      const cleanup = await dm.patch(`/api/v1/encounters/${encounterId}`, {
        data: { fog: { enabled: false, revealed: [] }, aoe: [] },
      });
      await expectOk(cleanup, 'clear AoE fixture');
      await dm.dispose();
    }
  });
});
