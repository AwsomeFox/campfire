import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #1643 — Exhaustion shown as a level (1-6) on the character sheet, real browser DOM
 * proof (the pure adapter-selection/level-read logic is unit-tested in
 * character-condition-level.unit.spec.ts, and the MCP/REST composition end-to-end is
 * proven server-side in mcp.e2e-spec.ts's two "#1643:" tests). The seed campaign's
 * `ruleSystem` ('e2e-open5e-actions', an unregistered slug) falls back to the 5e adapter
 * (see `ruleSystemAdapter` in packages/schema), so this is a real 5e sheet.
 */
test.describe('character sheet surfaces Exhaustion as a level (#1643)', () => {
  test.use({ storageState: stateFor('dm') });

  test('raises and lowers the level with +/- controls, capped at 6, and the plain condition chip does not duplicate it', async ({
    page,
  }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    const raise = page.getByRole('button', { name: 'Raise' });
    const lower = page.getByRole('button', { name: 'Lower' });
    await expect(raise).toBeVisible();

    // Fresh (never-touched) character: level 0, Lower disabled (nothing to lower).
    await expect(page.getByLabel('0 of 6 — Exhaustion level')).toBeVisible();
    await expect(lower).toBeDisabled();
    await expect(raise).toBeEnabled();

    const raiseReq = page.waitForResponse(
      (res) => res.url().includes(`/api/v1/characters/${navigation.characterId}/conditions/level`) && res.request().method() === 'POST',
    );
    await raise.click();
    await raiseReq;
    await expect(page.getByLabel('1 of 6 — Exhaustion level')).toBeVisible();

    // Exhaustion at level 1 does NOT also show up as a plain removable chip — it has its
    // own level control now, not a second, disagreeing "remove entirely" control.
    await expect(page.getByRole('button', { name: 'Remove Exhaustion' })).toHaveCount(0);

    const lowerReq = page.waitForResponse(
      (res) => res.url().includes(`/api/v1/characters/${navigation.characterId}/conditions/level`) && res.request().method() === 'POST',
    );
    await lower.click();
    await lowerReq;
    await expect(page.getByLabel('0 of 6 — Exhaustion level')).toBeVisible();
    await expect(lower).toBeDisabled();
  });
});
