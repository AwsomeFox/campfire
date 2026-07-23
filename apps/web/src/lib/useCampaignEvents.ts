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
 * Reconnects automatically with capped exponential backoff; after a drop is
 * healed, onReconnect fires so pages can refetch whatever they missed while
 * offline. Parser buffer-overrun recovery is separate ({@link CampaignEventsHandlers.onStreamRecovery})
 * — the TCP/HTTP connection stayed up. A proven 401 signals session expiry
 * (issue #885) and stops until reauth bumps the resume epoch; a campaign-scoped
 * 403 stops without clearing identity (retrying won't help).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { CampaignEvent } from '@campfire/schema';
import { API } from './api';
import {
  classifyStreamConnectStatus,
  getSessionResumeEpoch,
  signalSessionExpired,
  subscribeSessionResume,
} from './sessionExpiry';
import { SseParser, type SseParseSignal } from './sseParse';

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

export type CampaignEventsStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'stopped';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;

/**
 * Runtime guard for the CampaignEvent union (issue #527 widened it to a
 * discriminated union; #582 added treasury.updated; #790 added schedule.updated;
 * #421 added character.updated).
 * Accepts every variant: the
 * encounter.* signals carry an encounterId; membership.revoked carries
 * userId/memberId; treasury.updated carries userId (the actor); schedule.updated
 * carries scheduleId; character.updated carries characterId + userId. Consumers
 * narrow by `type` before reading variant-specific fields (see RunSessionPage
 * and DashboardPage).
 *
 * Note: the server filters membership.revoked out of the data path as an internal
 * control signal, so in practice this client sees encounter.*, treasury.updated,
 * schedule.updated, and character.updated frames — but validating the full union
 * here keeps the guard correct if that filtering ever changes, and lets the type
 * system prove that `onEvent` callbacks handle every variant (or explicitly narrow).
 */
const ENCOUNTER_EVENT_TYPES = new Set(['encounter.updated', 'encounter.deleted', 'encounter.ping']);
function isCampaignEvent(value: unknown): value is CampaignEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  // Common to every variant: a known type, a numeric campaignId, and a string `at`
  // timestamp. Validating `at` here keeps the predicate honest about the full union
  // shape (every CampaignEvent variant requires it) rather than only checking the
  // discriminant + campaignId.
  if (typeof v.type !== 'string' || typeof v.campaignId !== 'number' || typeof v.at !== 'string') return false;
  if (ENCOUNTER_EVENT_TYPES.has(v.type)) {
    // encounter.* variants: require encounterId. The ping variant additionally
    // carries a `ping` payload whose shape (MapPing) is NOT validated client-side
    // — the server is authoritative on frame shape, and a malformed ping would
    // simply be ignored by addPing rather than crash. So the guard narrows to the
    // CampaignEvent type on the fields the client actually reads.
    return typeof v.encounterId === 'number';
  }
  if (v.type === 'membership.revoked') {
    // membership.revoked: userId + memberId instead of encounterId.
    return typeof v.userId === 'string' && typeof v.memberId === 'number';
  }
  if (v.type === 'treasury.updated') {
    // treasury.updated (#582): the actor's userId so the editor can attribute the
    // change and ignore the echo of its own write. No coin payload — the client
    // refetches the permission-checked REST read on receipt.
    return typeof v.userId === 'string';
  }
  if (v.type === 'schedule.updated') {
    // Issue #790: schedule writes carry only the changed row id. Consumers refetch
    // the authoritative projection rather than accepting schedule details over SSE.
    return typeof v.scheduleId === 'number';
  }
  if (v.type === 'character.updated') {
    // Issue #421: sheet invalidation — characterId + actor userId, no encounterId.
    return typeof v.characterId === 'number' && typeof v.userId === 'string';
  }
  return false;
}

export function useCampaignEvents(campaignId: number | undefined, handlers: CampaignEventsHandlers): void {
  // Latest handlers in a ref so a re-render never tears down the connection.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  // After a 401 stop, reauth bumps this epoch so the effect reopens the stream
  // even when campaignId is unchanged (issue #885).
  const resumeEpoch = useSyncExternalStore(subscribeSessionResume, getSessionResumeEpoch, () => 0);

  useEffect(() => {
    if (campaignId === undefined || !Number.isFinite(campaignId)) return;

    let disposed = false;
    let activeRequest: AbortController | null = null;
    let wakeSleep: (() => void) | null = null;
    let status: CampaignEventsStatus | null = null;
    let needsCatchUp = !navigator.onLine;

    const setStatus = (next: CampaignEventsStatus) => {
      if (status === next || disposed) return;
      status = next;
      handlersRef.current.onStatusChange?.(next);
    };

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(handle);
          window.removeEventListener('online', finish);
          if (wakeSleep === finish) wakeSleep = null;
          resolve();
        };
        const handle = setTimeout(finish, ms);
        wakeSleep = finish;
        window.addEventListener('online', finish, { once: true });
        if (disposed) finish();
      });

    const onOffline = () => {
      needsCatchUp = true;
      setStatus('offline');
      // Force the current reader to settle so the retry loop can wait for `online`
      // and then open a fresh permission-checked stream.
      activeRequest?.abort();
    };
    window.addEventListener('offline', onOffline);
    setStatus(navigator.onLine ? 'connecting' : 'offline');

    (async () => {
      let attempt = 0;
      while (!disposed) {
        if (!navigator.onLine) {
          setStatus('offline');
          await sleep(RECONNECT_MAX_MS);
          continue;
        }
        try {
          activeRequest = new AbortController();
          const headers: Record<string, string> = { accept: 'text/event-stream' };
          const devRole = localStorage.getItem('cf.devRole');
          const devUser = localStorage.getItem('cf.devUser');
          if (devRole) headers['x-dev-role'] = devRole;
          if (devUser) headers['x-dev-user'] = devUser;

          const res = await fetch(`${API}/campaigns/${campaignId}/events`, {
            credentials: 'include',
            headers,
            signal: activeRequest.signal,
          });
          const auth = classifyStreamConnectStatus(res.status);
          if (auth === 'session-expired') {
            // Proven 401 — not offline, not a campaign 403. Fan out so AuthProvider
            // can show reauth; stop until resumeEpoch advances after login.
            signalSessionExpired();
            setStatus('stopped');
            return;
          }
          if (auth === 'forbidden') {
            setStatus('stopped');
            return;
          }
          if (!res.ok || !res.body) throw new Error(`SSE connect failed (${res.status})`);

          const reconnected = needsCatchUp;
          attempt = 0;
          needsCatchUp = false;
          setStatus('connected');
          if (reconnected) handlersRef.current.onReconnect?.();

          const reader = res.body.getReader();
          // Incremental SSE parser (#748): CRLF/CR/LF frames, heartbeats, multiline
          // data, UTF-8 chunk splits, and bounded recovery for malformed streams.
          const parser = new SseParser();
          const consume = (signals: SseParseSignal[]) => {
            for (const signal of signals) {
              if (signal.kind === 'recovered') {
                // Parser discarded mid-stream bytes — connection stays up, but
                // UI may have missed events. Not a transport reconnect.
                needsCatchUp = true;
                if (!disposed) handlersRef.current.onStreamRecovery?.();
                continue;
              }
              const data = signal.message.data;
              if (!data) continue;
              try {
                const parsed: unknown = JSON.parse(data);
                // Keepalive pings and unknown future event types are ignored here.
                if (isCampaignEvent(parsed) && !disposed) handlersRef.current.onEvent(parsed);
              } catch {
                /* malformed JSON payload — skip */
              }
            }
          };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              consume(parser.flush());
              break;
            }
            consume(parser.push(value));
          }
          // Server closed the stream cleanly (e.g. restart) — fall through to reconnect.
          throw new Error('SSE stream ended');
        } catch {
          if (disposed) return;
          needsCatchUp = true;
          setStatus(navigator.onLine ? 'reconnecting' : 'offline');
          await sleep(Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS));
          attempt += 1;
        } finally {
          activeRequest = null;
        }
      }
    })();

    return () => {
      disposed = true;
      window.removeEventListener('offline', onOffline);
      wakeSleep?.();
      activeRequest?.abort();
    };
  }, [campaignId, resumeEpoch]);
}
