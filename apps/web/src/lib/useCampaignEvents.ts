/**
 * Real-time campaign events over SSE (GET /campaigns/:id/events) — replaces the
 * old 5s polling loops (issue #4).
 *
 * Implemented with fetch + ReadableStream rather than native EventSource so the
 * request carries the exact same auth surface as lib/api.ts: the session cookie
 * (credentials: include) plus the dev-role override headers, which EventSource
 * cannot send. Events are thin invalidation signals
 * (`{ type, campaignId, ...entityIds }`) — consumers refetch through the normal
 * REST reads.
 *
 * Reconnects automatically with capped exponential backoff via the shared
 * {@link startSseReconnectLoop} helper (issue #800); after a drop is healed,
 * onReconnect fires so pages can refetch whatever they missed while offline.
 * Parser buffer-overrun recovery is separate ({@link CampaignEventsHandlers.onStreamRecovery})
 * — the TCP/HTTP connection stayed up. A proven 401 signals session expiry
 * (issue #885) and stops until reauth bumps the resume epoch; a campaign-scoped
 * 403 stops without clearing identity (retrying won't help).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { CampaignEvent } from '@campfire/schema';
import { API } from './api';
import { getSessionResumeEpoch, subscribeSessionResume } from './sessionExpiry';
import { startSseReconnectLoop, type SseStreamStatus } from './sseReconnect';

export interface CampaignEventsHandlers {
  onEvent: (event: CampaignEvent) => void;
  /** Fires after the stream reconnects following a transport drop — refetch to catch up. */
  onReconnect?: () => void;
  /**
   * Fires when the SSE parser discards mid-stream bytes (buffer overrun) while
   * the connection stays up. Distinct from {@link onReconnect}; wire the same
   * catch-up refetch when UI state may have skipped events.
   */
  onStreamRecovery?: () => void;
  /** Lets last-known-data surfaces distinguish a healthy stream from a dropped/offline one. */
  onStatusChange?: (status: CampaignEventsStatus) => void;
}

export type CampaignEventsStatus = SseStreamStatus;

/**
 * Runtime guard for the CampaignEvent union (issue #527 widened it to a
 * discriminated union; #582 added treasury.updated; #790 added schedule.updated;
 * #421 added character.updated; #437 added membership.updated).
 */
const ENCOUNTER_EVENT_TYPES = new Set(['encounter.updated', 'encounter.deleted', 'encounter.ping']);
function isCampaignEvent(value: unknown): value is CampaignEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string' || typeof v.campaignId !== 'number' || typeof v.at !== 'string') return false;
  if (ENCOUNTER_EVENT_TYPES.has(v.type)) {
    return typeof v.encounterId === 'number';
  }
  if (v.type === 'membership.revoked') {
    return typeof v.userId === 'string' && typeof v.memberId === 'number';
  }
  if (v.type === 'membership.updated') {
    return (
      typeof v.userId === 'string'
      && typeof v.memberId === 'number'
      && (v.role === 'dm' || v.role === 'player' || v.role === 'viewer')
    );
  }
  if (v.type === 'treasury.updated') {
    return typeof v.userId === 'string';
  }
  if (v.type === 'schedule.updated') {
    return typeof v.scheduleId === 'number';
  }
  if (v.type === 'character.updated') {
    return typeof v.characterId === 'number' && typeof v.userId === 'string';
  }
  return false;
}

export function useCampaignEvents(campaignId: number | undefined, handlers: CampaignEventsHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const resumeEpoch = useSyncExternalStore(subscribeSessionResume, getSessionResumeEpoch, () => 0);

  useEffect(() => {
    if (campaignId === undefined || !Number.isFinite(campaignId)) return;

    const loop = startSseReconnectLoop({
      url: `${API}/campaigns/${campaignId}/events`,
      trackBrowserOnline: true,
      onData: (data) => {
        try {
          const parsed: unknown = JSON.parse(data);
          if (isCampaignEvent(parsed)) handlersRef.current.onEvent(parsed);
        } catch {
          /* malformed frame — skip */
        }
      },
      onReconnect: () => handlersRef.current.onReconnect?.(),
      onStreamRecovery: () => handlersRef.current.onStreamRecovery?.(),
      onStatusChange: (status) => handlersRef.current.onStatusChange?.(status),
    });

    return () => loop.dispose();
  }, [campaignId, resumeEpoch]);
}
