/**
 * Keep AuthProvider's /me memberships fresh when a DM promotes or demotes this
 * user (issue #437). Subscribes to campaign SSE while a campaign is open; on a
 * `membership.updated` for the signed-in user, refreshes /me and fans the signal
 * out to other tabs via BroadcastChannel. Does not navigate — the current route
 * stays put while role-gated chrome re-renders from the new memberships.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { CampaignEvent } from '@campfire/schema';
import { useAuth } from '../../app/auth';
import { useCampaignEvents } from '../../lib/useCampaignEvents';
import {
  openMembershipSyncChannel,
  type MembershipSyncMessage,
} from '../../lib/membershipLiveSync';

export function useMembershipLiveSync(campaignId: number | undefined): void {
  const { me, refresh } = useAuth();
  const userId = me?.user.id;
  const channelRef = useRef<BroadcastChannel | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Publish-only channel — AuthProvider owns the cross-tab listener so every
  // authenticated surface (including /screen outside Layout) refreshes /me.
  useEffect(() => {
    if (userId === undefined) return;
    const channel = openMembershipSyncChannel(userId);
    channelRef.current = channel;
    return () => {
      channel?.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [userId]);

  const onEvent = useCallback(
    (event: CampaignEvent) => {
      if (event.type !== 'membership.updated') return;
      if (userId === undefined || event.userId !== String(userId)) return;

      void refreshRef.current();

      const message: MembershipSyncMessage = {
        type: 'membership.updated',
        campaignId: event.campaignId,
        role: event.role,
      };
      try {
        channelRef.current?.postMessage(message);
      } catch {
        /* BroadcastChannel unavailable or closed — SSE refresh already ran. */
      }
    },
    [userId],
  );

  useCampaignEvents(campaignId, { onEvent });
}
