import { expect, test, type APIRequestContext } from '@playwright/test';
import { restoreSeedEncounter, seed, stateFor } from './seed';

function encounterUrl(): string {
  const { campaignId, encounterId } = seed();
  return `/c/${campaignId}/encounters/${encounterId}`;
}

async function placeTokenStateFixture(request: APIRequestContext) {
  const { encounterId, bossId, skirmisherId } = seed();
  const encounter = await request.patch(`/api/v1/encounters/${encounterId}`, {
    data: { fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 100, h: 100 }] } },
  });
  expect(encounter.ok()).toBeTruthy();
  for (const [id, x, y] of [[bossId, 30, 40], [skirmisherId, 70, 60]] as const) {
    const placed = await request.patch(`/api/v1/encounters/${encounterId}/combatants/${id}`, {
      data: { tokenX: x, tokenY: y, ...(id === bossId ? { tokenSize: 'large' } : {}) },
    });
    expect(placed.ok()).toBeTruthy();
  }
  const conditions = await request.patch(`/api/v1/encounters/${encounterId}/combatants/${bossId}`, {
    data: { addConditions: ['Poisoned', 'Prone', 'Frightened', 'Gravity-sick'] },
  });
  expect(conditions.ok()).toBeTruthy();
  const concentration = await request.post(`/api/v1/encounters/${encounterId}/combatants/${bossId}/turn-state`, {
    data: { concentration: 'Bless' },
  });
  expect(concentration.ok()).toBeTruthy();
}

