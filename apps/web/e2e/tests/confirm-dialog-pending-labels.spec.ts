import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';

/**
 * Issue #793 — ConfirmDialog busy copy must keep the action (+ object) while a
 * slow request is in flight, expose aria-busy on the dialog, and announce the
 * pending label once via a polite live region.
 *
 * Covers each RunSessionPage confirm action with a held network request.
 */

// Seed once per worker — fixture ids are stable/idempotent, and calling seed()
// repeatedly in helpers can diverge if that contract ever changes.
const seeded = seed();

function encounterUrl(): string {
  return `/c/${seeded.campaignId}/encounters/${seeded.encounterId}`;
}

function endedEncounterUrl(): string {
  return `/c/${seeded.campaignId}/encounters/${seeded.endedEncounterId}`;
}

async function holdRoute(
  page: Page,
  urlGlob: string,
  method: string,
): Promise<{ release: () => void; started: Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  await page.route(urlGlob, async (route) => {
    if (route.request().method() !== method) return route.continue();
    signalStarted();
    await gate;
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: '{"message":"test hold"}',
    });
  });
  return { release, started };
}

async function expectBusyConfirm(
  page: Page,
  dialogName: string,
  pendingLabel: string,
  idleLabel: string,
  release: () => void,
  shouldClose = false,
) {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-busy', 'true');
  const busyConfirm = dialog.getByRole('button', { name: pendingLabel });
  await expect(busyConfirm).toBeDisabled();
  await expect(busyConfirm).toHaveAttribute('aria-busy', 'true');
  // One-shot polite announcement of the pending label (not a generic "Working…").
  await expect(dialog.locator('[role="status"][aria-live="polite"]')).toHaveText(pendingLabel);
  // Escape must not dismiss while busy.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  // Held request fails.
  release();
  if (shouldClose) {
    await expect(page.getByRole('dialog', { name: dialogName })).toBeHidden();
  } else {
    await expect(dialog).not.toHaveAttribute('aria-busy', 'true');
    const idleConfirm = dialog.getByRole('button', { name: idleLabel });
    await expect(idleConfirm).toBeEnabled();
    await expect(idleConfirm).toHaveText(idleLabel);
    // ConfirmDialog unmounts the polite status region when idle so screen readers
    // do not announce a blank live region (issue #793).
    await expect(dialog.locator('[role="status"][aria-live="polite"]')).toHaveCount(0);
  }
}

test.describe('confirm dialog pending labels — slow requests (issue #793)', () => {
  // Block the PWA service worker so a prior run can't serve a stale ConfirmDialog
  // that still overwrites busy labels with "Working…".
  test.use({ storageState: stateFor('dm'), serviceWorkers: 'block' });

  test.beforeEach(async ({ page }) => {
    await restoreSeedEncounter(page);
  });

  test('End encounter keeps Ending encounter… while /end is held', async ({ page }) => {
    try {
      const { release, started } = await holdRoute(page, `**/api/v1/encounters/${seeded.encounterId}/end`, 'POST');

      await page.goto(encounterUrl());
      await page.getByRole('button', { name: 'End', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'End this encounter?' });
      await dialog.getByRole('button', { name: 'End encounter' }).click();
      await started;
      await expectBusyConfirm(page, 'End this encounter?', 'Ending encounter…', 'End encounter', release, true);
    } finally {
      await restoreSeedEncounter();
    }
  });

  test('Delete encounter keeps Deleting encounter… while DELETE is held', async ({ page }) => {
    // Delete is only offered for ended/preparing encounters (not running).
    const { release, started } = await holdRoute(
      page,
      `**/api/v1/encounters/${seeded.endedEncounterId}`,
      'DELETE',
    );

    await page.goto(endedEncounterUrl());
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this encounter?' });
    await dialog.getByRole('button', { name: 'Delete encounter' }).click();
    await started;
    await expectBusyConfirm(
      page,
      'Delete this encounter?',
      'Deleting encounter…',
      'Delete encounter',
      release,
    );
  });

  test('Reopen encounter keeps Reopening encounter… while /reopen is held', async ({ page }) => {
    const { endedEncounterId } = seeded;
    const { release, started } = await holdRoute(
      page,
      `**/api/v1/encounters/${endedEncounterId}/reopen`,
      'POST',
    );

    await page.goto(endedEncounterUrl());
    await page.getByRole('button', { name: 'Reopen', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Reopen this encounter?' });
    await dialog.getByRole('button', { name: 'Reopen encounter' }).click();
    await started;
    await expectBusyConfirm(
      page,
      'Reopen this encounter?',
      'Reopening encounter…',
      'Reopen encounter',
      release,
      true,
    );
  });

  test('Remove combatant keeps Removing… while DELETE is held', async ({ page }) => {
    const { encounterId } = seeded;
    const { release, started } = await holdRoute(
      page,
      `**/api/v1/encounters/${encounterId}/combatants/**`,
      'DELETE',
    );

    await page.goto(encounterUrl());
    // The row control is an icon button whose accessible name is "✕"; title carries the label.
    await page.getByTitle('Remove combatant').first().click();
    const dialog = page.getByRole('dialog', { name: 'Remove this combatant from the encounter?' });
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await started;
    await expectBusyConfirm(
      page,
      'Remove this combatant from the encounter?',
      'Removing…',
      'Remove',
      release,
    );
  });
});
