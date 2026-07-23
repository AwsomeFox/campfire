import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #706 — Sessions navigation exposed the Log/Schedule toggle and the
 * selected recap row only through color/border/shadow. This spec pins the
 * accessibility behavior that replaced it:
 *
 *  - Log/Schedule is a WAI-ARIA tablist (role=tablist, role=tab, aria-selected,
 *    aria-controls, roving tabindex) with Arrow/Home/End keyboard behavior.
 *  - Each tab controls a role=tabpanel region labeled by its tab.
 *  - The selected recap row carries aria-current="true" (semantic selection, not
 *    color alone), plus an sr-only "Selected" flag for SRs that ignore the
 *    attribute on a <button>.
 *  - Mobile list→detail focus moves to the recap heading when a recap is opened
 *    from the list (list and detail are mutually exclusive below the lg break).
 *  - The deep-link query param (?tab=schedule, ?session=:id) still drives the
 *    selected tab/recap.
 *  - Changes are announced through the app's polite live region.
 */

const TAB_IDS = ['sessions-tab-log', 'sessions-tab-schedule'] as const;
const PANEL_IDS = ['sessions-panel-log', 'sessions-panel-schedule'] as const;

test.use({ storageState: stateFor('dm') });

/** Creates a second seeded session so there are two rows to disambiguate selection.
 *  Picks the next free session number by scanning existing recaps, and retries
 *  past a 409 (the serial backend can carry a leftover from a prior spec run). */
async function ensureSecondSession(page: Page): Promise<{ id: number; title: string; number: number }> {
  const { campaignId } = seed();
  const listRes = await page.request.get(`/api/v1/campaigns/${campaignId}/sessions`);
  const existing = listRes.ok() ? ((await listRes.json()) as Array<{ number: number }>) : [];
  const taken = new Set(existing.map((s) => s.number));
  // Try numbers starting just past the current max; fall back higher on collision.
  const startFrom = existing.reduce((max, s) => Math.max(max, s.number), 1) + 1;
  for (let candidate = startFrom; candidate < startFrom + 50; candidate += 1) {
    if (taken.has(candidate)) continue;
    const title = `Sessions a11y ${candidate}`;
    const res = await page.request.post(`/api/v1/campaigns/${campaignId}/sessions`, {
      data: { number: candidate, title, recap: 'Second recap for selection semantics.', playedAt: '2026-07-20' },
    });
    if (res.ok()) {
      const created = (await res.json()) as { id: number };
      return { id: created.id, title, number: candidate };
    }
    if (res.status() !== 409) {
      throw new Error(`session create failed: ${res.status()} ${await res.text()}`);
    }
    // 409 → number raced; try the next candidate.
  }
  throw new Error('Could not allocate a free session number for the a11y fixture');
}

async function expectTabSelected(page: Page, tabId: string) {
  const tab = page.locator(`#${tabId}`);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(tab).toHaveAttribute('tabindex', '0');
  for (const other of TAB_IDS) {
    if (other === tabId) continue;
    await expect(page.locator(`#${other}`)).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator(`#${other}`)).toHaveAttribute('tabindex', '-1');
  }
}

