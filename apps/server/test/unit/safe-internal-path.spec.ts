import { safeInternalPath } from '../../src/modules/auth/safe-internal-path';

/**
 * Issue #478 — open-redirect guard for OIDC / login return targets.
 */
describe('safeInternalPath (issue #478)', () => {
  it('accepts in-app absolute paths including invite joins', () => {
    expect(safeInternalPath('/join/ABC123')).toBe('/join/ABC123');
    expect(safeInternalPath('/c/12')).toBe('/c/12');
    expect(safeInternalPath('/join/ABC?x=1')).toBe('/join/ABC?x=1');
  });

  it('rejects open redirects and auth loops', () => {
    expect(safeInternalPath('https://evil.example')).toBeNull();
    expect(safeInternalPath('//evil.example')).toBeNull();
    expect(safeInternalPath('/\\evil.example')).toBeNull();
    expect(safeInternalPath('/login')).toBeNull();
    expect(safeInternalPath('/login?local=1')).toBeNull();
    expect(safeInternalPath('/setup')).toBeNull();
    expect(safeInternalPath('')).toBeNull();
    expect(safeInternalPath(null)).toBeNull();
  });
});
