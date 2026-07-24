import {
  getLatestOidcTestResult,
  hashFlowToken,
  peekOidcTestPending,
  putOidcTestPending,
  resetOidcTestPendingForTests,
  setLatestOidcTestResult,
  takeOidcTestPending,
  type OidcTestPending,
} from '../../src/modules/auth/oidc-test-pending';
import { EMPTY_STORED_OIDC, resolveDiagnosticCandidate } from '../../src/modules/auth/oidc.config';
import type { OidcTestResult } from '@campfire/schema';

function makePending(overrides: Partial<OidcTestPending> & { flowToken: string }): OidcTestPending {
  const candidate = resolveDiagnosticCandidate({
    ...EMPTY_STORED_OIDC,
    issuer: 'https://idp.example.com',
    clientId: 'campfire',
    clientSecret: 'secret-value',
  });
  return {
    flowTokenHash: hashFlowToken(overrides.flowToken),
    state: overrides.state ?? 'state-a',
    codeVerifier: overrides.codeVerifier ?? 'verifier',
    candidate,
    fingerprint: overrides.fingerprint ?? 'abcd1234abcd1234',
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
  };
}

const sampleResult = {
  ok: true,
  kind: 'e2e',
  issuer: 'https://idp.example.com',
  message: 'ok',
  authorizationEndpoint: null,
  tokenEndpoint: null,
  testedAt: new Date().toISOString(),
  fingerprint: 'abcd1234abcd1234',
  fieldSources: {
    issuer: 'stored',
    clientId: 'stored',
    clientSecret: 'stored',
    redirectUri: 'default',
    adminGroup: 'default',
    allowedGroup: 'default',
    groupsClaim: 'default',
    scope: 'default',
  },
  checks: {
    discovery: { status: 'pass', message: 'ok' },
    redirectClient: { status: 'pass', message: 'ok' },
    tokenExchange: { status: 'pass', message: 'ok' },
    requiredClaims: { status: 'pass', message: 'ok' },
    groupPolicy: { status: 'pass', message: 'ok' },
  },
} as OidcTestResult;

describe('oidc test pending store (issue #848)', () => {
  beforeEach(() => {
    resetOidcTestPendingForTests();
  });

  it('stores concurrent pendings keyed by distinct flow tokens', () => {
    const a = makePending({ flowToken: 'token-a', state: 'state-a' });
    const b = makePending({ flowToken: 'token-b', state: 'state-b' });
    putOidcTestPending(a);
    putOidcTestPending(b);

    expect(peekOidcTestPending('token-a')?.state).toBe('state-a');
    expect(peekOidcTestPending('token-b')?.state).toBe('state-b');
  });

  it('take removes only the matching token and leaves others intact', () => {
    putOidcTestPending(makePending({ flowToken: 'token-a', state: 'state-a' }));
    putOidcTestPending(makePending({ flowToken: 'token-b', state: 'state-b' }));

    const taken = takeOidcTestPending('token-a');
    expect(taken?.state).toBe('state-a');
    expect(peekOidcTestPending('token-a')).toBeNull();
    expect(peekOidcTestPending('token-b')?.state).toBe('state-b');
    // Second take is a miss — does not disturb the other pending.
    expect(takeOidcTestPending('token-a')).toBeNull();
  });

  it('expires pending entries', () => {
    putOidcTestPending(
      makePending({ flowToken: 'token-a', expiresAt: Date.now() - 1 }),
    );
    expect(peekOidcTestPending('token-a')).toBeNull();
    expect(takeOidcTestPending('token-a')).toBeNull();
  });

  it('tracks latest non-secret result for admin UI polling', () => {
    expect(getLatestOidcTestResult()).toBeNull();
    setLatestOidcTestResult(sampleResult);
    expect(getLatestOidcTestResult()?.ok).toBe(true);
    setLatestOidcTestResult(null);
    expect(getLatestOidcTestResult()).toBeNull();
  });
});
