import { randomUUID } from 'node:crypto';
import { getRequestId } from './request-context';
import type { HttpException } from '@nestjs/common';
import type { ZodError } from 'zod';

/**
 * Issue #682 — machine-readable API error contracts.
 *
 * Problem Details-style (RFC 9457) error envelope published for BOTH the REST
 * API (Nest exception filter) and the MCP transport (mcp-tools fail()). The
 * same `code` slug vocabulary is used either side of the wire, so an integrator
 * can branch on `error.code` (e.g. `not_found`, `validation_failed`) without
 * parsing prose or knowing whether the failure came over HTTP or JSON-RPC.
 *
 * REST only (the HTTP-specific fields) carries `type`/`title`/`instance` per
 * RFC 9457 — MCP's wire shape omits those (they have no JSON-RPC meaning) and
 * wraps the per-call envelope inside `{ "error": { ... } }` exactly as before,
 * now with `requestId` + optional `errors[]`.
 */

/** Stable machine-readable slug derived from the HTTP status of an error. */
export type ApiErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'too_many_requests'
  | 'unprocessable_entity'
  | 'internal_error'
  | 'error';

/**
 * Map an HTTP status to the canonical machine-readable slug. Statuses outside
 * the documented table collapse to the nearest category (`internal_error` for
 * unknown 5xx and `error` for unknown 4xx), keeping the slug vocabulary bounded
 * so an integrator's switch-statement never needs to grow forever.
 */
export function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 422:
      return 'unprocessable_entity';
    case 429:
      return 'too_many_requests';
    default:
      return status >= 500 ? 'internal_error' : 'error';
  }
}

/** A single per-field validation failure — surfaced as `errors[]` on the envelope. */
export interface FieldError {
  /** Dotted path to the offending field, or `"(root)"` for whole-body failures. */
  field: string;
  /** Stable, short message describing the constraint that failed. */
  message: string;
}

/**
 * The unified error payload. REST returns this directly as the JSON body;
 * MCP nests it under `{ "error": <ApiErrorEnvelope> }` for legacy parity.
 *
 * `code` is typed as `ApiErrorCode | string` (not just the slug union) because
 * domain services sometimes throw a `ConflictException({ code: 'STALE_WRITE' })`
 * carrying a domain-specific slug that is MORE informative than the generic
 * `conflict`. We preserve that domain code on the wire rather than collapsing
 * it to the HTTP-derived slug — an integrator switching on `code` gets either
 * the canonical vocabulary (`not_found`, `validation_failed`, ...) OR a stable
 * domain code they already know (`STALE_WRITE`, `COMBATANT_IDENTITY_CONFLICT`).
 */
export interface ApiErrorEnvelope {
  /** RFC 9457 — a URI reference for the problem type; `about:blank` for built-in HTTP semantics. */
  type?: string;
  /** RFC 9457 — short, human-readable summary of the problem type (e.g. "Not Found"). */
  title?: string;
  /** HTTP status code (mirrors the response status for REST; informational for MCPS). */
  status: number;
  /** Machine-readable slug (see `codeForStatus` / `ApiErrorCode`) OR a preserved domain code. */
  code: ApiErrorCode | string;
  /** Human-readable detail of what went wrong — safe to surface to integrators. */
  message: string;
  /** RFC 9457 — the request path that errored. REST only. */
  instance?: string;
  /** Per-request correlation id — also echoed on the `X-Request-Id` response header (REST). */
  requestId?: string;
  /** Per-field validation errors (only present when the failure is a validation failure). */
  errors?: FieldError[];
  /** Optimistic-concurrency token the client sent (STALE_WRITE only). */
  expectedUpdatedAt?: string;
  /** Live revision token to retry against (STALE_WRITE only). */
  currentUpdatedAt?: string;
}

