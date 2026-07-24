import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  RECAP_BODY_HELP,
  RECAP_FIELD_LABELS,
  RECAP_PLAYED_ON_HELP,
  RECAP_TITLE_HELP,
  RECAP_TITLE_MAX,
  editRecapFieldIds,
  newRecapFieldIds,
} from '../../src/features/sessions/recapFormFields';
import { seed, stateFor } from './seed';

/**
 * Issue #859 — session recap create/edit: persistent labels, help/error
 * associations, first-invalid focus, and keyboard / SR smoke coverage.
 */

test.use({ storageState: stateFor('dm') });

const createIds = newRecapFieldIds();

async function openCreateForm(page: Page) {
  const { campaignId } = seed();
  await page.goto(`/c/${campaignId}/sessions`);
  await page.getByRole('button', { name: /^\+ Add recap$/ }).click();
  const form = page.locator('.new-recap-form');
  await expect(form).toBeVisible();
  return form;
}

async function openEditForm(page: Page) {
  const { campaignId, navigation } = seed();
  const ids = editRecapFieldIds(navigation.sessionId);
  await page.goto(`/c/${campaignId}/sessions?session=${navigation.sessionId}&action=edit-recap`);
  const form = page.locator('.edit-recap-form');
  await expect(form).toBeVisible();
  await expect(page.locator(`#${ids.title.controlId}`)).toBeVisible();
  return { form, ids };
}

