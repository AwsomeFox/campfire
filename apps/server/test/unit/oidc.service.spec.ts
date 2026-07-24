import { OidcService, slugifyUsername } from '../../src/modules/auth/oidc.service';
import type { SettingsService } from '../../src/modules/settings/settings.service';
import type { UsersService } from '../../src/modules/users/users.service';
import {
  getLatestOidcTestResult,
  hashFlowToken,
  putOidcTestPending,
  resetOidcTestPendingForTests,
} from '../../src/modules/auth/oidc-test-pending';
import { EMPTY_STORED_OIDC, resolveDiagnosticCandidate } from '../../src/modules/auth/oidc.config';
import { oidcConfigFingerprint } from '../../src/modules/auth/oidc-diagnostics';

describe('slugifyUsername', () => {
  it('normalizes and falls back for short/non-ascii inputs', () => {
    expect(slugifyUsername('Alice Example')).toBe('alice-example');
    expect(slugifyUsername('  Bob_1  ')).toBe('bob_1');
    expect(slugifyUsername('あ')).toBe('user-sso');
    expect(slugifyUsername('')).toBe('user-sso');
  });
});

describe('OidcService diagnostics (issue #848)', () => {
  const envKeys = [
    'OIDC_ISSUER',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URI',
    'OIDC_PROVIDER_NAME',
  ] as const;
  const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  let store: Map<string, unknown>;
  let settings: SettingsService;
  let service: OidcService;

  beforeEach(() => {
    for (const key of envKeys) saved[key] = process.env[key];
    for (const key of envKeys) delete process.env[key];
    resetOidcTestPendingForTests();
    store = new Map();
    settings = {
      getJson: jest.fn(async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null)),
      setJson: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    } as unknown as SettingsService;
    service = new OidcService({} as UsersService, settings);
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetOidcTestPendingForTests();
  });

  it('getAdminView coerces missing lastE2eTest to null and fingerprints effective config', async () => {
    store.set('oidcConfig', {
      ...EMPTY_STORED_OIDC,
      issuer: 'https://idp.example.com',
      clientId: 'campfire',
      clientSecret: 'secret-a',
      redirectUri: 'https://app/callback',
    });
    const view = await service.getAdminView();
    expect(view.enabled).toBe(true);
    expect(view.clientSecretSet).toBe(true);
    expect(view.lastE2eTest).toBeNull();
    expect(view.configFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(view)).not.toContain('secret-a');
  });

  it('updateStoredConfig rotates secret and changes fingerprint', async () => {
    store.set('oidcConfig', {
      ...EMPTY_STORED_OIDC,
      issuer: 'https://idp.example.com',
      clientId: 'campfire',
      clientSecret: 'secret-a',
    });
    const before = (await service.getAdminView()).configFingerprint;
    const after = await service.updateStoredConfig({ clientSecret: 'secret-b' });
    expect(after.configFingerprint).not.toBe(before);
    expect(after.clientSecretSet).toBe(true);
  });

  it('matchesActiveTestLogin requires both flow token and matching state', async () => {
    const flowToken = 'flow-token-1';
    const candidate = resolveDiagnosticCandidate({
      ...EMPTY_STORED_OIDC,
      issuer: 'https://idp.example.com',
      clientId: 'c',
      clientSecret: 's',
    });
    putOidcTestPending({
      flowTokenHash: hashFlowToken(flowToken),
      state: 'expected-state',
      codeVerifier: 'verifier',
      candidate,
      fingerprint: oidcConfigFingerprint(candidate),
      expiresAt: Date.now() + 60_000,
    });

    expect(await service.hasActiveTestLogin(flowToken)).toBe(true);
    expect(await service.matchesActiveTestLogin(flowToken, 'expected-state')).toBe(true);
    expect(await service.matchesActiveTestLogin(flowToken, 'other-state')).toBe(false);
    expect(await service.matchesActiveTestLogin(undefined, 'expected-state')).toBe(false);
    expect(await service.matchesActiveTestLogin(flowToken, undefined)).toBe(false);
  });

  it('completeTestLogin without pending does not clobber lastE2eTest', async () => {
    store.set('oidcLastE2eTest', {
      testedAt: '2026-01-01T00:00:00.000Z',
      fingerprint: 'abcd1234abcd1234',
      ok: true,
    });

    const result = await service.completeTestLogin('missing-token', { state: 'x' });
    expect(result.ok).toBe(false);
    expect(result.fingerprint).toBe('');
    expect(getLatestOidcTestResult()?.ok).toBe(false);
    // Durable verification signal must remain the prior success.
    expect(store.get('oidcLastE2eTest')).toEqual({
      testedAt: '2026-01-01T00:00:00.000Z',
      fingerprint: 'abcd1234abcd1234',
      ok: true,
    });
  });

  it('getPublicStatus and isEnabled reflect stored config', async () => {
    expect(await service.isEnabled()).toBe(false);
    expect(await service.getPublicStatus()).toEqual({ enabled: false, providerName: null });

    store.set('oidcConfig', {
      ...EMPTY_STORED_OIDC,
      issuer: 'https://idp.example.com',
      clientId: 'campfire',
      clientSecret: 'secret',
      providerName: 'Keycloak',
    });
    expect(await service.isEnabled()).toBe(true);
    expect(await service.getPublicStatus()).toEqual({ enabled: true, providerName: 'Keycloak' });
  });

  it('getTestLoginResult reads the ephemeral latest result', async () => {
    expect(await service.getTestLoginResult()).toBeNull();
    await service.completeTestLogin('missing', {});
    const latest = await service.getTestLoginResult();
    expect(latest?.kind).toBe('e2e');
    expect(latest?.ok).toBe(false);
  });
});
