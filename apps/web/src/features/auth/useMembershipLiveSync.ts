/**
 * Keep AuthProvider's /me memberships fresh when a DM promotes or demotes this
 * user (issue #437). Subscribes to campaign SSE while a campaign is open; on a
 * `membership.updated` for the signed-in user, refreshes /me and fans the signal
 * out to other tabs via BroadcastChannel. Does not navigate — the current route
 * stays put while role-gated chrome re-renders from the new memberships.
 *
 * Optional encounter hooks let Layout reuse this single stream for live-encounter
 * chrome (issue #637) instead of opening a second /campaigns/:id/events socket.
 *
 * `onRevoked` (issue #1640, widened by #1707) is the other half of membership change: unlike
 * a role change, a revocation — or the whole campaign being trashed — removes the membership
 * (or its meaning) entirely, so re-rendering chrome in place is not enough; the caller
 * (Layout) must move the user off this campaign. Wired to the SSE stream's `onForbidden`, not
 * to a `membership.revoked`/`campaign.trashed` frame: the server never puts either on the
 * data path (both are control signals that close the stream instead, #527/#867).
 *
 * The client-side observation this actually rests on is NOT uniformly "this stream 403'd" —
 * that was true only for revocation, and was wrong for trash until #1707: a still-a-member
 * subscriber reconnecting to a TRASHED campaign gets 404 from `assertLifecycleAccess`
 * (`campaign-access.service.ts`), by design, to keep a trashed campaign indistinguishable
 * from one that never existed. `useCampaignEvents.ts` now opts that 404 into the same
 * `onForbidden` callback via `treatNotFoundAsForbidden` (scoped to this one endpoint, not a
 * change to the shared 401/403 classifier — see its own doc comment). So the reliable
 * observation `onRevoked` actually rests on is "this campaign's stream terminated with a
 * proven, non-retryable connect failure" — 403 for revocation, 404 for trash — not "403"
 * specifically. Either way it fires within one reconnect attempt of the stream closing —
 * effectively immediate for a tab that has this campaign open, no polling wait.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CampaignEvent } from '@campfire/schema';
import { useAuth } from '../../app/auth';
import { useCampaignEvents } from '../../lib/useCampaignEvents';
import { invalidateCampaignCheckRequests } from '../../lib/query';
import {
  openMembershipSyncChannel,
  type MembershipSyncMessage,
} from '../../lib/membershipLiveSync';

export type MembershipLiveSyncOptions = {
  onEncounterChange?: () => void;
  onReconnect?: () => void;
  onStreamRecovery?: () => void;
  onRevoked?: () => void;
};

export function useMembershipLiveSync(
  campaignId: number | undefined,
  options?: MembershipLiveSyncOptions,
): void {
  const queryClient = useQueryClient();
  const { me, refresh } = useAuth();
  const userId = me?.user.id;
  const channelRef = useRef<BroadcastChannel | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const optionsRef = useRef(options);
  optionsRef.current = options;

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
      if (event.type === 'check.requested' || event.type === 'check.resolved') {
        invalidateCampaignCheckRequests(queryClient, event.campaignId);
      }
      if (event.type === 'encounter.updated' || event.type === 'encounter.deleted') {
        optionsRef.current?.onEncounterChange?.();
      }
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

  const onReconnect = useCallback(() => {
    optionsRef.current?.onReconnect?.();
  }, []);

  const onStreamRecovery = useCallback(() => {
    optionsRef.current?.onStreamRecovery?.();
  }, []);

  const onForbidden = useCallback(() => {
    optionsRef.current?.onRevoked?.();
  }, []);

  useCampaignEvents(campaignId, { onEvent, onReconnect, onStreamRecovery, onForbidden });
}
