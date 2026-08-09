import { expect, request, test } from '@playwright/test';
import { seed, stateFor } from './seed';
import { CREDS } from '../global-setup';
import { CONNECTING_GRACE_MS } from '../../src/features/encounters/encounterSyncState';
import { openCockpitTab } from '../lib/encounterCockpit';

/**
 * Issue #1446 — the stale-sync gate had no override: an environment where SSE never
 * connects (proxy buffering, a terminated long-lived connection, a per-origin connection
 * cap) made combat permanently unrunnable. These cover the "continue anyway" affordance
 * end to end, against a real server, with the campaign events stream stubbed to hang
 * forever (never fulfilled, never aborted) — the actual failure mode from the issue,
 * distinct from an immediate disconnect (already covered by encounter-sync-live.spec.ts).
 */

/** Generous timeout for assertions that must wait out the connecting-grace timer. */
const GRACE_WAIT_TIMEOUT = CONNECTING_GRACE_MS + 8_000;

test('DM can roll initiative, start, and advance turns after confirming the override when SSE never connects', async ({
  browser,
}) => {
  const { campaignId } = seed();
  const writer = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const reader = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const page = await reader.newPage();

  let encounterId: number | null = null;
  let releaseEvents: () => void = () => {};

  try {
    // Only one encounter may run per campaign — clear the field first.
    const live = await (await writer.request.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
    for (const e of live as { id: number }[]) {
      await writer.request.post(`/api/v1/encounters/${e.id}/end`);
    }

    const enc = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1446 Override', hidden: false },
      })
    ).json();
    encounterId = enc.id;
    await writer.request.post(`/api/v1/encounters/${encounterId}/combatants`, {
      data: { kind: 'monster', name: 'Goblin A', hpMax: 7 },
    });
    await writer.request.post(`/api/v1/encounters/${encounterId}/combatants`, {
      data: { kind: 'monster', name: 'Goblin B', hpMax: 7 },
    });

    // The campaign events fetch hangs forever — never fulfilled, never aborted — the
    // actual "SSE never connects" failure mode (a hard disconnect is already covered by
    // encounter-sync-live.spec.ts). Released in `finally` so context teardown is clean.
    const neverConnect = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    await reader.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      await neverConnect;
      await route.abort('connectionfailed');
    });

    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await openCockpitTab(page, 'party');

    const syncChip = page.getByTestId('encounter-sync-chip');
    await expect(syncChip).toHaveText('Connecting');

    const rollInitiativeBtn = page.getByRole('button', { name: /Roll (initiative|remaining)/i });
    const startBtn = page.getByRole('button', { name: 'Start' });

    // Blocked (and not yet even offered an override) during the first-load connecting
    // grace period — a genuine sub-second cold connect should just block quietly.
    await expect(rollInitiativeBtn).toBeDisabled();
    await expect(startBtn).toBeDisabled();
    await expect(page.getByTestId('encounter-sync-override-prompt')).toHaveCount(0);

    // Past the grace period, a stream that never connects reads as a confirmed outage —
    // the override becomes available instead of blocking forever (issue #1446's actual bug).
    await expect(syncChip).toHaveText('Offline', { timeout: GRACE_WAIT_TIMEOUT });
    await expect(page.getByTestId('encounter-sync-banner')).toBeVisible();
    await expect(rollInitiativeBtn).toBeDisabled();

    const overrideConfirm = page.getByTestId('encounter-sync-override-confirm');
    await expect(overrideConfirm).toBeVisible();
    await overrideConfirm.click();

    // The stale banner must stay visible while the override is active (issue #1446) — the
    // DM must never lose track of which mode they're in.
    await expect(page.getByTestId('encounter-sync-banner')).toBeVisible();
    await expect(page.getByTestId('encounter-sync-override-active')).toBeVisible();
    await expect(page.getByTestId('encounter-sync-override-prompt')).toHaveCount(0);

    // The override persists — no re-confirmation needed for each action (a DM mid-combat
    // cannot confirm 17 times).
    await expect(rollInitiativeBtn).toBeEnabled();
    await rollInitiativeBtn.click();
    await expect(startBtn).toBeEnabled({ timeout: 10_000 });
    await startBtn.click();

    await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('encounter-sync-banner')).toBeVisible();
    await expect(page.getByTestId('encounter-sync-override-active')).toBeVisible();

    const currentTurnBefore = await page.locator('[data-current-turn="true"]').getAttribute('data-testid');
    const nextTurnBtn = page.getByTestId('encounter-header-next-turn');
    await expect(nextTurnBtn).toBeEnabled();
    await nextTurnBtn.click();
    await expect(page.locator('[data-current-turn="true"]')).not.toHaveAttribute('data-testid', currentTurnBefore ?? '');
    await expect(page.getByTestId('error-note')).toHaveCount(0);
  } finally {
    releaseEvents();
    if (encounterId != null) {
      await writer.request.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
      await writer.request.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
    }
    await Promise.all([reader.close(), writer.close()]);
  }
});

