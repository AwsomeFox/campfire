/**
 * Bounded fetch budgets for the API client (issue #581).
 *
 * Reads fail fast so the UI can fall back to last-known / SW-cached data.
 * Mutations use longer budgets and surface an ambiguous outcome on timeout so
 * operators never assume a write failed when it may have committed.
 */

/** Read GET/HEAD: connect, time-to-headers, and full round-trip caps. */
export const API_READ_BUDGET = {
  connectMs: 8_000,
  headersMs: 15_000,
  overallMs: 30_000,
} as const;

/** POST/PATCH/PUT/DELETE JSON bodies. */
export const API_WRITE_BUDGET = {
  connectMs: 10_000,
  overallMs: 120_000,
} as const;

/** Large attachment uploads — separate from ordinary writes. */
export const API_UPLOAD_BUDGET = {
  connectMs: 15_000,
  overallMs: 5 * 60_000,
} as const;

/** SSE / long-lived streams: only bound the initial connect handshake. */
export const API_STREAM_BUDGET = {
  connectMs: 15_000,
} as const;

export type ApiBudgetKind = 'read' | 'write' | 'upload' | 'stream';

export type ApiFetchBudget =
  | typeof API_READ_BUDGET
  | typeof API_WRITE_BUDGET
  | typeof API_UPLOAD_BUDGET
  | typeof API_STREAM_BUDGET;

export type ReadTimeoutPhase = 'connect' | 'headers' | 'overall';

/** Thrown when a read budget elapses. Surfaces as `name === 'TimeoutError'`. */
export class ApiReadTimeoutError extends Error {
  readonly name = 'TimeoutError';

  constructor(
    public readonly phase: ReadTimeoutPhase,
    message?: string,
  ) {
    super(message ?? `Read timed out (${phase})`);
  }
}

/**
 * Thrown when a mutation budget elapses. The server may still have applied the
 * change — callers must not treat this as a clean failure.
 */
export class ApiAmbiguousMutationError extends Error {
  readonly name = 'AmbiguousMutationError';

  constructor(message = 'Request timed out — the change may still have been saved.') {
    super(message);
  }
}

export function isReadTimeout(err: unknown): err is ApiReadTimeoutError {
  return err instanceof ApiReadTimeoutError;
}

export function isAmbiguousMutation(err: unknown): err is ApiAmbiguousMutationError {
  return err instanceof ApiAmbiguousMutationError;
}

function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const onAbort = () => target.abort(source.reason);
  source.addEventListener('abort', onAbort);
  return () => source.removeEventListener('abort', onAbort);
}

type TimerPhase = ReadTimeoutPhase | 'write-overall' | 'upload-overall' | 'stream-connect';

function armTimer(
  ms: number,
  phase: TimerPhase,
  controller: AbortController,
  onFire: (phase: TimerPhase) => void,
): () => void {
  if (ms <= 0) return () => {};
  const handle = globalThis.setTimeout(() => {
    onFire(phase);
    controller.abort(phase);
  }, ms);
  return () => globalThis.clearTimeout(handle);
}

/**
 * `fetch` with layered budgets. Caller `signal` aborts win over budget aborts.
 */
export async function fetchWithBudget(
  url: string,
  init: RequestInit,
  kind: ApiBudgetKind,
  budget: ApiFetchBudget,
): Promise<Response> {
  const budgetController = new AbortController();
  const unlinkCaller = init.signal ? linkAbortSignal(init.signal, budgetController) : () => {};

  let firedPhase: TimerPhase | null = null;
  const onFire = (phase: TimerPhase) => {
    if (firedPhase == null) firedPhase = phase;
  };

  const clearTimers: Array<() => void> = [];
  if (kind === 'read') {
    const readBudget = budget as typeof API_READ_BUDGET;
    clearTimers.push(armTimer(readBudget.connectMs, 'connect', budgetController, onFire));
    clearTimers.push(armTimer(readBudget.headersMs, 'headers', budgetController, onFire));
    clearTimers.push(armTimer(readBudget.overallMs, 'overall', budgetController, onFire));
  } else if (kind === 'write') {
    const writeBudget = budget as typeof API_WRITE_BUDGET;
    // fetch exposes no connect/first-byte hook — overallMs bounds the full mutation.
    clearTimers.push(armTimer(writeBudget.overallMs, 'write-overall', budgetController, onFire));
  } else if (kind === 'upload') {
    const uploadBudget = budget as typeof API_UPLOAD_BUDGET;
    clearTimers.push(armTimer(uploadBudget.overallMs, 'upload-overall', budgetController, onFire));
  } else if (kind === 'stream') {
    const streamBudget = budget as typeof API_STREAM_BUDGET;
    clearTimers.push(armTimer(streamBudget.connectMs, 'stream-connect', budgetController, onFire));
  }

  const clearAll = () => {
    for (const clear of clearTimers) clear();
    unlinkCaller();
  };

  try {
    const res = await fetch(url, { ...init, signal: budgetController.signal });
    clearAll();
    return res;
  } catch (error) {
    clearAll();
    if (init.signal?.aborted) throw error;
    if (!budgetController.signal.aborted) throw error;

    if (kind === 'read') {
      const phase: ReadTimeoutPhase =
        firedPhase === 'connect' || firedPhase === 'headers' || firedPhase === 'overall'
          ? firedPhase
          : 'overall';
      throw new ApiReadTimeoutError(phase);
    }
    throw new ApiAmbiguousMutationError();
  }
}

/** Classify a request path/method into a budget kind. */
export function apiBudgetKind(method: string, init?: RequestInit): ApiBudgetKind {
  const upper = method.toUpperCase();
  if (upper === 'GET' || upper === 'HEAD') return 'read';
  const body = init?.body;
  if (body instanceof FormData || body instanceof Blob) return 'upload';
  return 'write';
}

export function budgetForKind(kind: ApiBudgetKind): ApiFetchBudget {
  switch (kind) {
    case 'read':
      return API_READ_BUDGET;
    case 'write':
      return API_WRITE_BUDGET;
    case 'upload':
      return API_UPLOAD_BUDGET;
    case 'stream':
      return API_STREAM_BUDGET;
  }
}