test.describe('Sessions Log/Schedule tablist (#706)', () => {
  test('exposes tab semantics with roving tabindex, controlled panels, and arrow/Home/End keys', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/sessions`);

    const tablist = page.getByRole('tablist', { name: 'Sessions view' });
    await expect(tablist).toBeVisible();
    const tabs = tablist.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    await expect(tabs).toHaveText(['Log', 'Schedule']);

    // Default selection: Log is selected, Schedule is in the roving chain at -1.
    await expectTabSelected(page, 'sessions-tab-log');

    // aria-controls ↔ aria-labelledby: each tab points at a real, labeled panel.
    for (let i = 0; i < TAB_IDS.length; i += 1) {
      const tab = page.locator(`#${TAB_IDS[i]}`);
      await expect(tab).toHaveAttribute('aria-controls', PANEL_IDS[i]);
      const panel = page.locator(`#${PANEL_IDS[i]}`);
      await expect(panel).toHaveAttribute('role', 'tabpanel');
      await expect(panel).toHaveAttribute('aria-labelledby', TAB_IDS[i]);
    }

    // ArrowRight moves selection to Schedule and focuses the Schedule tab.
    const logTab = page.locator('#sessions-tab-log');
    const scheduleTab = page.locator('#sessions-tab-schedule');
    await logTab.focus();
    await expect(logTab).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(scheduleTab).toBeFocused();
    await expectTabSelected(page, 'sessions-tab-schedule');
    // URL deep-link is preserved.
    await expect(page).toHaveURL(/tab=schedule/);

    // ArrowLeft returns to Log.
    await page.keyboard.press('ArrowLeft');
    await expect(logTab).toBeFocused();
    await expectTabSelected(page, 'sessions-tab-log');
    await expect(page).not.toHaveURL(/tab=schedule/);

    // Home/End jump to the first/last tab respectively.
    await page.keyboard.press('End');
    await expect(scheduleTab).toBeFocused();
    await expectTabSelected(page, 'sessions-tab-schedule');
    await page.keyboard.press('Home');
    await expect(logTab).toBeFocused();
    await expectTabSelected(page, 'sessions-tab-log');

    // Enter and Space activate the focused tab (native <button> behavior, but
    // asserted so a future refactor to a non-button can't silently drop it).
    await page.keyboard.press('ArrowRight');
    await expect(scheduleTab).toBeFocused();
    await page.keyboard.press('Space');
    await expectTabSelected(page, 'sessions-tab-schedule');

    // Activating a tab with the mouse also flips selection and the URL.
    await logTab.click();
    await expectTabSelected(page, 'sessions-tab-log');
    await expect(page).not.toHaveURL(/tab=schedule/);

    // Deep-linking straight into Schedule lands on the Schedule tab selected.
    await page.goto(`/c/${campaignId}/sessions?tab=schedule`);
    await expectTabSelected(page, 'sessions-tab-schedule');

    // The tablist control itself (tabs + their semantics) is axe-clean. The panel
    // contents carry unrelated pre-existing findings (e.g. SchedulePanel copy
    // contrast) tracked separately and out of scope for this tablist PR.
    const results = await new AxeBuilder({ page })
      .include('[role="tablist"][aria-label="Sessions view"]')
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('marks the active recap with aria-current and an sr-only Selected flag (not color alone)', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const second = await ensureSecondSession(page);

    try {
      await page.goto(`/c/${campaignId}/sessions?session=${navigation.sessionId}`);

      // The timeline rows are buttons; locate them by stable title text (the
      // "Selected" flag is part of the accessible name only when active, so we
      // anchor on the title that's always present and read aria-current off it).
      const firstRow = page.getByRole('button', { name: /DLRNAV First Crossing/i });
      const secondRow = page.getByRole('button', { name: new RegExp(second.title) });
      await expect(firstRow).toBeVisible();
      await expect(secondRow).toBeVisible();

      // The seeded session is selected: its row carries the semantic current state
      // and an sr-only flag that doubles for SRs that don't voice aria-current on <button>.
      await expect(firstRow).toHaveAttribute('aria-current', 'true');
      await expect(firstRow.locator('.sr-only')).toHaveText('Selected');

      // The other row has no current-state attribute and no Selected flag.
      await expect(secondRow).not.toHaveAttribute('aria-current', 'true');
      await expect(secondRow.locator('.sr-only')).toHaveCount(0);

      // Activating the other recap moves the semantic selection to it.
      await secondRow.click();
      await expect(page).toHaveURL(new RegExp(`session=${second.id}`));
      await expect(secondRow).toHaveAttribute('aria-current', 'true');
      await expect(secondRow.locator('.sr-only')).toHaveText('Selected');
      await expect(firstRow).not.toHaveAttribute('aria-current', 'true');
      await expect(firstRow.locator('.sr-only')).toHaveCount(0);

      // The selected detail title is the focusable heading (mobile entry point).
      const detailHeading = page.getByRole('heading', { level: 2, name: second.title });
      await expect(detailHeading).toHaveAttribute('tabindex', '-1');

      // Axe on just the list region (the detail pane carries unrelated content).
      const results = await new AxeBuilder({ page })
        .include('[aria-label="Session recaps"]')
        .analyze();
      expect(results.violations).toEqual([]);
    } finally {
      await page.request.delete(`/api/v1/sessions/${second.id}`);
    }
  });

  test('manages mobile list→detail focus and announces selection changes', async ({ browser }) => {
    // Mobile: list and detail are mutually exclusive, so opening a recap must move
    // focus into the detail heading so SR/keyboard users reach the new content.
    const context: BrowserContext = await browser.newContext({
      storageState: stateFor('dm'),
      viewport: { width: 375, height: 812 },
    });
    const page = await context.newPage();
    try {
      const { campaignId } = seed();
      const second = await ensureSecondSession(page);

      // Watch the app's polite live region so we can assert the announcement.
      await page.goto(`/c/${campaignId}/sessions`);
      const polite = page.locator('.sr-only[aria-live="polite"]');
      await expect(polite).toHaveCount(1);

      // On mobile the list is visible first; selecting a recap swaps to detail.
      const firstRow = page.getByRole('button', { name: /DLRNAV First Crossing/i });
      await expect(firstRow).toBeVisible();
      await firstRow.click();

      // Focus lands on the detail heading (the semantic entry point for the pane).
      const heading = page.getByRole('heading', { level: 2, name: 'DLRNAV First Crossing' });
      await expect(heading).toBeFocused();

      // The selection was announced through the polite live region.
      await expect.poll(async () => polite.textContent()).toContain('Session 1');
      await expect.poll(async () => polite.textContent()).toMatch(/Selected/i);

      // Selecting the other recap re-announces and refocuses.
      // Navigate back to the list, then pick the other recap.
      await page.getByRole('button', { name: /Back to sessions/i }).click();
      const secondRow = page.getByRole('button', { name: new RegExp(second.title) });
      await secondRow.click();
      const secondHeading = page.getByRole('heading', { level: 2, name: second.title });
      await expect(secondHeading).toBeFocused();
      await expect.poll(async () => polite.textContent()).toContain(`Session ${second.number}`);

      await page.request.delete(`/api/v1/sessions/${second.id}`);
    } finally {
      await context.close();
    }
  });

  test('preserves the deep-link session param across reloads', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/sessions?session=${navigation.sessionId}`);
    const row = page.getByRole('button', { name: /DLRNAV First Crossing/i });
    await expect(row).toHaveAttribute('aria-current', 'true');
    await page.reload();
    // The ?session param is the source of truth: the same row is selected after reload.
    await expect(row).toHaveAttribute('aria-current', 'true');
  });
});
