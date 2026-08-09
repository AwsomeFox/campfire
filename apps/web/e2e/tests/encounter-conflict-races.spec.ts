import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { seed, stateFor } from './seed';
import { CREDS } from '../global-setup';
import { openCockpitTab } from '../lib/encounterCockpit';

/**
 * Issue #1916 — the encounter cockpit's optimistic/conflict layer is what keeps HP and the
 * turn pointer correct when a DM and a player write at the same table simultaneously. It was
 * previously exercised only in disconnected unit specs and DM-vs-DM browser specs
 * (`encounter-sync-live.spec.ts`, `encounter-sync-override.spec.ts`) — no browser test ever
 * ran a real DM context against a real player context. This suite covers three concrete
 * races end to end: a turn-advance CAS conflict (`TURN_ALREADY_ADVANCED`), an encounter-level
 * STALE_WRITE with client-side rollback, and an SSE outage that gates one role's writes while
 * the other keeps acting, then converges on reconnect. (A fourth scenario — concurrent
 * relative HP writes to one combatant — is deliberately NOT included here; see the comment
 * where it would sit, below scenario 1, for why it could not be proven under mutation.)
 *
 * Every test builds its OWN dedicated campaign (never the shared seeded "Ambush" fixture,
 * whose `dmControlsTurns` and roster other specs depend on) and tears it down in `finally`,
 * so this file never mutates state another shard's spec could observe.
 */

/**
 * Creates a fresh campaign with a real player member and a player-owned, active PC.
 *
 * `onCampaignCreated` fires the instant the campaign id exists — BEFORE any of the later
 * setup steps (player login, member add, character create) that could still throw. Every
 * call site uses it to record the id for `finally`-block cleanup immediately, rather than
 * waiting for this whole helper to return; a throw partway through would otherwise leave
 * the caller's `campaignId` at its initial `null` and skip deletion entirely, leaking the
 * campaign into the shared e2e database — exactly what this file's own header comment says
 * never happens.
 */
async function setupConflictCampaign(
  dmContext: { request: APIRequestContext },
  name: string,
  campaignOpts: Record<string, unknown> = {},
  onCampaignCreated?: (campaignId: number) => void,
): Promise<{ campaignId: number; characterId: number; playerUserId: string }> {
  const campaign = await (
    await dmContext.request.post('/api/v1/campaigns', { data: { name, ...campaignOpts } })
  ).json();
  const campaignId: number = campaign.id;
  onCampaignCreated?.(campaignId);

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
    const setup = await setupConflictCampaign(dmContext, 'E2E1916 Turn Race', { dmControlsTurns: false }, (id) => {
      campaignId = id;
    });

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
    await openCockpitTab(playerPage, 'party');
    await dmPage.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await openCockpitTab(dmPage, 'party');

    // A player's own End turn is the cockpit's Turn tab.
    await openCockpitTab(playerPage, 'turn');
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
// Scenario 2 — concurrent relative HP writes to the SAME combatant: NOT COVERED here.
//
// A DM damage write and a player heal write to the same combatant DO compose correctly
// (relative hpDelta writes, no CAS token — see encounters.service.ts's updateCombatant),
// but that is not the same claim as "proven safe under a genuine concurrent race", and this
// suite ships only claims it can prove. A held-then-released two-context Playwright test
// was built and DID assert the correct composed result (30 - 7 + 4 = 27) — but inverting the
// production guard (using the pre-transaction `existing.hpCurrent` snapshot instead of the
// in-transaction `fresh.hpCurrent` read at encounters.service.ts, in the combatant HP write
// path) did NOT make it fail. Two HTTP requests released back-to-back from two separate
// Playwright browser contexts do not force genuine interleaving at the server: this
// single-process Node server's request handling for this path has no macrotask-yielding I/O
// between the pre-transaction read and the write (better-sqlite3 is synchronous), so one
// request's whole promise chain drains to completion before the other's socket data is even
// read — the two writes end up fully serialized rather than racing, regardless of how close
// together the client fires them. That is a real inversion of the target guard producing no
// observable failure, so shipping the test would report protection that was not demonstrated.
// This is the same class of limitation the coordinator hit driving a genuine write race for
// an `EncounterOpRaceMarker` path and filed issue #2032 for (a two-connection harness that
// can force real interleaving does not exist in this repo today). Filing this here as the
// same gap rather than shipping a test that cannot fail.
// ---------------------------------------------------------------------------------------

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
    // Player-visibility is table-wide setup, so the cockpit keeps its bar in the Table tab.
    await openCockpitTab(dmPage, 'table');

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
    const setup = await setupConflictCampaign(dmContext, 'E2E1916 SSE Outage', {}, (id) => {
      campaignId = id;
    });

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
    await openCockpitTab(playerPage, 'party');
    await initialStream;
    await expect(playerPage.getByTestId('encounter-sync-chip')).toHaveText('Live');

    await dmPage.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await openCockpitTab(dmPage, 'party');
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
