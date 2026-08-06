import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { seed, stateFor } from './seed';
import { CREDS } from '../global-setup';

/**
 * Issue #1916 — the encounter cockpit's optimistic/conflict layer is what keeps HP and the
 * turn pointer correct when a DM and a player write at the same table simultaneously. It was
 * previously exercised only in disconnected unit specs and DM-vs-DM browser specs
 * (`encounter-sync-live.spec.ts`, `encounter-sync-override.spec.ts`) — no browser test ever
 * ran a real DM context against a real player context. This suite covers three concrete
 * races end to end: a turn-advance CAS conflict (`TURN_ALREADY_ADVANCED`), concurrent
 * relative HP writes composing without a lost update, and an SSE outage that gates one
 * role's writes while the other keeps acting, then converges on reconnect.
 *
 * Every test builds its OWN dedicated campaign (never the shared seeded "Ambush" fixture,
 * whose `dmControlsTurns` and roster other specs depend on) and tears it down in `finally`,
 * so this file never mutates state another shard's spec could observe.
 */

/** Creates a fresh campaign with a real player member and a player-owned, active PC. */
async function setupConflictCampaign(
  dmContext: { request: APIRequestContext },
  name: string,
  campaignOpts: Record<string, unknown> = {},
): Promise<{ campaignId: number; characterId: number; playerUserId: string }> {
  const campaign = await (
    await dmContext.request.post('/api/v1/campaigns', { data: { name, ...campaignOpts } })
  ).json();
  const campaignId: number = campaign.id;

  const playerCtx = await request.newContext({ baseURL: seed().baseURL });
  await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });
  const me = await (await playerCtx.get('/api/v1/me')).json();
  const playerUserId = String(me.user.id);
  await playerCtx.dispose();

  await dmContext.request.post(`/api/v1/campaigns/${campaignId}/members`, {
    data: { userId: me.user.id, role: 'player' },
  });

  const character = await (
    await dmContext.request.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: {
        name: `${name} PC`,
        className: 'Fighter',
        level: 3,
        ownerUserId: playerUserId,
        hpCurrent: 30,
        hpMax: 30,
        ac: 14,
      },
    })
  ).json();

  return { campaignId, characterId: character.id, playerUserId };
}

