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
      });

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
      await panel.getByRole('checkbox', { name: 'Test Hero' }).check();
      // The check dropdown populates from the checked character's catalog once it loads.
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

      await panel.getByRole('checkbox', { name: 'Scout Hero' }).check();
      await expect(panel.getByLabel('Check').locator('option[value="skill:Perception"]')).toHaveCount(1);
      await panel.getByLabel('Check').selectOption('skill:Perception');
      await panel.getByLabel('DC').fill('12');
      await panel.getByLabel('Consequence').fill('You spot a hidden trapdoor.');
      await panel.getByRole('button', { name: 'Send request' }).click();

      // --- Player on /party receives prompt without navigating and rolls ------------------
      const rollBtn = playerPage.getByRole('button', { name: /Roll Perception.*for Scout Hero/ });
      await expect(rollBtn).toBeVisible({ timeout: 15_000 });
      await rollBtn.click();

      // Result appears for the player and prompt clears from pending
      const prompts = playerPage.getByTestId('check-request-prompts');
      await expect(prompts.getByText('You spot a hidden trapdoor.')).toBeVisible();
      await expect(prompts.getByText(/Rolled/)).toBeVisible();
      await expect(playerPage.getByRole('button', { name: /Roll Perception.*for Scout Hero/ })).toHaveCount(0);

      // Verify server pending check requests for this campaign is empty
      const pendingRes = await dmApi.get(`/api/v1/campaigns/${campaignId}/check-requests?status=pending`);
      const pendingJson = await pendingRes.json();
      expect(pendingJson.filter((r: { characterId: number }) => r.characterId === characterId)).toHaveLength(0);
    } finally {
      await playerContext.close();
      await dmApi.dispose();
    }
  });

  test('group checks (#1943): DM sends a whole-party save; the DM board tally advances live over SSE as each roll lands, with no reload', async ({ page, browser }) => {
    const { baseURL } = seed();

    const dmApi: APIRequestContext = await request.newContext({ baseURL: baseURL || undefined, storageState: stateFor('dm') });
    const playerApi: APIRequestContext = await request.newContext({ baseURL: baseURL || undefined, storageState: stateFor('player') });

    let campaignId: number;
    let encounterId: number;
    try {
      const playerUserId: number = (await (await playerApi.get('/api/v1/me')).json()).user.id;

      const campaign = await (await dmApi.post('/api/v1/campaigns', { data: { name: 'E2E — Group Check Board' } })).json();
      campaignId = campaign.id;
      const addMember = await dmApi.post(`/api/v1/campaigns/${campaignId}/members`, {
        data: { userId: playerUserId, role: 'player' },
      });
      expect(addMember.ok()).toBe(true);

      // Two player-owned characters with a positive DEX modifier + DC 1, so the save is a
      // deterministic pass for both — the test asserts the tally/advisory, not dice luck.
      for (const name of ['Hero One', 'Hero Two']) {
        const created = await dmApi.post(`/api/v1/campaigns/${campaignId}/characters`, {
          data: {
            name,
            ownerUserId: String(playerUserId),
            level: 3,
            hpMax: 20,
            hpCurrent: 20,
            stats: { STR: 10, DEX: 14, CON: 10, INT: 10, WIS: 10, CHA: 10 },
            saveProficiencies: ['DEX'],
          },
        });
        expect(created.ok()).toBe(true);
      }

      const encounter = await (
        await dmApi.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name: 'Collapsing Floor', hidden: false } })
      ).json();
      encounterId = encounter.id;
    } finally {
      await playerApi.dispose();
    }

    const playerContext = await browser.newContext({ storageState: stateFor('player') });
    try {
      const playerPage = await playerContext.newPage();
      await playerPage.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(playerPage.getByRole('heading', { name: 'Collapsing Floor' })).toBeVisible();

      // --- DM sends a whole-party DEX save via the one-tap preset -----------------------------
      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      const panel = page.getByTestId('request-check-panel');
      await expect(panel).toBeVisible();
      await panel.getByTestId('check-request-whole-party').click();
      await expect(panel.getByLabel('Check').locator('option[value="save:DEX"]')).toHaveCount(1);
      await panel.getByLabel('Check').selectOption('save:DEX');
      await panel.getByLabel('DC').fill('1');
      await panel.getByRole('button', { name: 'Send request' }).click();

      // --- the DM board shows the new group at 0 of 2 passed, both members pending -----------
      const board = page.getByTestId('group-check-board');
      await expect(board).toBeVisible({ timeout: 15_000 });
      await expect(board.getByText('0 of 2 passed')).toBeVisible();
      await expect(board.getByText('Hero One')).toBeVisible();
      await expect(board.getByText('Hero Two')).toBeVisible();

      // --- the player rolls the first prompt; the DM board advances to 1 of 2, live over SSE --
      const rollOne = playerPage.getByRole('button', { name: 'Roll DEX save for Hero One' });
      await expect(rollOne).toBeVisible({ timeout: 15_000 });
      await rollOne.click();
      await expect(board.getByText('1 of 2 passed')).toBeVisible({ timeout: 15_000 });

      // --- the second roll completes the group; the tally reaches 2 of 2 and the 5e majority
      //     advisory renders (this fresh campaign defaults to the 5e adapter) -------------------
      const rollTwo = playerPage.getByRole('button', { name: 'Roll DEX save for Hero Two' });
      await expect(rollTwo).toBeVisible({ timeout: 15_000 });
      await rollTwo.click();
      await expect(board.getByText('2 of 2 passed')).toBeVisible({ timeout: 15_000 });
      await expect(board.getByText('Group succeeds (half or more)')).toBeVisible();
    } finally {
      await playerContext.close();
      await dmApi.dispose();
    }
  });

  test('hand-picking more than 20 targets disables Send with a clear reason, instead of a raw server 400 (#1943 review)', async ({ page }) => {
    const { baseURL } = seed();

    const dmApi: APIRequestContext = await request.newContext({ baseURL: baseURL || undefined, storageState: stateFor('dm') });

    try {
      const campaign = await (await dmApi.post('/api/v1/campaigns', { data: { name: 'E2E — Manual Selection Cap' } })).json();
      const campaignId = campaign.id;

      // 21 IDENTICAL characters — one over CheckRequestCreate.characterIds' server-side cap of
      // 20 — sharing a save proficiency so a real checkId CAN be picked. Without a shared stat
      // block the catalogs' intersection would be empty and the check <select> would have no
      // option to choose, which would make `canSend` false for an unrelated reason (empty
      // checkId) and never actually exercise the cap guard this test targets.
      for (let i = 1; i <= 21; i++) {
        const created = await dmApi.post(`/api/v1/campaigns/${campaignId}/characters`, {
          data: {
            name: `Extra ${i}`,
            stats: { STR: 10, DEX: 14, CON: 10, INT: 10, WIS: 10, CHA: 10 },
            saveProficiencies: ['DEX'],
          },
        });
        expect(created.ok()).toBe(true);
      }

      await page.goto(`/c/${campaignId}`);
      const panel = page.getByTestId('request-check-panel');
      await expect(panel).toBeVisible();

      // Hand-check all 21 — deliberately NOT using the "Whole party" preset, so this exercises
      // the manual-checkbox path the preset's own cap guard does not cover.
      const checkboxes = panel.locator('input[type="checkbox"][data-testid^="check-request-target-"]');
      const count = await checkboxes.count();
      expect(count).toBeGreaterThanOrEqual(21);
      for (let i = 0; i < 21; i++) {
        await checkboxes.nth(i).check();
      }

      // The cap hint is visible...
      await expect(panel.getByTestId('check-request-manual-selection-too-large')).toBeVisible();
      await expect(panel.getByTestId('check-request-manual-selection-too-large')).toContainText('21');
      await expect(panel.getByTestId('check-request-manual-selection-too-large')).toContainText('20');

      // ...and picking a real, available check (proving canSend's OTHER conditions are all
      // satisfied) still leaves Send disabled — the cap itself must be the thing blocking it.
      await expect(panel.getByLabel('Check').locator('option[value="save:DEX"]')).toHaveCount(1, { timeout: 10_000 });
      await panel.getByLabel('Check').selectOption('save:DEX');
      await expect(panel.getByRole('button', { name: 'Send request' })).toBeDisabled();

      // Unchecking back down to the cap re-enables sending. Toggling a checkbox resets the
      // chosen check (the shared-catalog intersection can change with the selection), so a
      // check must be re-picked before Send reflects the cap alone again.
      await checkboxes.nth(20).uncheck();
      await expect(panel.getByTestId('check-request-manual-selection-too-large')).toHaveCount(0);
      await expect(panel.getByLabel('Check').locator('option[value="save:DEX"]')).toHaveCount(1, { timeout: 10_000 });
      await panel.getByLabel('Check').selectOption('save:DEX');
      await expect(panel.getByRole('button', { name: 'Send request' })).toBeEnabled();
    } finally {
      await dmApi.dispose();
    }
  });

  test('a failed check-catalog fetch that later recovers clears its own error message — not just stays disabled forever (#1943 review)', async ({
    page,
  }) => {
    const { baseURL } = seed();

    const dmApi: APIRequestContext = await request.newContext({ baseURL: baseURL || undefined, storageState: stateFor('dm') });

    try {
      const campaign = await (await dmApi.post('/api/v1/campaigns', { data: { name: 'E2E — Check Load Recovery' } })).json();
      const campaignId = campaign.id;

      const character = await (
        await dmApi.post(`/api/v1/campaigns/${campaignId}/characters`, { data: { name: 'Recovery Hero' } })
      ).json();
      const characterId = character.id;

      // Force exactly the first catalog fetch for this character to fail with a 4xx (no
      // automatic react-query retry — see apps/web/src/lib/query.ts's `retry` rule — so the
      // query settles into `isError` deterministically on the very first attempt), then let
      // every subsequent request through to the real server untouched.
      let failedOnce = false;
      await page.route(`**/api/v1/characters/${characterId}/checks`, async (route) => {
        if (!failedOnce) {
          failedOnce = true;
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Simulated transient failure' }) });
          return;
        }
        await route.continue();
      });

      await page.goto(`/c/${campaignId}`);
      const panel = page.getByTestId('request-check-panel');
      await expect(panel).toBeVisible();

      await panel.getByTestId(`check-request-target-${characterId}`).check();

      // --- FAILED: the catalog fetch errors — the panel surfaces a retryable message and the
      //     check <select> is disabled, exactly as the earlier tri-state fix intends -----------
      // translateApiError prefers the server-supplied `message` verbatim over the fallback key
      // (apps/web/src/lib/api.ts) — the simulated 400 body's `message` is what actually renders.
      const errorMessage = panel.getByText('Simulated transient failure');
      await expect(errorMessage).toBeVisible({ timeout: 10_000 });
      const retryButton = panel.getByTestId('check-request-retry-catalog');
      await expect(retryButton).toBeVisible();
      await expect(panel.getByLabel('Check')).toBeDisabled();

      // --- RECOVERED: clicking Retry refetches (now hitting the real server) and succeeds —
      //     the exact regression: the error message must disappear, not linger forever ---------
      await retryButton.click();
      await expect(errorMessage).toHaveCount(0, { timeout: 10_000 });
      await expect(panel.getByLabel('Check')).toBeEnabled();
    } finally {
      await dmApi.dispose();
    }
  });
});
