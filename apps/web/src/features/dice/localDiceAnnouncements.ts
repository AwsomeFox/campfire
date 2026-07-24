/**
 * Cross-mount dedupe for campaign dice announcements (issue #590).
 * Character-card rolls (`useRoller`) and SharedDiceLog can both observe the same
 * roll id; remember local announces so the poll cursor does not re-speak them.
 *
 * Bounded per campaign: only recent ids need to survive until the next SharedDiceLog
 * poll (seconds). Caps prevent growth when SharedDiceLog is never mounted.
 */

const MAX_LOCAL_ANNOUNCED_PER_CAMPAIGN = 64;

const localAnnounced = new Map<number, Set<number>>();

export function rememberLocalDiceAnnouncement(campaignId: number, rollId: number): void {
  let set = localAnnounced.get(campaignId);
  if (!set) {
    set = new Set<number>();
    localAnnounced.set(campaignId, set);
  }
  set.add(rollId);
  while (set.size > MAX_LOCAL_ANNOUNCED_PER_CAMPAIGN) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/** Snapshot + clear remembered local ids for a campaign (consumed by SharedDiceLog). */
export function takeLocalDiceAnnouncements(campaignId: number): Set<number> {
  const set = localAnnounced.get(campaignId);
  if (!set || set.size === 0) return new Set();
  localAnnounced.delete(campaignId);
  return set;
}

export function clearLocalDiceAnnouncements(campaignId: number): void {
  localAnnounced.delete(campaignId);
}
