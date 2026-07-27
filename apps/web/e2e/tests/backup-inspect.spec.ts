import { expect, test } from '@playwright/test';
import { stateFor } from './seed';

const MOCK_INSPECT = {
  app: 'campfire',
  kind: 'server-backup',
  formatVersion: 3,
  appVersion: '0.14.2',
  schemaVersion: 57,
  createdAt: '2026-07-20T18:30:00.000Z',
  dbEntry: 'db/campfire.db',
  dbBytes: 2048000,
  uploadCount: 2,
  uploads: ['campaigns/1/portraits/hero.png', 'campaigns/1/maps/world.jpg'],
  aiKeySource: 'keyfile',
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
    await expect(region.getByText('Format version').locator('..').getByText('3')).toBeVisible();
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
            'Invalid backup archive — manifest format version 42 is unsupported; this pre-1.0 server accepts format version 3 only.',
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
    await expect(card.getByRole('alert')).toContainText(/accepts format version 3 only/i);
  });

  test('discloses bounded memory fallback and reports successful streamed download state', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    });
    await page.route('**/api/v1/backup/status', (route) => route.fulfill({ status: 200, json: MOCK_STATUS }));
    let releaseDownload!: () => void;
    const downloadReady = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    await page.route('**/api/v1/backup', async (route) => {
      await downloadReady;
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="server.zip"',
          'Content-Length': '4',
        },
        body: 'zip!',
      });
    });

    await page.goto('/admin/storage');
    const card = page.locator('.server-backup-workflow-card');
    await expect(card.getByText(/buffer.*archive in browser memory/i)).toBeVisible();
    await card.getByRole('button', { name: 'Create & download backup' }).click();
    await expect(card.getByRole('status')).toContainText(/Preparing backup/i);
    releaseDownload();
    await expect(card.getByText(/Downloaded server\.zip/)).toBeVisible();
    await expect(card.getByText(/buffered the archive in memory/i)).toBeVisible();
  });

  test('rejects oversized fallback downloads with recovery copy', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    });
    await page.route('**/api/v1/backup/status', (route) => route.fulfill({ status: 200, json: MOCK_STATUS }));
    await page.route('**/api/v1/backup', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/zip', 'Content-Length': String(513 * 1024 * 1024) },
        body: '',
      }),
    );

    await page.goto('/admin/storage');
    const card = page.locator('.server-backup-workflow-card');
    await card.getByRole('button', { name: 'Create & download backup' }).click();
    await expect(card.getByRole('alert')).toContainText(/only supports backups up to 512 MiB/i);
    await expect(card.getByRole('alert')).toContainText(/File System Access support or download with curl/i);
    await expect(card.getByRole('alert').getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('uses the bounded blob fallback when the response has no readable body', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await nativeFetch(input, init);
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith('/api/v1/backup')) return response;
        return new Proxy(response, {
          get(target, property) {
            if (property === 'body') return null;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
    });
    await page.route('**/api/v1/backup/status', (route) => route.fulfill({ status: 200, json: MOCK_STATUS }));
    await page.route('**/api/v1/backup', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="blob.zip"', 'Content-Length': '4' }, body: 'zip!' }));
    await page.goto('/admin/storage');
    const card = page.locator('.server-backup-workflow-card');
    await card.getByRole('button', { name: 'Create & download backup' }).click();
    await expect(card.getByText(/Downloaded blob\.zip/)).toBeVisible();
  });

  test('rejects an unknown-length response when no readable body is available', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await nativeFetch(input, init);
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith('/api/v1/backup')) return response;
        const headers = new Headers(response.headers);
        headers.delete('Content-Length');
        return new Proxy(response, {
          get(target, property) {
            if (property === 'body') return null;
            if (property === 'headers') return headers;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
    });
    await page.route('**/api/v1/backup/status', (route) => route.fulfill({ status: 200, json: MOCK_STATUS }));
    await page.route('**/api/v1/backup', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="unknown.zip"' },
      body: 'zip!',
    }));
    await page.goto('/admin/storage');
    const card = page.locator('.server-backup-workflow-card');
    await card.getByRole('button', { name: 'Create & download backup' }).click();
    await expect(card.getByRole('alert')).toContainText(/known size up to 512 MiB/i);
  });

  test('localizes generic network failures while preserving download-specific errors', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    });
    await page.route('**/api/v1/backup/status', (route) => route.fulfill({ status: 200, json: MOCK_STATUS }));
    await page.route('**/api/v1/backup', (route) => route.abort('failed'));

    await page.goto('/admin/storage');
    const card = page.locator('.server-backup-workflow-card');
    await card.getByRole('button', { name: 'Create & download backup' }).click();
    await expect(card.getByRole('alert')).toContainText("Couldn't load data.");
  });

  test('shows neutral and unknown-length streaming progress before and after the first chunk', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith('/api/v1/backup')) return nativeFetch(input, init);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            window.setTimeout(() => controller.enqueue(new TextEncoder().encode('zip')), 250);
            window.setTimeout(() => controller.close(), 800);
          },
        });
        return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'application/zip' } }));
      };
    });
    await page.route('**/api/v1/backup/status', (route) => route.fulfill({ status: 200, json: MOCK_STATUS }));

    await page.goto('/admin/storage');
    const card = page.locator('.server-backup-workflow-card');
    await card.getByRole('button', { name: 'Create & download backup' }).click();
    const progress = card.getByRole('progressbar', { name: 'Backup download progress' });
    await expect(progress).toBeVisible();
    await expect(card.getByRole('status')).toContainText('Streaming backup…');
    await expect(progress).not.toHaveAttribute('value');
    await expect(card.getByRole('status')).toContainText(/Streaming backup — 3 B received/i);
  });

  test('shows known-length streaming progress after the first chunk', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith('/api/v1/backup')) return nativeFetch(input, init);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            window.setTimeout(() => controller.enqueue(new TextEncoder().encode('zip')), 250);
            window.setTimeout(() => controller.close(), 800);
          },
        });
        return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'application/zip', 'Content-Length': '3' } }));
      };
    });
    await page.route('**/api/v1/backup/status', (route) => route.fulfill({ status: 200, json: MOCK_STATUS }));

    await page.goto('/admin/storage');
    const card = page.locator('.server-backup-workflow-card');
    await card.getByRole('button', { name: 'Create & download backup' }).click();
    const progress = card.getByRole('progressbar', { name: 'Backup download progress' });
    await expect(card.getByRole('status')).toContainText('Streaming backup…');
    await expect(progress).toHaveAttribute('value', '3');
    await expect(progress).toHaveAttribute('max', '3');
    await expect(card.getByRole('status')).toContainText(/Streaming backup — 3 B of 3 B/i);
  });

  test('writes to a File System Access destination without browser buffering', async ({ page }) => {
    await page.addInitScript(() => {
      (window as Window & { __backupWrites?: number; __pickerReceiverIsWindow?: boolean }).__backupWrites = 0;
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: function (this: Window) {
          const testWindow = window as Window & { __backupWrites?: number; __pickerReceiverIsWindow?: boolean };
          testWindow.__pickerReceiverIsWindow = this === window;
          if (this !== window) throw new TypeError('Illegal invocation');
          return Promise.resolve({
            name: 'chosen-backup.zip',
            createWritable: async () => ({
              write: async () => {
                testWindow.__backupWrites! += 1;
              },
              close: async () => undefined,
              abort: async () => undefined,
            }),
          });
        },
      });
    });
    await page.route('**/api/v1/backup/status', (route) => route.fulfill({ status: 200, json: MOCK_STATUS }));
    await page.route('**/api/v1/backup', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="streamed.zip"' },
        body: 'zip!',
      }),
    );

    await page.goto('/admin/storage');
    const card = page.locator('.server-backup-workflow-card');
    await card.getByRole('button', { name: 'Create & download backup' }).click();
    await expect(card.getByText(/Saved chosen-backup\.zip .*directly to the selected file/i)).toBeVisible();
    await expect.poll(() =>
      page.evaluate(() =>
        (window as Window & { __pickerReceiverIsWindow?: boolean }).__pickerReceiverIsWindow),
    ).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as Window & { __backupWrites?: number }).__backupWrites)).toBeGreaterThan(0);
  });

  test('treats a cancelled destination picker as a cancelled download without starting a request', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: async () => {
          throw new DOMException('The user aborted a request.', 'AbortError');
        },
      });
    });
    await page.route('**/api/v1/backup/status', (route) => route.fulfill({ status: 200, json: MOCK_STATUS }));
    let downloadRequests = 0;
    await page.route('**/api/v1/backup', (route) => {
      downloadRequests += 1;
      return route.fulfill({ status: 200, body: 'should-not-be-requested' });
    });

    await page.goto('/admin/storage');
    const card = page.locator('.server-backup-workflow-card');
    await card.getByRole('button', { name: 'Create & download backup' }).click();
    await expect(card.getByText('Download cancelled.')).toBeVisible();
    await expect.poll(() => downloadRequests).toBe(0);
  });

  test('cancels the response stream when the selected destination fails', async ({ page }) => {
    await page.addInitScript(() => {
      (window as Window & { __backupResponseCancelled?: boolean }).__backupResponseCancelled = false;
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: async () => ({
          name: 'full-disk.zip',
          createWritable: async () => ({
            write: async () => { throw new Error('disk full'); },
            close: async () => undefined,
            abort: async () => undefined,
          }),
        }),
      });
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith('/api/v1/backup')) return nativeFetch(input, init);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('zip'));
          },
          cancel() {
            (window as Window & { __backupResponseCancelled?: boolean }).__backupResponseCancelled = true;
          },
        });
        return Promise.resolve(new Response(stream, {
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="server.zip"',
          },
        }));
      };
    });
    await page.route('**/api/v1/backup/status', (route) => route.fulfill({ status: 200, json: MOCK_STATUS }));

    await page.goto('/admin/storage');
    const card = page.locator('.server-backup-workflow-card');
    await card.getByRole('button', { name: 'Create & download backup' }).click();
    await expect(card.getByRole('alert')).toContainText("Couldn't load data.");
    await expect.poll(() =>
      page.evaluate(() => (window as Window & { __backupResponseCancelled?: boolean }).__backupResponseCancelled),
    ).toBe(true);
  });

  test('confirms cancellation and announces the aborted request', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    });
    await page.route('**/api/v1/backup/status', (route) => route.fulfill({ status: 200, json: MOCK_STATUS }));
    await page.route('**/api/v1/backup', () => new Promise(() => undefined));
    await page.goto('/admin/storage');
    const card = page.locator('.server-backup-workflow-card');
    await card.getByRole('button', { name: 'Create & download backup' }).click();
    await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await card.getByRole('button', { name: 'Cancel' }).click();
    await expect(card.getByText('Download cancelled.')).toBeVisible();
  });
});
