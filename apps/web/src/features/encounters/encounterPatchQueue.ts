export type QueuedEncounterPatch = {
  encounterId: number;
  queueId: string;
  pendingKey: string;
  observedUpdatedAt?: string;
  patch: Record<string, unknown>;
};

/** Only an immediately repeated pending body is redundant; undo/redo may revisit an older one. */
export function isAdjacentDuplicateEncounterPatch(
  pending: Iterable<QueuedEncounterPatch>,
  encounterId: number,
  pendingKey: string,
): boolean {
  const entries = Array.from(pending);
  const latest = entries[entries.length - 1];
  return latest?.encounterId === encounterId && latest.pendingKey === pendingKey;
}

/**
 * A successful PATCH returns the server's full snapshot, which predates any locally queued
 * PATCHes. Retain those later optimistic values while adopting the returned revision token.
 */
export function reconcileEncounterPatchResponse<T extends object>(
  updated: T,
  pending: Iterable<QueuedEncounterPatch>,
  settledQueueId: string,
  encounterId: number,
): T {
  return Array.from(pending)
    .filter((entry) => entry.encounterId === encounterId && entry.queueId !== settledQueueId)
    .reduce<T>((snapshot, entry) => ({ ...snapshot, ...entry.patch }), updated);
}
