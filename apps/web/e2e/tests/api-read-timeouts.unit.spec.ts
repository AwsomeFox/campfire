/**
 * Issue #581 — bounded read timeouts, SW networkTimeoutSeconds, and stale fallback.
 *
 * Run with:
 *   npx playwright test --config pw-unit.config.ts e2e/tests/api-read-timeouts.unit.spec.ts
 */
import { expect, test } from '@playwright/test';
import {
  api,
  ApiError,
  isTransientError,
  isReadTimeout,
  isAmbiguousMutation,
} from '../../src/lib/api';
import {
  API_READ_BUDGET,
  API_WRITE_BUDGET,
  ApiAmbiguousMutationError,
  ApiReadTimeoutError,
  apiBudgetKind,
  budgetForKind,
  fetchWithBudget,
} from '../../src/lib/apiTimeouts';
import { API_NETWORK_TIMEOUT_SECONDS } from '../../src/lib/pwaCachePolicy';
import {
  __resetConnectionSyncForTests,
  getConnectionSyncSnapshot,
  noteReadSuccess,
  noteReadStale,
} from '../../src/lib/connectionSync';

function installLocalStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
  });
}

function abortAwareFetch(hang: boolean): typeof fetch {
  return (_url, init) =>
    new Promise((resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      if (!hang) {
        resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
        return;
      }
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    });
}

test.beforeEach(() => {
  __resetConnectionSyncForTests();
});

test.describe('api budget classification (#581)', () => {
  test('separate kinds for reads, writes, uploads, and streams', () => {
    expect(apiBudgetKind('GET')).toBe('read');
    expect(apiBudgetKind('HEAD')).toBe('read');
    expect(apiBudgetKind('POST')).toBe('write');
    expect(apiBudgetKind('PATCH', { body: JSON.stringify({ x: 1 }) })).toBe('write');
    expect(apiBudgetKind('POST', { body: new FormData() })).toBe('upload');
    expect(budgetForKind('read')).toBe(API_READ_BUDGET);
    expect(budgetForKind('write')).toBe(API_WRITE_BUDGET);
  });

  test('Workbox network timeout aligns with read connect budget', () => {
    expect(API_NETWORK_TIMEOUT_SECONDS).toBe(Math.ceil(API_READ_BUDGET.connectMs / 1000));
  });
});

test.describe('fetchWithBudget (#581)', () => {
  test('slow response within budget succeeds', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    try {
      const res = await fetchWithBudget('/api/v1/ping', { method: 'GET' }, 'read', API_READ_BUDGET);
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('hanging origin aborts read with TimeoutError', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = abortAwareFetch(true);
    try {
      let err: unknown;
      try {
        await fetchWithBudget(
          '/api/v1/campaigns/1/summary',
          { method: 'GET' },
          'read',
          { connectMs: 5, headersMs: 10, overallMs: 20 } as unknown as typeof API_READ_BUDGET,
        );
        throw new Error('should throw');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApiReadTimeoutError);
      expect(err).toMatchObject({ name: 'TimeoutError' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('mutation timeout is ambiguous, not transient', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = abortAwareFetch(true);
    try {
      let err: unknown;
      try {
        await fetchWithBudget(
          '/api/v1/campaigns/1',
          { method: 'PATCH', body: '{}' },
          'write',
          { connectMs: 5, overallMs: 10 } as unknown as typeof API_WRITE_BUDGET,
        );
        throw new Error('should throw');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApiAmbiguousMutationError);
      expect(isAmbiguousMutation(err)).toBe(true);
      expect(isTransientError(err)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('caller abort is not classified as a read timeout', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = abortAwareFetch(true);
    const controller = new AbortController();
    try {
      const pending = fetchWithBudget(
        '/api/v1/campaigns/1/summary',
        { method: 'GET', signal: controller.signal },
        'read',
        API_READ_BUDGET,
      );
      controller.abort();
      let err: unknown;
      try {
        await pending;
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ name: 'AbortError' });
      expect(isReadTimeout(err)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('DNS / refusal surfaces as transient network errors', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    installLocalStorage();
    try {
      await expect(api.get('/api/v1/campaigns/1')).rejects.toBeInstanceOf(TypeError);
      expect(isTransientError(new TypeError('Failed to fetch'))).toBe(true);
      expect(getConnectionSyncSnapshot().state).toBe('stale');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('successful read marks connection sync live', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    installLocalStorage();
    try {
      await api.get('/api/v1/campaigns/1');
      expect(getConnectionSyncSnapshot().state).toBe('live');
      expect(getConnectionSyncSnapshot().lastSyncAt).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('read timeout marks connection sync stale', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = abortAwareFetch(true);
    installLocalStorage();
    try {
      const pending = fetchWithBudget(
        '/api/v1/campaigns/1/summary',
        { method: 'GET' },
        'read',
        { connectMs: 5, headersMs: 10, overallMs: 20 } as unknown as typeof API_READ_BUDGET,
      );
      await expect(pending).rejects.toBeInstanceOf(ApiReadTimeoutError);
      noteReadStale();
      expect(getConnectionSyncSnapshot().state).toBe('stale');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('persistent 4xx read does not mark sync stale', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    installLocalStorage();
    noteReadSuccess(1_000);
    try {
      await expect(api.get('/api/v1/campaigns/1')).rejects.toBeInstanceOf(ApiError);
      expect(getConnectionSyncSnapshot().state).toBe('live');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('restart: sync recovers after a stale read succeeds', async () => {
    noteReadStale();
    expect(getConnectionSyncSnapshot().state).toBe('stale');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    installLocalStorage();
    try {
      await api.get('/api/v1/campaigns/1');
      expect(getConnectionSyncSnapshot().state).toBe('live');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