/** A short, stable title for each status — RFC 9457 `title`. */
function titleForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 405:
      return 'Method Not Allowed';
    case 409:
      return 'Conflict';
    case 413:
      return 'Payload Too Large';
    case 415:
      return 'Unsupported Media Type';
    case 422:
      return 'Unprocessable Entity';
    case 429:
      return 'Too Many Requests';
    case 500:
      return 'Internal Server Error';
    case 501:
      return 'Not Implemented';
    case 502:
      return 'Bad Gateway';
    case 503:
      return 'Service Unavailable';
    case 504:
      return 'Gateway Timeout';
    default:
      return status >= 500 ? 'Internal Server Error' : 'Error';
  }
}

/** Build the canonical code slug + message + field errors from any thrown value. */
export interface NormalizedError {
  status: number;
  code: ApiErrorCode | string;
  message: string;
  errors?: FieldError[];
}

/**
 * Coerce a single issue from ANY of the shapes that float through Nest's error
 * pipeline into the canonical `{ field, message }`:
 *   - Zod issue: `{ path: (string|number)[], message: string }` (nestjs-zod)
 *   - class-validator ValidationError: `{ property, constraints: {name: msg} }`
 *   - Our own `{ field, message }` already-canonical shape
 *   - bare string
 *
 * Without this, a zod issue nested inside `errors[]` renders as the useless
 * `"[object Object]"` (the prior `String(e)` fallback).
 */
function fieldErrorFromIssue(e: unknown): FieldError {
  if (typeof e === 'string') return { field: '(root)', message: e };
  if (e && typeof e === 'object') {
    const o = e as {
      field?: unknown;
      message?: unknown;
      path?: unknown;
      property?: unknown;
      constraints?: unknown;
    };
    if (typeof o.field === 'string' && typeof o.message === 'string') {
      return { field: o.field, message: o.message };
    }
    // Zod issue shape — nestjs-zod puts the raw issues array on `errors`.
    if (Array.isArray(o.path) && typeof o.message === 'string') {
      const field =
        o.path.length > 0
          ? o.path.map((p) => (typeof p === 'number' || typeof p === 'string' ? String(p) : '?')).join('.')
          : '(root)';
      return { field, message: o.message };
    }
    // class-validator ValidationError shape: { property, constraints: {name: msg} }
    if (typeof o.property === 'string' && o.constraints && typeof o.constraints === 'object') {
      const constraints = o.constraints as Record<string, string>;
      const msg = Object.values(constraints)[0];
      if (typeof msg === 'string') return { field: o.property, message: msg };
    }
    // Unknown object — best-effort readable render.
    if (typeof o.message === 'string') return { field: '(root)', message: o.message };
    try {
      return { field: '(root)', message: JSON.stringify(e) };
    } catch {
      return { field: '(root)', message: '[object]' };
    }
  }
  return { field: '(root)', message: String(e) };
}

/**
 * Normalize a thrown value into the canonical (status, code, message, errors?)
 * tuple. Pure / side-effect free — the REST filter adds HTTP-context fields
 * (`type`/`title`/`instance`/`requestId`), and MCP's fail() wraps the result
 * inside `{ error: ... }`.
 *
 * ZodError is treated as a 400 with `code:"validation_failed"` and structured
 * per-field errors (so an integrator can render a form with field highlights
 * rather than a single string). The global `ZodValidationPipe` (nestjs-zod)
 * throws the same `BadRequestException` with `{ message: [...] }` for request
 * bodies, and that path is normalized below into the same field-error shape.
 */
