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

test.describe('encounter cockpit layout', () => {
  test('is a fixed, non-scrolling shell: map canvas plus a tabbed side panel', async ({ page }) => {
    const fixture = await createRunningEncounter(page);
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByRole('heading', { name: 'Cockpit layout drill' })).toBeVisible();

      const shell = page.locator('.cf-vtt');
      const canvas = page.getByTestId('encounter-vtt-canvas');
      const panel = page.getByTestId('encounter-vtt-panel');
      await expect(canvas).toBeVisible();
      await expect(panel).toBeVisible();

      const desktop = await shell.evaluate((node) => {
        const canvasEl = node.querySelector('[data-testid="encounter-vtt-canvas"]')!;
        const panelEl = node.querySelector('[data-testid="encounter-vtt-panel"]')!;
        const shellRect = node.getBoundingClientRect();
        return {
          position: getComputedStyle(node).position,
          // The shell owns the viewport and the page itself never scrolls.
          fillsViewport:
            Math.round(shellRect.width) === window.innerWidth
            && Math.round(shellRect.height) === window.innerHeight,
          documentScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
          // Canvas and panel sit side by side, with the panel on the trailing edge.
          sideBySide:
            canvasEl.getBoundingClientRect().right <= panelEl.getBoundingClientRect().left + 1,
          canvasHeight: Math.round(canvasEl.getBoundingClientRect().height),
          panelWidth: Math.round(panelEl.getBoundingClientRect().width),
        };
      });
      expect(desktop.position).toBe('fixed');
      expect(desktop.fillsViewport).toBe(true);
      expect(desktop.documentScrolls).toBe(false);
      expect(desktop.sideBySide).toBe(true);
      // Starts at the template's 356px and grows with the viewport (clamped at 460).
      expect(desktop.panelWidth).toBeGreaterThanOrEqual(356);
      expect(desktop.panelWidth).toBeLessThanOrEqual(460);
      // The canvas gets the height left over under the header, not a 16:9 reservation.
      expect(desktop.canvasHeight).toBeGreaterThan(400);

      // The panel's tabs are the page's sections; only the selected one is mounted.
      await expect(page.getByTestId('encounter-vtt-tab-party')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('log', { name: 'Combat log' })).toHaveCount(0);
      await page.getByTestId('encounter-vtt-tab-log').click();
      await expect(page.getByRole('log', { name: 'Combat log' })).toBeVisible();

      // Collapsing the panel hands the whole canvas to the map, and the reopen tab returns it.
      await page.getByTestId('encounter-vtt-panel-close').click();
      await expect(panel).toHaveCount(0);
      await page.getByTestId('encounter-vtt-panel-open').click();
      await expect(panel).toBeVisible();

      // Below the two-column width the panel stacks under the canvas rather than
      // covering it — both stay on screen.
      await page.setViewportSize({ width: 390, height: 844 });
      const mobile = await shell.evaluate((node) => {
        const canvasEl = node.querySelector('[data-testid="encounter-vtt-canvas"]')!;
        const panelEl = node.querySelector('[data-testid="encounter-vtt-panel"]')!;
        return {
          stacked: canvasEl.getBoundingClientRect().bottom <= panelEl.getBoundingClientRect().top + 1,
          canvasHeight: Math.round(canvasEl.getBoundingClientRect().height),
          panelHeight: Math.round(panelEl.getBoundingClientRect().height),
        };
      });
      expect(mobile.stacked).toBe(true);
      expect(mobile.canvasHeight).toBeGreaterThan(100);
      expect(mobile.panelHeight).toBeGreaterThan(100);
    } finally {
      await page.request.delete(`/api/v1/encounters/${fixture.encounterId}`);
      await restoreSeedEncounter(page);
    }
  });
});
