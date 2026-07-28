import {
  AUTH_PASSWORD_LENGTH_ERROR,
  AUTH_PASSWORD_MISMATCH_ERROR,
  type AuthErrorState,
} from './authFormA11y';

export type ResetStep = 'request' | 'redeem';

/** A nonblank reset code is the only deep-link signal that selects redemption. */
export function resetStepForCode(code: string | null | undefined): ResetStep {
  return code?.trim() ? 'redeem' : 'request';
}

/** Client-side checks keep reset credentials out of a failing network request. */
export function validateResetPassword(input: {
  code: string;
  newPassword: string;
  confirmNewPassword: string;
}): AuthErrorState | null {
  if (!input.code.trim()) {
    return { kind: 'fields', fields: { code: 'Enter the reset code.' }, focus: 'code' };
  }
  if (input.newPassword.length < 8) {
    return {
      kind: 'fields',
      fields: { newPassword: AUTH_PASSWORD_LENGTH_ERROR },
      focus: 'newPassword',
    };
  }
  if (input.newPassword !== input.confirmNewPassword) {
    return {
      kind: 'fields',
      fields: { confirmNewPassword: AUTH_PASSWORD_MISMATCH_ERROR },
      focus: 'confirmNewPassword',
    };
  }
  return null;
}