export function normalizeError(err: unknown): NormalizedError {
  // Lazy-imported to avoid pulling zod into every cold start path of this file.
  // The REST filter is the only caller for the ZodError branch — MCP invokes
  // this from its own try/catch where zod is already loaded.
  if (typeof err === 'object' && err !== null && 'issues' in err && Array.isArray((err as { issues: unknown }).issues)) {
    const zErr = err as ZodError;
    const errors: FieldError[] = zErr.issues.map((i) => fieldErrorFromIssue(i));
    return {
      status: 400,
      code: 'validation_failed',
      message: errors.map((e) => `${e.field}: ${e.message}`).join('; '),
      errors,
    };
  }

  // HttpException: Nest's standard exception hierarchy. `getResponse()` is
  // either a string (legacy throw) or an object whose shape we try hard to
  // recover a structured `errors[]` and (optionally) a domain `code` from.
  const isHttpException =
    typeof err === 'object' && err !== null && typeof (err as { getStatus?: unknown }).getStatus === 'function';
  if (isHttpException) {
    const httpErr = err as HttpException;
    const status = httpErr.getStatus();
    const res = httpErr.getResponse();
    let message: string;
    let errors: FieldError[] | undefined;
    // Domain services sometimes throw with a custom machine-readable `code`
    // (e.g. ConflictException({ code: 'STALE_WRITE', message: '...' })). That
    // code is more informative than the HTTP-derived slug, so preserve it on
    // the wire — an integrator can still switch on the generic `conflict`
    // category by checking status, and gains the specific cause via `code`.
    let code: ApiErrorCode | string | undefined;
    if (typeof res === 'string') {
      message = res;
    } else {
      const obj = res as {
        message?: unknown;
        error?: unknown;
        errors?: unknown;
        code?: unknown;
      };
      if (typeof obj.code === 'string' && obj.code.length > 0) {
        code = obj.code;
      }
      // nestjs-zod's ZodValidationPipe throws a BadRequestException carrying
      // `message: string[]` (the raw zod issue strings). Re-shape as field
      // errors with `field:"(root)"` when the message isn't `path: message`,
      // which is the common shape for top-level body parse failures.
      if (Array.isArray(obj.message)) {
        errors = (obj.message as unknown[]).map((m) => {
          if (typeof m === 'string') {
            const idx = m.indexOf(':');
            return idx > 0
              ? { field: m.slice(0, idx).trim(), message: m.slice(idx + 1).trim() }
              : { field: '(root)', message: m };
          }
          return fieldErrorFromIssue(m);
        });
        message = errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      } else if (typeof obj.message === 'string') {
        message = obj.message;
      } else {
        message = typeof obj.error === 'string' ? obj.error : JSON.stringify(res);
      }
      if (Array.isArray(obj.errors)) {
        errors = (obj.errors as unknown[]).map((e) => fieldErrorFromIssue(e));
      }
    }
    return { status, code: code ?? codeForStatus(status), message, errors };
  }

  if (err instanceof Error) {
    // express.json / body-parser throws entity.too.large before Nest sees the body.
    const errStatus =
      (err as Error & { status?: number }).status ??
      (err as Error & { statusCode?: number }).statusCode;
    if (
      errStatus === 413 ||
      ('type' in err && (err as Error & { type?: string }).type === 'entity.too.large')
    ) {
      return { status: 413, code: 'payload_too_large', message: 'request entity too large' };
    }
    // Never leak internal stack traces for 500s — the filter replaces `message`
    // for 5xx with a generic string. The original message is preserved here for
    // non-production logs (the filter chooses what to surface).
    return { status: 500, code: 'internal_error', message: err.message };
  }

  // Non-Error non-HttpException throw — render it readably. `String(obj)`
  // collapses to "[object Object]" which is useless to an integrator, so
  // JSON-stringify object values when possible (fall back to String on a
  // circular/non-JSON value).
  if (typeof err === 'object' && err !== null) {
    try {
      return { status: 500, code: 'internal_error', message: JSON.stringify(err) };
    } catch {
      return { status: 500, code: 'internal_error', message: '[object]' };
    }
  }
  return { status: 500, code: 'internal_error', message: String(err) };
}

/**
 * Build the full REST envelope — HTTP context fields included. Generates a
 * `requestId` if none was already attached to the request (the filter accepts
 * an inbound `X-Request-Id` header so a caller's id propagates end-to-end).
 */
/** HttpException response keys absorbed into the canonical envelope (not passthrough). */
const ENVELOPE_RESERVED_KEYS = new Set(['message', 'error', 'errors', 'code', 'statusCode', 'status']);