// ---------------------------------------------------------------------------------------
// Scenario 1 — turn-advance race (real DM + real player browser contexts)
// ---------------------------------------------------------------------------------------
test('a stale player end-turn 409s TURN_ALREADY_ADVANCED after the DM advances first, and both clients converge on the server turn pointer', async ({
  browser,
}) => {
  const dmContext = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const playerContext = await browser.newContext({ storageState: stateFor('player'), serviceWorkers: 'block' });
  const dmPage = await dmContext.newPage();
  const playerPage = await playerContext.newPage();

  let campaignId: number | null = null;
  let encounterId: number | null = null;
  let releaseEndTurn: () => void = () => {};

  try {
    // dmControlsTurns explicitly false (also the schema default) — this campaign setting
    // is exactly what scenario 1 requires: a player may end their OWN active combatant's turn.
    const setup = await setupConflictCampaign(dmContext, 'E2E1916 Turn Race', { dmControlsTurns: false });
    campaignId = setup.campaignId;

    // A SECOND character owned by the SAME player. This is deliberate, not incidental: the
    // server's end-turn authorization (encounters.service.ts's endTurn) re-reads the CURRENT
    // combatant fresh from the row at request time and 403s a non-DM whose current combatant
    // isn't a character they own — BEFORE it ever reaches the CAS check this test targets. If
    // the DM's advance moved the pointer to a monster (or another player's PC), the player's
    // stale end-turn would 403 on ownership instead of 409 on staleness — a different,
    // legitimate rejection that would make this test pass for the wrong reason. Keeping BOTH
    // combatants owned by this player means the DM's advance still lands on a combatant this
    // player legitimately owns, so authorization clears and the CAS mismatch is what fires.
    const secondCharacter = await (
      await dmContext.request.post(`/api/v1/campaigns/${campaignId}/characters`, {
        data: {
          name: 'E2E1916 Turn Race PC2',
          className: 'Rogue',
          level: 3,
          ownerUserId: setup.playerUserId,
          hpCurrent: 20,
          hpMax: 20,
          ac: 14,
        },
      })
    ).json();

    const enc = await (
      await dmContext.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1916 Turn Race Fight', hidden: false },
      })
    ).json();
    encounterId = enc.id;
    const combatants = enc.combatants as Array<{ id: number; characterId: number | null }>;
    const playerCombatant = combatants.find((c) => c.characterId === setup.characterId);
    const playerCombatant2 = combatants.find((c) => c.characterId === secondCharacter.id);
    if (!playerCombatant || !playerCombatant2) throw new Error('expected two auto-added player combatants');

    await dmContext.request.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
    await dmContext.request.post(`/api/v1/encounters/${encounterId}/start`);

    // Deterministic order: the FIRST player combatant holds the turn. Two combatants total,
    // so one advance always flips the pointer to "the other one" — no dependence on whatever
    // roll-initiative happened to roll.
    await dmContext.request.patch(`/api/v1/encounters/${encounterId}/combatants/${playerCombatant.id}`, {
      data: { initiative: 20 },
    });
    await dmContext.request.patch(`/api/v1/encounters/${encounterId}/combatants/${playerCombatant2.id}`, {
      data: { initiative: 1 },
    });
    let state = await (await dmContext.request.get(`/api/v1/encounters/${encounterId}`)).json();
    if (state.currentCombatantId !== playerCombatant.id) {
      await dmContext.request.post(`/api/v1/encounters/${encounterId}/next-turn`, {
        data: { expectedCurrentCombatantId: state.currentCombatantId },
      });
      state = await (await dmContext.request.get(`/api/v1/encounters/${encounterId}`)).json();
    }
    if (state.currentCombatantId !== playerCombatant.id) {
      throw new Error(`expected turn to land on the player combatant, got ${JSON.stringify(state)}`);
    }

    // Hold the player's end-turn request client-side until we release it below — this is
    // what turns "the DM happens to advance first" into a DETERMINISTIC, not merely likely,
    // race: the player's request is dispatched (and its expectedCurrentCombatantId is
    // captured) BEFORE the DM's advance commits, but does not reach the server until after.
    const heldEndTurn = new Promise<void>((resolve) => {
      releaseEndTurn = resolve;
    });
    await playerPage.route(`**/api/v1/encounters/${encounterId}/end-turn`, async (route) => {
      await heldEndTurn;
      await route.continue();
    });

    await playerPage.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await dmPage.goto(`/c/${campaignId}/encounters/${encounterId}`);

    const endTurnBtn = playerPage.getByTestId('workspace-end-turn');
    await expect(endTurnBtn).toBeVisible();
    await expect(endTurnBtn).toBeEnabled();
    await endTurnBtn.click(); // fires the POST, which the route above now holds open

    const dmNextTurnBtn = dmPage.getByTestId('encounter-header-next-turn');
    await expect(dmNextTurnBtn).toBeEnabled();
    await dmNextTurnBtn.click();
    await expect(dmPage.locator(`[data-testid="combatant-row-${playerCombatant2.id}"]`)).toHaveAttribute(
      'data-current-turn',
      'true',
      { timeout: 10_000 },
    );

    // Only now does the player's already-in-flight (now stale) end-turn reach the server.
    releaseEndTurn();

    await expect(playerPage.getByTestId('error-note')).toContainText(/Someone else already advanced the turn/i);

    // Convergence: both clients settle on the server's real turn pointer (the second
    // combatant), not the player's stale expectation — asserted in the DOM for both roles
    // AND via REST.
    await expect(playerPage.locator(`[data-testid="combatant-row-${playerCombatant2.id}"]`)).toHaveAttribute(
      'data-current-turn',
      'true',
      { timeout: 10_000 },
    );
    await expect(dmPage.locator(`[data-testid="combatant-row-${playerCombatant2.id}"]`)).toHaveAttribute(
      'data-current-turn',
      'true',
    );

    const finalState = await (await dmContext.request.get(`/api/v1/encounters/${encounterId}`)).json();
    expect(finalState.currentCombatantId).toBe(playerCombatant2.id);
  } finally {
    releaseEndTurn();
    if (encounterId != null) {
      await dmContext.request.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
    }
    if (campaignId != null) {
      await dmContext.request.delete(`/api/v1/campaigns/${campaignId}`).catch(() => undefined);
    }
    await Promise.all([playerContext.close(), dmContext.close()]);
  }
});