test('an overridden turn advance against a server whose turn already moved surfaces the conflict and resyncs', async ({
  browser,
}) => {
  const { campaignId } = seed();
  const writer = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const reader = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const page = await reader.newPage();

  let encounterId: number | null = null;
  let releaseEvents: () => void = () => {};

  try {
    const live = await (await writer.request.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
    for (const e of live as { id: number }[]) {
      await writer.request.post(`/api/v1/encounters/${e.id}/end`);
    }

    const enc = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1446 Conflict', hidden: false },
      })
    ).json();
    encounterId = enc.id;
    await writer.request.post(`/api/v1/encounters/${encounterId}/combatants`, {
      data: { kind: 'monster', name: 'Goblin A', hpMax: 7 },
    });
    await writer.request.post(`/api/v1/encounters/${encounterId}/combatants`, {
      data: { kind: 'monster', name: 'Goblin B', hpMax: 7 },
    });
    await writer.request.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
    await writer.request.post(`/api/v1/encounters/${encounterId}/start`);

    const neverConnect = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    await reader.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      await neverConnect;
      await route.abort('connectionfailed');
    });

    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await openCockpitTab(page, 'party');

    const syncChip = page.getByTestId('encounter-sync-chip');
    await expect(syncChip).toHaveText('Offline', { timeout: GRACE_WAIT_TIMEOUT });
    await page.getByTestId('encounter-sync-override-confirm').click();
    await expect(page.getByTestId('encounter-sync-override-active')).toBeVisible();

    const nextTurnBtn = page.getByTestId('encounter-header-next-turn');
    await expect(nextTurnBtn).toBeEnabled();

    // Someone else — another device, a co-DM, the AI DM seat — advances the turn
    // server-side while this client's cached `currentCombatantId` is still the
    // pre-advance value (SSE is down; the periodic read poll has not ticked yet).
    const advanced = await writer.request.post(`/api/v1/encounters/${encounterId}/next-turn`);
    expect(advanced.ok()).toBe(true);

    // The overridden client submits its own advance against its now-stale expectation.
    await nextTurnBtn.click();

    // Server-enforced correctness: expectedCurrentCombatantId still 409s a stale advance
    // even with the client-side override granted — the override is a UX guard, not the
    // correctness boundary. The message is a readable "someone else already advanced the
    // turn", not a generic failure, and the view resyncs rather than staying stale.
    await expect(page.getByTestId('error-note')).toContainText(/already advanced/i);
    await expect(page.getByTestId('encounter-sync-banner')).toBeVisible();
  } finally {
    releaseEvents();
    if (encounterId != null) {
      await writer.request.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
      await writer.request.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
    }
    await Promise.all([reader.close(), writer.close()]);
  }
});

