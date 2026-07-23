/**
 * Pure helpers for deciding when the app-root live region must be wiped
 * (issue #434). Kept free of React so the identity/campaign change matrix can
 * be unit-tested without mounting AnnounceProvider.
 */

export type AnnounceScope = {
  /** Authenticated user id, or null when signed out / unknown. */
  userId: number | null;
  /** Active `/c/:campaignId` scope, or undefined outside a campaign route. */
  campaignId: number | undefined;
};

/** True when the announcer's identity or campaign scope has changed. */
export function announceScopeChanged(prev: AnnounceScope, next: AnnounceScope): boolean {
  return prev.userId !== next.userId || prev.campaignId !== next.campaignId;
}
