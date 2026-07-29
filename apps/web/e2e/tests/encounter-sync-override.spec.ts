import { expect, request, test } from '@playwright/test';
import { seed, stateFor } from './seed';
import { CREDS } from '../global-setup';
import { CONNECTING_GRACE_MS } from '../../src/features/encounters/encounterSyncState';

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
    const nextTurnBtn = page.getByRole('button', { name: /Next turn/i });
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

    const syncChip = page.getByTestId('encounter-sync-chip');
    await expect(syncChip).toHaveText('Offline', { timeout: GRACE_WAIT_TIMEOUT });
    await page.getByTestId('encounter-sync-override-confirm').click();
    await expect(page.getByTestId('encounter-sync-override-active')).toBeVisible();

    const nextTurnBtn = page.getByRole('button', { name: /Next turn/i });
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

    // With no way to grant an override, the player's OWN combatant stays non-editable —
    // the HP steppers (canEdit-gated) do not appear even though it is their character.
    const heroRow = page.getByTestId(`combatant-row-${heroCombatant.id}`);
    await expect(heroRow).toBeVisible();
    await expect(heroRow.getByTestId('hp-steppers')).toHaveCount(0);
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
