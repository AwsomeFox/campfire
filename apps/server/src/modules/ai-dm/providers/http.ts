/**
 * Shared HTTP plumbing for the fetch-based adapters (#309). Campfire ships no vendor
 * SDK; these thin helpers give the OpenAI and Anthropic adapters a common home for:
 *   - an injectable `fetch` (so tests drive adapters against recorded fixtures — never
 *     the live network),
 *   - per-request timeout composed with the caller's AbortSignal,
 *   - bounded retries with exponential backoff + jitter for retryable failures,
 *   - a classifying JSON body read (`readJsonBody`, #1602) so no native parse error
 *     escapes an adapter,
 *   - a line-oriented SSE parser shared by both streaming paths.
 */

import { Logger } from '@nestjs/common';
import { getRequestId } from '../../../common/request-context';
import { AiProviderError, classifyHttpStatus, getHttpStatusText, parseRetryAfterMs } from './errors';

const httpLogger = new Logger('AiHttpProvider');

/** The subset of `fetch` the adapters use — swapped for a fake in tests. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * The response surface the adapters read — a structural subset of the global `Response`.
 *
 * Issue #1602: `json()` is deliberately absent. The real `Response` has it, and every
 * adapter reached for it, which is exactly how native `SyntaxError`s ended up escaping
 * the taxonomy. Leaving it off the interface makes that call unavailable to adapter code
 * and routes every body read through {@link readJsonBody}, which classifies the failure.
 * Do not add it back.
 */
export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | null;
}

export interface RetryConfig {
  /** Total attempts = 1 + maxRetries. */
  maxRetries: number;
  /** Base backoff in ms (grows exponentially per attempt). */
  baseDelayMs: number;
  /** Ceiling on any single backoff wait. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryConfig = { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8000 };
export const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * Max silence between streamed body chunks before the read is aborted (#1063).
 * Distinct from {@link DEFAULT_TIMEOUT_MS} (time-to-first-byte): a long narration may
 * legitimately exceed 60s wall-clock, but a provider that goes quiet mid-body must not
 * wedge the driver seat forever.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** Deterministic-friendly sleep (overridable in tests). */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface TimeoutHandle {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
  /** Clear only the TTFB timer; keep the external AbortSignal linked to `signal`. */
  clearTimer: () => void;
}

/**
 * Compose a per-request AbortSignal: fires when the caller's signal fires OR the
 * timeout elapses. Returns the signal plus a `cleanup` to clear the timer.
 */
export function withTimeout(timeoutMs: number, external?: AbortSignal): TimeoutHandle {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    clearTimer: () => {
      clearTimeout(timer);
    },
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** Exponential backoff with full jitter, honouring a Retry-After hint when provided. */
export function backoffDelayMs(attempt: number, cfg: RetryConfig, retryAfterMs?: number, rand: () => number = Math.random): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, cfg.maxDelayMs);
  const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** attempt);
  return Math.floor(exp * (0.5 + 0.5 * rand())); // 50–100% of the exponential ceiling
}

export interface PostJsonOptions {
  provider: string;
  timeoutMs: number;
  retry: RetryConfig;
  signal?: AbortSignal;
  sleep?: Sleep;
  rand?: () => number;
}

/**
 * Perform a JSON POST with timeout + bounded retries, mapping transport/timeout faults
 * to typed errors. Retries only on retryable typed errors (5xx/429/transport/timeout).
 * The 4xx classification (auth/context/invalid) is thrown immediately. Callers that
 * need the raw stream body read `.body` off the returned response themselves.
 */
export function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  bodyObj: unknown,
  opts: PostJsonOptions,
): Promise<FetchResponse> {
  return postWithRetry(fetchImpl, url, headers, bodyObj, opts, async (res) => res);
}

/**
 * Issue #1602: the non-streaming sibling of {@link postJson} — POST, then consume the
 * body through {@link readJsonBody} INSIDE the retry loop.
 *
 * Reading inside the loop is the whole point. `postJson` + a parse at the call site puts
 * the body read outside every retry, so a connection that dies mid-body could only ever
 * fail the turn, never be re-attempted — the same shape of defect #1556 fixed for
 * `reader.read()` on the streaming path. Because `readJsonBody` marks a mid-body fault
 * `transport` (retryable) and an unparseable body `invalid_response` (not), the existing
 * `retryable` gate below sorts the two automatically: the socket case gets its backoff,
 * the garbage-body case throws out on the first attempt.
 */
