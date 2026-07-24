/**
 * Shared auth-form accessibility helpers (issue #449).
 *
 * Validation and server failures must:
 * - announce once via a role="alert" region (field-level or form summary)
 * - associate invalid inputs with aria-invalid + aria-describedby
 * - move focus to the first invalid field or the form summary
 * - preserve typed values (callers keep controlled input state)
 */

export type AuthFieldKey =
  | 'username'
  | 'password'
  | 'confirm'
  | 'displayName'
  | 'code'
  | 'newPassword';

export type AuthFieldErrors = Partial<Record<AuthFieldKey, string>>;

export type AuthErrorState =
  | { kind: 'fields'; fields: AuthFieldErrors; focus: AuthFieldKey }
  | { kind: 'form'; message: string };

export const AUTH_USERNAME_PATTERN_ERROR =
  'Username may only contain letters, numbers, and _ . -';
export const AUTH_PASSWORD_LENGTH_ERROR = 'Password must be at least 8 characters.';
export const AUTH_PASSWORD_MISMATCH_ERROR = 'Passwords do not match.';
export const AUTH_CREDENTIALS_ERROR = 'Wrong username or password.';
export const AUTH_LOCAL_DISABLED_ERROR =
  'Local sign-in is disabled — ask your server admin.';
export const AUTH_RATE_LIMIT_ERROR = 'Too many attempts — wait a minute and try again.';
export const AUTH_GENERIC_ERROR = 'Something went wrong. Try again.';
export const AUTH_USERNAME_TAKEN_ERROR = 'That username is already taken.';
export const AUTH_SIGNUP_DISABLED_ERROR =
  'Signup is disabled — ask your server admin for an account.';
export const AUTH_RESET_CODE_ERROR =
  'That code is invalid or has expired — ask your admin for a fresh one.';

export const AUTH_USERNAME_PATTERN = /^[a-z0-9_.-]+$/i;

/** Stable ids used by login / setup / signup / reset / join forms. */
export const AUTH_FIELD_IDS: Record<AuthFieldKey, string> = {
  username: 'username',
  password: 'password',
  confirm: 'confirm',
  displayName: 'displayName',
  code: 'reset-code',
  newPassword: 'reset-new-password',
};

export const AUTH_ERROR_IDS = {
  username: 'auth-username-error',
  password: 'auth-password-error',
  confirm: 'auth-confirm-error',
  displayName: 'auth-displayName-error',
  code: 'auth-code-error',
  newPassword: 'auth-newPassword-error',
  form: 'auth-form-error',
  /** Login keeps a stable id used by existing responsive tests. */
  login: 'login-error',
} as const;

export function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const joined = ids.filter(Boolean).join(' ');
  return joined || undefined;
}

export function focusAuthError(
  error: AuthErrorState,
  options?: { fieldIds?: Partial<Record<AuthFieldKey, string>>; formErrorId?: string },
): void {
  if (error.kind === 'fields') {
    const id = options?.fieldIds?.[error.focus] ?? AUTH_FIELD_IDS[error.focus];
    document.getElementById(id)?.focus();
    return;
  }
  const summaryId = options?.formErrorId ?? AUTH_ERROR_IDS.form;
  document.getElementById(summaryId)?.focus();
}

/** Client-side checks shared by setup / signup / invite-join account forms. */
export function validateNewAccountFields(input: {
  username: string;
  password: string;
  confirm: string;
}): AuthErrorState | null {
  if (!AUTH_USERNAME_PATTERN.test(input.username)) {
    return {
      kind: 'fields',
      fields: { username: AUTH_USERNAME_PATTERN_ERROR },
      focus: 'username',
    };
  }
  if (input.password.length < 8) {
    return {
      kind: 'fields',
      fields: { password: AUTH_PASSWORD_LENGTH_ERROR },
      focus: 'password',
    };
  }
  if (input.password !== input.confirm) {
    return {
      kind: 'fields',
      fields: { confirm: AUTH_PASSWORD_MISMATCH_ERROR },
      focus: 'confirm',
    };
  }
  return null;
}
