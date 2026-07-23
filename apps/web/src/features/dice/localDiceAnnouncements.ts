/**
 * Cross-mount dedupe for campaign dice announcements (issue #590).
 * Character-card rolls (`useRoller`) and SharedDiceLog can both observe the same
 * roll id; remember local announces so the poll cursor does not re-speak them.
 */

const localAnnounced = new Map<number, Set<number>>();

export function rememberLocalDiceAnnouncement(campaignId: number, rollId: number): void {
  let set = localAnnounced.get(campaignId);
  if (!set) {
    set = new Set<number>();
    localAnnounced.set(campaignId, set);
  }
  set.add(rollId);
}

/** Snapshot + clear remembered local ids for a campaign (consumed by SharedDiceLog). */
export function takeLocalDiceAnnouncements(campaignId: number): Set<number> {
  const set = localAnnounced.get(campaignId);
  if (!set || set.size === 0) return new Set();
  localAnnounced.set(campaignId, new Set());
  return set;
}

export function clearLocalDiceAnnouncements(campaignId: number): void {
  localAnnounced.delete(campaignId);
}