export function postAndReadJson<T>(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  bodyObj: unknown,
  opts: PostJsonOptions,
): Promise<T> {
  return postWithRetry(fetchImpl, url, headers, bodyObj, opts, (res) => readJsonBody<T>(res, opts.provider, opts.signal));
}

/**
 * The shared POST/timeout/backoff loop behind {@link postJson} and {@link postAndReadJson}.
 * `finalize` turns a 2xx response into the caller's result; it may reject with a typed
 * `AiProviderError`, and a retryable one re-enters the loop exactly like a failed fetch.
 */
async function postWithRetry<T>(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  bodyObj: unknown,
  opts: PostJsonOptions,
  finalize: (res: FetchResponse) => Promise<T>,
): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const body = JSON.stringify(bodyObj);
  let lastErr: AiProviderError | undefined;

  for (let attempt = 0; attempt <= opts.retry.maxRetries; attempt++) {
    const t = withTimeout(opts.timeoutMs, opts.signal);
    let res: FetchResponse;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body, signal: t.signal });
    } catch (cause) {
      t.cleanup();
      // Guarded fetch throws typed, non-retryable errors — propagate as-is.
      if (cause instanceof AiProviderError) throw cause;
      // Distinguish a timeout/abort from a raw transport fault.
      const aborted = t.didTimeout() || opts.signal?.aborted;
      lastErr = t.didTimeout()
        ? new AiProviderError('timeout', `${opts.provider}: request timed out after ${opts.timeoutMs}ms`, { provider: opts.provider, cause })
        : aborted
          ? new AiProviderError('timeout', `${opts.provider}: request aborted`, { provider: opts.provider, retryable: false, cause })
          : new AiProviderError('transport', `${opts.provider}: network error`, { provider: opts.provider, cause });
      if (!lastErr.retryable || attempt === opts.retry.maxRetries) throw lastErr;
      await sleep(backoffDelayMs(attempt, opts.retry, undefined, opts.rand));
      continue;
    }
    if (res.ok) {
      // Issue #1063: for streaming bodies, clear ONLY the time-to-first-byte timer.
      // Keep the caller's AbortSignal linked so a mid-body idle abort (or seat
      // teardown) still cancels the underlying fetch. Non-streaming responses have
      // no further reads, so full cleanup is safe.
      if (res.body) t.clearTimer();
      else t.cleanup();
      try {
        return await finalize(res);
      } catch (cause) {
        t.cleanup();
        // #1602: `finalize` is contractually typed (readJsonBody, or the identity used by
        // postJson, which cannot throw). Anything else is a bug in a finalizer, not a
        // provider fault — surface it typed rather than letting it escape raw, which is
        // the very guarantee this issue is about.
        lastErr =
          cause instanceof AiProviderError
            ? cause
            : new AiProviderError('unknown', `${opts.provider}: failed to consume response body`, { provider: opts.provider, cause });
        if (!lastErr.retryable || attempt === opts.retry.maxRetries) throw lastErr;
        await sleep(backoffDelayMs(attempt, opts.retry, lastErr.retryAfterMs, opts.rand));
        continue;
      }
    }

    t.cleanup();

    // Non-2xx: classify from status + body, retry the retryable ones.
    const bodyText = await safeText(res);
    const kind = classifyHttpStatus(res.status, bodyText);
    const statusText = getHttpStatusText(res.status);
    const sanitizedMessage = `AI provider returned HTTP ${res.status}${statusText ? ` ${statusText}` : ''}`;
    httpLogger.warn(
      `requestId=${getRequestId() ?? 'none'} AI provider (${opts.provider}) returned HTTP ${res.status} (${kind}). Raw body: ${truncate(bodyText, 1000)}`,
    );
    lastErr = new AiProviderError(kind, sanitizedMessage, {
      provider: opts.provider,
      status: res.status,
      rawBody: bodyText,
      retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
    });
    if (!lastErr.retryable || attempt === opts.retry.maxRetries) throw lastErr;
    await sleep(backoffDelayMs(attempt, opts.retry, lastErr.retryAfterMs, opts.rand));
  }
  // Unreachable — the loop either returns or throws — but satisfies the type checker.
  throw lastErr ?? new AiProviderError('unknown', `${opts.provider}: request failed`);
}

