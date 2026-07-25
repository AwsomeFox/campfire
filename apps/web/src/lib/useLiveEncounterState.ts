/**
 * Campaign-scoped running encounter lookup for chrome surfaces (dashboard chip,
 * mobile tab bar — issue #637). Best-effort: empty/failed fetch means no live
 * fight, not a page error. Callers should wire {@link refresh} to the Layout's
 * shared campaign SSE stream (useMembershipLiveSync) so encounter events keep
 * the pointer fresh without opening a second /campaigns/:id/events connection.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Encounter } from '@campfire/schema';
import { api, API } from './api';

export function useLiveEncounterState(campaignId: number | undefined): {
  liveEncounter: Encounter | null;
  refresh: () => Promise<void>;
} {
  const [projection, setProjection] = useState<{ campaignId: number; data: Encounter | null } | null>(null);
  const requestSequence = useRef(0);
  const activeCampaignId = useRef(campaignId);
  activeCampaignId.current = campaignId;

  const liveEncounter =
    campaignId !== undefined && projection?.campaignId === campaignId ? projection.data : null;

  const refresh = useCallback(async () => {
    if (campaignId === undefined || !Number.isFinite(campaignId)) return;
    const requestId = ++requestSequence.current;
    try {
      const running = await api.get<Encounter[]>(`${API}/campaigns/${campaignId}/encounters?status=running`);
      if (requestId !== requestSequence.current || activeCampaignId.current !== campaignId) return;
      setProjection({ campaignId, data: running[0] ?? null });
    } catch {
      if (requestId !== requestSequence.current || activeCampaignId.current !== campaignId) return;
      setProjection({ campaignId, data: null });
    }
  }, [campaignId]);

  useEffect(() => {
    if (campaignId === undefined) {
      setProjection(null);
      return;
    }
    // Defer the first fetch so campaign chrome (notifications polling, etc.) can
    // finish its own bootstrap before we add concurrent REST work on mount.
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [campaignId, refresh]);

  return { liveEncounter, refresh };
}
