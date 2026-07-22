import { expect, test, type Page } from '@playwright/test';
import { stateFor } from './seed';

/**
 * Issue #703 — storage cleanup is destructive, so a preview must be BOUND before
 * the Clean up button can fire, and at execute time the bound preview is
 * re-validated against a fresh dry-run. A stale or absent preview must never
 * drive the eventual delete set.
 *
 * These tests mock /admin/storage + /admin/storage/cleanup so the orphan state
 * is deterministic (the seeded backend may or may not have real orphans). They
 * pin the safety UX the issue requires:
 *   - no-preview  -> Clean up disabled
 *   - preview     -> binds; Clean up enabled
 *   - stale/changed-set -> confirm dialog shows drift, Delete disabled
 *   - cancel      -> no destructive call fired
 *   - partial I/O failure -> outcome banner shows the un-removed items
 *   - success     -> outcome banner, binding cleared
 */

const STATS = (rowsWithoutFile: number, filesWithoutRow: number, orphanBytes: number) => ({
  totalBytes: 1000,
  fileCount: 5,
  diskBytes: 1000,
  campaigns: [],
  orphans: { rowsWithoutFile, filesWithoutRow, orphanBytes },
});

const CLEAN_DRY = (rowsWithoutFile: number, filesWithoutRow: number) => ({
  dryRun: true,
  rowsWithoutFile,
  filesWithoutRow,
  rowsDeleted: 0,
  filesDeleted: 0,
  bytesReclaimed: 0,
});

/** Intercept the storage stats + cleanup endpoints with deterministic data. */
async function mockStorage(
  page: Page,
  opts: {
    stats?: ReturnType<typeof STATS>;
    /** Dry-run response(s); each call to the preview endpoint pops the next entry. */
    dryRuns?: ReturnType<typeof CLEAN_DRY>[];
    /** Real (non-dry) cleanup response. */
    execute?: object;
  } = {},
): Promise<{ executeCalls: string[] }> {
  const statsBody = opts.stats ?? STATS(2, 1, 500);
  const dryQueue = [...(opts.dryRuns ?? [])];
  const executeCalls: string[] = [];
  await page.route('**/api/v1/admin/storage', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(statsBody) });
  });
  await page.route('**/api/v1/admin/storage/cleanup*', async (route) => {
    const url = route.request().url();
    const isDry = url.includes('dryRun=true');
    if (isDry) {
      const next = dryQueue.shift() ?? CLEAN_DRY(statsBody.orphans.rowsWithoutFile, statsBody.orphans.filesWithoutRow);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(next) });
      return;
    }
    executeCalls.push(url);
    const exec =
      opts.execute ?? {
        dryRun: false,
        rowsWithoutFile: statsBody.orphans.rowsWithoutFile,
        filesWithoutRow: statsBody.orphans.filesWithoutRow,
        rowsDeleted: statsBody.orphans.rowsWithoutFile,
        filesDeleted: statsBody.orphans.filesWithoutRow,
        bytesReclaimed: statsBody.orphans.orphanBytes,
      };
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(exec) });
  });
  return { executeCalls };
}

test.describe('issue #703: storage cleanup binds a verified preview', () => {
  test.use({ storageState: stateFor('admin') });

  test('no preview: Clean up is disabled and cannot fire', async ({ page }) => {
    await mockStorage(page);
    await page.goto('/admin/storage');

    // Card heading distinguishes the storage card from the page <h1>.
    await expect(page.getByRole('heading', { level: 2, name: 'Storage' })).toBeVisible();
    await expect(page.getByTestId('storage-preview-none')).toBeVisible();

    const clean = page.getByRole('button', { name: 'Clean up' });
    await expect(clean).toBeDisabled();

    // A disabled button click must not open a confirm dialog.
    await clean.click({ force: true }).catch(() => undefined);
    await expect(page.getByRole('dialog', { name: 'Clean up storage orphans?' })).toHaveCount(0);
  });

  test('a successful preview enables Clean up and binds the counts', async ({ page }) => {
    await mockStorage(page);
    await page.goto('/admin/storage');

    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByTestId('storage-preview-bound')).toContainText('2 row(s)');
    await expect(page.getByTestId('storage-preview-bound')).toContainText('1 file(s)');

    await expect(page.getByRole('button', { name: 'Clean up' })).toBeEnabled();
  });

  test('cancel: confirm dialog closes without firing the destructive call', async ({ page }) => {
    const { executeCalls } = await mockStorage(page);
    await page.goto('/admin/storage');

    await page.getByRole('button', { name: 'Preview' }).click();
    await page.getByRole('button', { name: 'Clean up' }).click();

    const dialog = page.getByRole('dialog', { name: 'Clean up storage orphans?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/2 attachment row/)).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(executeCalls).toHaveLength(0);
  });

  test('changed set since preview: confirm shows drift and Delete stays disabled', async ({ page }) => {
    // Preview reports 2 rows / 1 file; but at execute time the set grew to 5 rows.
    await mockStorage(page, {
      dryRuns: [CLEAN_DRY(2, 1), CLEAN_DRY(5, 1)],
    });
    await page.goto('/admin/storage');

    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByTestId('storage-preview-bound')).toContainText('2 row(s)');

    await page.getByRole('button', { name: 'Clean up' }).click();
    const dialog = page.getByRole('dialog', { name: 'Clean up storage orphans?' });
    await expect(dialog).toBeVisible();

    // The dialog must surface the FRESH counts, not the bound ones.
    await expect(dialog.getByText(/5 attachment row/)).toBeVisible();
    await expect(dialog.getByTestId('storage-confirm-drift')).toBeVisible();

    // Drift -> Delete disabled so the admin can't act on a stale preview.
    const del = dialog.getByRole('button', { name: 'Delete orphans' });
    await expect(del).toBeDisabled();
  });

  test('partial I/O failure: outcome banner reports un-removed items and is downloadable', async ({ page }) => {
    await mockStorage(page, {
      execute: {
        dryRun: false,
        rowsWithoutFile: 2,
        filesWithoutRow: 1,
        rowsDeleted: 2,
        filesDeleted: 0, // couldn't unlink the orphan file
        bytesReclaimed: 0,
      },
    });
    await page.goto('/admin/storage');

    await page.getByRole('button', { name: 'Preview' }).click();
    await page.getByRole('button', { name: 'Clean up' }).click();

    const dialog = page.getByRole('dialog', { name: 'Clean up storage orphans?' });
    await dialog.getByRole('button', { name: 'Delete orphans' }).click();
    await expect(dialog).toHaveCount(0);

    const banner = page.getByTestId('storage-cleanup-outcome');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/Partial cleanup/);
    await expect(banner).toContainText(/1 file\(s\)/);
    await expect(banner.getByRole('button', { name: 'Download result' })).toBeVisible();
  });

  test('success: outcome banner shows reclaimed bytes and the binding is cleared', async ({ page }) => {
    const { executeCalls } = await mockStorage(page);
    await page.goto('/admin/storage');

    await page.getByRole('button', { name: 'Preview' }).click();
    await page.getByRole('button', { name: 'Clean up' }).click();

    const dialog = page.getByRole('dialog', { name: 'Clean up storage orphans?' });
    await dialog.getByRole('button', { name: 'Delete orphans' }).click();
    await expect(dialog).toHaveCount(0);

    await expect(page.getByTestId('storage-cleanup-outcome')).toContainText(/Cleaned:/);
    expect(executeCalls.length).toBeGreaterThanOrEqual(1);

    // A successful execution consumes the binding — next run must re-preview.
    await expect(page.getByTestId('storage-preview-none')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clean up' })).toBeDisabled();
  });
});
