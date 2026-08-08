/**
 * Regression coverage for `vitest.config.ts`'s `define` block (review finding
 * on PR #2033 / issue #2025): a component test that mounts anything reading a
 * build-time global (`__APP_VERSION__`, injected by `vite.config.ts`'s own
 * `define` for the real app build) must not throw a bare `ReferenceError`
 * under this separate Vitest config. `MetricsCard` reads `__APP_VERSION__`
 * directly in JSX (`Client: v{__APP_VERSION__}`), so mounting it is a direct
 * regression test for the config gap, not just for `MetricsCard` itself.
 */
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { test, expect, vi, afterEach } from 'vitest';
import type { AdminMetrics } from '@campfire/schema';
import { version as pkgVersion } from '../../package.json';
import '../../src/i18n';

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(async (_path: string) => ({}) as unknown),
}));

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: getMock,
    },
  };
});

import { MetricsCard } from '../../src/features/admin/MetricsCard';

afterEach(() => cleanup());

function fixtureMetrics(): AdminMetrics {
  return {
    version: '9.9.9', // deliberately distinct from __APP_VERSION__ so the two chips can't be confused
    now: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    uptimeSeconds: 60,
    activeSessions: 1,
    counts: {
      users: 1,
      campaigns: 1,
      characters: 0,
      npcs: 0,
      locations: 0,
      quests: 0,
      sessions: 0,
      notes: 0,
      encounters: 0,
      attachments: 0,
      apiTokens: 0,
      rulePacks: 0,
      ruleEntries: 0,
    },
    database: {
      sizeBytes: 1024,
      pageCount: 1,
      pageSize: 1024,
      dbFileBytes: 1024,
      walBytes: null,
      shmBytes: null,
    },
    storage: {
      freeBytes: null,
      totalBytes: null,
      availableBytes: null,
      uploadsBytes: null,
      backupsBytes: null,
      tempBytes: null,
      status: 'ok',
      quickCheck: { status: 'ok', checkedAt: null },
    },
    recentActivity: [],
  };
}

test('MetricsCard renders __APP_VERSION__ from the client build without throwing', async () => {
  getMock.mockResolvedValueOnce(fixtureMetrics());

  render(<MetricsCard />);

  const clientVersion = await waitFor(() => screen.getByTestId('client-version'));
  expect(clientVersion.textContent).toBe(`Client: v${pkgVersion}`);

  // The server-reported version is a distinct chip — confirms the two aren't
  // accidentally reading the same value.
  expect(screen.getByTestId('server-version').textContent).toBe('Server: v9.9.9');
});
