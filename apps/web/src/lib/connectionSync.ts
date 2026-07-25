/**
 * Global read-connection sync state (issue #581).
 *
 * Tracks whether recent API reads succeeded, timed out (stale), or could not
 * reach the server. Layout surfaces this beside the offline-identity banner so
 * operators know when campaign data may be last-known.
 */

export type ConnectionSyncState = 'live' | 'stale' | 'offline' | 'connecting';

export type ConnectionSyncSnapshot = {
  state: ConnectionSyncState;
  /** Wall-clock ms of the last successful read, or null when never confirmed. */
  lastSyncAt: number | null;
};

let snapshot: ConnectionSyncSnapshot = { state: 'connecting', lastSyncAt: null };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getConnectionSyncSnapshot(): ConnectionSyncSnapshot {
  return snapshot;
}

export function subscribeConnectionSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reset for unit tests. */
export function __resetConnectionSyncForTests(): void {
  snapshot = { state: 'connecting', lastSyncAt: null };
  listeners.clear();
}

export function noteReadConnecting(): void {
  // Only show "connecting" before the first successful read — background polls
  // should not downgrade a live indicator (#581).
  if (snapshot.state === 'connecting' || snapshot.lastSyncAt != null) return;
  snapshot = { ...snapshot, state: 'connecting' };
  emit();
}

export function noteReadSuccess(at: number = Date.now()): void {
  snapshot = { state: 'live', lastSyncAt: at };
  emit();
}

/** A read timed out or failed transiently while last-known data may still render. */
export function noteReadStale(at: number = Date.now()): void {
  snapshot = {
    state: 'stale',
    lastSyncAt: snapshot.lastSyncAt ?? at,
  };
  emit();
}

/** Browser offline or proven unreachable (distinct from a single timed-out read). */
export function noteReadOffline(): void {
  snapshot = { ...snapshot, state: 'offline' };
  emit();
}
