export type QueuedEncounterPatch = {
  encounterId: number;
  queueId: string;
  pendingKey: string;
  observedUpdatedAt?: string;
  patch: Record<string, unknown>;
  previousValues?: Record<string, unknown>;
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
 * A later optimistic whole-value edit is composed over every earlier queued edit. It must
 * retain that queue's original CAS base rather than adopting a remote poll's revision while
 * its predecessor may still fail. A successful predecessor supplies its newer revision at
 * dispatch time; a failed one leaves this original token to produce STALE_WRITE safely.
 */
export function observedEncounterPatchRevision(
  pending: Iterable<QueuedEncounterPatch>,
  encounterId: number,
  currentRevision?: string,
): string | undefined {
  const entries = Array.from(pending);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.encounterId === encounterId && entry.observedUpdatedAt !== undefined) return entry.observedUpdatedAt;
  }
  return currentRevision;
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

/**
 * When an encounter patch mutation fails, remove its optimistic patch from the query cache.
 * Any key modified by the failed patch is restored to its previous value unless another
 * remaining queued patch also modifies that key.
 */
export function rollbackEncounterPatchError<T extends object>(
  current: T,
  failedEntry: QueuedEncounterPatch,
  remainingPending: Iterable<QueuedEncounterPatch>,
  encounterId: number,
): T {
  if (!current || failedEntry.encounterId !== encounterId || !failedEntry.previousValues) return current;
  const remaining = Array.from(remainingPending).filter(
    (entry) => entry.encounterId === encounterId && entry.queueId !== failedEntry.queueId,
  );

  const updated = { ...current };
  for (const [key, prevVal] of Object.entries(failedEntry.previousValues)) {
    const overridingEntry = remaining.find((entry) => Object.prototype.hasOwnProperty.call(entry.patch, key));
    if (overridingEntry) {
      (updated as Record<string, unknown>)[key] = overridingEntry.patch[key];
    } else {
      (updated as Record<string, unknown>)[key] = prevVal;
    }
  }
  return updated;
}
