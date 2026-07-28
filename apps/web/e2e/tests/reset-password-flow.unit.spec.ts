import { expect, test } from '@playwright/test';
import {
  resetStepForCode,
  validateResetPassword,
} from '../../src/features/auth/resetPasswordFlow';

test.describe('password recovery flow (issue #757)', () => {
  test('starts with a request unless a nonblank deep-link code is supplied', () => {
    expect(resetStepForCode(null)).toBe('request');
    expect(resetStepForCode('   ')).toBe('request');
    expect(resetStepForCode('cf_reset_pasted')).toBe('redeem');
  });

  test('rejects absent codes and weak or mismatched passwords before a request', () => {
    expect(validateResetPassword({ code: '', newPassword: 'long-enough', confirmNewPassword: 'long-enough' }))
      .toMatchObject({ kind: 'fields', focus: 'code' });
    expect(validateResetPassword({ code: 'pasted', newPassword: 'short', confirmNewPassword: 'short' }))
      .toMatchObject({ kind: 'fields', focus: 'newPassword' });
    expect(validateResetPassword({ code: 'pasted', newPassword: 'long-enough', confirmNewPassword: 'different' }))
      .toMatchObject({ kind: 'fields', focus: 'confirmNewPassword' });
  });

  test('accepts a pasted code and matching password pair', () => {
    expect(validateResetPassword({ code: ' cf_reset_pasted ', newPassword: 'long-enough', confirmNewPassword: 'long-enough' }))
      .toBeNull();
  });
});
