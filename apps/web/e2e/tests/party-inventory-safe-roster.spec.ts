import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { CREDS } from '../global-setup';
import { seed, stateFor } from './seed';

async function login(ctx: APIRequestContext, baseURL: string, credentials: { username: string; password: string }) {
  await ctx.post(`${baseURL}/api/v1/auth/login`, { data: credentials });
}

test.describe('safe party roster consumers', () => {
  test.use({ storageState: stateFor('player') });

  test('a player sees a teammate on Party and their named inventory pack without receiving a sheet link', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const ownName = `Roster own ${suffix}`;
    const teammateName = `Roster teammate ${suffix}`;
    const itemName = `Roster item ${suffix}`;
    const player = await request.newContext({ baseURL });
    const dm = await request.newContext({ baseURL });
    let ownId = 0;
    let teammateId = 0;
    let itemId = 0;

    try {
      await login(player, baseURL!, CREDS.player);
      await login(dm, baseURL!, CREDS.dm);
      const own = await player.post(`/api/v1/campaigns/${campaignId}/characters`, { data: { name: ownName, className: 'Rogue', level: 3, hpCurrent: 15, hpMax: 20 } });
      if (!own.ok()) throw new Error(`create own character -> ${own.status()}: ${await own.text()}`);
      ownId = (await own.json() as { id: number }).id;
      const teammate = await dm.post(`/api/v1/campaigns/${campaignId}/characters`, { data: { name: teammateName, className: 'Fighter', level: 4, hpCurrent: 22, hpMax: 30 } });
      if (!teammate.ok()) throw new Error(`create teammate -> ${teammate.status()}: ${await teammate.text()}`);
      teammateId = (await teammate.json() as { id: number }).id;
      const item = await dm.post(`/api/v1/campaigns/${campaignId}/inventory`, { data: { name: itemName, qty: 1, ownerType: 'character', characterId: teammateId } });
      if (!item.ok()) throw new Error(`create teammate item -> ${item.status()}: ${await item.text()}`);
      itemId = (await item.json() as { id: number }).id;

      await page.goto(`/c/${campaignId}/party`);
      const teammateCard = page.getByLabel(`${teammateName}, roster entry`);
      await expect(teammateCard).toBeVisible();
      await expect(teammateCard.getByRole('link')).toHaveCount(0);
      await expect(page.getByRole('link', { name: ownName })).toHaveAttribute('href', `/c/${campaignId}/characters/${ownId}`);

      await page.goto(`/c/${campaignId}/inventory`);
      await expect(page.getByRole('heading', { name: teammateName })).toBeVisible();
      await expect(page.getByText(itemName)).toBeVisible();
      await expect(page.getByText('Unassigned', { exact: true })).toHaveCount(0);
    } finally {
      if (itemId) await dm.delete(`/api/v1/inventory/${itemId}`);
      if (teammateId) await dm.delete(`/api/v1/characters/${teammateId}`);
      if (ownId) await dm.delete(`/api/v1/characters/${ownId}`);
      await player.dispose();
      await dm.dispose();
    }
  });
});
