import { expect, test } from '@playwright/test';
import { api } from '../../src/lib/api';

test('API requests preserve Headers instances and add JSON and dev-auth headers', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let captured: RequestInit | undefined;

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string) {
        if (key === 'cf.devRole') return 'dm';
        if (key === 'cf.devUser') return 'header-test';
        return null;
      },
    },
  });
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return new Response(null, { status: 204 });
  };

  try {
    await api.post('/api/v1/header-probe', { ok: true }, {
      headers: new Headers([['X-Probe', 'preserved']]),
    });

    const headers = new Headers(captured?.headers);
    expect(headers.get('x-probe')).toBe('preserved');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-dev-role')).toBe('dm');
    expect(headers.get('x-dev-user')).toBe('header-test');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
