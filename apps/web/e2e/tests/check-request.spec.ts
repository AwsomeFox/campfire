import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * DM-initiated check request → player prompt → consequence loop (issue #415), across two real
 * clients hitting the live backend (mirrors recap-sharing.spec's two-user + SSE pattern).
 *
 * Scenario: the DM's client requests a DEX save (with a DC + consequence) from a player's
 * character; the player's separate client receives the in-page prompt over SSE, rolls once, and
 * the roll result + the DM's consequence text are shown — and the shared dice feed reflects it.
 *
 * A fresh isolated campaign is provisioned per run (DM api context) so the seed's pinned combat
 * rosters and party/XP fixtures are never disturbed.
 */
test.describe('DM check request loop (#415)', () => {
  test.use({ storageState: stateFor('dm') });

  test('DM requests a DEX save; the targeted player is prompted, rolls once, sees the consequence', async ({ page, browser }) => {
    const { baseURL } = seed();

    const dmApi: APIRequestContext = await request.newContext({ baseURL: baseURL || undefined, storageState: stateFor('dm') });
    const playerApi: APIRequestContext = await request.newContext({ baseURL: baseURL || undefined, storageState: stateFor('player') });

    let campaignId: number;
    let encounterId: number;
    let characterId: number;
    try {
      const playerUserId: number = (await (await playerApi.get('/api/v1/me')).json()).user.id;

      const campaign = await (await dmApi.post('/api/v1/campaigns', { data: { name: 'E2E — Check Request Loop' } })).json();
      campaignId = campaign.id;
      // The player must be a member to receive the campaign event stream + read the request.
      const addMember = await dmApi.post(`/api/v1/campaigns/${campaignId}/members`, {
        data: { userId: playerUserId, role: 'player' },
      });
      expect(addMember.ok()).toBe(true);

      // A player-OWNED character with a proficient DEX save (so the ask + roll are meaningful).
      const character = await (
        await dmApi.post(`/api/v1/campaigns/${campaignId}/characters`, {
          data: {
            name: 'Test Hero',
            ownerUserId: String(playerUserId),
            level: 5,
            hpMax: 30,
            hpCurrent: 30,
            stats: { STR: 12, DEX: 16, CON: 12, INT: 10, WIS: 11, CHA: 8 },
            saveProficiencies: ['DEX'],
          },
        })
      ).json();
      characterId = character.id;

      const encounter = await (
        await dmApi.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name: 'Rope Bridge', hidden: false } })
      ).json();
      encounterId = encounter.id;
    } finally {
      await playerApi.dispose();
    }

    // --- player client: on the run-session page, waiting for a prompt --------------------------
    const playerContext = await browser.newContext({ storageState: stateFor('player') });
    try {
      const playerPage = await playerContext.newPage();
      await playerPage.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(playerPage.getByRole('heading', { name: 'Rope Bridge' })).toBeVisible();

      // --- DM client: request a DEX save via the in-page control -------------------------------
      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      const panel = page.getByTestId('request-check-panel');
      await expect(panel).toBeVisible();
      await panel.getByLabel('Character').selectOption(String(characterId));
      // The check dropdown populates from the character's catalog once it loads.
      await expect(panel.getByLabel('Check').locator('option[value="save:DEX"]')).toHaveCount(1);
      await panel.getByLabel('Check').selectOption('save:DEX');
      await panel.getByLabel('DC').fill('5');
      await panel.getByLabel('Consequence').fill('The bridge groans ominously.');
      await panel.getByRole('button', { name: 'Send request' }).click();

      // --- player receives the prompt over SSE and rolls once ----------------------------------
      const rollButton = playerPage.getByRole('button', { name: 'Roll DEX save for Test Hero' });
      await expect(rollButton).toBeVisible({ timeout: 15_000 });
      await rollButton.click();

      // The result + the DM's consequence text are shown to the player.
      const prompts = playerPage.getByTestId('check-request-prompts');
      await expect(prompts.getByText('The bridge groans ominously.')).toBeVisible();
      await expect(prompts.getByText(/Rolled/)).toBeVisible();
      await expect(prompts.getByText('Success')).toBeVisible();
      // The prompt is single-use: no second Roll button remains for this request.
      await expect(playerPage.getByRole('button', { name: 'Roll DEX save for Test Hero' })).toHaveCount(0);

      // The shared dice feed reflects the resolved roll (label carries the character + check).
      await expect(playerPage.getByTestId('shared-dice-log').getByText(/Test Hero · DEX save/)).toBeVisible({ timeout: 15_000 });
    } finally {
      await playerContext.close();
      await dmApi.dispose();
    }
  });

  test('DM sends check request from dashboard (outside encounter); player on party page receives prompt and rolls', async ({ page, browser }) => {
    const { baseURL } = seed();

    const dmApi: APIRequestContext = await request.newContext({ baseURL: baseURL || undefined, storageState: stateFor('dm') });
    const playerApi: APIRequestContext = await request.newContext({ baseURL: baseURL || undefined, storageState: stateFor('player') });

    let campaignId: number;
    let characterId: number;
    try {
      const playerUserId: number = (await (await playerApi.get('/api/v1/me')).json()).user.id;

      const campaign = await (await dmApi.post('/api/v1/campaigns', { data: { name: 'E2E — Dashboard Check Request' } })).json();
      campaignId = campaign.id;

      await dmApi.post(`/api/v1/campaigns/${campaignId}/members`, {
        data: { userId: playerUserId, role: 'player' },
      });

      const character = await (
        await dmApi.post(`/api/v1/campaigns/${campaignId}/characters`, {
          data: {
            name: 'Scout Hero',
            ownerUserId: String(playerUserId),
            level: 3,
            hpMax: 20,
            hpCurrent: 20,
            stats: { STR: 10, DEX: 14, CON: 10, INT: 12, WIS: 16, CHA: 10 },
          },
        })
      ).json();
      characterId = character.id;
    } finally {
      await playerApi.dispose();
    }

    // --- Player is sitting on the Party page (out-of-combat surface) ------------------
    const playerContext = await browser.newContext({ storageState: stateFor('player') });
    try {
      const playerPage = await playerContext.newPage();
      await playerPage.goto(`/c/${campaignId}/party`);
      await expect(playerPage.getByRole('heading', { name: /Party|Heroes/i })).toBeVisible();

      // --- DM sends request from campaign dashboard -------------------------------------
      await page.goto(`/c/${campaignId}`);
      const panel = page.getByTestId('request-check-panel');
      await expect(panel).toBeVisible();

      await panel.getByLabel('Character').selectOption(String(characterId));
      await expect(panel.getByLabel('Check').locator('option[value="skill:Perception"]')).toHaveCount(1);
      await panel.getByLabel('Check').selectOption('skill:Perception');
      await panel.getByLabel('DC').fill('12');
      await panel.getByLabel('Consequence').fill('You spot a hidden trapdoor.');
      await panel.getByRole('button', { name: 'Send request' }).click();

      // --- Player on /party receives prompt without navigating and rolls ------------------
      const rollBtn = playerPage.getByRole('button', { name: 'Roll Perception check for Scout Hero' });
      await expect(rollBtn).toBeVisible({ timeout: 15_000 });
      await rollBtn.click();

      // Result appears for the player and prompt clears from pending
      const prompts = playerPage.getByTestId('check-request-prompts');
      await expect(prompts.getByText('You spot a hidden trapdoor.')).toBeVisible();
      await expect(prompts.getByText(/Rolled/)).toBeVisible();
      await expect(playerPage.getByRole('button', { name: 'Roll Perception check for Scout Hero' })).toHaveCount(0);

      // Verify server pending check requests for this campaign is empty
      const pendingRes = await dmApi.get(`/api/v1/campaigns/${campaignId}/check-requests?status=pending`);
      const pendingJson = await pendingRes.json();
      expect(pendingJson.filter((r: { characterId: number }) => r.characterId === characterId)).toHaveLength(0);
    } finally {
      await playerContext.close();
      await dmApi.dispose();
    }
  });
});
