/**
 * Cross-tab membership/role-change fan-out (issue #437).
 *
 * The campaign SSE stream delivers `membership.updated` to tabs that have the
 * campaign open. Tabs on other routes (home, another campaign, /admin) have no
 * stream, so the receiving tab also posts on a per-user BroadcastChannel. Every
 * tab of this origin then refreshes /me so promote/demote chrome updates without
 * a reload — and without navigating away from the current route.
 */

export const MEMBERSHIP_SYNC_CHANNEL_PREFIX = 'campfire.membership.sync.';

export type MembershipSyncMessage = {
  type: 'membership.updated';
  campaignId: number;
  role: 'dm' | 'player' | 'viewer';
};

export function membershipSyncChannelName(userId: number): string {
  return `${MEMBERSHIP_SYNC_CHANNEL_PREFIX}${userId}`;
}

export function openMembershipSyncChannel(userId: number): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(membershipSyncChannelName(userId));
  } catch {
    return null;
  }
}

export function isMembershipSyncMessage(value: unknown): value is MembershipSyncMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === 'membership.updated'
    && typeof v.campaignId === 'number'
    && (v.role === 'dm' || v.role === 'player' || v.role === 'viewer')
  );
}
