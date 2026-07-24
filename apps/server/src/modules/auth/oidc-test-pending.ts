/**
 * Shared TTL store for admin OIDC diagnostic login state (issue #848).
 *
 * Pending blobs include the client secret used for the probe, so they must not
 * live in the durable settings store / DB backups. Keyed by flow-token hash so
 * concurrent admin diagnostics do not overwrite each other.
 *
 * Persistence: a 0600 JSON file under DATA_DIR (outside the SQLite backup
 * bundle) so POST test-login, the IdP callback, and GET test-login/result stay
 * coherent across multiple Node processes sharing the same data volume.
 * Unit tests keep an in-memory map only (no file I/O).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OidcDiagnosticResolved } from './oidc.config';
import type { OidcTestResult } from '@campfire/schema';
import { resolveDataDir } from '../../db/db.module';

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
  __campfireOidcTestPendingFileDisabled?: boolean;
};

type PendingFileStore = {
  pending: Record<string, OidcTestPending>;
  latest: OidcTestResult | null;
};

function pendingMap(): Map<string, OidcTestPending> {
  const proc = process as ProcessWithOidcDiag;
  if (!proc.__campfireOidcTestPending) {
    proc.__campfireOidcTestPending = new Map();
  }
  return proc.__campfireOidcTestPending;
}

function fileStoreEnabled(): boolean {
  const proc = process as ProcessWithOidcDiag;
  if (proc.__campfireOidcTestPendingFileDisabled) return false;
  // Unit specs stay process-local; production / e2e share DATA_DIR.
  return process.env.NODE_ENV !== 'test';
}

function storePath(): string {
  return path.join(resolveDataDir(), 'oidc-test-pending.json');
}

function readFileStore(): PendingFileStore {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as PendingFileStore;
    return {
      pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
      latest: parsed.latest ?? null,
    };
  } catch {
    return { pending: {}, latest: null };
  }
}

function writeFileStore(store: PendingFileStore): void {
  const dir = resolveDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = storePath();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600, encoding: 'utf8' });
  fs.renameSync(tmp, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // best-effort on platforms that ignore mode
  }
}

function hydrateFromFile(): void {
  if (!fileStoreEnabled()) return;
  const store = readFileStore();
  const map = pendingMap();
  map.clear();
  for (const [hash, pending] of Object.entries(store.pending)) {
    map.set(hash, pending);
  }
  (process as ProcessWithOidcDiag).__campfireOidcTestLatestResult = store.latest;
}

function persistToFile(): void {
  if (!fileStoreEnabled()) return;
  const pending: Record<string, OidcTestPending> = {};
  for (const [hash, value] of pendingMap()) {
    pending[hash] = value;
  }
  writeFileStore({
    pending,
    latest: (process as ProcessWithOidcDiag).__campfireOidcTestLatestResult ?? null,
  });
}

export function hashFlowToken(flowToken: string): string {
  return createHash('sha256').update(flowToken).digest('hex');
}

/** Drop expired entries. Safe to call on every access. */
export function purgeExpiredOidcTestPending(now = Date.now()): void {
  hydrateFromFile();
  const store = pendingMap();
  let changed = false;
  for (const [hash, pending] of store) {
    if (pending.expiresAt < now) {
      store.delete(hash);
      changed = true;
    }
  }
  if (changed) persistToFile();
}

export function putOidcTestPending(pending: OidcTestPending): void {
  purgeExpiredOidcTestPending();
  pendingMap().set(pending.flowTokenHash, pending);
  persistToFile();
}

/** Peek without consuming — used to decide whether a callback is diagnostic. */
export function peekOidcTestPending(flowToken: string | undefined, now = Date.now()): OidcTestPending | null {
  if (!flowToken) return null;
  purgeExpiredOidcTestPending(now);
  const pending = pendingMap().get(hashFlowToken(flowToken));
  if (!pending) return null;
  if (pending.expiresAt < now) {
    pendingMap().delete(pending.flowTokenHash);
    persistToFile();
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
  persistToFile();
  return pending;
}

export function setLatestOidcTestResult(result: OidcTestResult | null): void {
  hydrateFromFile();
  (process as ProcessWithOidcDiag).__campfireOidcTestLatestResult = result;
  persistToFile();
}

export function getLatestOidcTestResult(): OidcTestResult | null {
  hydrateFromFile();
  return (process as ProcessWithOidcDiag).__campfireOidcTestLatestResult ?? null;
}

/** Test helper — clears process-scoped diagnostic state between unit cases. */
export function resetOidcTestPendingForTests(): void {
  const proc = process as ProcessWithOidcDiag;
  proc.__campfireOidcTestPending?.clear();
  proc.__campfireOidcTestLatestResult = null;
  proc.__campfireOidcTestPendingFileDisabled = true;
}