test.describe('session recap form accessibility (#859)', () => {
  test('create form exposes labeled controls, optional markers, and date help', async ({ page }) => {
    const form = await openCreateForm(page);

    const title = form.getByRole('textbox', { name: new RegExp(`^${RECAP_FIELD_LABELS.title}\\b`) });
    const playedOn = form.getByLabel(new RegExp(`^${RECAP_FIELD_LABELS.playedAt}\\b`));
    const recap = form.getByRole('textbox', { name: new RegExp(`^${RECAP_FIELD_LABELS.recap}\\b`) });

    await expect(title).toHaveAttribute('id', createIds.title.controlId);
    await expect(playedOn).toHaveAttribute('id', createIds.playedAt.controlId);
    await expect(recap).toHaveAttribute('id', createIds.recap.controlId);

    await expect(form.locator(`label[for="${createIds.title.controlId}"]`)).toContainText(/optional/i);
    await expect(form.locator(`label[for="${createIds.playedAt.controlId}"]`)).toContainText(/optional/i);
    await expect(form.locator(`label[for="${createIds.recap.controlId}"]`)).toContainText(/optional/i);

    await expect(title).toHaveAccessibleDescription(RECAP_TITLE_HELP);
    await expect(playedOn).toHaveAccessibleDescription(RECAP_PLAYED_ON_HELP);
    await expect(recap).toHaveAccessibleDescription(RECAP_BODY_HELP);

    // Label activation focuses the associated control.
    await form.locator(`label[for="${createIds.title.controlId}"]`).click();
    await expect(title).toBeFocused();
    await form.locator(`label[for="${createIds.playedAt.controlId}"]`).click();
    await expect(playedOn).toBeFocused();
    await form.locator(`label[for="${createIds.recap.controlId}"]`).click();
    await expect(recap).toBeFocused();

    const scan = await new AxeBuilder({ page }).include('.new-recap-form').analyze();
    expect(scan.violations).toEqual([]);
  });

  test('edit form associates Title / Played on / Recap with stable ids', async ({ page }) => {
    const { form, ids } = await openEditForm(page);

    const title = form.getByRole('textbox', { name: new RegExp(`^${RECAP_FIELD_LABELS.title}\\b`) });
    const playedOn = form.getByLabel(new RegExp(`^${RECAP_FIELD_LABELS.playedAt}\\b`));
    const recap = form.getByRole('textbox', { name: new RegExp(`^${RECAP_FIELD_LABELS.recap}\\b`) });

    await expect(title).toHaveAttribute('id', ids.title.controlId);
    await expect(playedOn).toHaveAttribute('id', ids.playedAt.controlId);
    await expect(recap).toHaveAttribute('id', ids.recap.controlId);
    await expect(title).toHaveAccessibleName(/Title/);
    await expect(playedOn).toHaveAccessibleName(/Played on/);
    await expect(recap).toHaveAccessibleName(/Recap/);
    await expect(playedOn).toHaveAccessibleDescription(/local calendar day/i);

    await form.locator(`label[for="${ids.title.controlId}"]`).click();
    await expect(title).toBeFocused();

    const scan = await new AxeBuilder({ page }).include('.edit-recap-form').analyze();
    expect(scan.violations).toEqual([]);
  });

  test('keyboard journey reaches Publish and focuses the first invalid field', async ({ page }) => {
    const form = await openCreateForm(page);
    const title = form.getByRole('textbox', { name: new RegExp(`^${RECAP_FIELD_LABELS.title}\\b`) });
    const playedOn = form.getByLabel(new RegExp(`^${RECAP_FIELD_LABELS.playedAt}\\b`));
    const recap = form.getByRole('textbox', { name: new RegExp(`^${RECAP_FIELD_LABELS.recap}\\b`) });
    const publish = form.getByRole('button', { name: 'Publish recap' });

    await expect(title).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(playedOn).toBeFocused();
    await page.keyboard.press('Tab');
    // Template button sits between the Recap label row and the textarea in tab order
    // only when focused from the date field — next stop is the Recap textarea or Insert template.
    // Walk until Publish so the smoke covers a complete keyboard path.
    let guard = 0;
    while (!(await publish.evaluate((el) => el === document.activeElement)) && guard < 8) {
      await page.keyboard.press('Tab');
      guard += 1;
    }
    await expect(publish).toBeFocused();

    // Over-long title — no maxLength on the control so client validation can announce.
    await title.fill('x'.repeat(RECAP_TITLE_MAX + 1));
    await publish.click();

    await expect(title).toBeFocused();
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    await expect(title).toHaveAccessibleDescription(/at most 200 characters/i);
    await expect(page.locator(`#${createIds.title.errorId}`)).toHaveAttribute('role', 'alert');
    // Valid path still reachable after correction — keep the draft focused for SR users.
    await expect(recap).toBeVisible();
  });

  test('create form associates API failures with the title field and keeps focus', async ({ page }) => {
    const { campaignId } = seed();
    await page.route(`**/api/v1/campaigns/${campaignId}/sessions`, async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 503, json: { message: 'Temporary recap failure' } });
        return;
      }
      await route.continue();
    });

    const form = await openCreateForm(page);
    const title = form.getByRole('textbox', { name: new RegExp(`^${RECAP_FIELD_LABELS.title}\\b`) });
    await title.fill(`A11y failure ${Date.now()}`);
    await form.getByRole('button', { name: 'Publish recap' }).click();

    await expect(form.getByRole('alert').filter({ hasText: "Couldn't publish the recap" })).toBeVisible();
    await expect(title).toBeFocused();
    await expect(title).toHaveAccessibleDescription(/Couldn't publish the recap/i);
  });

  test('preserves labeled create/edit forms at the 400% zoom equivalent', async ({ page }) => {
    // A 1280 CSS-pixel desktop viewport reduced to 320 CSS pixels is the WCAG
    // reflow equivalent of 400% browser zoom (same approach as storyline a11y).
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 720,
      deviceScaleFactor: 4,
      mobile: false,
    });

    const createForm = await openCreateForm(page);
    for (const control of [
      createForm.getByRole('textbox', { name: new RegExp(`^${RECAP_FIELD_LABELS.title}\\b`) }),
      createForm.getByLabel(new RegExp(`^${RECAP_FIELD_LABELS.playedAt}\\b`)),
      createForm.getByRole('textbox', { name: new RegExp(`^${RECAP_FIELD_LABELS.recap}\\b`) }),
    ]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }
    for (const forId of [createIds.title.controlId, createIds.playedAt.controlId, createIds.recap.controlId]) {
      const label = createForm.locator(`label[for="${forId}"]`);
      await expect(label).toBeVisible();
      const labelBox = await label.boundingBox();
      expect(labelBox).not.toBeNull();
      expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(320);
    }
    // Scope reflow to the form card — Sessions page chrome (header actions) is
    // outside this issue's label budget and may still overflow at 320px.
    expect(await createForm.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    const { form: editForm, ids } = await openEditForm(page);
    for (const forId of [ids.title.controlId, ids.playedAt.controlId, ids.recap.controlId]) {
      const label = editForm.locator(`label[for="${forId}"]`);
      await expect(label).toBeVisible();
      const labelBox = await label.boundingBox();
      expect(labelBox).not.toBeNull();
      expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(320);
    }
    expect(await editForm.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    const metrics = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      devicePixelRatio: window.devicePixelRatio,
    }));
    expect(metrics.viewportWidth).toBe(320);
    expect(metrics.devicePixelRatio).toBe(4);

    const editScan = await new AxeBuilder({ page }).include('.edit-recap-form').analyze();
    expect(editScan.violations).toEqual([]);
  });
});
