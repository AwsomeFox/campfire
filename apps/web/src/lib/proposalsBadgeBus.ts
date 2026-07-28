/**
 * Issue #1646 — lets a page that files proposals WITHOUT navigating away (the inbox
 * sweep control) bump Layout's "Proposals" nav badge immediately, instead of waiting
 * for the next route change to re-poll GET /campaigns/:id/proposals?status=pending.
 *
 * Deliberately a plain in-memory pub/sub rather than new React context: Layout already
 * owns the `pendingProposals` count as local state (see Layout.tsx's badge effects),
 * so this only needs to notify it of a delta — no shared value to read, nothing to
 * thread through providers. Module-scoped listeners are fine here because there is at
 * most one Layout mounted at a time; a listener that outlives its component is a no-op
 * once nothing calls the returned unsubscribe is skipped (Layout always unsubscribes
 * on unmount).
 */
type BumpListener = (delta: number) => void;

const listeners = new Set<BumpListener>();

/** Called by a producer (e.g. InboxPage after a sweep) once N proposals were filed. */
export function bumpPendingProposalsBadge(delta: number): void {
  if (delta <= 0) return;
  for (const listener of listeners) listener(delta);
}

/** Called by Layout to subscribe; returns an unsubscribe function. */
export function onPendingProposalsBadgeBump(listener: BumpListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
