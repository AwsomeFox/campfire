/**
 * Typed provider errors (#309 resilience). Every adapter maps vendor HTTP failures and
 * transport faults onto ONE `AiProviderError` taxonomy so the driver runtime (#312) can
 * branch on `kind` — e.g. feed `rate_limit`/`context_length` into the stuck-ladder,
 * surface `auth` to the operator, retry `transport`/`server`/`timeout`. No vendor error
 * type escapes an adapter.
 */

export type AiErrorKind =
  /** Bad/missing/expired credentials (401/403). Not retryable — needs operator action. */
  | 'auth'
  /** Rate limited / quota (429). Retryable with backoff (honours Retry-After when present). */
  | 'rate_limit'
  /** Prompt + max_tokens exceed the model's context window. Not retryable as-is. */
  | 'context_length'
  /** Provider refused on safety grounds (content filter / stop_reason). Not retryable. */
  | 'content_filter'
  /** Network/connection fault, no HTTP response. Retryable. */
  | 'transport'
  /** Per-request timeout / abort elapsed. Retryable. */
  | 'timeout'
  /** Malformed request the provider rejected (400/422 that isn't context length). Not retryable. */
  | 'invalid_request'
  /** Provider-side 5xx. Retryable. */
  | 'server'
  /** Anything unclassified. Not retryable by default. */
  | 'unknown';

export interface AiProviderErrorOptions {
  /** Whether a bounded retry with backoff is worth attempting. */
  retryable?: boolean;
  /** HTTP status, when the failure had a response. */
  status?: number;
  /** Provider name for context in logs/audit. */
  provider?: string;
  /** Seconds to wait before retrying, parsed from a Retry-After header when present. */
  retryAfterMs?: number;
  /** Underlying error/cause. */
  cause?: unknown;
}

export class AiProviderError extends Error {
  readonly kind: AiErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly provider?: string;
  readonly retryAfterMs?: number;

  constructor(kind: AiErrorKind, message: string, opts: AiProviderErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AiProviderError';
    this.kind = kind;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE.has(kind);
    this.status = opts.status;
    this.provider = opts.provider;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

const DEFAULT_RETRYABLE = new Set<AiErrorKind>(['rate_limit', 'transport', 'timeout', 'server']);

/**
 * Classify an HTTP status (and optionally the vendor error body) into an `AiErrorKind`.
 * `bodyText` lets us disambiguate a 400 that is really a context-length overflow
 * (both OpenAI and Anthropic report it with a 400 + a recognizable message).
 */
export function classifyHttpStatus(status: number, bodyText = ''): AiErrorKind {
  const lower = bodyText.toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 422) {
    if (lower.includes('context length') || lower.includes('context_length') || lower.includes('maximum context') || lower.includes('too many tokens') || lower.includes('prompt is too long')) {
      return 'context_length';
    }
    if (lower.includes('content filter') || lower.includes('content_filter') || lower.includes('content management policy')) {
      return 'content_filter';
    }
    return 'invalid_request';
  }
  if (status >= 500) return 'server';
  return 'unknown';
}

/** Parse a Retry-After header (seconds or HTTP-date) into milliseconds, if usable. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