test('the stale banner remains visible for the duration of an active override', async ({ browser }) => {
  const { campaignId } = seed();
  const writer = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const reader = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const page = await reader.newPage();

  let encounterId: number | null = null;
  let releaseEvents: () => void = () => {};

  try {
    const live = await (await writer.request.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
    for (const e of live as { id: number }[]) {
      await writer.request.post(`/api/v1/encounters/${e.id}/end`);
    }

    const enc = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1446 Banner', hidden: false },
      })
    ).json();
    encounterId = enc.id;

    const neverConnect = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    await reader.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      await neverConnect;
      await route.abort('connectionfailed');
    });

    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await openCockpitTab(page, 'party');

    const banner = page.getByTestId('encounter-sync-banner');
    const syncChip = page.getByTestId('encounter-sync-chip');

    // Visible from the very first "Connecting…" moment…
    await expect(banner).toBeVisible();
    await expect(syncChip).toHaveText('Offline', { timeout: GRACE_WAIT_TIMEOUT });
    // …through the confirmed-outage state…
    await expect(banner).toBeVisible();

    await page.getByTestId('encounter-sync-override-confirm').click();
    await expect(page.getByTestId('encounter-sync-override-active')).toBeVisible();
    // …and for as long as the override stays active, not just at the moment it was granted.
    await expect(banner).toBeVisible();
    await page.waitForTimeout(2_000);
    await expect(banner).toBeVisible();
    await expect(syncChip).toHaveText('Offline');
  } finally {
    releaseEvents();
    if (encounterId != null) {
      await writer.request.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
      await writer.request.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
    }
    await Promise.all([reader.close(), writer.close()]);
  }
});

/**
 * Issue #1446 fix (Codex P2): "continue anyway" is a DM decision per the issue text — a
 * player must never see or be able to grant it, since doing so would re-enable mutations
 * against their OWN owned combatant (HP, death saves, actions) from possibly-stale state.
 */
