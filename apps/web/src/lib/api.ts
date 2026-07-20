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
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.json !== undefined) headers['Content-Type'] = 'application/json';
  const devRole = localStorage.getItem('cf.devRole');
  const devUser = localStorage.getItem('cf.devUser');
  if (devRole) headers['x-dev-role'] = devRole;
  if (devUser) headers['x-dev-user'] = devUser;

  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) {
    let message = res.statusText;
    let fieldErrors: FieldError[] = [];
    try {
      const body = await res.json();
      fieldErrors = parseFieldErrors(body);
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
    throw new ApiError(res.status, message, fieldErrors);
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
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, json?: unknown) => request<T>(path, { method: 'POST', json }),
  patch: <T>(path: string, json?: unknown) => request<T>(path, { method: 'PATCH', json }),
  put: <T>(path: string, json?: unknown) => request<T>(path, { method: 'PUT', json }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export const API = '/api/v1';
