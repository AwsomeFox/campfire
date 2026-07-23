/**
 * Issue #801 — first-run / cold-load bootstrap recovery.
 *
 * If GET /auth/status fails, Retry must refresh status AND /me before choosing
 * setup vs login. These specs pin the pure surface classifiers in
 * authBootstrapState.ts (loading / success / error, splash / recovery / …)
 * covering configured + fresh partial failure, recovery, repeated Retry, and
 * reload-equivalent loading.
 */
import { expect, test } from '@playwright/test';
import {
  authStatusPhase,
  authedBootstrapSurface,
  loginBootstrapSurface,
  retryAuthBootstrap,
  setupBootstrapSurface,
  type AuthStatusPhase,
} from '../../src/app/authBootstrapState';

function authed(input: {
  statusPhase: AuthStatusPhase;
  setupRequired?: boolean;
  meReady?: boolean;
  hasMe?: boolean;
  connectionError?: boolean;
}) {
  return authedBootstrapSurface({
    statusPhase: input.statusPhase,
    setupRequired: input.setupRequired ?? false,
    meReady: input.meReady ?? true,
    hasMe: input.hasMe ?? false,
    connectionError: input.connectionError ?? false,
  });
}

test.describe('auth status phase (issue #801)', () => {
  test('models loading / success / error', () => {
    expect(authStatusPhase({ loading: true, status: null, error: false })).toBe('loading');
    expect(authStatusPhase({ loading: false, status: { setupRequired: true }, error: false })).toBe('success');
    expect(authStatusPhase({ loading: false, status: null, error: true })).toBe('error');
    // Pre-#801 hole: settled with neither status nor error ⇒ unknown ⇒ error.
    expect(authStatusPhase({ loading: false, status: null, error: false })).toBe('error');
  });

  test('a failed refresh reports error even if a prior status is still cached', () => {
    expect(
      authStatusPhase({ loading: false, status: { setupRequired: false }, error: true }),
    ).toBe('error');
  });
});

test.describe('authed bootstrap surface — partial failure (issue #801)', () => {
  test('configured: status error + proven 401 (/me ok as loggedOut) stays on recovery, not login', () => {
    // The bug: Retry only re-fetched /me; a 401 cleared connectionError and
    // bounced to Sign in while setupRequired was still unknown.
    expect(
      authed({ statusPhase: 'error', setupRequired: false, connectionError: false, hasMe: false }),
    ).toBe('recovery');
  });

  test('fresh: status error + proven 401 stays on recovery, not setup or login', () => {
    expect(
      authed({ statusPhase: 'error', setupRequired: true, connectionError: false, hasMe: false }),
    ).toBe('recovery');
  });

  test('either bootstrap failure alone is enough for the one recovery surface', () => {
    expect(
      authed({ statusPhase: 'success', setupRequired: false, connectionError: true, hasMe: false }),
    ).toBe('recovery');
    expect(
      authed({ statusPhase: 'error', setupRequired: false, connectionError: true, hasMe: false }),
    ).toBe('recovery');
  });

  test('reload-equivalent: either promise still loading shows splash', () => {
    expect(authed({ statusPhase: 'loading', meReady: true })).toBe('splash');
    expect(authed({ statusPhase: 'success', meReady: false })).toBe('splash');
    expect(authed({ statusPhase: 'loading', meReady: false })).toBe('splash');
  });
});

test.describe('authed bootstrap surface — recovery outcomes (issue #801)', () => {
  test('recovery → status known fresh → setup', () => {
    expect(
      authed({ statusPhase: 'success', setupRequired: true, connectionError: false, hasMe: false }),
    ).toBe('setup');
  });

  test('recovery → status known configured → login (deep link preserved by caller)', () => {
    expect(
      authed({ statusPhase: 'success', setupRequired: false, connectionError: false, hasMe: false }),
    ).toBe('login');
  });

  test('repeated Retry while still failing stays on recovery', () => {
    // Simulate three Retry clicks that each leave status unknown /me unreachable.
    for (let i = 0; i < 3; i += 1) {
      expect(
        authed({ statusPhase: 'error', connectionError: true, hasMe: false }),
      ).toBe('recovery');
    }
  });

  test('stale offline identity is not blocked when status fails (#579 coexistence)', () => {
    expect(
      authed({
        statusPhase: 'error',
        setupRequired: false,
        hasMe: true,
        connectionError: true,
      }),
    ).toBe('authed');
  });

  test('live session reaches authed once both bootstraps succeed', () => {
    expect(
      authed({
        statusPhase: 'success',
        setupRequired: false,
        hasMe: true,
        connectionError: false,
      }),
    ).toBe('authed');
  });
});

test.describe('public auth screens (issue #801)', () => {
  test('login does not choose setup/form until status is known', () => {
    expect(loginBootstrapSurface({ statusPhase: 'loading', setupRequired: false })).toBe('loading');
    expect(loginBootstrapSurface({ statusPhase: 'error', setupRequired: true })).toBe('recovery');
    expect(loginBootstrapSurface({ statusPhase: 'error', setupRequired: false })).toBe('recovery');
    expect(loginBootstrapSurface({ statusPhase: 'success', setupRequired: true })).toBe('setup');
    expect(loginBootstrapSurface({ statusPhase: 'success', setupRequired: false })).toBe('form');
  });

  test('setup does not show the first-admin form until status is known', () => {
    expect(setupBootstrapSurface({ statusPhase: 'loading', setupRequired: true })).toBe('loading');
    expect(setupBootstrapSurface({ statusPhase: 'error', setupRequired: true })).toBe('recovery');
    expect(setupBootstrapSurface({ statusPhase: 'error', setupRequired: false })).toBe('recovery');
    expect(setupBootstrapSurface({ statusPhase: 'success', setupRequired: true })).toBe('form');
    expect(setupBootstrapSurface({ statusPhase: 'success', setupRequired: false })).toBe('redirect');
  });
});

test.describe('retryAuthBootstrap (issue #801)', () => {
  test('invokes status and /me refresh together', async () => {
    const calls: string[] = [];
    await retryAuthBootstrap(
      async () => {
        calls.push('status');
      },
      async () => {
        calls.push('me');
      },
    );
    expect(calls.sort()).toEqual(['me', 'status']);
  });

  test('swallows rejection from either bootstrap promise so Retry stays clickable', async () => {
    const calls: string[] = [];
    await retryAuthBootstrap(
      async () => {
        calls.push('status');
        throw new Error('status down');
      },
      async () => {
        calls.push('me');
      },
    );
    expect(calls.sort()).toEqual(['me', 'status']);
  });
});