test('a player never sees or can grant the override, and their owned combatant stays blocked', async ({ browser }) => {
  const { baseURL, campaignId } = seed();
  const writer = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const reader = await browser.newContext({ storageState: stateFor('player'), serviceWorkers: 'block' });
  const page = await reader.newPage();

  let encounterId: number | null = null;
  let characterId: number | null = null;
  let releaseEvents: () => void = () => {};

  try {
    const playerCtx = await request.newContext({ baseURL });
    await playerCtx.post('/api/v1/auth/login', { data: CREDS.player });
    const me = await (await playerCtx.get('/api/v1/me')).json();
    const playerUserId = String(me.user.id);
    await playerCtx.dispose();

    const live = await (await writer.request.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
    for (const e of live as { id: number }[]) {
      await writer.request.post(`/api/v1/encounters/${e.id}/end`);
    }

    const character = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/characters`, {
        data: {
          name: 'Override Guard Test PC',
          className: 'Fighter',
          level: 3,
          ownerUserId: playerUserId,
          hpCurrent: 20,
          hpMax: 20,
          stats: { DEX: 12 },
        },
      })
    ).json();
    characterId = character.id;

    // A new encounter auto-adds every active party PC — the owned combatant we need.
    const enc = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1446 Player Guard', hidden: false },
      })
    ).json();
    encounterId = enc.id;
    const heroCombatant = (enc.combatants as Array<{ id: number; characterId: number | null }>).find(
      (c) => c.characterId === characterId,
    );
    if (!heroCombatant) throw new Error('expected auto-added hero combatant');

    await writer.request.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
    await writer.request.post(`/api/v1/encounters/${encounterId}/start`);

    const neverConnect = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    await reader.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      await neverConnect;
      await route.abort('connectionfailed');
    });

    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await openCockpitTab(page, 'party');

    const syncChip = page.getByTestId('encounter-sync-chip');
    await expect(syncChip).toHaveText('Offline', { timeout: CONNECTING_GRACE_MS + 8_000 });
    // The banner is still informational for a player…
    await expect(page.getByTestId('encounter-sync-banner')).toBeVisible();
    // …but the DM-only "continue anyway" affordance is never offered to them, no matter
    // how long the outage lasts.
    await page.waitForTimeout(2_000);
    await expect(page.getByTestId('encounter-sync-override-prompt')).toHaveCount(0);
    await expect(page.getByTestId('encounter-sync-override-confirm')).toHaveCount(0);
    await expect(page.getByTestId('encounter-sync-override-active')).toHaveCount(0);

    // With no way to grant an override, the player's OWN combatant stays non-editable.
    // Issue #1746: the HP steppers still MOUNT — the player owns this character, so
    // permission is granted — but render disabled, because the sync gate is blocking
    // and no override authorizes past it. Absent would be the pre-#1746 defect (the
    // row unmounting the controls instead of disabling them); permission-denied absence
    // is covered separately by combatant-row-sync-disable.spec.ts.
    const heroRow = page.getByTestId(`combatant-row-${heroCombatant.id}`);
    await expect(heroRow).toBeVisible();
    const heroStepper = heroRow.getByTestId('hp-steppers').getByRole('button').first();
    await expect(heroStepper).toBeVisible();
    await expect(heroStepper).toBeDisabled();
  } finally {
    releaseEvents();
    if (encounterId != null) {
      await writer.request.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
      await writer.request.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
    }
    if (characterId != null) {
      await writer.request.delete(`/api/v1/characters/${characterId}`).catch(() => undefined);
    }
    await Promise.all([reader.close(), writer.close()]);
  }
});

/**
 * Issue #1446 review fix: `RunSessionPage` is reused across encounters in the same
 * campaign. `useCampaignEvents` is keyed on the CAMPAIGN, not the encounter, and its
 * reconnect loop only calls `onStatusChange` when the status actually changes — so a
 * still-`connected` stream never re-announces itself. The connecting-grace timeout added
 * for this issue used to take the encounter-switch effect's stale `eventStatus` reset as
 * ground truth and, after CONNECTING_GRACE_MS, wrongly degrade a perfectly healthy stream
 * to `offline` on ordinary in-app navigation between two encounters — prompting the DM to
 * override for no reason and leaving a player permanently blocked. No SSE stubbing here:
 * this must hold up against the real server's real stream.
 */
test('switching between two encounters in one campaign does not degrade a connected stream', async ({ browser }) => {
  const { campaignId } = seed();
  const writer = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const reader = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const page = await reader.newPage();

  let encounterAId: number | null = null;
  let encounterBId: number | null = null;

  try {
    const live = await (await writer.request.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
    for (const e of live as { id: number }[]) {
      await writer.request.post(`/api/v1/encounters/${e.id}/end`);
    }

    const encA = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1446 Switch A', hidden: false },
      })
    ).json();
    encounterAId = encA.id;
    const encB = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1446 Switch B', hidden: false },
      })
    ).json();
    encounterBId = encB.id;

    const initialStream = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/campaigns/${campaignId}/events`),
    );
    await page.goto(`/c/${campaignId}/encounters/${encounterAId}`);
    await openCockpitTab(page, 'party');
    await initialStream;

    const syncChip = page.getByTestId('encounter-sync-chip');
    await expect(syncChip).toHaveText('Live');

    // In-app navigation (no full reload): back to the list, then into encounter B. Both
    // links are react-router `<Link>`s (ListDetailLink / DetailPageWayfinding) — the SPA
    // transition this bug requires, unlike a fresh `page.goto`.
    await page.getByRole('link', { name: /Back to encounters/i }).click();
    await page.getByRole('link', { name: /E2E1446 Switch B/ }).click();
    await expect(page).toHaveURL(new RegExp(`/encounters/${encounterBId}$`));

    // Wait out the FULL connecting-grace window: the regression only manifests once the
    // timeout elapses, so a shorter wait would pass even with the bug present.
    await page.waitForTimeout(CONNECTING_GRACE_MS + 4_000);
    await expect(syncChip).toHaveText('Live');
    await expect(page.getByTestId('encounter-sync-banner')).toHaveCount(0);
    await expect(page.getByTestId('encounter-sync-override-prompt')).toHaveCount(0);
  } finally {
    for (const id of [encounterAId, encounterBId]) {
      if (id != null) {
        await writer.request.post(`/api/v1/encounters/${id}/end`).catch(() => undefined);
        await writer.request.delete(`/api/v1/encounters/${id}`).catch(() => undefined);
      }
    }
    await Promise.all([reader.close(), writer.close()]);
  }
});

/**
 * Issue #1446 review fix (round 3): the connecting-grace timer used to be reset (to "not
 * elapsed yet") by the `[eid]` effect on every encounter switch, but its OWN re-arming
 * effect is keyed on `[eventStatus]` alone — while a stream that never connects sits at
 * the literal string `connecting` for the whole session, that dependency never changes,
 * so the timer was never rescheduled and the new encounter got stuck on `Connecting`
 * forever with no override ever offered again. That is the exact permanent block this
 * issue exists to remove, reintroduced on the encounter-switch path.
 */