// ---------------------------------------------------------------------------------------
// Scenario 2 — concurrent relative HP writes to the SAME combatant (real DM + real player)
// ---------------------------------------------------------------------------------------
test('a DM damage write and a player heal write to the same combatant both compose — no lost update — and both clients converge on the REST-read final HP', async ({
  browser,
}) => {
  const dmContext = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const playerContext = await browser.newContext({ storageState: stateFor('player'), serviceWorkers: 'block' });
  const dmPage = await dmContext.newPage();
  const playerPage = await playerContext.newPage();

  let campaignId: number | null = null;
  let encounterId: number | null = null;
  let releaseDmPatch: () => void = () => {};
  let releasePlayerPatch: () => void = () => {};

  try {
    const setup = await setupConflictCampaign(dmContext, 'E2E1916 HP Race');
    campaignId = setup.campaignId;

    const enc = await (
      await dmContext.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1916 HP Race Fight', hidden: false },
      })
    ).json();
    encounterId = enc.id;
    const playerCombatant = (enc.combatants as Array<{ id: number; characterId: number | null }>).find(
      (c) => c.characterId === setup.characterId,
    );
    if (!playerCombatant) throw new Error('expected auto-added player combatant');

    await dmContext.request.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
    await dmContext.request.post(`/api/v1/encounters/${encounterId}/start`);

    const combatantUrl = `**/api/v1/encounters/${encounterId}/combatants/${playerCombatant.id}`;
    const dmHeld = new Promise<void>((resolve) => {
      releaseDmPatch = resolve;
    });
    const playerHeld = new Promise<void>((resolve) => {
      releasePlayerPatch = resolve;
    });
    await dmPage.route(combatantUrl, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await dmHeld;
      return route.continue();
    });
    await playerPage.route(combatantUrl, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await playerHeld;
      return route.continue();
    });

    await dmPage.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await playerPage.goto(`/c/${campaignId}/encounters/${encounterId}`);

    const dmRow = dmPage.getByTestId(`combatant-row-${playerCombatant.id}`);
    const playerRow = playerPage.getByTestId(`combatant-row-${playerCombatant.id}`);
    await expect(dmRow.getByTestId('hp-steppers')).toBeVisible();
    await expect(playerRow.getByTestId('hp-steppers')).toBeVisible();

    await dmRow.getByLabel('Exact HP amount').fill('7');
    await playerRow.getByLabel('Exact HP amount').fill('4');

    const dmPatchDone = dmPage.waitForResponse(
      (r) => r.url().includes(`/combatants/${playerCombatant.id}`) && r.request().method() === 'PATCH',
    );
    const playerPatchDone = playerPage.waitForResponse(
      (r) => r.url().includes(`/combatants/${playerCombatant.id}`) && r.request().method() === 'PATCH',
    );

    // Fire both writes — held by the routes above — before releasing either, so the two
    // PATCH requests are genuinely in flight together rather than strictly sequential.
    await dmRow.getByRole('button', { name: 'Apply exact damage' }).click();
    await playerRow.getByRole('button', { name: 'Apply exact healing' }).click();
    releaseDmPatch();
    releasePlayerPatch();

    await dmPatchDone;
    await playerPatchDone;

    // 30 (seeded) - 7 (DM damage) + 4 (player heal) = 27. Neither write was lost.
    const finalState = await (await dmContext.request.get(`/api/v1/encounters/${encounterId}`)).json();
    const finalCombatant = (finalState.combatants as Array<{ id: number; hpCurrent: number }>).find(
      (c) => c.id === playerCombatant.id,
    );
    expect(finalCombatant?.hpCurrent).toBe(27);

    // Both UIs converge on that same value via their own stepper's aria-label (not just a
    // raw text match — the label spells out "currently N of M", so this asserts the real
    // rendered HP, not merely the presence of the number 27 somewhere on the page).
    const hpLabelPattern = /currently 27 of 30/;
    await expect
      .poll(async () => (await dmRow.getByRole('button', { name: /Increase/ }).first().getAttribute('aria-label')) ?? '')
      .toMatch(hpLabelPattern);
    await expect
      .poll(async () => (await playerRow.getByRole('button', { name: /Increase/ }).first().getAttribute('aria-label')) ?? '')
      .toMatch(hpLabelPattern);
  } finally {
    releaseDmPatch();
    releasePlayerPatch();
    if (encounterId != null) {
      await dmContext.request.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
    }
    if (campaignId != null) {
      await dmContext.request.delete(`/api/v1/campaigns/${campaignId}`).catch(() => undefined);
    }
    await Promise.all([playerContext.close(), dmContext.close()]);
  }
});

