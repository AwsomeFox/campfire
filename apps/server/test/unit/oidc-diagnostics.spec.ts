import {
  canonicalIssuer,
  evaluateGroupPolicy,
  groupsFromClaims,
  isAbsoluteHttpUrl,
  issuersMatch,
  oidcConfigFingerprint,
} from '../../src/modules/auth/oidc-diagnostics';
import { resolveDiagnosticCandidate, EMPTY_STORED_OIDC } from '../../src/modules/auth/oidc.config';

describe('oidc diagnostics helpers (issue #848)', () => {
  describe('canonical issuer equality', () => {
    it('strips trailing slashes and matches', () => {
      expect(canonicalIssuer('https://idp.example.com/')).toBe('https://idp.example.com');
      expect(issuersMatch('https://idp.example.com/', 'https://idp.example.com')).toBe(true);
      expect(issuersMatch('https://idp.example.com', 'https://other.example.com')).toBe(false);
    });
  });

  describe('endpoint URL validation', () => {
    it('accepts absolute http(s) URLs only', () => {
      expect(isAbsoluteHttpUrl('https://idp.example.com/authorize')).toBe(true);
      expect(isAbsoluteHttpUrl('http://127.0.0.1:9/token')).toBe(true);
      expect(isAbsoluteHttpUrl('/relative')).toBe(false);
      expect(isAbsoluteHttpUrl('not a url')).toBe(false);
    });
  });

  describe('fingerprint', () => {
    it('is stable for equivalent config and never embeds the secret', () => {
      const a = oidcConfigFingerprint({
        issuer: 'https://idp.example.com/',
        clientId: 'campfire',
        clientSecret: 'super-secret-value',
        redirectUri: 'https://app/callback',
        adminGroup: 'admins',
        allowedGroup: '',
        groupsClaim: '',
        scope: '',
      });
      const b = oidcConfigFingerprint({
        issuer: 'https://idp.example.com',
        clientId: 'campfire',
        clientSecret: 'different-secret',
        redirectUri: 'https://app/callback',
        adminGroup: 'admins',
        allowedGroup: '',
        groupsClaim: 'groups',
        scope: 'openid profile email',
      });
      // Secret presence matches, defaults applied — same fingerprint; secret text absent.
      expect(a).toBe(b);
      expect(a).not.toContain('super-secret');
      expect(a).toMatch(/^[a-f0-9]{16}$/);

      const noSecret = oidcConfigFingerprint({
        issuer: 'https://idp.example.com',
        clientId: 'campfire',
        clientSecret: '',
        redirectUri: 'https://app/callback',
        adminGroup: 'admins',
        allowedGroup: '',
        groupsClaim: 'groups',
        scope: 'openid profile email',
      });
      expect(noSecret).not.toBe(a);
    });
  });

  describe('group policy evaluation', () => {
    it('allows anyone when no allowed group is set', () => {
      expect(evaluateGroupPolicy([], null, null).status).toBe('pass');
    });

    it('requires allowed or admin group membership', () => {
      expect(evaluateGroupPolicy(['other'], 'admins', 'users').status).toBe('fail');
      expect(evaluateGroupPolicy(['users'], 'admins', 'users').status).toBe('pass');
      expect(evaluateGroupPolicy(['admins'], 'admins', 'users').status).toBe('pass');
    });

    it('reads groups from claims', () => {
      expect(groupsFromClaims({ groups: ['a', 'b'] }, 'groups')).toEqual(['a', 'b']);
      expect(groupsFromClaims({ roles: 'single' }, 'roles')).toEqual(['single']);
      expect(groupsFromClaims({}, 'groups')).toEqual([]);
    });
  });

  describe('resolveDiagnosticCandidate sources', () => {
    const envKeys = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const;
    const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

    beforeEach(() => {
      for (const key of envKeys) saved[key] = process.env[key];
    });

    afterEach(() => {
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it('labels draft vs stored vs environment without exposing secrets', () => {
      const stored = {
        ...EMPTY_STORED_OIDC,
        issuer: 'https://stored.example.com',
        clientId: 'stored-client',
        clientSecret: 'stored-secret',
      };
      process.env.OIDC_ISSUER = 'https://env.example.com';
      delete process.env.OIDC_CLIENT_ID;
      delete process.env.OIDC_CLIENT_SECRET;

      const resolved = resolveDiagnosticCandidate(stored, {
        clientId: 'draft-client',
        clientSecret: 'draft-secret',
      });

      expect(resolved.issuer).toBe('https://env.example.com');
      expect(resolved.fieldSources.issuer).toBe('environment');
      expect(resolved.fieldSources.clientId).toBe('draft');
      expect(resolved.fieldSources.clientSecret).toBe('draft');
      expect(JSON.stringify(resolved.fieldSources)).not.toContain('secret');
      expect(resolved.clientSecret).toBe('draft-secret');
    });

    it('reuses stored secret when draft secret is blank', () => {
      delete process.env.OIDC_ISSUER;
      delete process.env.OIDC_CLIENT_ID;
      delete process.env.OIDC_CLIENT_SECRET;
      const stored = {
        ...EMPTY_STORED_OIDC,
        issuer: 'https://stored.example.com',
        clientId: 'stored-client',
        clientSecret: 'stored-secret',
      };
      const resolved = resolveDiagnosticCandidate(stored, { clientSecret: '' });
      expect(resolved.clientSecret).toBe('stored-secret');
      expect(resolved.fieldSources.clientSecret).toBe('stored');
    });
  });
});