/**
 * Issue #987: GET helper for model discovery (`GET /v1/models`). Simpler than `postJson`
 * — no body, no retry loop (model lists are not transient), just a timeout-guarded GET
 * with the same error classification.
 *
 * Issue #1602: callers apply {@link readJsonBody} themselves rather than getting the read
 * pulled inside a retry loop the way {@link postAndReadJson} does, so a body that dies
 * mid-read here is classified `transport`/retryable but nothing retries it. That
 * asymmetry is deliberate: the sole caller is `listModels`, reached only from
 * `fetchAvailableModels` — an operator pressing a button in provider config, which
 * collapses every failure into one generic BadRequest anyway. No turn fails, no token
 * budget is spent, and the operator retries by clicking again. The POST path had to pull
 * the read inside the loop because it IS the driver's hot path.
 */
export async function getJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  opts: { provider: string; timeoutMs: number; signal?: AbortSignal },
): Promise<FetchResponse> {
  const t = withTimeout(opts.timeoutMs, opts.signal);
  try {
    return await fetchImpl(url, { method: 'GET', headers, signal: t.signal });
  } catch (cause) {
    if (cause instanceof AiProviderError) throw cause;
    const aborted = t.didTimeout() || opts.signal?.aborted;
    throw t.didTimeout()
      ? new AiProviderError('timeout', `${opts.provider}: request timed out after ${opts.timeoutMs}ms`, { provider: opts.provider, cause })
      : aborted
        ? new AiProviderError('timeout', `${opts.provider}: request aborted`, { provider: opts.provider, retryable: false, cause })
        : new AiProviderError('transport', `${opts.provider}: network error`, { provider: opts.provider, cause });
  } finally {
    t.cleanup();
  }
}

/** Cap on how much of an unparseable body we keep for triage (see {@link readJsonBody}). */
const MAX_RAW_BODY_CHARS = 1000;

/**
 * Issue #1602: THE single place the adapters turn a 2xx response body into JSON.
 *
 * `await res.json()` is two failures wearing one coat, and the taxonomy needs them apart:
 *
 *  1. The connection died before the body finished arriving. Rejects (a `TypeError` under
 *     undici, something else under another runtime) from the socket read. Retryable — the
 *     next attempt may land a whole body.
 *  2. The bytes all arrived and are not JSON. Deterministic — an HTML error page from an
 *     intercepting proxy, an empty 200, a payload the upstream cut short at the
 *     application layer. Re-requesting cannot change the answer.
 *
 * Splitting them on the thrown error's *type* is the tempting lever and the wrong one:
 * which native error `.json()` raises for which fault is a runtime implementation detail,
 * not a spec guarantee, and Campfire runs against undici plus whatever a self-hoster's
 * Node ships. So we split on *sequence* instead. Reading the body as text first isolates
 * fault (1) — `res.text()` is a raw socket read whose only failure mode is the transfer
 * not completing, exactly like `reader.read()` in {@link parseSse} (#1556). Once `text()`
 * resolves the transfer is provably complete, so a `JSON.parse` failure can only be
 * fault (2). The cost is one extra string copy on a body `.json()` would have buffered
 * whole anyway — `postJson` already pays it on the non-2xx path via `safeText`.
 *
 * The thrown message is sanitized (byte count, no content) because it reaches the table
 * verbatim as `turn.error.message`; the offending prefix goes to `rawBody` and the server
 * log, truncated, so a provider streaming megabytes of HTML cannot flood either.
 */
