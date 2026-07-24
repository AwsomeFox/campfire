/**
 * Issue #885 — provenance-safe session expiry signal + stream auth classification.
 *
 * Pure module tests (no browser / no seeded server). Run with:
 *   npx playwright test --config pw-unit.config.ts e2e/tests/session-expiry.unit.spec.ts
 */
import { expect, test } from '@playwright/test';
import { api, ApiError } from '../../src/lib/api';
import {
  __resetSessionExpiryForTests,
  classifyStreamConnectStatus,
  getSessionResumeEpoch,
  isAuthChallengePath,
  isSessionExpiredSignaled,
  noteUnauthorizedResponse,
  requestPathname,
  resetSessionExpiredSignal,
  signalSessionExpired,
  subscribeSessionExpired,
  subscribeSessionResume,
} from '../../src/lib/sessionExpiry';

test.beforeEach(() => {
  __resetSessionExpiryForTests();
});

test.describe('sessionExpiry classification (#885)', () => {
  test('auth challenge paths are ignored (login 401 is not session expiry)', () => {
    expect(isAuthChallengePath('/api/v1/auth/login')).toBe(true);
    expect(isAuthChallengePath('/api/v1/auth/token')).toBe(true);
    expect(isAuthChallengePath('/api/v1/auth/signup')).toBe(true);
    expect(isAuthChallengePath('/api/v1/auth/oidc/login')).toBe(true);
    expect(isAuthChallengePath('/api/v1/me')).toBe(false);
    expect(isAuthChallengePath('/api/v1/campaigns/1/encounters')).toBe(false);
  });

  test('requestPathname strips origin and query', () => {
    expect(requestPathname('/api/v1/me')).toBe('/api/v1/me');
    expect(requestPathname('https://example.test/api/v1/me?x=1')).toBe('/api/v1/me');
  });

  test('stream connect: 401 is expiry, 403 is campaign-forbidden, others retryable', () => {
    expect(classifyStreamConnectStatus(401)).toBe('session-expired');
    expect(classifyStreamConnectStatus(403)).toBe('forbidden');
    expect(classifyStreamConnectStatus(500)).toBe('other');
    expect(classifyStreamConnectStatus(200)).toBe('other');
  });
});

test.describe('sessionExpiry signal latch (#885)', () => {
  test('signal is idempotent and notifies subscribers once until reset', () => {
    let hits = 0;
    const unsub = subscribeSessionExpired(() => {
      hits += 1;
    });
    signalSessionExpired();
    signalSessionExpired();
    expect(hits).toBe(1);
    expect(isSessionExpiredSignaled()).toBe(true);

    const epochBefore = getSessionResumeEpoch();
    let resumes = 0;
    const unsubResume = subscribeSessionResume(() => {
      resumes += 1;
    });
    resetSessionExpiredSignal();
    expect(isSessionExpiredSignaled()).toBe(false);
    expect(getSessionResumeEpoch()).toBe(epochBefore + 1);
    expect(resumes).toBe(1);

    // Second reset is a no-op (already clear).
    resetSessionExpiredSignal();
    expect(getSessionResumeEpoch()).toBe(epochBefore + 1);
    expect(resumes).toBe(1);

    unsub();
    unsubResume();
  });

  test('noteUnauthorizedResponse ignores challenge paths and non-401 statuses', () => {
    noteUnauthorizedResponse('/api/v1/auth/login', 401);
    expect(isSessionExpiredSignaled()).toBe(false);

    noteUnauthorizedResponse('/api/v1/campaigns/1/attachments', 403);
    expect(isSessionExpiredSignaled()).toBe(false);

    noteUnauthorizedResponse('/api/v1/campaigns/1/attachments', 401);
    expect(isSessionExpiredSignaled()).toBe(true);
  });
});

test.describe('api client 401 fan-out (#885)', () => {
  test('API 401 on a protected path latches session expiry; login 401 does not', async () => {
    const originalFetch = globalThis.fetch;
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null },
    });

    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ message: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });

      await expect(api.get('/api/v1/campaigns/1')).rejects.toBeInstanceOf(ApiError);
      expect(isSessionExpiredSignaled()).toBe(true);

      __resetSessionExpiryForTests();
      await expect(api.post('/api/v1/auth/login', { username: 'x', password: 'y' })).rejects.toBeInstanceOf(
        ApiError,
      );
      expect(isSessionExpiredSignaled()).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  test('network failures do not latch session expiry (offline ≠ expired)', async () => {
    const originalFetch = globalThis.fetch;
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null },
    });

    try {
      globalThis.fetch = async () => {
        throw new TypeError('Failed to fetch');
      };
      await expect(api.get('/api/v1/campaigns/1')).rejects.toBeInstanceOf(TypeError);
      expect(isSessionExpiredSignaled()).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});
