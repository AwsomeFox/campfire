import { expect, test } from '@playwright/test';
import { stateFor } from './seed';

const MOCK_INSPECT = {
  app: 'campfire',
  kind: 'server-backup',
  formatVersion: 1,
  appVersion: '0.14.2',
  schemaVersion: 57,
  createdAt: '2026-07-20T18:30:00.000Z',
  dbEntry: 'db/campfire.db',
  dbBytes: 2048000,
  uploadCount: 2,
  uploads: ['campaigns/1/portraits/hero.png', 'campaigns/1/maps/world.jpg'],
};

test.describe('server backup inspection UI (issue #514)', () => {
  test.use({ storageState: stateFor('admin') });

  test('shows manifest metadata and upload listing after inspect', async ({ page }) => {
    await page.route('**/api/v1/backup/inspect', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_INSPECT) });
    });

    await page.goto('/admin/storage');

    const card = page.locator('.server-backup-inspect-card');
    await expect(card.getByRole('heading', { name: 'Server backup inspection' })).toBeVisible();

    const fileInput = card.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'campfire-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('PK-fake-zip-for-ui-test'),
    });

    await expect(card.getByText('Selected: campfire-backup.zip')).toBeVisible();

    await card.getByRole('button', { name: 'Inspect backup' }).click();

    const region = card.getByRole('region', { name: 'Backup inspection results' });
    await expect(region).toBeVisible();
    await expect(region.getByText('0.14.2')).toBeVisible();
    await expect(region.getByText('57')).toBeVisible();
    await expect(region.getByText('Format version').locator('..').getByText('1')).toBeVisible();
    await expect(region.getByText(/Upload contents/)).toContainText('2');
    await expect(region.getByText('campaigns/1/portraits/hero.png')).toBeVisible();
    await expect(region.getByText('campaigns/1/maps/world.jpg')).toBeVisible();
  });

  test('surfaces server validation errors from inspect', async ({ page }) => {
    await page.route('**/api/v1/backup/inspect', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          message:
            'Invalid backup archive — manifest format version 42 is newer than this server supports (format version 1). Upgrade Campfire to at least v99.0.0 before restoring this archive.',
        }),
      });
    });

    await page.goto('/admin/storage');
    const card = page.locator('.server-backup-inspect-card');
    await card.locator('input[type="file"]').setInputFiles({
      name: 'future.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('PK-fake'),
    });
    await card.getByRole('button', { name: 'Inspect backup' }).click();
    await expect(card.getByRole('alert')).toContainText(/format version 42/);
    await expect(card.getByRole('alert')).toContainText(/v99\.0\.0/);
  });
});