test('switching encounters while the stream never connects still offers the override', async ({ browser }) => {
  const { campaignId } = seed();
  const writer = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const reader = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const page = await reader.newPage();

  let encounterAId: number | null = null;
  let encounterBId: number | null = null;
  let releaseEvents: () => void = () => {};

  try {
    const live = await (await writer.request.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
    for (const e of live as { id: number }[]) {
      await writer.request.post(`/api/v1/encounters/${e.id}/end`);
    }

    const encA = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1446 NeverConnect A', hidden: false },
      })
    ).json();
    encounterAId = encA.id;
    const encB = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1446 NeverConnect B', hidden: false },
      })
    ).json();
    encounterBId = encB.id;

    // The events fetch hangs forever for the WHOLE session — both encounters. `eventStatus`
    // never changes from `connecting` at any point in this test.
    const neverConnect = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    await reader.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      await neverConnect;
      await route.abort('connectionfailed');
    });

    await page.goto(`/c/${campaignId}/encounters/${encounterAId}`);
    await openCockpitTab(page, 'party');

    const syncChip = page.getByTestId('encounter-sync-chip');
    // Grace elapses on encounter A: the override becomes offered.
    await expect(syncChip).toHaveText('Offline', { timeout: CONNECTING_GRACE_MS + 8_000 });
    await expect(page.getByTestId('encounter-sync-override-prompt')).toBeVisible();

    // In-app navigation to encounter B, WITHOUT confirming the override on A.
    await page.getByRole('link', { name: /Back to encounters/i }).click();
    await page.getByRole('link', { name: /E2E1446 NeverConnect B/ }).click();
    await expect(page).toHaveURL(new RegExp(`/encounters/${encounterBId}$`));

    // The regression: encounter B must NOT be stuck on a bare `Connecting` with the
    // override never offered again — the already-elapsed grace state carries over
    // correctly, immediately, with no further wait required.
    await expect(syncChip).toHaveText('Offline');
    await expect(page.getByTestId('encounter-sync-override-prompt')).toBeVisible();
  } finally {
    releaseEvents();
    for (const id of [encounterAId, encounterBId]) {
      if (id != null) {
        await writer.request.post(`/api/v1/encounters/${id}/end`).catch(() => undefined);
        await writer.request.delete(`/api/v1/encounters/${id}`).catch(() => undefined);
      }
    }
    await Promise.all([reader.close(), writer.close()]);
  }
});

/**
 * Issue #1446 review fix (round 4): an active override must not survive loss of DM
 * authority. The override is only settled by `settleEncounterOverride` (stream back to
 * `live`) — a co-DM demoted to player mid-outage kept `encounterSyncOverride.active`
 * untouched, so `riskyBlocked` stayed false and their own owned-combatant HP/death-save/
 * action mutations remained unblocked against possibly-stale data.
 *
 * The demoted member's browser has no way to learn about a role change except via THIS
 * campaign's own SSE stream (`membership.updated`, relayed cross-tab over BroadcastChannel
 * by `useMembershipLiveSync` — see AuthProvider.tsx / useMembershipLiveSync.ts) or a full
 * reload. Since the main tab's stream is deliberately stubbed dead for this test (the only
 * way to reach an active override in the first place), a second "sidecar" tab in the SAME
 * browser context keeps a REAL, healthy connection to the same campaign so the demotion
 * still reaches the main tab exactly the way it would in production — through the existing
 * cross-tab relay, not a page reload (which would trivially reset the in-memory override
 * state regardless of whether this fix exists).
 */
