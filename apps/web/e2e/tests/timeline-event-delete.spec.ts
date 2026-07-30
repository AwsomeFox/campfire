import { expect, test, request, type APIRequestContext } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #693 — confirmable, recoverable timeline event deletion.
 * Covers: cancel, confirm, failure, Undo/restore, keyboard.
 */

async function dmApi(baseURL: string): Promise<APIRequestContext> {
  return request.newContext({ baseURL, storageState: stateFor('dm') });
}

async function createTimelineEvent(baseURL: string, title: string): Promise<number> {
  const { campaignId } = seed();
  const ctx = await dmApi(baseURL);
  const res = await ctx.post(`/api/v1/campaigns/${campaignId}/timeline`, {
    data: { title, body: 'Fixture event', inWorldDate: 'Year 1', hidden: false },
  });
  if (!res.ok()) throw new Error(`create timeline event -> ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  await ctx.dispose();
  return body.id as number;
}

async function restoreTimelineEvent(baseURL: string, id: number) {
  const ctx = await dmApi(baseURL);
  const res = await ctx.post(`/api/v1/timeline/${id}/restore`);
  await ctx.dispose();
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`restore timeline event ${id} -> ${res.status()}: ${await res.text()}`);
  }
}

async function openDeleteDialog(page: import('@playwright/test').Page, eventId: number, title: string) {
  const { campaignId } = seed();
  await page.goto(`/c/${campaignId}/timeline`);
  const event = page.locator(`[data-entity-type="timeline"][data-entity-id="${eventId}"]`);
  await event.getByRole('button', { name: 'Edit' }).click();
  const deleteBtn = event.getByRole('button', { name: 'Delete' });
  await deleteBtn.click();
  const dialog = page.getByRole('dialog', { name: `Delete ${title}?` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Trash');
  return { event, deleteBtn, dialog };
}

test.describe('Timeline event deletion (issue #693)', () => {
  test.use({ storageState: stateFor('dm') });

  test('cancel closes the dialog and restores focus to Delete', async ({ page, baseURL }) => {
    const title = `693 Cancel ${Date.now()}`;
    const eventId = await createTimelineEvent(baseURL!, title);
    try {
      const { deleteBtn, dialog } = await openDeleteDialog(page, eventId, title);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(deleteBtn).toBeFocused();
      await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
    } finally {
      await restoreTimelineEvent(baseURL!, eventId);
    }
  });

  test('confirm soft-deletes, shows Undo, and restore brings the event back', async ({ page, baseURL }) => {
    const title = `693 Confirm ${Date.now()}`;
    const eventId = await createTimelineEvent(baseURL!, title);
    try {
      const { event, dialog } = await openDeleteDialog(page, eventId, title);

      const [deleteRequest] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().endsWith(`/api/v1/timeline/${eventId}`) && res.request().method() === 'DELETE',
        ),
        dialog.getByRole('button', { name: 'Delete event' }).click(),
      ]);
      expect(deleteRequest.status()).toBe(200);
      await expect(dialog).toHaveCount(0);
      await expect(event).toBeHidden();

      const snackbar = page.locator('[role="status"]', { hasText: `${title} moved to the Trash.` });
      await expect(snackbar).toBeVisible();

      const [restoreRequest] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().endsWith(`/api/v1/timeline/${eventId}/restore`) && res.request().method() === 'POST',
        ),
        snackbar.getByRole('button', { name: 'Undo' }).click(),
      ]);
      expect(restoreRequest.status()).toBe(201);
      await expect(event).toBeVisible();
    } finally {
      await restoreTimelineEvent(baseURL!, eventId);
    }
  });

  test('server failure keeps the dialog open with the confirm button re-enabled', async ({ page, baseURL }) => {
    const title = `693 Failure ${Date.now()}`;
    const eventId = await createTimelineEvent(baseURL!, title);
    try {
      const { dialog } = await openDeleteDialog(page, eventId, title);
      const confirm = dialog.getByRole('button', { name: 'Delete event' });

      await page.route(`**/api/v1/timeline/${eventId}`, (route) => {
        if (route.request().method() === 'DELETE') {
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'Internal server error' } }),
          });
        }
        return route.continue();
      });

      await confirm.click();
      await expect(dialog).toBeVisible();
      await expect(confirm).toBeEnabled();
      await expect(page.getByText("Couldn't delete the event.")).toBeVisible();

      await page.unroute(`**/api/v1/timeline/${eventId}`);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    } finally {
      await restoreTimelineEvent(baseURL!, eventId);
    }
  });

  test('keyboard path opens, confirms, and Escape cancels before delete', async ({ page, baseURL }) => {
    const title = `693 Keyboard ${Date.now()}`;
    const eventId = await createTimelineEvent(baseURL!, title);
    try {
      const { campaignId } = seed();
      await page.goto(`/c/${campaignId}/timeline`);
      const event = page.locator(`[data-entity-type="timeline"][data-entity-id="${eventId}"]`);
      await event.getByRole('button', { name: 'Edit' }).click();

      const deleteBtn = event.getByRole('button', { name: 'Delete' });
      await deleteBtn.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: `Delete ${title}?` });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(deleteBtn).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Tab');
      const confirm = dialog.getByRole('button', { name: 'Delete event' });
      await expect(confirm).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('[role="status"]', { hasText: `${title} moved to the Trash.` })).toBeVisible();

      const snackbar = page.locator('[role="status"]', { hasText: `${title} moved to the Trash.` });
      await snackbar.getByRole('button', { name: 'Undo' }).click();
      await expect(event).toBeVisible();
    } finally {
      await restoreTimelineEvent(baseURL!, eventId);
    }
  });

  // Issue #1783 — ConfirmDialog now composes the shared Dialog primitive.
  // The other tests in this file already prove initial focus (Cancel),
  // Escape-to-close, and focus-restore-to-trigger; this one proves the FULL
  // Tab-trap cycle (forward wrap AND Shift+Tab wrap), which none of the
  // existing ConfirmDialog coverage exercised end-to-end.
  test('focus trap cycles within the dialog in both directions', async ({ page, baseURL }) => {
    const title = `1783 FocusTrap ${Date.now()}`;
    const eventId = await createTimelineEvent(baseURL!, title);
    try {
      const { dialog } = await openDeleteDialog(page, eventId, title);
      const cancel = dialog.getByRole('button', { name: 'Cancel' });
      const confirm = dialog.getByRole('button', { name: 'Delete event' });

      await expect(cancel).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(confirm).toBeFocused();
      // Forward wrap: Tab past the last focusable returns to the first.
      await page.keyboard.press('Tab');
      await expect(cancel).toBeFocused();
      // Backward wrap: Shift+Tab before the first focusable goes to the last.
      await page.keyboard.press('Shift+Tab');
      await expect(confirm).toBeFocused();

      await cancel.click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await restoreTimelineEvent(baseURL!, eventId);
    }
  });
});
