import { expect, test, type Page } from '@playwright/test';
import { restoreSeedEncounter, seed, stateFor } from './seed';

test.use({ storageState: stateFor('dm') });

async function endLiveEncounters(page: Page, campaignId: number) {
  const live = await page.request.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`);
  if (!live.ok()) return;
  for (const encounter of (await live.json()) as { id: number }[]) {
    await page.request.post(`/api/v1/encounters/${encounter.id}/end`);
  }
}

async function createRunningEncounter(page: Page) {
  const { campaignId } = seed();
  await endLiveEncounters(page, campaignId);

  const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
    data: { name: 'Cockpit layout drill', hidden: false },
  });
  expect(created.ok()).toBe(true);
  const encounter = (await created.json()) as { id: number };

  const added = await page.request.post(`/api/v1/encounters/${encounter.id}/combatants`, {
    data: { kind: 'monster', name: 'Cockpit sentinel', hpMax: 10 },
  });
  expect(added.ok()).toBe(true);
  const combatant = (await added.json()) as { id: number };

  const initiative = await page.request.patch(
    `/api/v1/encounters/${encounter.id}/combatants/${combatant.id}`,
    { data: { initiative: 18 } },
  );
  expect(initiative.ok()).toBe(true);
  expect((await page.request.post(`/api/v1/encounters/${encounter.id}/roll-initiative`)).ok()).toBe(true);
  expect((await page.request.post(`/api/v1/encounters/${encounter.id}/start`)).ok()).toBe(true);

  return { campaignId, encounterId: encounter.id };
}

test.describe('encounter cockpit layout (issue #669)', () => {
  test('uses a bounded sticky activity rail at lg and normal flow below it', async ({ page }) => {
    const fixture = await createRunningEncounter(page);
    try {
      await page.setViewportSize({ width: 1280, height: 500 });
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByRole('heading', { name: 'Cockpit layout drill' })).toBeVisible();

      const cockpit = page.getByTestId('encounter-cockpit');
      const activity = cockpit.getByRole('complementary', { name: 'Encounter activity' });
      await expect(activity).toBeVisible();
      await expect(activity.getByRole('log', { name: 'Combat log' })).toBeVisible();

      const desktop = await cockpit.evaluate((node) => {
        const rail = node.querySelector('aside')!;
        const cockpitStyle = getComputedStyle(node);
        const railStyle = getComputedStyle(rail);
        return {
          columns: cockpitStyle.gridTemplateColumns.trim().split(/\s+/).length,
          position: railStyle.position,
          overflowY: railStyle.overflowY,
          maxHeight: parseFloat(railStyle.maxHeight),
          viewportHeight: window.innerHeight,
        };
      });
      expect(desktop.columns).toBe(2);
      expect(desktop.position).toBe('sticky');
      expect(desktop.overflowY).toBe('auto');
      expect(desktop.maxHeight).toBeLessThanOrEqual(desktop.viewportHeight);

      await page.setViewportSize({ width: 390, height: 844 });
      const mobile = await cockpit.evaluate((node) => {
        const rail = node.querySelector('aside')!;
        const cockpitStyle = getComputedStyle(node);
        const railStyle = getComputedStyle(rail);
        return {
          columns: cockpitStyle.gridTemplateColumns.trim().split(/\s+/).length,
          position: railStyle.position,
          overflowY: railStyle.overflowY,
          maxHeight: railStyle.maxHeight,
        };
      });
      expect(mobile.columns).toBe(1);
      expect(mobile.position).toBe('static');
      expect(mobile.overflowY).toBe('visible');
      expect(mobile.maxHeight).toBe('none');
    } finally {
      await page.request.delete(`/api/v1/encounters/${fixture.encounterId}`);
      await restoreSeedEncounter(page);
    }
  });
});
