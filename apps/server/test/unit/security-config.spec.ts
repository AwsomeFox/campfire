import {
  resolveTrustProxy,
  resolveAllowInsecureHttp,
  resolveCookieSecure,
  isDevAuthActive,
  resolvePublicBase,
  hasPublicBase,
  joinPublicBase,
} from '../../src/common/security-config';

/**
 * Deploy/security env resolution (issues #165, #117, #119). Pure functions, so no
 * app bootstrap — just assert each env string maps to the value Express / the cookie
 * layer / the auth guard actually expect.
 */
describe('resolveTrustProxy (issue #165: env strings are not hop counts to Express)', () => {
  it('unset -> 1 (trust exactly one hop, the reference default)', () => {
    expect(resolveTrustProxy(undefined)).toBe(1);
  });

  it('an all-digits string is coerced to a NUMBER hop count (not read as an IP literal)', () => {
    // The bug: Express reads the string "2" as an IP allow-list, silently disabling trust.
    expect(resolveTrustProxy('2')).toBe(2);
    expect(typeof resolveTrustProxy('2')).toBe('number');
    expect(resolveTrustProxy('0')).toBe(0);
    expect(resolveTrustProxy(' 3 ')).toBe(3);
  });

  it('"true"/"false" (any case) coerce to booleans (not thrown-on IP literals)', () => {
    // The bug: the string "true" makes Express throw `invalid IP address: true` at boot.
    expect(resolveTrustProxy('true')).toBe(true);
    expect(resolveTrustProxy('false')).toBe(false);
    expect(resolveTrustProxy('TRUE')).toBe(true);
    expect(resolveTrustProxy('False')).toBe(false);
  });

  it('any other string passes through unchanged (an explicit IP/subnet allow-list)', () => {
    expect(resolveTrustProxy('127.0.0.1')).toBe('127.0.0.1');
    expect(resolveTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});

describe('resolveAllowInsecureHttp / resolveCookieSecure (issue #117: plain-HTTP LAN)', () => {
  const originalInsecure = process.env.ALLOW_INSECURE_HTTP;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalInsecure === undefined) delete process.env.ALLOW_INSECURE_HTTP;
    else process.env.ALLOW_INSECURE_HTTP = originalInsecure;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('ALLOW_INSECURE_HTTP unset -> not insecure', () => {
    delete process.env.ALLOW_INSECURE_HTTP;
    expect(resolveAllowInsecureHttp()).toBe(false);
  });

  it('ALLOW_INSECURE_HTTP=1 or =true -> insecure', () => {
    process.env.ALLOW_INSECURE_HTTP = '1';
    expect(resolveAllowInsecureHttp()).toBe(true);
    process.env.ALLOW_INSECURE_HTTP = 'true';
    expect(resolveAllowInsecureHttp()).toBe(true);
    process.env.ALLOW_INSECURE_HTTP = 'TRUE';
    expect(resolveAllowInsecureHttp()).toBe(true);
  });

  it('cookie secure defaults ON in production (unchanged default behavior)', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_INSECURE_HTTP;
    expect(resolveCookieSecure()).toBe(true);
  });

  it('production + ALLOW_INSECURE_HTTP=1 -> cookie NOT secure (so login works over plain HTTP)', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_INSECURE_HTTP = '1';
    expect(resolveCookieSecure()).toBe(false);
  });

  it('outside production the cookie is never Secure regardless of the flag', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_INSECURE_HTTP;
    expect(resolveCookieSecure()).toBe(false);
  });
});

describe('isDevAuthActive (issue #119: no prod interlock on DEV_AUTH)', () => {
  const originalDevAuth = process.env.DEV_AUTH;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalDevAuth === undefined) delete process.env.DEV_AUTH;
    else process.env.DEV_AUTH = originalDevAuth;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('DEV_AUTH=1 outside production -> active (e2e/dev path keeps working)', () => {
    process.env.DEV_AUTH = '1';
    process.env.NODE_ENV = 'test';
    expect(isDevAuthActive()).toBe(true);
  });

  it('DEV_AUTH=1 in production -> INACTIVE (hard interlock — a stray flag cannot open the server)', () => {
    process.env.DEV_AUTH = '1';
    process.env.NODE_ENV = 'production';
    expect(isDevAuthActive()).toBe(false);
  });

  it('DEV_AUTH unset -> inactive', () => {
    delete process.env.DEV_AUTH;
    process.env.NODE_ENV = 'development';
    expect(isDevAuthActive()).toBe(false);
  });
});

/**
 * Issue #798 — reverse-proxy subpath support.
 *
 * The server reads PUBLIC_BASE at runtime to prefix its browser-facing OIDC
 * redirects (`res.redirect('/')` -> `${PUBLIC_BASE}/`) and to scope the OIDC
 * flow cookie's `path` (the browser sees the URL under the prefix, so a cookie
 * scoped to `/api/v1/auth/oidc` would never be sent). The server's OWN routing
 * is unchanged — the reverse proxy strips the prefix before forwarding.
 *
 * These specs pin the canonicalization (so `campfire`, `/campfire/`, and a
 * pasted `https://host/campfire` all behave identically) and the join helper
 * (so redirects and cookie paths come out correctly shaped).
 */
