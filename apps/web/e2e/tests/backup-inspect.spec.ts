import { expect, test } from '@playwright/test';
import { stateFor } from './seed';

const MOCK_INSPECT = {
  app: 'campfire',
  kind: 'server-backup',
  formatVersion: 1,
  sourceFormatVersion: 1,
  appVersion: '0.14.2',
  schemaVersion: 57,
  createdAt: '2026-07-20T18:30:00.000Z',
  dbEntry: 'db/campfire.db',
  dbBytes: 2048000,
  uploadCount: 2,
  uploads: ['campaigns/1/portraits/hero.png', 'campaigns/1/maps/world.jpg'],
  aiKeySource: null,
  aiKeyIncluded: false,
  aiCredentialCount: null,
  attachmentChecksums: [
    { path: 'campaigns/1/portraits/hero.png', size: 1200, sha256: 'abc123' },
  ],
  reconciliation: {
    generation: 'gen-1',
    totalAttachments: 2,
    missing: 0,
    changed: 0,
    orphanCount: 0,
    clean: true,
    orphans: [],
  },
};

const MOCK_STATUS = {
  scheduleEnabled: true,
  intervalHours: 24,
  backupDir: '/data/backups',
  cadence: {
    lastAttemptAt: '2026-07-20T18:00:00.000Z',
    lastSuccessAt: '2026-07-20T18:00:00.000Z',
    nextRunAt: '2026-07-21T18:00:00.000Z',
    lastSize: 2048000,
    lastChecksum: 'deadbeef'.repeat(8),
    lastError: '',
  },
  disk: {
    freeBytes: 8 * 1024 * 1024 * 1024,
    totalBytes: 32 * 1024 * 1024 * 1024,
    reserveBytes: 512 * 1024 * 1024,
    estimatedNextBytes: 2048000,
    lowSpace: false,
  },
  retention: {
    policy: {
      keepCount: 14,
      keepDays: 30,
      maxTotalBytes: null,
      protectLastGood: true,
    },
    archiveCount: 1,
    totalBytes: 2048000,
    protectedLastGoodName: 'campfire-backup-2026-07-20T18-00-00-000Z.zip',
    pruneCount: 0,
    prunedBytes: 0,
    lastPruneAt: null,
    lastPruneError: '',
  },
  alerts: [],
  onDisk: [{ name: 'campfire-backup-2026-07-20T18-00-00-000Z.zip', bytes: 2048000, mtime: '2026-07-20T18:00:00.000Z' }],
};

test.describe('server backup workflow UI (issues #514 / #444)', () => {
  test.use({ storageState: stateFor('admin') });

  test('shows manifest metadata and upload listing after inspect', async ({ page }) => {
    await page.route('**/api/v1/backup/status', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_STATUS) });
    });
    await page.route('**/api/v1/backup/inspect', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_INSPECT) });
    });

    await page.goto('/admin/storage');

    const card = page.locator('.server-backup-workflow-card');
    await expect(card.getByRole('heading', { name: 'Whole-server backup & restore' })).toBeVisible();
    await expect(card.getByText(/Enabled — every 24h/)).toBeVisible();

    const fileInput = card.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'campfire-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('PK-fake-zip-for-ui-test'),
    });

    await expect(card.getByText('Selected: campfire-backup.zip')).toBeVisible();

    await card.getByRole('button', { name: 'Inspect (dry-run)' }).click();

    const region = card.getByRole('region', { name: 'Backup inspection results' });
    await expect(region).toBeVisible();
    await expect(region.getByText('0.14.2')).toBeVisible();
    await expect(region.getByText('57')).toBeVisible();
    await expect(region.getByText('Format version').locator('..').getByText('1')).toBeVisible();
    await expect(region.getByText(/Upload contents/)).toContainText('2');
    await expect(region.getByRole('listitem', { name: 'campaigns/1/portraits/hero.png' })).toBeVisible();
    await expect(region.getByRole('listitem', { name: 'campaigns/1/maps/world.jpg' })).toBeVisible();
    await expect(region.getByText(/Attachment checksums/)).toBeVisible();
    await expect(region.getByText(/fully reconciled/)).toBeVisible();
  });

  test('surfaces server validation errors from inspect', async ({ page }) => {
    await page.route('**/api/v1/backup/status', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_STATUS) });
    });
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
    const card = page.locator('.server-backup-workflow-card');
    await card.locator('input[type="file"]').setInputFiles({
      name: 'future.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('PK-fake'),
    });
    await card.getByRole('button', { name: 'Inspect (dry-run)' }).click();
    await expect(card.getByRole('alert')).toContainText(/format version 42/);
    await expect(card.getByRole('alert')).toContainText(/v99\.0\.0/);
  });
});
