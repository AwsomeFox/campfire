import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { Campaign } from '@campfire/schema';
import { stateFor } from './seed';

/**
 * Issue #750 — the dashboard quick-edit on `/c/:id` used placeholder-only
 * inputs (no labels, no stable ids, no requirement marker, no character help,
 * no shared structure with the Settings page). This spec pins the acceptance
 * criteria for the shared labeled metadata field group now driving both
 * surfaces: label activation, accessible names, DOM order, dirty/saving/saved
 * state, value preservation on failure, and mobile layout.
 */

async function json<T>(response: APIResponse, operation: string): Promise<T> {
  if (!response.ok()) throw new Error(`${operation} -> ${response.status()}: ${await response.text()}`);
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

async function createDisposableCampaign(request: APIRequestContext, name: string): Promise<Campaign> {
  return json<Campaign>(
    await request.post('/api/v1/campaigns', { data: { name, description: 'E2E750 baseline description' } }),
    'create E2E750 campaign',
  );
}

async function resetCampaign(request: APIRequestContext, campaign: Campaign): Promise<void> {
  await json<Campaign>(
    await request.patch(`/api/v1/campaigns/${campaign.id}`, {
      data: { name: campaign.name, description: campaign.description, dangerLevel: 'low' },
    }),
    'reset E2E750 campaign',
  );
}

test.describe('dashboard campaign quick edit (#750)', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: stateFor('dm') });

  let campaign: Campaign;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFor('dm') });
    try {
      campaign = await createDisposableCampaign(ctx.request, `E2E750 ${Date.now()}`);
    } finally {
      await ctx.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!campaign) return;
    const ctx = await browser.newContext({ storageState: stateFor('dm') });
    try {
      // Soft-delete via trash so the next test run finds a clean seed list.
      await ctx.request.delete(`/api/v1/campaigns/${campaign.id}`).catch(() => {});
    } finally {
      await ctx.close();
    }
  });

  test('exposes labeled metadata controls with activated labels and stable accessible names', async ({ page, browser }) => {
    test.skip(!campaign, 'campaign fixture unavailable');
    // Reset to baseline before each behavioural case so this serial spec is order-independent.
    const resetCtx = await browser.newContext({ storageState: stateFor('dm') });
    try { await resetCampaign(resetCtx.request, campaign); } finally { await resetCtx.close(); }

    await page.goto(`/c/${campaign.id}`);

    await page.getByRole('button', { name: '✎ Edit' }).click();
    const editor = page.getByRole('region', { name: 'Edit campaign details' });

    // Stable accessible names — the speech-recognition / screen-reader contract.
    const nameField = editor.getByRole('textbox', { name: /^Name/ });
    const descField = editor.getByRole('textbox', { name: 'Description' });
    const dangerField = editor.getByRole('combobox', { name: 'Danger level' });
    await expect(nameField).toBeVisible();
    await expect(descField).toBeVisible();
    await expect(dangerField).toBeVisible();

    // The required marker is exposed to assistive tech via the label text.
    await expect(editor.locator('label')).toContainText([/Name/, /Description/, /Danger level/]);

    // Label activation: clicking a <label> focuses its associated input via htmlFor.
    await editor.locator('label', { hasText: 'Description' }).click();
    await expect(descField).toBeFocused();
    await editor.locator('label', { hasText: 'Name' }).click();
    await expect(nameField).toBeFocused();
    await editor.locator('label', { hasText: 'Danger level' }).click();
    await expect(dangerField).toBeFocused();

    // Character help is present and counts live characters.
    await nameField.fill('E2E750 renamed');
    await expect(editor.getByText(/14\/120 characters/i)).toBeVisible();

    const a11y = await new AxeBuilder({ page }).include('[aria-label="Edit campaign details"]').analyze();
    expect(a11y.violations).toEqual([]);

    // Cancel restores the baseline values — no stale text lingers on the next open.
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByRole('heading', { name: campaign.name })).toBeVisible();
  });

  test('keeps a sensible keyboard order and pristine Save gate', async ({ page, browser }) => {
    test.skip(!campaign, 'campaign fixture unavailable');
    const resetCtx = await browser.newContext({ storageState: stateFor('dm') });
    try { await resetCampaign(resetCtx.request, campaign); } finally { await resetCtx.close(); }

    await page.goto(`/c/${campaign.id}`);
    await page.getByRole('button', { name: '✎ Edit' }).click();
    const editor = page.getByRole('region', { name: 'Edit campaign details' });

    // Open with focus on the first field, then Tab forward through the group
    // in source order — name → description → danger → cancel → save. Speech
    // input and switch users rely on this linear DOM order.
    const nameField = editor.getByRole('textbox', { name: /^Name/ });
    await nameField.focus();
    await expect(nameField).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(editor.getByRole('textbox', { name: 'Description' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(editor.getByRole('combobox', { name: 'Danger level' })).toBeFocused();

    // Save is disabled until something actually changes (dirty gate).
    const save = editor.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();

    // Editing name lifts the dirty gate; clearing it again re-disables Save.
    await nameField.fill('E2E750 keyboard dirty');
    await expect(save).toBeEnabled();
    await nameField.fill(campaign.name);
    await expect(save).toBeDisabled();

    await editor.getByRole('button', { name: 'Cancel' }).click();
  });

  test('preserves field values and shows a transient error on save failure', async ({ page, browser }) => {
    test.skip(!campaign, 'campaign fixture unavailable');
    const resetCtx = await browser.newContext({ storageState: stateFor('dm') });
    try { await resetCampaign(resetCtx.request, campaign); } finally { await resetCtx.close(); }

    // Force the next PATCH on this campaign to fail with a server message.
    await page.route(`**/api/v1/campaigns/${campaign.id}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'E2E750 simulated outage' }),
      });
    });

    await page.goto(`/c/${campaign.id}`);
    await page.getByRole('button', { name: '✎ Edit' }).click();
    const editor = page.getByRole('region', { name: 'Edit campaign details' });

    const nameField = editor.getByRole('textbox', { name: /^Name/ });
    const descField = editor.getByRole('textbox', { name: 'Description' });
    await nameField.fill('E2E750 should survive failure');
    await descField.fill('E2E750 new description that must not be lost');

    await editor.getByRole('button', { name: 'Save' }).click();

    // Editor stays open, error is announced, and the typed text is preserved.
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('alert')).toContainText('E2E750 simulated outage');
    await expect(nameField).toHaveValue('E2E750 should survive failure');
    await expect(descField).toHaveValue('E2E750 new description that must not be lost');

    await page.unroute(`**/api/v1/campaigns/${campaign.id}`);
    await editor.getByRole('button', { name: 'Cancel' }).click();
  });

  test('shows a transient saved confirmation and closes the editor on success', async ({ page, browser }) => {
    test.skip(!campaign, 'campaign fixture unavailable');
    const resetCtx = await browser.newContext({ storageState: stateFor('dm') });
    try { await resetCampaign(resetCtx.request, campaign); } finally { await resetCtx.close(); }

    await page.goto(`/c/${campaign.id}`);
    await page.getByRole('button', { name: '✎ Edit' }).click();
    const editor = page.getByRole('region', { name: 'Edit campaign details' });

    const nameField = editor.getByRole('textbox', { name: /^Name/ });
    await nameField.fill('E2E750 saved name');
    await editor.getByRole('button', { name: 'Save' }).click();

    await expect(editor).toBeHidden();
    await expect(page.getByRole('heading', { name: 'E2E750 saved name' })).toBeVisible();
    // Saved. confirmation lives on the header row for the brief window after close.
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    await expect(page.getByText('Saved.', { exact: true })).toBeHidden();
  });

  test('mirrors the labeled structure used by the Settings general card', async ({ page, browser }) => {
    test.skip(!campaign, 'campaign fixture unavailable');
    const resetCtx = await browser.newContext({ storageState: stateFor('dm') });
    try { await resetCampaign(resetCtx.request, campaign); } finally { await resetCtx.close(); }

    // Dashboard surface: every label is a real <label htmlFor> with a stable id pair.
    await page.goto(`/c/${campaign.id}`);
    await page.getByRole('button', { name: '✎ Edit' }).click();
    const dashboardEditor = page.getByRole('region', { name: 'Edit campaign details' });
    for (const [labelText, id] of [
      ['Name', 'dashboard-campaign-name'],
      ['Description', 'dashboard-campaign-desc'],
      ['Danger level', 'dashboard-campaign-danger'],
    ] as const) {
      const label = dashboardEditor.locator('label', { hasText: new RegExp(`^${labelText}`) });
      await expect(label).toHaveAttribute('for', id);
      await expect(dashboardEditor.locator(`#${id}`)).toBeVisible();
    }
    await dashboardEditor.getByRole('button', { name: 'Cancel' }).click();

    // Settings surface: same labeled structure, different id prefix.
    await page.goto(`/c/${campaign.id}/settings`);
    const settingsGeneral = page.locator('.card.elev-sm').filter({ hasText: 'DM controls progression' });
    await expect(settingsGeneral).toBeVisible();
    for (const [labelText, id] of [
      ['Name', 'settings-name'],
      ['Description', 'settings-desc'],
      ['Danger level', 'settings-danger'],
    ] as const) {
      const label = settingsGeneral.locator('label', { hasText: new RegExp(`^${labelText}`) });
      await expect(label).toHaveAttribute('for', id);
      await expect(settingsGeneral.locator(`#${id}`)).toBeVisible();
    }
  });

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 375, height: 812 },
  ] as const) {
    test(`keeps every control reachable without horizontal overflow at ${viewport.name} size`, async ({ page, browser }, testInfo) => {
      test.skip(!campaign, 'campaign fixture unavailable');
      const resetCtx = await browser.newContext({ storageState: stateFor('dm') });
      try { await resetCampaign(resetCtx.request, campaign); } finally { await resetCtx.close(); }

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/c/${campaign.id}`);
      await page.getByRole('button', { name: '✎ Edit' }).click();
      const editor = page.getByRole('region', { name: 'Edit campaign details' });

      const controls = [
        editor.getByRole('textbox', { name: /^Name/ }),
        editor.getByRole('textbox', { name: 'Description' }),
        editor.getByRole('combobox', { name: 'Danger level' }),
        editor.getByRole('button', { name: 'Cancel' }),
        editor.getByRole('button', { name: 'Save' }),
      ];
      for (const control of controls) {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        expect(box, `control ${control} had no bounding box at ${viewport.name}`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        // Touch-sized targets on mobile keep the form usable by thumb.
        if (viewport.name === 'mobile') {
          expect(box!.height).toBeGreaterThanOrEqual(24);
        }
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${viewport.name} produced horizontal overflow`,
      ).toBeTruthy();

      const scan = await new AxeBuilder({ page }).include('[aria-label="Edit campaign details"]').analyze();
      expect(scan.violations).toEqual([]);

      await testInfo.attach(`dashboard-editor-${viewport.name}`, {
        body: await editor.screenshot({ animations: 'disabled' }),
        contentType: 'image/png',
      });

      await editor.getByRole('button', { name: 'Cancel' }).click();
    });
  }
});
