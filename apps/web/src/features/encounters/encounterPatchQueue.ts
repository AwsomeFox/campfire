export type QueuedEncounterPatch = {
  encounterId: number;
  pendingKey: string;
  patch: Record<string, unknown>;
};

/**
 * A successful PATCH returns the server's full snapshot, which predates any locally queued
 * PATCHes. Retain those later optimistic values while adopting the returned revision token.
 */
export function reconcileEncounterPatchResponse<T extends object>(
  updated: T,
  pending: Iterable<QueuedEncounterPatch>,
  settledPendingKey: string,
  encounterId: number,
): T {
  return Array.from(pending)
    .filter((entry) => entry.encounterId === encounterId && entry.pendingKey !== settledPendingKey)
    .reduce<T>((snapshot, entry) => ({ ...snapshot, ...entry.patch }), updated);
}
