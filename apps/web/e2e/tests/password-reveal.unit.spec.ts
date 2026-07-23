import { expect, test } from '@playwright/test';
import {
  passwordInputType,
  passwordRevealLabel,
} from '../../src/components/PasswordInput';

/**
 * Issue #868 — shared Show/Hide password vocabulary and type mapping.
 *
 * The auth surfaces share one PasswordInput; these pure helpers pin the
 * accessible names and the password-manager-safe type toggle contract so a
 * future copy tweak cannot silently diverge across login/setup/reset flows.
 */

test.describe('password reveal labels (issue #868)', () => {
  test('defaults to the explicit Show password / Hide password pair', () => {
    expect(passwordRevealLabel(false)).toBe('Show password');
    expect(passwordRevealLabel(true)).toBe('Hide password');
  });

  test('keeps confirm/new field names distinguishable for assistive tech', () => {
    expect(passwordRevealLabel(false, 'confirm password')).toBe('Show confirm password');
    expect(passwordRevealLabel(true, 'new password')).toBe('Hide new password');
  });
});

test.describe('password input type mapping (issue #868)', () => {
  test('stays masked until revealed, then uses a single text input', () => {
    expect(passwordInputType(false)).toBe('password');
    expect(passwordInputType(true)).toBe('text');
  });
});
