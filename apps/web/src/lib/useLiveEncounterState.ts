/**
 * Campaign-scoped running encounter lookup for chrome surfaces (dashboard chip,
 * mobile tab bar — issue #637). Best-effort: empty/failed fetch means no live
 * fight, not a page error. SSE encounter events keep the pointer fresh.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Encounter } from '@campfire/schema';
import { api, API } from './api';
import { useCampaignEvents } from './useCampaignEvents';

export function useLiveEncounterState(campaignId: number | undefined): Encounter | null {
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
    void refresh();
  }, [campaignId, refresh]);

  useCampaignEvents(campaignId, {
    onEvent: useCallback((event) => {
      if (event.type === 'encounter.updated' || event.type === 'encounter.deleted') {
        void refresh();
      }
    }, [refresh]),
    onReconnect: useCallback(() => {
      void refresh();
    }, [refresh]),
    onStreamRecovery: useCallback(() => {
      void refresh();
    }, [refresh]),
  });

  return liveEncounter;
}