test('DM and player clients render token state safely, follow SSE turns, and retain the DM presentation choice (#1905)', async ({ browser }) => {
  const dm = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const player = await browser.newContext({ storageState: stateFor('player'), serviceWorkers: 'block' });
  const dmPage = await dm.newPage();
  const playerPage = await player.newPage();
  const { campaignId, encounterId, bossId, skirmisherId } = seed();

  try {
    await restoreSeedEncounter();
    await placeTokenStateFixture(dm.request);
    await Promise.all([dmPage.goto(encounterUrl()), playerPage.goto(encounterUrl())]);

    const dmBoss = dmPage.getByTestId(`map-token-${bossId}`);
    const playerBoss = playerPage.getByTestId(`map-token-${bossId}`);
    await expect(dmBoss).toBeVisible();
    await expect(playerBoss).toBeVisible();
    await expect(dmPage.getByTestId(`map-token-hp-arc-${bossId}`)).toBeVisible();
    const playerArc = playerPage.getByTestId(`map-token-hp-arc-${bossId}`);
    await expect(playerArc).toHaveAttribute('aria-label', 'Health: healthy');
    await expect(playerBoss).not.toContainText('30');
    await expect(playerBoss).not.toContainText('12');
    const overflowCondition = playerPage.getByTestId(`map-token-condition-overflow-${bossId}`);
    await expect(overflowCondition).toHaveText('+2');
    await expect(playerPage.getByTestId(`map-token-concentration-${bossId}`)).toBeVisible();
    const conditionBox = await overflowCondition.boundingBox();
    expect(conditionBox?.width).toBeGreaterThanOrEqual(18);
    expect(conditionBox?.height).toBeGreaterThanOrEqual(18);
    await overflowCondition.focus();
    await playerPage.keyboard.press('Enter');
    await expect(playerPage.locator(`#combatant-${bossId}-conditions`)).toBeFocused();
    await overflowCondition.focus();
    await playerPage.keyboard.press('Delete');
    await expect(playerBoss).toBeVisible();
    await overflowCondition.click();
    await expect(playerPage.locator(`#combatant-${bossId}-conditions`)).toBeFocused();

    // Map-surface tools own their gestures, even when one begins over a badge.
    await dmPage.getByTestId('map-tool-reveal').click();
    await expect(dmPage.getByTestId('map-tool-reveal')).toHaveAttribute('aria-pressed', 'true');
    await expect(dmPage.getByTestId(`map-token-condition-overflow-${bossId}`)).toHaveCSS('pointer-events', 'none');
    await dmPage.getByTestId('map-tool-move').click();
    await dmPage.getByTestId('map-viewport-pan').click();
    await expect(dmPage.getByTestId('map-viewport-pan')).toHaveAttribute('aria-pressed', 'true');
    await expect(dmPage.getByTestId(`map-token-condition-overflow-${bossId}`)).toHaveCSS('pointer-events', 'none');
    await dmPage.getByTestId('map-viewport-pan').click();

    // The viewer never clicks: the DM advances the real encounter and its SSE update
    // moves the accent ring on the second client.
    await expect(playerPage.getByTestId(`map-token-current-turn-${bossId}`)).toBeVisible();
    await dmPage.getByTestId('encounter-header-next-turn').click();
    await expect(playerPage.getByTestId(`map-token-current-turn-${bossId}`)).toHaveCount(0);
    await expect(playerPage.getByTestId(`map-token-current-turn-${skirmisherId}`)).toBeVisible();

    const detailMode = dmPage.getByTestId('map-token-detail-mode');
    await detailMode.selectOption('off');
    await expect(dmPage.getByTestId(`map-token-hp-arc-${bossId}`)).toHaveCount(0);
    await expect(dmPage.getByTestId(`map-token-current-turn-${skirmisherId}`)).toHaveCount(0);
    await dmPage.reload();
    await expect(dmPage.getByTestId('map-token-detail-mode')).toHaveValue('off');
    await expect(dmPage.getByTestId(`map-token-hp-arc-${bossId}`)).toHaveCount(0);

    // A capability-backed Cast page receives its own viewer-redacted payload even
    // though it renders from a browser that is otherwise capable of holding DM state.
    const created = await dm.request.post(`/api/v1/campaigns/${campaignId}/cast-sessions`, {
      data: { label: 'token-state-e2e', expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    });
    expect(created.ok()).toBeTruthy();
    const { token, session } = (await created.json()) as { token: string; session: { id: number } };
    const cast = await browser.newContext({ serviceWorkers: 'block' });
    const castPage = await cast.newPage();
    try {
      await castPage.addInitScript((id) => localStorage.setItem(`cf.screen.scene.${id}`, 'map'), campaignId);
      await castPage.goto(`/cast/${campaignId}/${token}`);
      await expect(castPage.getByTestId(`map-token-${bossId}`)).toBeVisible();
      await expect(castPage.getByTestId(`map-token-hp-arc-${bossId}`)).toHaveAttribute('aria-label', 'Health: healthy');
      await expect(castPage.getByTestId(`map-token-${bossId}`)).not.toContainText('30');
      await expect(castPage.getByTestId('map-token-detail-mode')).toHaveCount(0);
    } finally {
      await cast.close();
      await dm.request.delete(`/api/v1/campaigns/${campaignId}/cast-sessions/${session.id}`);
    }

    // Off restores the plain disc even after a token becomes defeated.
    const downed = await dm.request.patch(`/api/v1/encounters/${encounterId}/combatants/${bossId}`, {
      data: { hpSet: 0 },
    });
    expect(downed.ok()).toBeTruthy();
    await expect(dmBoss.locator(':scope > div > span').first()).toHaveCSS('opacity', '1');
  } finally {
    await restoreSeedEncounter();
    await dm.request.patch(`/api/v1/encounters/${encounterId}`, { data: { fog: { enabled: true, revealed: [] } } });
    await dm.request.patch(`/api/v1/encounters/${encounterId}/combatants/${bossId}`, { data: { tokenX: null, tokenY: null } });
    await dm.request.patch(`/api/v1/encounters/${encounterId}/combatants/${skirmisherId}`, { data: { tokenX: null, tokenY: null } });
    await Promise.all([dm.close(), player.close()]);
  }
});

test('40-token map smoke keeps token drag feedback available (#1905)', async ({ browser }) => {
  test.slow();
  const dm = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const page = await dm.newPage();
  const { encounterId } = seed();
  try {
    await restoreSeedEncounter();
    const added = await dm.request.post(`/api/v1/encounters/${encounterId}/combatants`, {
      data: { kind: 'monster', name: 'Smoke token', hpMax: 10, count: 40 },
    });
    expect(added.ok()).toBeTruthy();
    const encounter = await dm.request.get(`/api/v1/encounters/${encounterId}`);
    expect(encounter.ok()).toBeTruthy();
    const combatants = (await encounter.json() as { combatants: Array<{ id: number }> }).combatants;
    for (const [index, combatant] of combatants.entries()) {
      const placed = await dm.request.patch(`/api/v1/encounters/${encounterId}/combatants/${combatant.id}`, {
        data: { tokenX: 5 + (index % 10) * 10, tokenY: 10 + Math.floor(index / 10) * 14 },
      });
      expect(placed.ok()).toBeTruthy();
    }
    await page.goto(encounterUrl());
    const tokens = page.locator('[data-testid^="map-token-"][role="button"]');
    await expect(tokens).toHaveCount(combatants.length);
    const token = tokens.first();
    const beforeLeft = await token.evaluate((element) => (element as HTMLElement).style.left);
    // Playwright's drag gesture uses the same mouse/pointer path as the table. The
    // opacity preview is intentionally transient and returns to 1 after mouseup, so
    // assert the durable server-backed position rather than sampling that animation.
    await token.dragTo(tokens.nth(1));
    await expect.poll(() => token.evaluate((element) => (element as HTMLElement).style.left)).not.toBe(beforeLeft);
  } finally {
    await restoreSeedEncounter();
    await dm.close();
  }
});