test('an active override is revoked the instant DM authority is lost', async ({ browser }) => {
  const { campaignId } = seed();
  const writer = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const reader = await browser.newContext({ storageState: stateFor('player'), serviceWorkers: 'block' });
  const page = await reader.newPage();
  const sidecar = await reader.newPage();

  let encounterId: number | null = null;
  let characterId: number | null = null;
  let playerMemberId: number | null = null;
  let releaseEvents: () => void = () => {};

  try {
    const members = await (await writer.request.get(`/api/v1/campaigns/${campaignId}/members`)).json();
    const playerMember = (members as Array<{ id: number; userId: number; username: string }>).find(
      (m) => m.username === CREDS.player.username,
    );
    if (!playerMember) throw new Error('expected seeded player membership');
    playerMemberId = playerMember.id;

    // Temporarily promote the player to co-DM so they can legitimately confirm the
    // override — this IS the "was a co-DM, got demoted mid-outage" scenario.
    await writer.request.patch(`/api/v1/campaigns/${campaignId}/members/${playerMemberId}`, {
      data: { role: 'dm' },
    });

    const live = await (await writer.request.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
    for (const e of live as { id: number }[]) {
      await writer.request.post(`/api/v1/encounters/${e.id}/end`);
    }

    const character = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/characters`, {
        data: {
          name: 'Revoke Guard Test PC',
          className: 'Fighter',
          level: 3,
          ownerUserId: String(playerMember.userId),
          hpCurrent: 20,
          hpMax: 20,
          stats: { DEX: 12 },
        },
      })
    ).json();
    characterId = character.id;

    // A new encounter auto-adds every active party PC — the owned combatant we need.
    const enc = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1446 Revoke Guard', hidden: false },
      })
    ).json();
    encounterId = enc.id;
    const heroCombatant = (enc.combatants as Array<{ id: number; characterId: number | null }>).find(
      (c) => c.characterId === characterId,
    );
    if (!heroCombatant) throw new Error('expected auto-added hero combatant');

    await writer.request.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
    await writer.request.post(`/api/v1/encounters/${encounterId}/start`);

    // The sidecar's job is ONLY to keep a real, healthy stream open so the membership
    // sync relay works — it never touches the encounter under test.
    await sidecar.goto(`/c/${campaignId}/encounters`);
    await expect(sidecar.getByText('E2E1446 Revoke Guard')).toBeVisible();

    const neverConnect = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    // Page-scoped route (not context-scoped): only the main tab's stream is stubbed dead —
    // the sidecar tab must stay genuinely connected.
    await page.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      await neverConnect;
      await route.abort('connectionfailed');
    });

    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await openCockpitTab(page, 'party');

    const syncChip = page.getByTestId('encounter-sync-chip');
    await expect(syncChip).toHaveText('Offline', { timeout: CONNECTING_GRACE_MS + 8_000 });
    await page.getByTestId('encounter-sync-override-confirm').click();
    await expect(page.getByTestId('encounter-sync-override-active')).toBeVisible();

    // Confirm the override actually unblocked their own combatant before revoking anything —
    // present AND enabled while the override is active.
    const heroRow = page.getByTestId(`combatant-row-${heroCombatant.id}`);
    const heroStepper = heroRow.getByTestId('hp-steppers').getByRole('button').first();
    await expect(heroStepper).toBeVisible();
    await expect(heroStepper).toBeEnabled();

    // Demote back to player. The sidecar's healthy stream receives membership.updated and
    // relays it cross-tab; the main (SSE-dead) tab picks it up via BroadcastChannel and
    // refreshes /me — exactly the production path, no reload.
    await writer.request.patch(`/api/v1/campaigns/${campaignId}/members/${playerMemberId}`, {
      data: { role: 'player' },
    });

    // The override must be REVOKED, not just its confirmation UI hidden: the previously
    // unblocked owned-combatant controls are disabled again. Issue #1746: they stay
    // MOUNTED throughout — the player still owns this character, so permission never
    // changed — only their disabled state tracks the (now unauthorized) sync gate.
    await expect(heroStepper).toBeDisabled({ timeout: 10_000 });
    await expect(page.getByTestId('encounter-sync-override-active')).toHaveCount(0);
    await expect(page.getByTestId('encounter-sync-override-prompt')).toHaveCount(0);
  } finally {
    releaseEvents();
    if (playerMemberId != null) {
      await writer.request
        .patch(`/api/v1/campaigns/${campaignId}/members/${playerMemberId}`, { data: { role: 'player' } })
        .catch(() => undefined);
    }
    if (encounterId != null) {
      await writer.request.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
      await writer.request.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
    }
    if (characterId != null) {
      await writer.request.delete(`/api/v1/characters/${characterId}`).catch(() => undefined);
    }
    await Promise.all([page.close(), sidecar.close()]);
    await Promise.all([reader.close(), writer.close()]);
  }
});

/**
 * Issue #1446 review fix (round 5): the SAME root cause one level up. `RunSessionPage` is
 * reused not only across encounters in one campaign but across campaigns entirely — e.g.
 * following a cross-campaign notification link (`NotificationsBell.tsx`, `entityLinks.ts`
 * resolving a comment to another campaign's encounter route) does an in-app `navigate`,
 * not a reload. Without this fix, an override confirmed in campaign A stayed active after
 * switching to campaign B — a cross-campaign leak of a trust decision: campaign B's
 * combat controls would be immediately actionable with no grace period and no
 * confirmation for that campaign at all. `eventStatus` / the connecting-grace timer /
 * `encounterSyncOverride` are now explicitly keyed to `(campaignId, userId)` and reset the
 * moment that key changes — this test switches the key by navigating cross-campaign
 * in-app (history.pushState + popstate, the same technique used elsewhere in this suite
 * for SPA transitions — NOT `page.goto`, which is a real reload and would trivially pass
 * regardless of this fix by remounting everything fresh).
 */
test('an override confirmed in one campaign does not carry over to a different campaign', async ({ browser }) => {
  const { campaignId: campaignAId, semantic } = seed();
  const campaignBId = semantic.campaignId;
  const writer = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const reader = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const page = await reader.newPage();

  let encounterAId: number | null = null;
  let encounterBId: number | null = null;
  let releaseEvents: () => void = () => {};

  try {
    const liveA = await (await writer.request.get(`/api/v1/campaigns/${campaignAId}/encounters?status=running`)).json();
    for (const e of liveA as { id: number }[]) {
      await writer.request.post(`/api/v1/encounters/${e.id}/end`);
    }
    const liveB = await (await writer.request.get(`/api/v1/campaigns/${campaignBId}/encounters?status=running`)).json();
    for (const e of liveB as { id: number }[]) {
      await writer.request.post(`/api/v1/encounters/${e.id}/end`);
    }

    const encA = await (
      await writer.request.post(`/api/v1/campaigns/${campaignAId}/encounters`, {
        data: { name: 'E2E1446 Cross-Campaign A', hidden: false },
      })
    ).json();
    encounterAId = encA.id;
    const encB = await (
      await writer.request.post(`/api/v1/campaigns/${campaignBId}/encounters`, {
        data: { name: 'E2E1446 Cross-Campaign B', hidden: false },
      })
    ).json();
    encounterBId = encB.id;

    // Both campaigns' streams hang forever — the DM's whole session is in the exact
    // "SSE never connects" environment this issue targets, for either campaign.
    const neverConnect = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    await reader.route('**/api/v1/campaigns/*/events', async (route) => {
      await neverConnect;
      await route.abort('connectionfailed');
    });

    await page.goto(`/c/${campaignAId}/encounters/${encounterAId}`);
    await openCockpitTab(page, 'party');

    const syncChip = page.getByTestId('encounter-sync-chip');
    await expect(syncChip).toHaveText('Offline', { timeout: CONNECTING_GRACE_MS + 8_000 });
    await page.getByTestId('encounter-sync-override-confirm').click();
    await expect(page.getByTestId('encounter-sync-override-active')).toBeVisible();

    // In-app cross-campaign navigation (SPA transition, no reload) — the same mechanism a
    // notification link uses, reusing this component with a new `cid`.
    await page.evaluate((url) => {
      window.history.pushState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, `/c/${campaignBId}/encounters/${encounterBId}`);
    await expect(page).toHaveURL(new RegExp(`/c/${campaignBId}/encounters/${encounterBId}$`));

    // The regression: campaign B must NOT inherit campaign A's override, its elapsed grace
    // timer, or its `connected`-adjacent status. It starts genuinely fresh: blocked, and —
    // once its OWN grace period elapses — offered its OWN confirmation, not silently live.
    await expect(page.getByTestId('encounter-sync-override-active')).toHaveCount(0);
    const startBtn = page.getByRole('button', { name: 'Start' });
    await expect(startBtn).toBeDisabled();
    await expect(page.getByTestId('encounter-sync-override-prompt')).toHaveCount(0);
    await expect(syncChip).toHaveText('Offline', { timeout: CONNECTING_GRACE_MS + 8_000 });
    await expect(page.getByTestId('encounter-sync-override-prompt')).toBeVisible();
    await expect(startBtn).toBeDisabled();
  } finally {
    releaseEvents();
    for (const id of [encounterAId, encounterBId]) {
      if (id != null) {
        await writer.request.post(`/api/v1/encounters/${id}/end`).catch(() => undefined);
        await writer.request.delete(`/api/v1/encounters/${id}`).catch(() => undefined);
      }
    }
    await Promise.all([reader.close(), writer.close()]);
  }
});

/**
 * Issue #1446 review fix (final round): `staleIdentity` is AuthProvider's documented
 * contract for a cached-identity restore after a failed `/me` (issue #579) — membership
 * may be obsolete, so mutations must stay disabled. `deriveEncounterSyncState` already
 * maps `staleIdentity` to `offline`, but the override-offer condition used to ignore it:
 * a cached former DM could confirm "continue anyway" while running on a stale membership
 * snapshot, and if connectivity returned without a fresh `/me` revalidation and that user
 * had since been demoted, the server would legitimately accept the (now unauthorized)
 * mutation. This proves the override is never offered — and no confirmation is reachable
 * at all — while `staleIdentity` is true, using the REAL mechanism (a snapshot persisted
 * by a genuine prior live `/me`, then an offline reload), not a mocked auth context.
 */
test('the override is never offered while AuthProvider is showing a stale (cached) identity', async ({ browser }) => {
  const { campaignId } = seed();
  const writer = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const reader = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const page = await reader.newPage();

  let encounterId: number | null = null;
  let releaseEvents: () => void = () => {};

  try {
    const live = await (await writer.request.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
    for (const e of live as { id: number }[]) {
      await writer.request.post(`/api/v1/encounters/${e.id}/end`);
    }
    const enc = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E1446 Stale Identity', hidden: false },
      })
    ).json();
    encounterId = enc.id;

    // First, a NORMAL load: a real, live `/me` succeeds and AuthProvider persists a
    // snapshot (issue #579) — this is the genuine mechanism, not a seeded/mocked one.
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await openCockpitTab(page, 'party');
    const syncChip = page.getByTestId('encounter-sync-chip');
    await expect(syncChip).toHaveText('Live');

    // Now make `/me` unreachable (a network-level failure, NOT a 401 — the distinction
    // issue #579 exists for) and reload. The campaign events stream is also stubbed dead,
    // matching the outage this issue targets, so the ONLY thing standing between the
    // reviewer's scenario and a bypass is the staleIdentity check itself.
    const neverConnect = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    await reader.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      await neverConnect;
      await route.abort('connectionfailed');
    });
    await reader.route('**/api/v1/me', (route) => route.abort('connectionfailed'));

    await page.reload();

    // The stale-identity fallback renders the authed UI (not a bounce to /login) — the
    // chip reads `Offline` (deriveEncounterSyncState already maps staleIdentity there).
    await expect(syncChip).toHaveText('Offline');

    // The regression: no override is ever offered, and none can become active, for as
    // long as staleIdentity holds — regardless of how long the "outage" persists.
    await page.waitForTimeout(CONNECTING_GRACE_MS + 2_000);
    await expect(page.getByTestId('encounter-sync-override-prompt')).toHaveCount(0);
    await expect(page.getByTestId('encounter-sync-override-confirm')).toHaveCount(0);
    await expect(page.getByTestId('encounter-sync-override-active')).toHaveCount(0);
    const startBtn = page.getByRole('button', { name: 'Start' });
    await expect(startBtn).toBeDisabled();
  } finally {
    releaseEvents();
    if (encounterId != null) {
      await writer.request.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
      await writer.request.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
    }
    await Promise.all([reader.close(), writer.close()]);
  }
});
