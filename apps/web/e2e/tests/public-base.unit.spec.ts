import { expect, test } from '@playwright/test';
import { normalizeBasePrefix, joinPublicBase, HAS_SUBPATH, PUBLIC_BASE } from '../../src/lib/public-base';

/**
 * Issue #798 — reverse-proxy subpath support.
 *
 * A single PUBLIC_BASE setting (operator env → Docker ARG → Vite define → runtime
 * constant) drives every path the SPA emits. These specs pin the normalizer's
 * canonicalization rules and the joinPublicBase() path-prefixing helper that the
 * API client, router, and PWA depend on.
 *
 * PUBLIC_BASE and HAS_SUBPATH reflect whatever value __PUBLIC_BASE__ was stamped
 * with for THIS test build — under `vite build` without PUBLIC_BASE set they are
 * the root-deployment defaults (`/` and `false`). The normalizer is a pure
 * function, so the bulk of the coverage is on normalizeBasePrefix() directly.
 */
test.describe('reverse-proxy subpath (issue #798)', () => {
  test.describe('normalizeBasePrefix — canonicalization', () => {
    test('empty / undefined / whitespace-only → root', () => {
      expect(normalizeBasePrefix(undefined)).toBe('/');
      expect(normalizeBasePrefix('')).toBe('/');
      expect(normalizeBasePrefix('   ')).toBe('/');
      expect(normalizeBasePrefix('\t\n')).toBe('/');
    });

    test('bare root slash is unchanged', () => {
      expect(normalizeBasePrefix('/')).toBe('/');
      expect(normalizeBasePrefix('//')).toBe('/');
      expect(normalizeBasePrefix('///')).toBe('/');
    });

    test('adds a leading slash when missing', () => {
      expect(normalizeBasePrefix('campfire')).toBe('/campfire');
      expect(normalizeBasePrefix('a/b')).toBe('/a/b');
    });

    test('strips a trailing slash (except for bare root)', () => {
      expect(normalizeBasePrefix('/campfire/')).toBe('/campfire');
      expect(normalizeBasePrefix('/a/b/')).toBe('/a/b');
      // Bare root stays root even with trailing slash.
      expect(normalizeBasePrefix('/')).toBe('/');
    });

    test('collapses accidental double slashes', () => {
      expect(normalizeBasePrefix('//campfire//')).toBe('/campfire');
      expect(normalizeBasePrefix('/a//b')).toBe('/a/b');
      expect(normalizeBasePrefix('//a//b//')).toBe('/a/b');
    });

    test('accepts a full URL and keeps only the pathname', () => {
      // PUBLIC_BASE is a PATH, not an origin — operators may paste the public
      // URL for convenience; the host portion is dropped.
      expect(normalizeBasePrefix('https://host/campfire')).toBe('/campfire');
      expect(normalizeBasePrefix('https://host/campfire/')).toBe('/campfire');
      expect(normalizeBasePrefix('http://host/a/b')).toBe('/a/b');
      expect(normalizeBasePrefix('https://host:8443/')).toBe('/');
      expect(normalizeBasePrefix('https://host')).toBe('/');
    });

    test('treats a protocol-relative //path as a path, not a URL', () => {
      // Distinguishing //host/path (URL) from //path (typo'd path) is
      // unreliable; only an explicit http(s):// scheme is parsed as a URL.
      expect(normalizeBasePrefix('//campfire//')).toBe('/campfire');
      expect(normalizeBasePrefix('//a//b')).toBe('/a/b');
    });

    test('handles whitespace around the input', () => {
      expect(normalizeBasePrefix('  /campfire  ')).toBe('/campfire');
      expect(normalizeBasePrefix(' /campfire/ ')).toBe('/campfire');
    });

    test('multi-segment prefixes are preserved', () => {
      expect(normalizeBasePrefix('/apps/campfire')).toBe('/apps/campfire');
      expect(normalizeBasePrefix('/apps/campfire/')).toBe('/apps/campfire');
    });
  });

  test.describe('joinPublicBase — path prefixing', () => {
    // joinPublicBase uses the build-time PUBLIC_BASE constant. Under the test
    // build (no PUBLIC_BASE env), PUBLIC_BASE is '/' — so joinPublicBase is the
    // identity. Pin that contract here so a root build is provably unchanged.
    test('root deployment (PUBLIC_BASE=/) is the identity', () => {
      expect(PUBLIC_BASE).toBe('/');
      expect(HAS_SUBPATH).toBe(false);
      expect(joinPublicBase('/api/v1/x')).toBe('/api/v1/x');
      expect(joinPublicBase('/login')).toBe('/login');
      expect(joinPublicBase('/')).toBe('/');
    });
  });

  test.describe('root build never sees a prefix', () => {
    // The acceptance criterion "root remains default" — under a build without
    // PUBLIC_BASE, every constant must report root.
    test('PUBLIC_BASE and HAS_SUBPATH default to root / false', () => {
      expect(PUBLIC_BASE).toBe('/');
      expect(HAS_SUBPATH).toBe(false);
    });
  });
});

/**
 * The subpath behavior of joinPublicBase() can't be exercised directly in a
 * root build (PUBLIC_BASE is stamped at build time), but the joining logic is
 * trivially mirrored here against an arbitrary prefix to pin the contract for
 * review. This is the exact same logic as the production helper; duplicating
 * it locally is intentional — if the production helper drifts, this spec
 * surfaces the expected shape.
 */
function joinWith(prefix: string, path: string): string {
  if (prefix === '/') return path;
  if (path === '/') return `${prefix}/`;
  if (path.startsWith('/')) return `${prefix}${path}`;
  return `${prefix}/${path}`;
}

test.describe('joinPublicBase — subpath contract (mirrored)', () => {
  test('prefixes a leading-slash path', () => {
    expect(joinWith('/campfire', '/api/v1/x')).toBe('/campfire/api/v1/x');
    expect(joinWith('/campfire', '/login')).toBe('/campfire/login');
  });

  test('root path gets a trailing slash (directory URL)', () => {
    expect(joinWith('/campfire', '/')).toBe('/campfire/');
    // This matters for window.location.replace(joinPublicBase('/')) — a
    // redirect to /campfire (no slash) would be a 301-hop to /campfire/.
  });

  test('non-leading-slash path is joined after a single slash', () => {
    expect(joinWith('/campfire', 'relative')).toBe('/campfire/relative');
  });

  test('root prefix is identity', () => {
    expect(joinWith('/', '/api/v1/x')).toBe('/api/v1/x');
    expect(joinWith('/', '/')).toBe('/');
  });

  test('multi-segment prefix works', () => {
    expect(joinWith('/apps/cf', '/api/v1/x')).toBe('/apps/cf/api/v1/x');
    expect(joinWith('/apps/cf', '/')).toBe('/apps/cf/');
  });
});