// ---------------------------------------------------------------------------------------
// Scenario 3 — STALE_WRITE + client-side rollback on an encounter-level field
// ---------------------------------------------------------------------------------------
test('an encounter-level PATCH rejected as STALE_WRITE renders the conflict, rolls the optimistic edit back, and settles on server truth', async ({
  browser,
}) => {
  const dmContext = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const dmPage = await dmContext.newPage();
  const writerContext = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });

  let campaignId: number | null = null;
  let encounterId: number | null = null;
  let releasePatch: () => void = () => {};

  try {
    const campaign = await (
      await dmContext.request.post('/api/v1/campaigns', { data: { name: 'E2E1916 Stale Write' } })
    ).json();
    campaignId = campaign.id;

    const enc = await (
      await dmContext.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1916 Stale Fight', hidden: false },
      })
    ).json();
    encounterId = enc.id;
    await dmContext.request.post(`/api/v1/encounters/${encounterId}/combatants`, {
      data: { kind: 'monster', name: 'E2E1916 Stale Foe', hpMax: 10 },
    });
    await dmContext.request.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
    // Running (not just preparing) so VisibleToPlayersBar's onReveal is wired and the
    // hidden/visible bar swap is observable — see that component's branch on encounter.status.
    await dmContext.request.post(`/api/v1/encounters/${encounterId}/start`);

    const heldPatch = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    await dmPage.route(`**/api/v1/encounters/${encounterId}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await heldPatch;
      return route.continue();
    });

    await dmPage.goto(`/c/${campaignId}/encounters/${encounterId}`);

    const visibleBar = dmPage.getByTestId('visible-to-players-bar');
    await expect(visibleBar).toBeVisible();
    await visibleBar.getByRole('button', { name: 'Hide' }).click(); // fires PATCH {hidden:true}, held

    // Optimistic write lands immediately (before the network call even resolves): the bar
    // flips to "hidden" while our PATCH is still in flight.
    await expect(dmPage.getByTestId('hidden-from-players-bar')).toBeVisible();

    // A second writer (same DM, a different device/tab) bumps the encounter's revision
    // while our PATCH is held — this is the race: our optimistic write is now based on a
    // revision token the server no longer has.
    await writerContext.request.patch(`/api/v1/encounters/${encounterId}`, {
      data: { name: 'E2E1916 Stale Fight (bumped)' },
    });

    // Release the held PATCH — it now carries a stale expectedUpdatedAt and 409s.
    releasePatch();

    await expect(dmPage.getByTestId('error-note')).toContainText(/Another device saved a newer encounter version/i);

    // The optimistic `hidden: true` rolls back (rollbackEncounterPatchError) — the bar
    // reverts to "visible", not the wrongly-optimistic "hidden" state.
    await expect(dmPage.getByTestId('visible-to-players-bar')).toBeVisible();
    await expect(dmPage.getByTestId('hidden-from-players-bar')).toHaveCount(0);

    const finalState = await (await writerContext.request.get(`/api/v1/encounters/${encounterId}`)).json();
    expect(finalState.hidden).toBe(false);
    expect(finalState.name).toBe('E2E1916 Stale Fight (bumped)');
  } finally {
    releasePatch();
    if (encounterId != null) {
      await dmContext.request.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
    }
    if (campaignId != null) {
      await dmContext.request.delete(`/api/v1/campaigns/${campaignId}`).catch(() => undefined);
    }
    await Promise.all([writerContext.close(), dmContext.close()]);
  }
});

// ---------------------------------------------------------------------------------------
// Scenario 5 — SSE outage with mixed roles (real DM + real player browser contexts)
// ---------------------------------------------------------------------------------------
test('a player-only SSE outage gates the player while the DM keeps acting, and the player converges on reconnect', async ({
  browser,
}) => {
  const dmContext = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const playerContext = await browser.newContext({ storageState: stateFor('player'), serviceWorkers: 'block' });
  const dmPage = await dmContext.newPage();
  const playerPage = await playerContext.newPage();

  let campaignId: number | null = null;
  let encounterId: number | null = null;
  let blockEvents = false;
  let eventAttempts = 0;

  try {
    const setup = await setupConflictCampaign(dmContext, 'E2E1916 SSE Outage');
    campaignId = setup.campaignId;

    const enc = await (
      await dmContext.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1916 SSE Outage Fight', hidden: false },
      })
    ).json();
    encounterId = enc.id;
    const playerCombatant = (enc.combatants as Array<{ id: number; characterId: number | null }>).find(
      (c) => c.characterId === setup.characterId,
    );
    if (!playerCombatant) throw new Error('expected auto-added player combatant');

    const monster = await (
      await dmContext.request.post(`/api/v1/encounters/${encounterId}/combatants`, {
        data: { kind: 'monster', name: 'E2E1916 Outage Foe', hpMax: 10 },
      })
    ).json();

    await dmContext.request.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
    await dmContext.request.post(`/api/v1/encounters/${encounterId}/start`);
    // Deterministic starting pointer so "the DM advances" has an unambiguous before/after.
    await dmContext.request.patch(`/api/v1/encounters/${encounterId}/combatants/${playerCombatant.id}`, {
      data: { initiative: 20 },
    });
    await dmContext.request.patch(`/api/v1/encounters/${encounterId}/combatants/${monster.id}`, {
      data: { initiative: 1 },
    });
    const initialState = await (await dmContext.request.get(`/api/v1/encounters/${encounterId}`)).json();
    if (initialState.currentCombatantId !== playerCombatant.id) {
      await dmContext.request.post(`/api/v1/encounters/${encounterId}/next-turn`, {
        data: { expectedCurrentCombatantId: initialState.currentCombatantId },
      });
    }
    const verifiedState = await (await dmContext.request.get(`/api/v1/encounters/${encounterId}`)).json();
    if (verifiedState.currentCombatantId !== playerCombatant.id) {
      throw new Error(`expected turn to land on the player combatant, got ${JSON.stringify(verifiedState)}`);
    }

    await playerPage.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      eventAttempts += 1;
      if (blockEvents) await route.abort('connectionfailed');
      else await route.continue();
    });

    const initialStream = playerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/campaigns/${campaignId}/events`),
    );
    await playerPage.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await initialStream;
    await expect(playerPage.getByTestId('encounter-sync-chip')).toHaveText('Live');

    await dmPage.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await expect(dmPage.getByTestId('encounter-sync-chip')).toHaveText('Live');

    const playerRow = playerPage.getByTestId(`combatant-row-${playerCombatant.id}`);
    const playerStepper = playerRow.getByTestId('hp-steppers').getByRole('button').first();
    await expect(playerStepper).toBeEnabled();

    // The player's SSE connection drops — a real network cut, not just the next reconnect
    // attempt — while the DM's own connection is completely untouched.
    await playerContext.setOffline(true);
    await expect(playerPage.getByTestId('encounter-sync-chip')).toHaveText('Offline');
    await expect(playerPage.getByTestId('encounter-sync-banner')).toContainText(/Combat actions are paused/i);
    await expect(playerStepper).toBeDisabled();

    // The DM advances the turn WHILE the player is still cut off.
    const dmNextTurnBtn = dmPage.getByTestId('encounter-header-next-turn');
    await expect(dmNextTurnBtn).toBeEnabled();
    await dmNextTurnBtn.click();
    await expect(dmPage.locator(`[data-testid="combatant-row-${monster.id}"]`)).toHaveAttribute(
      'data-current-turn',
      'true',
      { timeout: 10_000 },
    );

    // Network returns, but the events endpoint itself keeps failing until we say otherwise —
    // isolates "network is back" from "the stream successfully reconnected".
    blockEvents = true;
    const attemptsBeforeRestore = eventAttempts;
    await playerContext.setOffline(false);
    await expect.poll(() => eventAttempts).toBeGreaterThan(attemptsBeforeRestore);
    await expect(playerPage.getByTestId('encounter-sync-chip')).toHaveText(/Reconnecting|Stale/);
    await expect(playerStepper).toBeDisabled();

    blockEvents = false;
    await expect(playerPage.getByTestId('encounter-sync-chip')).toHaveText('Live', { timeout: 15_000 });

    // Convergence: the player's reconnect refetch shows the DM's advance, and the
    // previously-gated write control is live again — both asserted in the DOM.
    await expect(playerPage.locator(`[data-testid="combatant-row-${monster.id}"]`)).toHaveAttribute(
      'data-current-turn',
      'true',
      { timeout: 10_000 },
    );
    await expect(playerStepper).toBeEnabled();

    // ...and confirmed as real server state via REST, from a context the outage never touched.
    const finalState = await (await dmContext.request.get(`/api/v1/encounters/${encounterId}`)).json();
    expect(finalState.currentCombatantId).toBe(monster.id);
  } finally {
    if (encounterId != null) {
      await dmContext.request.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
    }
    if (campaignId != null) {
      await dmContext.request.delete(`/api/v1/campaigns/${campaignId}`).catch(() => undefined);
    }
    await Promise.all([playerContext.close(), dmContext.close()]);
  }
});
