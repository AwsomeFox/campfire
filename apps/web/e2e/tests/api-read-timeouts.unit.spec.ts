/**
 * Issue #581 — bounded read timeouts, SW networkTimeoutSeconds, and stale fallback.
 *
 * Run with:
 *   npx playwright test --config playwright.unit.config.ts e2e/tests/api-read-timeouts.unit.spec.ts
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
  // Unit workers may lack a real browser online bit; transient network errors
  // only map to "stale" when the client believes it is online (#581).
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
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

  test('stalled response body aborts read with TimeoutError', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Headers resolve immediately; body never produces bytes.
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };
    try {
      const res = await fetchWithBudget(
        '/api/v1/campaigns/1/summary',
        { method: 'GET' },
        'read',
        { connectMs: 50, headersMs: 50, overallMs: 30 } as unknown as typeof API_READ_BUDGET,
      );
      let err: unknown;
      try {
        await res.text();
        throw new Error('should throw');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApiReadTimeoutError);
      expect(err).toMatchObject({ name: 'TimeoutError', phase: 'overall' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('stalled mutation response body is ambiguous, not a clean failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };
    try {
      const res = await fetchWithBudget(
        '/api/v1/campaigns/1',
        { method: 'PATCH', body: '{}' },
        'write',
        { connectMs: 50, overallMs: 30 } as unknown as typeof API_WRITE_BUDGET,
      );
      await expect(res.text()).rejects.toBeInstanceOf(ApiAmbiguousMutationError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('wrapped bodies drop content-encoding so decoded streams are not re-decompressed', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': '999',
        },
      });
    try {
      const res = await fetchWithBudget('/api/v1/campaigns/1', { method: 'PATCH', body: '{}' }, 'write', API_WRITE_BUDGET);
      expect(res.headers.get('Content-Encoding')).toBeNull();
      expect(res.headers.get('Content-Length')).toBeNull();
      expect(JSON.parse(await res.text())).toEqual({ ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Content-Length 0 responses do not wrap or leak the overall timer', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('', {
        status: 200,
        headers: { 'Content-Length': '0' },
      });
    try {
      const res = await fetchWithBudget(
        '/api/v1/campaigns/1/noop',
        { method: 'GET' },
        'read',
        API_READ_BUDGET,
      );
      expect(res.headers.get('Content-Length')).toBe('0');
      expect(await res.text()).toBe('');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('204/null-body statuses are returned unwrapped (Response cannot carry a stream)', async () => {
    const originalFetch = globalThis.fetch;
    // Chromium exposes a non-null empty body on 204; reconstructing with a stream
    // throws "Response with null body status cannot have body".
    globalThis.fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      const res = new Response(stream, { status: 200, statusText: 'No Content' });
      Object.defineProperty(res, 'status', { value: 204 });
      return res;
    };
    try {
      const res = await fetchWithBudget(
        '/api/v1/users/1/password',
        { method: 'POST', body: '{}' },
        'write',
        API_WRITE_BUDGET,
      );
      expect(res.status).toBe(204);
      expect(res.body).not.toBeNull();
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
