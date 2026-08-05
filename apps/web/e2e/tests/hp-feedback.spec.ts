import { expect, test } from '@playwright/test';
import { MONSTERS } from '../global-setup';
import { restoreSeedEncounter, seed, stateFor } from './seed';

const [boss] = MONSTERS;

test('HP feedback reaches a second client without exposing redacted monster numbers (#1907)', async ({ browser }) => {
  await restoreSeedEncounter();
  const { campaignId, encounterId, bossId } = seed();
  const dmContext = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const playerContext = await browser.newContext({ storageState: stateFor('player'), serviceWorkers: 'block' });
  const dmPage = await dmContext.newPage();
  const playerPage = await playerContext.newPage();
  const url = `/c/${campaignId}/encounters/${encounterId}`;

  try {
    await Promise.all([dmPage.goto(url), playerPage.goto(url)]);
    await expect(dmPage.getByRole('heading', { name: 'Ambush at the Ember Hearth' })).toBeVisible();
    await expect(playerPage.getByText('Healthy').first()).toBeVisible();

    const reduceBossHp = dmPage.getByRole('button', { name: `Reduce ${boss.name}'s HP by 5` }).first();
    // A Shift-click is the existing ×5 interaction. Starting at 30 HP, it lands the
    // boss at 5 HP and therefore crosses the server-owned redaction band in one
    // committed PATCH (rather than merely expecting two -5 hits to do so).
    const committedDamage = dmPage.waitForResponse((response) =>
      response.request().method() === 'PATCH'
      && response.url().includes(`/api/v1/encounters/${encounterId}/combatants/${bossId}`)
      && response.ok(),
    );
    await reduceBossHp.click({ modifiers: ['Shift'] });
    // The overlay is intentionally transient. Start observing immediately after the
    // click while still requiring the PATCH to commit, rather than beginning the
    // visibility assertion after a slow server response may have outlived the badge.
    await Promise.all([
      committedDamage,
      expect(dmPage.getByTestId('hp-feedback-damage').first()).toBeVisible(),
    ]);

    // The remote player sees its own canonical SSE refetch and a qualitative tick,
    // never the hidden amount.
    const playerFeedback = playerPage.getByTestId('hp-feedback').first();
    await expect(playerFeedback).toContainText('Hurt');
    await expect(playerFeedback).not.toContainText(/\d/);
  } finally {
    await Promise.all([dmContext.close(), playerContext.close()]);
  }
});
