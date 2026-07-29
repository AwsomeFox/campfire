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
 *
 * campaignId is the originating campaign (issue #1679 review): a sweep started on
 * campaign A can resolve after the DM has already switched to campaign B, and without
 * it the bump would land on whichever campaign Layout currently displays — inflating
 * B's badge with a count that belongs to A. Layout ignores bumps whose campaignId
 * doesn't match the one it's currently showing.
 */
type BumpListener = (delta: number, campaignId: number) => void;

const proposalListeners = new Set<BumpListener>();

/** Called by a producer (e.g. InboxPage after a sweep) once N proposals were filed. */
export function bumpPendingProposalsBadge(delta: number, campaignId: number): void {
  if (delta <= 0) return;
  for (const listener of proposalListeners) listener(delta, campaignId);
}

/** Called by Layout to subscribe to delta bumps; returns an unsubscribe function. */
export function onPendingProposalsBadgeBump(listener: BumpListener): () => void {
  proposalListeners.add(listener);
  return () => proposalListeners.delete(listener);
}

/**
 * Same campaign-scoped absolute count pattern as `setInboxCountBadge`: after a sweep
 * the page can hand Layout the authoritative pending total it just fetched, rather
 * than relying on a delta that can be mis-attributed across concurrent sweeps.
 */
type SetProposalsListener = (total: number, campaignId: number) => void;

const proposalSetListeners = new Set<SetProposalsListener>();

/** Called by a producer with the authoritative pending proposals count. */
export function setPendingProposalsBadge(total: number, campaignId: number): void {
  for (const listener of proposalSetListeners) listener(total, campaignId);
}

/** Called by Layout to subscribe to absolute counts; returns an unsubscribe function. */
export function onPendingProposalsBadgeSet(listener: SetProposalsListener): () => void {
  proposalSetListeners.add(listener);
  return () => proposalSetListeners.delete(listener);
}

/**
 * Same problem, the inbox count's own badge (issue #1679 review): Layout's `inboxCount`
 * only re-fetches on campaignId/isDm/location.pathname change, none of which fire when
 * a sweep resolves items while the DM stays on /inbox — the sidebar count is stale until
 * the next route change. Unlike the proposals bus this carries an absolute count, not a
 * delta: InboxPage already has the authoritative post-sweep total from its own reload,
 * so there is no drift risk in just handing that number over directly.
 */
type InboxCountListener = (total: number, campaignId: number) => void;

const inboxCountListeners = new Set<InboxCountListener>();

/** Called by a producer (e.g. InboxPage after its post-sweep reload) with the fresh open total. */
export function setInboxCountBadge(total: number, campaignId: number): void {
  for (const listener of inboxCountListeners) listener(total, campaignId);
}

/** Called by Layout to subscribe; returns an unsubscribe function. */
export function onInboxCountBadgeSet(listener: InboxCountListener): () => void {
  inboxCountListeners.add(listener);
  return () => inboxCountListeners.delete(listener);
}
