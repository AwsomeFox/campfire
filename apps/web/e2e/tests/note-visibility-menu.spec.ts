import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { NOTE_VISIBILITY_GROUP_LABEL, noteVisibilityOptionLabel } from '../../src/components/noteVisibilityA11y';
import { seed, stateFor } from './seed';

async function createPrivateNote(page: Page, campaignId: number, body: string) {
  const res = await page.request.post(`/api/v1/campaigns/${campaignId}/notes`, {
    data: { body, visibility: 'private' },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: number };
}

async function openNotesPage(page: Page, campaignId: number) {
  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes(`/api/v1/campaigns/${campaignId}/notes`) &&
        res.request().method() === 'GET' &&
        res.ok(),
    ),
    page.goto(`/c/${campaignId}/notes`),
  ]);
}

test.describe('note visibility menu (issue #689)', () => {
  test.use({ storageState: stateFor('dm') });

  test('menu selects DM share without confirmation; party share confirms and can undo', async ({
    page,
  }) => {
    const { campaignId } = seed();
    const body = `Visibility menu ${Date.now()}`;
    const note = await createPrivateNote(page, campaignId, body);

    await openNotesPage(page, campaignId);
    const card = page.getByTestId(`note-card-${note.id}`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText(body)).toBeVisible();

    const menu = page.getByTestId(`note-visibility-menu-${note.id}`);
    const trigger = menu.getByRole('button', { name: /Note visibility:/ });
    await trigger.click();

    const listbox = page.getByRole('listbox', { name: new RegExp(NOTE_VISIBILITY_GROUP_LABEL) });
    await expect(listbox).toBeVisible();
    await listbox.getByRole('option', { name: noteVisibilityOptionLabel('dm_shared') }).click();

    await expect.poll(async () => {
      const res = await page.request.get(`/api/v1/notes/${note.id}`);
      return res.ok() ? ((await res.json()) as { visibility: string }).visibility : '';
    }).toBe('dm_shared');
    await expect(trigger).toContainText('Shared with DM');

    await trigger.click();
    await listbox.getByRole('option', { name: noteVisibilityOptionLabel('party_shared') }).click();
    const dialog = page.getByRole('dialog', { name: 'Share with party?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Currently: Shared with DM.')).toBeVisible();
    await expect(dialog.getByText('This will change to: Shared with party.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Share with party' }).click();

    await expect.poll(async () => {
      const res = await page.request.get(`/api/v1/notes/${note.id}`);
      return res.ok() ? ((await res.json()) as { visibility: string }).visibility : '';
    }).toBe('party_shared');

    const undo = page.getByTestId('undo-snackbar');
    await expect(undo).toBeVisible();
    await undo.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => {
      const res = await page.request.get(`/api/v1/notes/${note.id}`);
      return res.ok() ? ((await res.json()) as { visibility: string }).visibility : '';
    }).toBe('dm_shared');
  });

  test('keyboard navigation commits a visibility change', async ({ page }) => {
    const { campaignId } = seed();
    const body = `Visibility keyboard ${Date.now()}`;
    const note = await createPrivateNote(page, campaignId, body);

    await openNotesPage(page, campaignId);
    await expect(page.getByTestId(`note-card-${note.id}`)).toBeVisible({ timeout: 15_000 });
    const menu = page.getByTestId(`note-visibility-menu-${note.id}`);
    const trigger = menu.getByRole('button', { name: /Note visibility:/ });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');

    const listbox = page.getByRole('listbox', { name: new RegExp(NOTE_VISIBILITY_GROUP_LABEL) });
    await expect(listbox).toBeVisible();
    const dmOption = listbox.getByRole('option', { name: noteVisibilityOptionLabel('dm_shared') });
    await dmOption.focus();
    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const res = await page.request.get(`/api/v1/notes/${note.id}`);
      return res.ok() ? ((await res.json()) as { visibility: string }).visibility : '';
    }).toBe('dm_shared');
  });

  test('failed visibility update rolls back and keeps prior scope', async ({ page }) => {
    const { campaignId } = seed();
    const body = `Visibility failure ${Date.now()}`;
    const note = await createPrivateNote(page, campaignId, body);

    await page.route(`**/api/v1/notes/${note.id}`, async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ status: 500, body: 'nope' });
        return;
      }
      await route.continue();
    });

    await openNotesPage(page, campaignId);
    await expect(page.getByTestId(`note-card-${note.id}`)).toBeVisible({ timeout: 15_000 });
    const menu = page.getByTestId(`note-visibility-menu-${note.id}`);
    const trigger = menu.getByRole('button', { name: /Note visibility:/ });
    await trigger.click();
    await page
      .getByRole('listbox', { name: new RegExp(NOTE_VISIBILITY_GROUP_LABEL) })
      .getByRole('option', { name: noteVisibilityOptionLabel('dm_shared') })
      .click();

    await expect(
      page.locator('#main-content').getByText("Couldn't update visibility."),
    ).toBeVisible();
    await expect(trigger).toContainText('Private');

    const res = await page.request.get(`/api/v1/notes/${note.id}`);
    expect(res.ok()).toBe(true);
    expect(((await res.json()) as { visibility: string }).visibility).toBe('private');
  });

  test('visibility menu is axe-clean', async ({ page }) => {
    const { campaignId } = seed();
    const body = `Visibility a11y ${Date.now()}`;
    const note = await createPrivateNote(page, campaignId, body);

    await openNotesPage(page, campaignId);
    await expect(page.getByTestId(`note-card-${note.id}`)).toBeVisible({ timeout: 15_000 });
    const menu = page.getByTestId(`note-visibility-menu-${note.id}`);
    await menu.getByRole('button', { name: /Note visibility:/ }).click();

    const scan = await new AxeBuilder({ page })
      .include(`[data-testid="note-visibility-menu-${note.id}"]`)
      .disableRules(['color-contrast'])
      .analyze();
    expect(scan.violations).toEqual([]);
  });
});
