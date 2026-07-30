import { expect, test, type Locator, type Page } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';

const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Press a global shortcut until its dialog actually opens.
 *
 * A key press is a ONE-SHOT event: if it lands while no `keydown` listener is
 * registered it is swallowed for good, and the following `toBeVisible()` then burns its
 * entire timeout waiting for a dialog nothing ever asked to open. This spec had two such
 * windows, which is why it failed on `main` itself rather than only under load:
 *
 *  1. `page.goto` resolves on the document `load` event, which for this SPA fires before
 *     React mounts and before KeyboardCommandProvider's effect adds its listener.
 *  2. That effect lists `overlay` in its dependencies, so it tears the listener down and
 *     re-adds it on EVERY open and close — leaving a fresh gap after each Escape.
 *
 * Retrying the press is safe and idempotent: each shortcut only sets its overlay, and the
 * handler returns early (`if (overlay) return`) once one is open, so a duplicate press is
 * a no-op. This awaits the real condition rather than sleeping, and costs one extra press
 * only when the first genuinely lands in a gap.
 */
async function openViaShortcut(page: Page, chord: string, dialogName: string): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(async () => {
    await page.keyboard.press(chord);
    await expect(dialog).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
  return dialog;
}

/** Close an open command dialog and wait for it to leave the DOM before the next press. */
async function closeDialog(page: Page, dialog: Locator): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

/**
 * Wait until the keyboard command layer has mounted. `aria-keyshortcuts` is rendered from
 * the provider's own context (see `useKeyboardCommandHint`), so a control carrying it
 * cannot exist before that provider mounts. This is a cheap barrier, not a guarantee —
 * the DOM commits before React flushes passive effects, so `openViaShortcut` above still
 * owns the actual "is it listening yet" problem.
 */
async function waitForCommandLayer(page: Page): Promise<void> {
  await expect(page.locator('[aria-keyshortcuts]').first()).toBeAttached();
}

test.describe('keyboard command layer (issue #672)', () => {
  test.use({ storageState: stateFor('dm') });

  test('opens global search, quick capture, and shortcut help from anywhere in campaign', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/quests`);
    await waitForCommandLayer(page);

    const search = await openViaShortcut(page, `${MODIFIER}+KeyK`, 'Search campaign');
    await closeDialog(page, search);

    const quickCapture = await openViaShortcut(page, `${MODIFIER}+Shift+KeyN`, 'Quick capture');
    await closeDialog(page, quickCapture);

    const help = await openViaShortcut(page, 'Shift+Slash', 'Keyboard shortcuts');
    await expect(page.getByRole('button', { name: 'Change' }).first()).toBeVisible();
    await closeDialog(page, help);
  });

  test('does not fire shortcuts while typing in an editor', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/search`);
    await waitForCommandLayer(page);

    const search = page.getByRole('textbox', { name: 'Search this campaign' });
    // SearchPage renders this input with `autoFocus`, so the editor guard under test is
    // already active on arrival.
    await expect(search).toBeFocused();

    // Prove the shortcut DOES work on this page while focus is outside the editor.
    // Without this the assertion at the end is vacuous: if the command layer simply were
    // not listening, no dialog would open either and the test would pass for entirely the
    // wrong reason — which is how the sibling test above hid a real race for so long.
    await search.blur();
    await expect(search).not.toBeFocused();
    const palette = await openViaShortcut(page, `${MODIFIER}+KeyK`, 'Search campaign');
    await closeDialog(page, palette);

    // The actual assertion: with focus back in the editor, the same chord must not fire.
    await search.focus();
    await page.keyboard.press(`${MODIFIER}+KeyK`);
    await expect(page.getByRole('dialog', { name: 'Search campaign' })).toHaveCount(0);
  });

  test('does not fire guarded next turn while a confirm dialog is open', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    await restoreSeedEncounter(page);
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

    await page.getByRole('button', { name: 'End', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press(`${MODIFIER}+Period`);
    // Confirm dialog still open — next turn must not have dismissed it.
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('exposes aria-keyshortcuts on next turn when running', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    await restoreSeedEncounter(page);
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

    const nextTurn = page.getByTestId('encounter-header-next-turn');
    await expect(nextTurn).toBeVisible();
    await expect(nextTurn).toHaveAttribute('aria-keyshortcuts', /.+/);
  });
});