function isHttpException(err: unknown): err is HttpException {
  return typeof err === 'object' && err !== null && typeof (err as { getStatus?: unknown }).getStatus === 'function';
}

/** Strip query strings so error `instance` does not echo caller-supplied search terms. */
function sanitizeInstance(instance: string): string {
  const q = instance.indexOf('?');
  return q >= 0 ? instance.slice(0, q) : instance;
}

export function buildRestEnvelope(opts: {
  err: unknown;
  requestId?: string;
  instance?: string;
}): ApiErrorEnvelope & Record<string, unknown> {
  const norm = normalizeError(opts.err);
  const intentional = isHttpException(opts.err);
  // Sanitize only uncaught/internal 5xx — intentional HttpExceptions (e.g. 503
  // Service Unavailable with a domain message) keep their wired message.
  const isServerError = norm.status >= 500;
  const message =
    isServerError && !intentional
      ? 'Something went wrong. Please try again later.'
      : norm.message;
  const envelope: ApiErrorEnvelope & Record<string, unknown> = {
    type: 'about:blank',
    title: titleForStatus(norm.status),
    status: norm.status,
    code: norm.code,
    message,
    requestId: opts.requestId,
  };
  if (opts.instance !== undefined) envelope.instance = sanitizeInstance(opts.instance);
  if (norm.errors && norm.errors.length > 0) envelope.errors = norm.errors;

  // Domain services attach machine-readable extension fields (combatantId, current,
  // encounterName, …) alongside code/message — preserve them on the wire.
  if (intentional) {
    const httpErr = opts.err as HttpException;
    const res = httpErr.getResponse();
    if (typeof res === 'object' && res !== null) {
      for (const [key, value] of Object.entries(res as Record<string, unknown>)) {
        if (!ENVELOPE_RESERVED_KEYS.has(key) && value !== undefined) {
          envelope[key] = value;
        }
      }
    }
  }
  return envelope;
}

/**
 * Build the MCP envelope — the same payload as REST minus HTTP-context fields,
 * wrapped inside `{ "error": <envelope> }`. `requestId` is taken from the
 * active request context when present (issue #684), else minted per-error.
 */
export function buildMcpEnvelope(err: unknown): { error: ApiErrorEnvelope } {
  const norm = normalizeError(err);
  const intentional = isHttpException(err);
  const isServerError = norm.status >= 500;
  const message =
    isServerError && !intentional
      ? 'Something went wrong. Please try again later.'
      : norm.message;
  const error: ApiErrorEnvelope = {
    status: norm.status,
    code: norm.code,
    message,
    requestId: getRequestId() ?? randomUUID(),
  };
  if (norm.errors && norm.errors.length > 0) error.errors = norm.errors;
  if (isHttpException(err)) {
    const res = (err as HttpException).getResponse();
    if (typeof res === 'object' && res !== null) {
      const obj = res as { expectedUpdatedAt?: unknown; currentUpdatedAt?: unknown };
      if (typeof obj.expectedUpdatedAt === 'string') error.expectedUpdatedAt = obj.expectedUpdatedAt;
      if (typeof obj.currentUpdatedAt === 'string') error.currentUpdatedAt = obj.currentUpdatedAt;
    }
  }
  return { error };
}

/**
 * Generate (or accept) a per-request id. Callers may pass an inbound header
 * value (e.g. `X-Request-Id`) so a downstream service's correlation id
 * propagates end-to-end; we only validate that it's a reasonable printable
 * string (capped at 128 chars) to avoid log-injection via the header.
 */
export function resolveRequestId(inbound?: string): string {
  if (inbound && inbound.length > 0 && inbound.length <= 128 && /^[\w.\-:]+$/.test(inbound)) {
    return inbound;
  }
  return randomUUID();
}

/** Normalize Express's `string | string[]` header value before resolveRequestId(). */
export function resolveRequestIdFromHeader(header: string | string[] | undefined): string {
  return resolveRequestId(Array.isArray(header) ? header[0] : header);
}
