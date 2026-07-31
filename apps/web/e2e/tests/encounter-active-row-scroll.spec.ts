import { expect, test, type Page } from '@playwright/test';
import { restoreSeedEncounter, seed, stateFor } from './seed';

test.use({ storageState: stateFor('dm') });

const COMBATANT_COUNT = 20;

async function endLiveEncounters(page: Page, campaignId: number) {
  const live = await page.request.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`);
  if (!live.ok()) return;
  for (const enc of (await live.json()) as { id: number }[]) {
    await page.request.post(`/api/v1/encounters/${enc.id}/end`);
  }
}

async function createTallRunningEncounter(page: Page) {
  const { campaignId } = seed();
  await endLiveEncounters(page, campaignId);

  const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
    data: { name: 'Tall scroll drill', hidden: false },
  });
  expect(created.ok()).toBe(true);
  const encounter = (await created.json()) as { id: number };

  for (let i = 0; i < COMBATANT_COUNT; i++) {
    const added = await page.request.post(`/api/v1/encounters/${encounter.id}/combatants`, {
      data: { kind: 'monster', name: `Scroll Mob ${String(i + 1).padStart(2, '0')}`, hpMax: 10 },
    });
    expect(added.ok()).toBe(true);
    const combatant = (await added.json()) as { id: number };
    const initiative = await page.request.patch(
      `/api/v1/encounters/${encounter.id}/combatants/${combatant.id}`,
      { data: { initiative: 100 - i } },
    );
    expect(initiative.ok()).toBe(true);
  }

  const rolled = await page.request.post(`/api/v1/encounters/${encounter.id}/roll-initiative`);
  expect(rolled.ok()).toBe(true);
  const started = await page.request.post(`/api/v1/encounters/${encounter.id}/start`);
  expect(started.ok()).toBe(true);

  return { campaignId, encounterId: encounter.id };
}

test.describe('run session active row scroll (issue #636)', () => {
  test('advancing turn scrolls the active combatant row into view', async ({ page }) => {
    const fixture = await createTallRunningEncounter(page);
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 900, height: 360 });
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByRole('heading', { name: 'Tall scroll drill' })).toBeVisible();
      const nextTurnBtn = page.getByTestId('encounter-header-next-turn');
      await expect(nextTurnBtn).toBeVisible();

      // Pin the window at the top so lower initiative rows start below the fold.
      await page.evaluate(() => window.scrollTo(0, 0));

      const targetName = 'Scroll Mob 12';
      const turnsToAdvance = 11;
      for (let i = 0; i < turnsToAdvance; i++) {
        const nextTurn = page.waitForResponse(
          (response) => response.url().includes('/next-turn') && response.ok(),
        );
        await nextTurnBtn.click();
        await nextTurn;
        await expect(page.getByText('Running', { exact: false }).first()).toBeVisible();
      }

      const activeRow = page.locator(`[data-testid^="combatant-row-"][data-current-turn="true"]`);
      await expect(activeRow).toHaveCount(1);
      await expect(activeRow).toContainText(targetName);

      await expect
        .poll(async () =>
          activeRow.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < window.innerHeight;
          }),
          { timeout: 15_000 },
        )
        .toBe(true);
    } finally {
      await page.request.delete(`/api/v1/encounters/${fixture.encounterId}`);
      await restoreSeedEncounter(page);
    }
  });
});