export async function readJsonBody<T>(res: FetchResponse, provider: string, signal?: AbortSignal): Promise<T> {
  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    // A guarded fetch already speaks the taxonomy — do not re-wrap and lose its kind.
    if (cause instanceof AiProviderError) throw cause;
    // The caller's signal firing mid-body is a CANCELLATION, not a fault — a seat
    // teardown or a stop control (#558). It must not be relabelled `transport`, because
    // `transport` is retryable and retrying would re-POST a generation the table just
    // cancelled. `postJson`'s fetch-throw branch draws the same line via `t.didTimeout()`,
    // but that lever is unavailable here: the TTFB timer is already cleared by the time
    // the body is read (#1063), so the caller's signal is the only remaining signal.
    if (signal?.aborted) {
      throw new AiProviderError('timeout', `${provider}: request aborted`, { provider, retryable: false, cause });
    }
    throw new AiProviderError('transport', `${provider}: connection closed before the response body was complete`, {
      provider,
      status: res.status,
      cause,
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    const rawBody = truncate(text, MAX_RAW_BODY_CHARS);
    httpLogger.warn(
      `requestId=${getRequestId() ?? 'none'} AI provider (${provider}) returned HTTP ${res.status} with a non-JSON body (${text.length} bytes). Raw body: ${rawBody}`,
    );
    throw new AiProviderError('invalid_response', `${provider}: response body was not valid JSON (${text.length} bytes)`, {
      provider,
      status: res.status,
      rawBody,
      cause,
    });
  }
}

async function safeText(res: FetchResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Options for {@link parseSse} — idle/read timeout + caller abort (#1063). */
export interface ParseSseOptions {
  /** Abort mid-read (driver idle watchdog / seat teardown). */
  signal?: AbortSignal;
  /**
   * Abort if `reader.read()` yields no chunk within this many ms. Defaults to
   * {@link DEFAULT_IDLE_TIMEOUT_MS}. Pass `0` to disable.
   */
  idleTimeoutMs?: number;
  /** Provider name for timeout error messages. */
  provider?: string;
}

/**
 * Race a promise against an AbortSignal and an optional idle timer. The idle timer is
 * armed for each call (so callers reset it per chunk). Rejects with `AiProviderError`
 * (`timeout`) when the idle deadline elapses or the signal aborts for an idle reason.
 */
export function raceRead<T>(
  read: Promise<T>,
  opts: {
    signal?: AbortSignal;
    idleTimeoutMs: number;
    provider: string;
    onIdle: () => void;
  },
): Promise<T> {
  const { signal, idleTimeoutMs, provider, onIdle } = opts;
  if (signal?.aborted) {
    onIdle();
    return Promise.reject(
      new AiProviderError('timeout', `${provider}: stream aborted`, { provider, retryable: false, cause: signal.reason }),
    );
  }
  if (idleTimeoutMs <= 0 && !signal) return read;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = () => {
      onIdle();
      finish(() =>
        reject(new AiProviderError('timeout', `${provider}: stream aborted`, { provider, retryable: false, cause: signal?.reason })),
      );
    };

    if (idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        onIdle();
        finish(() =>
          reject(
            new AiProviderError('timeout', `${provider}: stream idle for ${idleTimeoutMs}ms`, {
              provider,
              cause: new Error('stream idle timeout'),
            }),
          ),
        );
      }, idleTimeoutMs);
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    read.then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    );
  });
}

/**
 * Parse a byte stream of Server-Sent Events into `{ event, data }` records. Handles CRLF
 * or LF, multi-line `data:` accumulation, and blank-line dispatch. Adapters interpret the
 * `data` payload themselves (OpenAI: raw JSON or `[DONE]`; Anthropic: JSON keyed by `event`).
 *
 * Issue #1063: each `reader.read()` is bounded by an idle timeout (and the caller's
 * AbortSignal). The idle timer is NOT cleared until the stream fully completes or aborts —
 * it resets on every chunk so a healthy slow stream survives, but silence mid-body aborts.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  opts: ParseSseOptions = {},
): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | null = null;
  let dataLines: string[] = [];
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const provider = opts.provider ?? 'ai';

  const flush = function* (): Generator<{ event: string | null; data: string }> {
    if (dataLines.length === 0 && event === null) return;
    const data = dataLines.join('\n');
    const ev = event;
    event = null;
    dataLines = [];
    if (data.length > 0 || ev !== null) yield { event: ev, data };
  };

  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };

  try {
    for (;;) {
      const { value, done } = await raceRead(reader.read(), {
        signal: opts.signal,
        idleTimeoutMs,
        provider,
        onIdle: cancelReader,
      });
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      // Normalize CRLF, then split on LF.
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line === '') {
          yield* flush();
          continue;
        }
        if (line.startsWith(':')) continue; // comment/heartbeat
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? '' : line.slice(colon + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') dataLines.push(val);
        // other fields (id/retry) ignored
      }
    }
    // Dispatch any trailing event that wasn't newline-terminated.
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}
