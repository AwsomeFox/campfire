import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveRequestIdFromHeader } from './api-error.envelope';

/** Which transport stamped this request context. */
export type RequestTransport = 'rest' | 'mcp';

/**
 * Per-request correlation context (issue #684). Stored in AsyncLocalStorage so
 * audit rows, structured logs, MCP tool handlers, and provider retries all see
 * the same `requestId` without threading it through every call signature.
 */
export interface RequestContextStore {
  requestId: string;
  transport: RequestTransport;
  startedAt: number;
  actor?: string;
  campaignId?: number;
  tool?: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export function getRequestContext(): RequestContextStore | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Merge fields into the active store (no-op when no context is bound). */
export function patchRequestContext(patch: Partial<RequestContextStore>): void {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, patch);
}

export function runWithRequestContext<T>(store: RequestContextStore, fn: () => T): T {
  return storage.run(store, fn);
}

/**
 * Re-bind the current context for an explicit async handoff (timers, detached
 * promises) so background work started during a request keeps the correlation id.
 */
export function bindRequestContext<T extends (...args: never[]) => unknown>(fn: T): T {
  const store = storage.getStore();
  if (!store) return fn;
  return ((...args: Parameters<T>) => storage.run({ ...store }, () => fn(...args))) as T;
}

export function createRequestContext(opts: {
  inboundHeader?: string | string[];
  transport: RequestTransport;
}): RequestContextStore {
  return {
    requestId: resolveRequestIdFromHeader(opts.inboundHeader),
    transport: opts.transport,
    startedAt: Date.now(),
  };
}
