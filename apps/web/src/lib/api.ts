/**
 * Typed API client. All feature code calls the API through this — never raw fetch.
 * - sends session cookie (credentials: include)
 * - dev-role override: localStorage 'cf.devRole' / 'cf.devUser' adds x-dev-* headers
 *   (only honored by the server when DEV_AUTH=1; harmless otherwise)
 * - throws ApiError with status + server message
 */

/** A single field-level validation failure parsed from the server's `errors[]`. */
export interface FieldError {
  /** Dotted path to the offending field, e.g. "title" or "actions.0.name". '' = form-level. */
  field: string;
  /** The server's message for that field, e.g. "String must contain at most 200 character(s)". */
  message: string;
}

/**
 * Turn a dotted field path into a human label for prefixing a message —
 * "hpMax" -> "Hp max", "actions.0.name" -> "Actions 0 name". Best-effort only;
 * the raw server message is always the substance.
 */
function humanizeField(field: string): string {
  const words = field
    .split('.')
    .flatMap((seg) => seg.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/))
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return '';
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

/**
 * Parse the server's structured validation errors. NestJS/nestjs-zod's
 * ZodValidationException serializes as `{ message: "Validation failed", errors: ZodIssue[] }`,
 * where each issue is `{ path: (string|number)[], message: string, ... }`. Returns [] when the
 * body has no such array (e.g. a plain BadRequestException carrying only `message`).
 */
function parseFieldErrors(body: unknown): FieldError[] {
  if (!body || typeof body !== 'object') return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  const out: FieldError[] = [];
  for (const issue of errors) {
    if (!issue || typeof issue !== 'object') continue;
    const message = (issue as { message?: unknown }).message;
    if (typeof message !== 'string' || message.length === 0) continue;
    const path = (issue as { path?: unknown }).path;
    const field = Array.isArray(path) ? path.filter((p) => p !== '' && p != null).join('.') : '';
    out.push({ field, message });
  }
  return out;
}

/** Compose a readable one-line summary from field errors: "Title: too long; Body: required". */
function summarizeFieldErrors(fieldErrors: FieldError[]): string {
  return fieldErrors
    .map((fe) => {
      const label = humanizeField(fe.field);
      return label ? `${label}: ${fe.message}` : fe.message;
    })
    .join('; ');
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * Field-level validation failures parsed from the server's `errors[]`, when present.
     * Empty for non-validation errors. `message` already folds these into a readable summary,
     * so callers can just show `err.message`; use this for per-field UI (e.g. inline messages).
     */
    public fieldErrors: FieldError[] = [],
    /**
     * Machine-readable error code from the server's body (`code`/`error`), when present.
     * This is the i18n seam for server errors (issue #94): if the server emits a stable code
     * (e.g. `CAMPAIGN_NOT_FOUND`), the client can map it to a translated string via
     * {@link translateApiError}. When absent, the human-readable `message` is used as-is.
     */
    public code?: string,
  ) {
    super(message);
  }

  /** Field path -> message map (first message wins per field). Only fields with a path are included. */
  fieldMessages(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const fe of this.fieldErrors) {
      if (fe.field && !(fe.field in out)) out[fe.field] = fe.message;
    }
    return out;
  }
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.json !== undefined) headers.set('Content-Type', 'application/json');
  const devRole = localStorage.getItem('cf.devRole');
  const devUser = localStorage.getItem('cf.devUser');
  if (devRole) headers.set('x-dev-role', devRole);
  if (devUser) headers.set('x-dev-user', devUser);

  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) {
    let message = res.statusText;
    let fieldErrors: FieldError[] = [];
    let code: string | undefined;
    try {
      const body = await res.json();
      fieldErrors = parseFieldErrors(body);
      // A stable, machine-readable code (if the server supplies one) is the i18n seam:
      // the client can translate it, falling back to the human message below.
      const rawCode = (body as { code?: unknown; error?: unknown }).code ?? (body as { error?: unknown }).error;
      if (typeof rawCode === 'string' && rawCode.length > 0) code = rawCode;
      // Prefer the structured field-level reasons — the server's `message` for a validation
      // failure is a bare "Validation failed", the actual detail lives in `errors[]` (issue #146).
      if (fieldErrors.length > 0) {
        message = summarizeFieldErrors(fieldErrors);
      } else {
        message = Array.isArray(body.message) ? body.message.join('; ') : (body.message ?? message);
      }
    } catch {
      /* non-json error body */
    }
    throw new ApiError(res.status, message, fieldErrors, code);
  }
  // Success with no body: 204/205 by spec, but many endpoints (e.g. DELETE)
  // return 200 with a 0-byte body. Guard against parsing empty/non-JSON bodies
  // so a succeeded operation isn't reported as a failure.
  if (res.status === 204 || res.status === 205) return undefined as T;
  if (res.headers.get('Content-Length') === '0') return undefined as T;
  const text = await res.text();
  if (text === '') return undefined as T;
  return JSON.parse(text) as T;
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>(path, init),
  post: <T>(path: string, json?: unknown, init?: RequestInit) => request<T>(path, { ...init, method: 'POST', json }),
  patch: <T>(path: string, json?: unknown, init?: RequestInit) => request<T>(path, { ...init, method: 'PATCH', json }),
  put: <T>(path: string, json?: unknown, init?: RequestInit) => request<T>(path, { ...init, method: 'PUT', json }),
  delete: <T>(path: string, init?: RequestInit) => request<T>(path, { ...init, method: 'DELETE' }),
};

export const API = '/api/v1';

/**
 * i18n seam for server errors (issue #94). Maps an {@link ApiError}'s server-provided `code`
 * to a translated string under the `errors.<code>` catalog key, falling back to the server's
 * human-readable `message` when there's no code or no matching translation. Field-level
 * validation summaries (which are per-field server text) are always used verbatim.
 *
 * Usage (inside a component):
 *   const { t } = useTranslation();
 *   catch (e) { setError(translateApiError(e, t)); }
 *
 * `t` is typed loosely so this helper stays dependency-free; pass react-i18next's `t`.
 */
export function translateApiError(
  err: unknown,
  t: (key: string, opts?: { defaultValue?: string }) => string,
): string {
  if (!(err instanceof ApiError)) {
    return err instanceof Error ? err.message : String(err);
  }
  if (err.code) {
    // `defaultValue` makes this a safe fallback: unknown codes render the server message.
    return t(`errors.${err.code}`, { defaultValue: err.message });
  }
  return err.message;
}
