import {
  resolveTrustProxy,
  resolveAllowInsecureHttp,
  resolveCookieSecure,
  isDevAuthActive,
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
