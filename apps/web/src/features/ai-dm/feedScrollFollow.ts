/**
 * Transcript / feed scroll follow helpers (issue #590).
 *
 * Pure functions only — Playwright unit specs pin follow-vs-read-history behaviour
 * without a browser (mirrors combatLogAccessibility / narrationAccessibility).
 */

export const FEED_NEAR_BOTTOM_PX = 48;

export function isFeedNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = FEED_NEAR_BOTTOM_PX,
): boolean {
  if (scrollHeight <= clientHeight) return true;
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/** Unread count after the feed grows while the reader is not pinned to the tail. */
export function unreadAfterFeedGrowth(
  unread: number,
  followLatest: boolean,
  previousEntryCount: number,
  nextEntryCount: number,
): number {
  const delta = Math.max(0, nextEntryCount - previousEntryCount);
  if (delta === 0) return unread;
  if (followLatest) return 0;
  return unread + delta;
}

/** Whether a user scroll gesture should pin follow mode to the tail. */
export function followLatestAfterUserScroll(nearBottom: boolean): boolean {
  return nearBottom;
}