describe('resolvePublicBase / joinPublicBase (issue #798: reverse-proxy subpath)', () => {
  const original = process.env.PUBLIC_BASE;

  afterEach(() => {
    if (original === undefined) delete process.env.PUBLIC_BASE;
    else process.env.PUBLIC_BASE = original;
  });

  describe('resolvePublicBase — canonicalization', () => {
    it('unset / empty / whitespace -> root (default deployment, unchanged behavior)', () => {
      expect(resolvePublicBase(undefined)).toBe('/');
      expect(resolvePublicBase('')).toBe('/');
      expect(resolvePublicBase('   ')).toBe('/');
    });

    it('bare root slash normalizes to root', () => {
      expect(resolvePublicBase('/')).toBe('/');
      expect(resolvePublicBase('//')).toBe('/');
    });

    it('adds a leading slash when missing', () => {
      expect(resolvePublicBase('campfire')).toBe('/campfire');
    });

    it('strips a trailing slash (except for bare root)', () => {
      expect(resolvePublicBase('/campfire/')).toBe('/campfire');
      expect(resolvePublicBase('/a/b/')).toBe('/a/b');
      // Bare root stays root.
      expect(resolvePublicBase('/')).toBe('/');
    });

    it('collapses accidental double slashes', () => {
      expect(resolvePublicBase('//campfire//')).toBe('/campfire');
      expect(resolvePublicBase('/a//b')).toBe('/a/b');
    });

    it('accepts a full URL and keeps only the pathname', () => {
      // PUBLIC_BASE is a path, never an origin — operator may paste the public URL.
      expect(resolvePublicBase('https://host/campfire')).toBe('/campfire');
      expect(resolvePublicBase('https://host/campfire/')).toBe('/campfire');
      expect(resolvePublicBase('http://host/a/b')).toBe('/a/b');
      expect(resolvePublicBase('https://host:8443/')).toBe('/');
    });

    it('treats a protocol-relative //path as a path, not a URL', () => {
      // Distinguishing //host/path (URL) from //path (typo'd path) is
      // unreliable; only an explicit http(s):// scheme is parsed as a URL.
      // The leading // is collapsed by the normalizer.
      expect(resolvePublicBase('//campfire//')).toBe('/campfire');
      expect(resolvePublicBase('//a//b')).toBe('/a/b');
    });

    it('reads process.env.PUBLIC_BASE when no argument is passed', () => {
      process.env.PUBLIC_BASE = '/campfire';
      expect(resolvePublicBase()).toBe('/campfire');
      expect(hasPublicBase()).toBe(true);
      process.env.PUBLIC_BASE = '/';
      expect(hasPublicBase()).toBe(false);
    });

    it('multi-segment prefixes are preserved', () => {
      expect(resolvePublicBase('/apps/campfire')).toBe('/apps/campfire');
    });
  });

  describe('joinPublicBase — path prefixing for redirects and cookie paths', () => {
    it('root deployment (PUBLIC_BASE=/) is the identity', () => {
      process.env.PUBLIC_BASE = '/';
      expect(joinPublicBase('/api/v1/auth/oidc')).toBe('/api/v1/auth/oidc');
      expect(joinPublicBase('/login/sso-error?x=1')).toBe('/login/sso-error?x=1');
      expect(joinPublicBase('/')).toBe('/');
    });

    it('prefixes a leading-slash path under a subpath', () => {
      process.env.PUBLIC_BASE = '/campfire';
      // The OIDC success redirect — bare / must become /campfire/.
      expect(joinPublicBase('/')).toBe('/campfire/');
      // The OIDC failure redirect.
      expect(joinPublicBase('/login/sso-error?category=x&ref=Y')).toBe(
        '/campfire/login/sso-error?category=x&ref=Y',
      );
      // The OIDC flow cookie path — must match what the browser sees.
      expect(joinPublicBase('/api/v1/auth/oidc')).toBe('/campfire/api/v1/auth/oidc');
    });

    it('multi-segment prefix works', () => {
      process.env.PUBLIC_BASE = '/apps/cf';
      expect(joinPublicBase('/api/v1/auth/oidc')).toBe('/apps/cf/api/v1/auth/oidc');
      expect(joinPublicBase('/')).toBe('/apps/cf/');
    });

    it('handles trailing-slash variants of PUBLIC_BASE identically', () => {
      // Operators write the prefix either way; the canonicalizer unifies them.
      process.env.PUBLIC_BASE = '/campfire/';
      expect(joinPublicBase('/api/v1/x')).toBe('/campfire/api/v1/x');
      expect(joinPublicBase('/')).toBe('/campfire/');
    });

    it('accepts a URL-form PUBLIC_BASE by dropping the host', () => {
      process.env.PUBLIC_BASE = 'https://host/campfire';
      expect(joinPublicBase('/api/v1/x')).toBe('/campfire/api/v1/x');
    });

    it('treats protocol-relative //campfire as a path (not a URL)', () => {
      process.env.PUBLIC_BASE = '//campfire';
      expect(joinPublicBase('/api/v1/x')).toBe('/campfire/api/v1/x');
    });
  });
});
