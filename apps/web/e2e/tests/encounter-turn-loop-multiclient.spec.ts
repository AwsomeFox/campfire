import { expect, request, test } from '@playwright/test';
import { seed, stateFor } from './seed';
import { CREDS } from '../global-setup';

/**
 * Issue #1465 — Multi-client turn loop E2E test.
 *
 * Verifies SSE propagation of turn advancement in both directions (Player -> DM, DM -> Player)
 * and verifies that concurrent advancement attempts (DM Next Turn vs Player End Turn)
 * advance turn exactly once, surfacing a stale/conflict error banner to the loser.
 */
test.describe('encounter turn loop multi-client (issue #1465)', () => {
  test('turn advancement propagates live over SSE in both directions and guards against concurrent double-advance', async ({ browser }) => {
    const { baseURL } = seed();

    const dmCtx = await request.newContext({ baseURL });
    const playerCtx = await request.newContext({ baseURL });

    const dmBrowser = await browser.newContext({ storageState: stateFor('dm') });
    const playerBrowser = await browser.newContext({ storageState: stateFor('player') });

    const dmPage = await dmBrowser.newPage();
    const playerPage = await playerBrowser.newPage();

    let campaignId: number | null = null;
    let encounterId: number | null = null;
    let characterId: number | null = null;

    try {
      await dmCtx.post('/api/v1/auth/login', { data: CREDS.dm });
      await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });

      const mePlayer = await (await playerCtx.get('/api/v1/me')).json();
      const playerUserId = mePlayer.user.id;

      const campaign = await (
        await dmCtx.post('/api/v1/campaigns', { data: { name: 'E2E — Multi-Client Turn Loop' } })
      ).json();
      campaignId = campaign.id;

      await dmCtx.post(`/api/v1/campaigns/${campaignId}/members`, {
        data: { userId: playerUserId, role: 'player' },
      });

      const character = await (
        await dmCtx.post(`/api/v1/campaigns/${campaignId}/characters`, {
          data: {
            name: 'Turn Hero',
            className: 'Fighter',
            level: 3,
            ownerUserId: String(playerUserId),
            hpCurrent: 30,
            hpMax: 30,
            stats: { DEX: 18 },
          },
        })
      ).json();
      characterId = character.id;

      const encounter = await (
        await dmCtx.post(`/api/v1/campaigns/${campaignId}/encounters`, {
          data: { name: 'Multi-Client Turn Drill', hidden: false },
        })
      ).json();
      encounterId = encounter.id;

      const heroCombatant = (
        encounter.combatants as Array<{ id: number; characterId: number | null }>
      ).find((c) => c.characterId === characterId);
      if (!heroCombatant) throw new Error('Expected auto-added hero combatant');

      const monster = await (
        await dmCtx.post(`/api/v1/encounters/${encounterId}/combatants`, {
          data: { kind: 'monster', name: 'Turn Goblin', hpMax: 15 },
        })
      ).json();

      await dmCtx.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
      await dmCtx.patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatant.id}`, {
        data: { initiative: 50 },
      });
      await dmCtx.patch(`/api/v1/encounters/${encounterId}/combatants/${monster.id}`, {
        data: { initiative: 10 },
      });
      await dmCtx.post(`/api/v1/encounters/${encounterId}/start`);

      // Open encounter on DM and Player browsers
      await dmPage.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await playerPage.goto(`/c/${campaignId}/encounters/${encounterId}`);

      await expect(dmPage.getByText('Running', { exact: true })).toBeVisible();
      await expect(playerPage.getByText('Running', { exact: true })).toBeVisible();

      // Turn 1: Hero (Player) has the turn.
      await expect(playerPage.getByTestId('workspace-end-turn')).toBeVisible();

      // Step A: Player ends turn -> DM screen updates via SSE.
      await playerPage.getByTestId('workspace-end-turn').click();

      // DM screen should automatically receive SSE update showing Goblin turn.
      await expect(dmPage.getByTestId(`combatant-row-${monster.id}`)).toHaveAttribute(
        'data-current-turn',
        'true',
      );

      // Step B: DM clicks Next turn -> Player screen updates via SSE.
      await dmPage.getByTestId('encounter-header-next-turn').click();

      // Player screen should automatically receive SSE update giving turn back to Hero.
      await expect(playerPage.getByTestId('workspace-end-turn')).toBeVisible();

      // The DM page must ALSO have applied its own Step B advance before the race below —
      // `.click()` only awaits the DOM event dispatch, not the mutation's response, so the
      // DM's local `encounter.currentCombatantId` (which the Next Turn mutation reads to
      // build `expectedCurrentCombatantId`) could still read stale Goblin here. Racing from
      // that stale state would 409 on a mismatched expected-combatant rather than exercising
      // the same-current-combatant double-advance guard the race exists to prove.
      await expect(dmPage.getByTestId(`combatant-row-${heroCombatant.id}`)).toHaveAttribute(
        'data-current-turn',
        'true',
      );

      // Step C: Concurrent race test — DM Next turn and Player End turn fired together.
      const playerEndBtn = playerPage.getByTestId('workspace-end-turn');
      const dmNextBtn = dmPage.getByTestId('encounter-header-next-turn');

      // Both buttons are confirmed actionable right above (the awaited toBeVisible() on
      // Hero's turn). But Playwright's `.click()` is not a single atomic dispatch: it
      // hit-tests, waits for the element to be stable across animation frames, then
      // synthesizes input over CDP — several sequential round-trips that, empirically,
      // take longer than this same-machine test server needs to answer the DM's request,
      // push the SSE tick, and have the player's page refetch the turn workspace. That
      // refetch flips `canEndTurn` false (it's no longer Hero's turn) and unmounts the
      // button out from under Playwright's still-in-flight actionability wait, which then
      // hangs forever waiting for a button that is never coming back — not a genuine
      // "the UI correctly prevented this click" case (the awaited assertion above already
      // proved it was clickable at the start of the race), just Playwright's own dispatch
      // pipeline losing a real race to the server. Dispatch the underlying DOM click
      // directly instead — `locator.evaluate` only waits for the element to be attached,
      // not for the full visible/stable/enabled chain — so both requests actually leave
      // the browser before either round-trip can land.
      const [playerClickOutcome, dmClickOutcome] = await Promise.allSettled([
        playerEndBtn.evaluate((el) => (el as HTMLButtonElement).click()),
        dmNextBtn.evaluate((el) => (el as HTMLButtonElement).click()),
      ]);
      // Both clicks must actually land for this to be a real race. A single request would
      // still satisfy "advances exactly once" below for the wrong reason, and no client
      // would ever error, so the banner assertion could never pass — that would be a
      // broken race, not proof the client fails to surface a real conflict.
      expect(playerClickOutcome.status, 'player end-turn click').toBe('fulfilled');
      expect(dmClickOutcome.status, 'dm next-turn click').toBe('fulfilled');

      // Turn must advance exactly ONCE (to Goblin), not twice (back to Hero in round 3).
      await expect(dmPage.getByTestId(`combatant-row-${monster.id}`)).toHaveAttribute(
        'data-current-turn',
        'true',
      );

      // Loser should surface error banner. The loser's mutation settles asynchronously
      // (its own onError callback fires after the request round-trip), so an immediate
      // isVisible() check races the render and can observe "not yet" on both pages —
      // Promise.race over instant checks resolves on whichever settles first, which is
      // usually the fast "false" from the page that never gets an error at all. Wait for
      // either banner to actually become visible instead of sampling a single instant.
      const hasErrorBanner = await Promise.race([
        dmPage
          .getByTestId('error-note')
          .waitFor({ state: 'visible', timeout: 8000 })
          .then(() => true)
          .catch(() => false),
        playerPage
          .getByTestId('error-note')
          .waitFor({ state: 'visible', timeout: 8000 })
          .then(() => true)
          .catch(() => false),
      ]);
      expect(hasErrorBanner).toBe(true);
    } finally {
      if (encounterId && campaignId) {
        await dmCtx.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
        await dmCtx.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
      }
      if (characterId) await dmCtx.delete(`/api/v1/characters/${characterId}`).catch(() => undefined);
      if (campaignId) await dmCtx.delete(`/api/v1/campaigns/${campaignId}`).catch(() => undefined);

      await dmBrowser.close();
      await playerBrowser.close();
      await dmCtx.dispose();
      await playerCtx.dispose();
    }
  });
});
