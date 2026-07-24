import {
  EMPTY_STORED_OIDC,
  effectiveIssuer,
  effectiveRedirectUri,
  oidcEnvKeysSet,
  oidcSecretSet,
  resolveDiagnosticCandidate,
  resolveOidcConfig,
} from '../../src/modules/auth/oidc.config';

describe('oidc.config helpers', () => {
  const envKeys = [
    'OIDC_ISSUER',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URI',
    'OIDC_PROVIDER_NAME',
    'OIDC_ADMIN_GROUP',
    'OIDC_ALLOWED_GROUP',
    'OIDC_GROUPS_CLAIM',
    'OIDC_SCOPE',
    'APP_URL',
  ] as const;
  const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of envKeys) saved[key] = process.env[key];
    for (const key of envKeys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('resolveOidcConfig returns null until issuer/client/secret are all set', () => {
    expect(resolveOidcConfig(EMPTY_STORED_OIDC)).toBeNull();
    expect(
      resolveOidcConfig({
        ...EMPTY_STORED_OIDC,
        issuer: 'https://idp.example.com',
        clientId: 'c',
      }),
    ).toBeNull();

    const resolved = resolveOidcConfig({
      ...EMPTY_STORED_OIDC,
      issuer: 'https://idp.example.com',
      clientId: 'c',
      clientSecret: 's',
      providerName: 'Keycloak',
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.issuer).toBe('https://idp.example.com');
    expect(resolved!.groupsClaim).toBe('groups');
    expect(resolved!.scope).toBe('openid profile email');
    expect(resolved!.redirectUri).toContain('/api/v1/auth/oidc/callback');
  });

  it('env overrides stored values and is listed by oidcEnvKeysSet', () => {
    process.env.OIDC_ISSUER = 'https://env.example.com';
    process.env.OIDC_CLIENT_ID = 'env-client';
    process.env.OIDC_CLIENT_SECRET = 'env-secret';
    process.env.OIDC_PROVIDER_NAME = 'Env Provider';
    const stored = {
      ...EMPTY_STORED_OIDC,
      issuer: 'https://stored.example.com',
      clientId: 'stored-client',
      clientSecret: 'stored-secret',
      providerName: 'Stored',
    };
    const resolved = resolveOidcConfig(stored);
    expect(resolved!.issuer).toBe('https://env.example.com');
    expect(resolved!.clientId).toBe('env-client');
    expect(resolved!.providerName).toBe('Env Provider');
    expect(oidcEnvKeysSet()).toEqual(
      expect.arrayContaining(['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_PROVIDER_NAME']),
    );
    expect(oidcSecretSet(stored)).toBe(true);
    expect(effectiveIssuer(stored)).toBe('https://env.example.com');
  });

  it('effectiveRedirectUri falls back to APP_URL when unset', () => {
    process.env.APP_URL = 'https://camp.example.com';
    expect(effectiveRedirectUri(EMPTY_STORED_OIDC)).toBe(
      'https://camp.example.com/api/v1/auth/oidc/callback',
    );
  });

  it('resolveDiagnosticCandidate prefers draft over stored over defaults', () => {
    const stored = {
      ...EMPTY_STORED_OIDC,
      issuer: 'https://stored.example.com',
      clientId: 'stored-client',
      clientSecret: 'stored-secret',
    };
    const resolved = resolveDiagnosticCandidate(stored, {
      issuer: 'https://draft.example.com',
      clientSecret: '',
      adminGroup: 'admins',
    });
    expect(resolved.issuer).toBe('https://draft.example.com');
    expect(resolved.fieldSources.issuer).toBe('draft');
    expect(resolved.clientSecret).toBe('stored-secret');
    expect(resolved.fieldSources.clientSecret).toBe('stored');
    expect(resolved.adminGroup).toBe('admins');
    expect(resolved.groupsClaim).toBe('groups');
    expect(resolved.fieldSources.groupsClaim).toBe('default');
  });
});
