/**
 * In-memory TTL store for admin OIDC diagnostic login state (issue #848).
 *
 * Pending blobs include the client secret used for the probe, so they must not
 * live in the durable settings store / DB backups. Keyed by flow-token hash so
 * concurrent admin diagnostics do not overwrite each other.
 */
import { createHash } from 'node:crypto';
import type { OidcDiagnosticResolved } from './oidc.config';
import type { OidcTestResult } from '@campfire/schema';

export interface OidcTestPending {
  flowTokenHash: string;
  state: string;
  codeVerifier: string;
  candidate: OidcDiagnosticResolved;
  fingerprint: string;
  expiresAt: number;
}

type ProcessWithOidcDiag = NodeJS.Process & {
  __campfireOidcTestPending?: Map<string, OidcTestPending>;
  __campfireOidcTestLatestResult?: OidcTestResult | null;
};

function pendingMap(): Map<string, OidcTestPending> {
  const proc = process as ProcessWithOidcDiag;
  if (!proc.__campfireOidcTestPending) {
    proc.__campfireOidcTestPending = new Map();
  }
  return proc.__campfireOidcTestPending;
}

export function hashFlowToken(flowToken: string): string {
  return createHash('sha256').update(flowToken).digest('hex');
}

/** Drop expired entries. Safe to call on every access. */
export function purgeExpiredOidcTestPending(now = Date.now()): void {
  const store = pendingMap();
  for (const [hash, pending] of store) {
    if (pending.expiresAt < now) store.delete(hash);
  }
}

export function putOidcTestPending(pending: OidcTestPending): void {
  purgeExpiredOidcTestPending();
  pendingMap().set(pending.flowTokenHash, pending);
}

/** Peek without consuming — used to decide whether a callback is diagnostic. */
export function peekOidcTestPending(flowToken: string | undefined, now = Date.now()): OidcTestPending | null {
  if (!flowToken) return null;
  purgeExpiredOidcTestPending(now);
  const pending = pendingMap().get(hashFlowToken(flowToken));
  if (!pending) return null;
  if (pending.expiresAt < now) {
    pendingMap().delete(pending.flowTokenHash);
    return null;
  }
  return pending;
}

/**
 * Atomically take (remove) pending state for this flow token.
 * Prevents overlapping callbacks from racing on a shared pending slot.
 */
export function takeOidcTestPending(flowToken: string, now = Date.now()): OidcTestPending | null {
  const pending = peekOidcTestPending(flowToken, now);
  if (!pending) return null;
  pendingMap().delete(pending.flowTokenHash);
  return pending;
}

export function setLatestOidcTestResult(result: OidcTestResult | null): void {
  (process as ProcessWithOidcDiag).__campfireOidcTestLatestResult = result;
}

export function getLatestOidcTestResult(): OidcTestResult | null {
  return (process as ProcessWithOidcDiag).__campfireOidcTestLatestResult ?? null;
}

/** Test helper — clears process-scoped diagnostic state between unit cases. */
export function resetOidcTestPendingForTests(): void {
  const proc = process as ProcessWithOidcDiag;
  proc.__campfireOidcTestPending?.clear();
  proc.__campfireOidcTestLatestResult = null;
}
