import { expect, request, test } from '@playwright/test';
import { seed, stateFor } from './seed';
import { CREDS } from '../global-setup';

/**
 * Issue #1746 — CombatantRow used to fold the encounter sync gate into the same
 * `canEdit` value that governs permission, so `{canEdit && ...}` controls (HP
 * steppers, the temp-HP field, the "+ condition" toggle) UNMOUNTED whenever the
 * sync gate blocked writes — including the ordinary first-load `connecting` state
 * on every cold load and reconnect. That produced a mid-tap reflow: a control the
 * viewer was about to tap disappeared and a different one slid into its place.
 *
 * These specs pin the fix: permission (`canEditCombatantPermission`) governs
 * whether the controls mount at all; the sync gate (`riskyBlocked`) only disables
 * them, with an accessible reason. A genuinely unauthorized viewer still never
 * sees them, sync-blocked or not.
 */

async function seedOwnedCombatant(
  hp: { hpCurrent: number; hpMax: number; deathState?: 'dying' } = { hpCurrent: 24, hpMax: 24 },
) {
  const { baseURL, campaignId } = seed();
  const dm = await request.newContext({ baseURL });
  const player = await request.newContext({ baseURL });
  await dm.post('/api/v1/auth/login', { data: CREDS.dm });
  await player.post('/api/v1/auth/login', { data: CREDS.player });
  const me = await (await player.get('/api/v1/me')).json();
  const playerUserId = String(me.user.id);

  const character = await (
    await dm.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: {
        name: 'Sync Gate Test Hero',
        className: 'Fighter',
        level: 3,
        ownerUserId: playerUserId,
        hpCurrent: hp.hpCurrent,
        hpMax: hp.hpMax,
        stats: { STR: 16 },
      },
    })
  ).json();

  // create() auto-adds every ACTIVE campaign character as a combatant (issue #115)
  // — the freshly created hero is already active, so it lands in enc.combatants
  // without a separate POST /combatants call (which would 409 as a duplicate).
  const enc = await (
    await dm.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: 'Sync gate disable drill', hidden: false },
    })
  ).json();
  const encounterId = enc.id as number;
  const heroCombatant = (enc.combatants as Array<{ id: number; characterId: number | null }>).find(
    (c) => c.characterId === character.id,
  );
  if (!heroCombatant) throw new Error('expected auto-added hero combatant');

  if (hp.deathState) {
    await dm.patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatant.id}`, {
      data: { deathState: hp.deathState },
    });
  }

  await dm.dispose();
  return {
    baseURL,
    campaignId,
    encounterId,
    heroCombatantId: heroCombatant.id,
    characterId: character.id as number,
    playerCtx: player,
  };
}

async function teardown(baseURL: string, encounterId: number, characterId: number) {
  const dm = await request.newContext({ baseURL });
  await dm.post('/api/v1/auth/login', { data: CREDS.dm });
  await dm.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
  await dm.delete(`/api/v1/characters/${characterId}`).catch(() => undefined);
  await dm.dispose();
}

test.describe('CombatantRow sync-gate disable, not unmount (issue #1746)', () => {
  test('permission granted + sync gate blocked: HP steppers, temp-HP field, and +condition stay mounted, disabled, with an accessible reason', async ({ browser }) => {
    const { baseURL, campaignId, encounterId, heroCombatantId, characterId, playerCtx } = await seedOwnedCombatant();
    const context = await browser.newContext({ storageState: stateFor('player'), serviceWorkers: 'block' });
    const page = await context.newPage();

    let releaseEvents: () => void = () => {};
    const neverConnect = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    await page.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      await neverConnect;
      await route.continue();
    });

    try {
      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

      const syncChip = page.getByTestId('encounter-sync-chip');
      await expect(syncChip).toHaveText('Connecting');

      const row = page.getByTestId(`combatant-row-${heroCombatantId}`);
      await expect(row).toBeVisible();

      const hpSteppers = row.getByTestId('hp-steppers');
      const increaseBtn = hpSteppers.getByRole('button', { name: /Increase .* HP by 1/ });
      const tempHpInput = page.getByTestId(`temp-hp-input-${heroCombatantId}`);
      const addConditionBtn = page.getByTestId(`add-condition-toggle-${heroCombatantId}`);

      // Present (mounted) — permission is granted (the player owns this combatant's
      // character) — but disabled, because the sync gate is blocking right now.
      await expect(increaseBtn).toBeVisible();
      await expect(increaseBtn).toBeDisabled();
      await expect(tempHpInput).toBeVisible();
      await expect(tempHpInput).toBeDisabled();
      await expect(addConditionBtn).toBeVisible();
      await expect(addConditionBtn).toBeDisabled();

      // The accessible reason: each disabled control's aria-describedby resolves to a
      // (visually hidden) element carrying the actual sync-blocked reason text — not
      // merely a `title` tooltip, which screen readers announce inconsistently and
      // keyboard-only users cannot reach.
      for (const control of [increaseBtn, tempHpInput, addConditionBtn]) {
        const describedBy = await control.getAttribute('aria-describedby');
        expect(describedBy, 'expected aria-describedby on a sync-blocked control').toBeTruthy();
        const reasonText = await page.locator(`#${describedBy}`).innerText();
        expect(reasonText).toMatch(/paused|reconnecting/i);
      }

      // Mark the actual DOM nodes so we can prove, after the transition below, that
      // they are the SAME nodes — not a fresh mount that merely reuses the same
      // data-testid. React does not know about this attribute, so it only survives
      // if the element itself survived (issue #1746's anti-reflow guarantee).
      await increaseBtn.evaluate((el) => el.setAttribute('data-stable-probe', '1'));
      await tempHpInput.evaluate((el) => el.setAttribute('data-stable-probe', '1'));
      await addConditionBtn.evaluate((el) => el.setAttribute('data-stable-probe', '1'));

      // Resolve the hung events request so the stream actually connects — the
      // real connecting -> live transition, not a simulated offline toggle.
      releaseEvents();
      await expect(syncChip).toHaveText('Live', { timeout: 15_000 });

      // Same nodes (probe survived): only the disabled state changed, nothing
      // unmounted and remounted.
      await expect(increaseBtn).toHaveAttribute('data-stable-probe', '1');
      await expect(tempHpInput).toHaveAttribute('data-stable-probe', '1');
      await expect(addConditionBtn).toHaveAttribute('data-stable-probe', '1');
      await expect(increaseBtn).toBeEnabled();
      await expect(tempHpInput).toBeEnabled();
      await expect(addConditionBtn).toBeEnabled();
    } finally {
      await playerCtx.dispose();
      await teardown(baseURL, encounterId, characterId);
      await context.close();
    }
  });

  test('permission denied: the same controls stay absent regardless of the sync gate (regression guard)', async ({ browser }) => {
    const { baseURL, campaignId, encounterId, heroCombatantId, characterId, playerCtx } = await seedOwnedCombatant();
    // Viewer role: never has write permission on any combatant, owned or not — this
    // must not become "disabled for everyone" once mount/disable are split apart.
    const context = await browser.newContext({ storageState: stateFor('viewer') });
    const page = await context.newPage();

    try {
      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      const row = page.getByTestId(`combatant-row-${heroCombatantId}`);
      await expect(row).toBeVisible();

      // Exact HP is still visible (character HP is shared table knowledge, unlike a
      // redacted monster) — so an absent control here is unambiguously about
      // permission, not about the row simply not knowing hpCurrent.
      await expect(row.getByText('24 / 24')).toBeVisible();

      await expect(row.getByTestId('hp-steppers')).toHaveCount(0);
      await expect(page.getByTestId(`temp-hp-input-${heroCombatantId}`)).toHaveCount(0);
      await expect(page.getByTestId(`add-condition-toggle-${heroCombatantId}`)).toHaveCount(0);
    } finally {
      await playerCtx.dispose();
      await teardown(baseURL, encounterId, characterId);
      await context.close();
    }
  });

  // Devin review finding on this PR: DeathSaveTracker took its own `canEdit` prop,
  // which silently changed meaning from "permitted AND not sync-blocked" to
  // "permitted only" once the mount/disable split landed elsewhere in this file —
  // the death-save pips and Roll button would have gone from correctly-blocked to
  // always-live during an outage. Two clients disagreeing about whether a character
  // died is exactly the corruption the sync gate exists to prevent, so this is
  // pinned as its own test rather than folded into the generic controls test above.
  test('death-save controls: disabled while sync-blocked, enabled when live — never unmounted', async ({ browser }) => {
    // hpCurrent 0 puts the combatant at the death-save threshold (kind 'character',
    // hpCurrent <= 0) so CombatantRow renders the DeathSaveTracker at all.
    const { baseURL, campaignId, encounterId, heroCombatantId, characterId, playerCtx } = await seedOwnedCombatant({
      hpCurrent: 0,
      hpMax: 24,
      deathState: 'dying',
    });
    const context = await browser.newContext({ storageState: stateFor('player'), serviceWorkers: 'block' });
    const page = await context.newPage();

    let releaseEvents: () => void = () => {};
    const neverConnect = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    await page.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      await neverConnect;
      await route.continue();
    });

    try {
      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

      const syncChip = page.getByTestId('encounter-sync-chip');
      await expect(syncChip).toHaveText('Connecting');

      const row = page.getByTestId(`combatant-row-${heroCombatantId}`);
      await expect(row).toBeVisible();

      const tracker = row.getByTestId('death-save-tracker');
      await expect(tracker).toBeVisible();
      const successPip = tracker.getByTestId('death-save-success-pips').getByRole('button').first();
      const rollBtn = tracker.getByRole('button', { name: 'Roll a death save' });

      // Present (mounted) — the player owns this combatant — but disabled, because
      // the sync gate is blocking. Asserting disabled, not absence, is the point:
      // this must not regress to unmounting, and it must not become permanently
      // live just because it is mounted.
      await expect(successPip).toBeVisible();
      await expect(successPip).toBeDisabled();
      await expect(rollBtn).toBeVisible();
      await expect(rollBtn).toBeDisabled();

      const describedBy = await successPip.getAttribute('aria-describedby');
      expect(describedBy, 'expected aria-describedby on the disabled death-save pip').toBeTruthy();
      const reasonText = await page.locator(`#${describedBy}`).innerText();
      expect(reasonText).toMatch(/paused|reconnecting/i);

      await successPip.evaluate((el) => el.setAttribute('data-stable-probe', '1'));
      await rollBtn.evaluate((el) => el.setAttribute('data-stable-probe', '1'));

      releaseEvents();
      await expect(syncChip).toHaveText('Live', { timeout: 15_000 });

      await expect(successPip).toHaveAttribute('data-stable-probe', '1');
      await expect(rollBtn).toHaveAttribute('data-stable-probe', '1');
      await expect(successPip).toBeEnabled();
      await expect(rollBtn).toBeEnabled();
    } finally {
      await playerCtx.dispose();
      await teardown(baseURL, encounterId, characterId);
      await context.close();
    }
  });
});
