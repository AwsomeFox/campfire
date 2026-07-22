/**
 * Real-time campaign events over SSE (GET /campaigns/:id/events) — replaces the
 * old 5s polling loops (issue #4).
 *
 * Implemented with fetch + ReadableStream rather than native EventSource so the
 * request carries the exact same auth surface as lib/api.ts: the session cookie
 * (credentials: include) plus the dev-role override headers, which EventSource
 * cannot send. Events are thin invalidation signals ({type, campaignId,
 * encounterId}) — consumers refetch through the normal REST reads.
 *
 * Reconnects automatically with capped exponential backoff; after a drop is
 * healed, onReconnect fires so pages can refetch whatever they missed while
 * offline. A 401/403 stops the loop entirely (no access — retrying won't help).
 */
import { useEffect, useRef } from 'react';
import type { CampaignEvent } from '@campfire/schema';
import { API } from './api';

export interface CampaignEventsHandlers {
  onEvent: (event: CampaignEvent) => void;
  /** Fires after the stream reconnects following a drop — refetch to catch up. */
  onReconnect?: () => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;

/**
 * Runtime guard for the CampaignEvent union (issue #527 widened it to a
 * discriminated union). Accepts every variant: the encounter.* signals carry an
 * encounterId; membership.revoked carries userId/memberId instead. Consumers
 * narrow by `type` before reading variant-specific fields (see RunSessionPage).
 *
 * Note: the server filters membership.revoked out of the data path as an internal
 * control signal, so in practice this client only ever sees encounter.* frames —
 * but validating the full union here keeps the guard correct if that filtering
 * ever changes, and lets the type system prove that `onEvent` callbacks handle
 * every variant (or explicitly narrow).
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
  return false;
}

/** Extracts the concatenated `data:` payload of one SSE event block. */
function sseBlockData(block: string): string {
  return block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');
}

export function useCampaignEvents(campaignId: number | undefined, handlers: CampaignEventsHandlers): void {
  // Latest handlers in a ref so a re-render never tears down the connection.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (campaignId === undefined || !Number.isFinite(campaignId)) return;

    const controller = new AbortController();
    let disposed = false;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, ms);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(handle);
          resolve();
        });
      });

    (async () => {
      let attempt = 0;
      while (!disposed) {
        try {
          const headers: Record<string, string> = { accept: 'text/event-stream' };
          const devRole = localStorage.getItem('cf.devRole');
          const devUser = localStorage.getItem('cf.devUser');
          if (devRole) headers['x-dev-role'] = devRole;
          if (devUser) headers['x-dev-user'] = devUser;

          const res = await fetch(`${API}/campaigns/${campaignId}/events`, {
            credentials: 'include',
            headers,
            signal: controller.signal,
          });
          if (res.status === 401 || res.status === 403) return;
          if (!res.ok || !res.body) throw new Error(`SSE connect failed (${res.status})`);

          if (attempt > 0) handlersRef.current.onReconnect?.();
          attempt = 0;

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep: number;
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
              const data = sseBlockData(buffer.slice(0, sep));
              buffer = buffer.slice(sep + 2);
              if (!data) continue;
              try {
                const parsed: unknown = JSON.parse(data);
                // Keepalive pings and unknown future event types are ignored here.
                if (isCampaignEvent(parsed) && !disposed) handlersRef.current.onEvent(parsed);
              } catch {
                /* malformed frame — skip */
              }
            }
          }
          // Server closed the stream cleanly (e.g. restart) — fall through to reconnect.
          throw new Error('SSE stream ended');
        } catch {
          if (disposed || controller.signal.aborted) return;
          await sleep(Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS));
          attempt += 1;
        }
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [campaignId]);
}
