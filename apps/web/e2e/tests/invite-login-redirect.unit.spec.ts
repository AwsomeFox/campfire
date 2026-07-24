import { expect, test } from '@playwright/test';
import { loginHrefWithReturn, safeInternalPath } from '../../src/lib/safeInternalPath';

/**
 * Issue #478 — preserve invite join links through login (open-redirect guard).
 */
test.describe('safeInternalPath / loginHrefWithReturn (issue #478)', () => {
  test('accepts join paths and builds a login href with redirect', () => {
    expect(safeInternalPath('/join/TESTCODE478')).toBe('/join/TESTCODE478');
    expect(loginHrefWithReturn('/join/TESTCODE478')).toBe(
      '/login?redirect=%2Fjoin%2FTESTCODE478',
    );
  });

  test('rejects open redirects', () => {
    expect(safeInternalPath('//evil.example')).toBeNull();
    expect(safeInternalPath('/login')).toBeNull();
    expect(loginHrefWithReturn('https://evil.example')).toBe('/login');
  });
});
