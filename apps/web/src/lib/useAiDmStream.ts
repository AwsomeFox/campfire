/**
 * AI-DM narration stream over SSE (GET /campaigns/:id/ai-dm/stream) — the shared
 * client foundation for the AI-DM web UI (#338; the Table page #339, stuck-ladder
 * #340, co-DM #341, scribe #342, onboarding #343, live-state relay #344 build on it).
 *
 * Modelled line-for-line on {@link ./useCampaignEvents}: fetch + ReadableStream rather
 * than native EventSource, so the request carries the exact same auth surface as
 * lib/api.ts — the session cookie (credentials: include) plus the dev-role override
 * headers, which EventSource cannot send. Reconnects with capped exponential backoff;
 * after a heal, `onReconnect` fires so the page can refetch GET /ai-dm/session to catch
 * up on state it missed while offline. A 401/403 stops the loop entirely (no access —
 * retrying won't help), which is also how the server enforces the role matrix: the
 * client simply stops when told no.
 *
 * The transcript is NOT assembled here — this hook only decodes and validates the typed
 * event union and hands each event to `onEvent`. See features/ai-dm/transcript.ts (the
 * reducer that turns these events into a running transcript) and features/ai-dm/
 * toolActivity.ts (the tool-event → query-invalidation map).
 */
import { useEffect, useRef } from 'react';
import { API } from './api';
import { SseParser, type SseParseSignal } from './sseParse';

/**
 * One AI-DM stream event, mirroring the server union in
 * apps/server/src/modules/ai-driver/ai-driver-stream.service.ts (`AiDmStreamEvent`).
 * Kept as a hand-authored client mirror (like {@link ./useCampaignEvents}'s
 * `CampaignEvent`) so the web bundle needn't import server code; the parser below is
 * the single client-side authority on the shape, exercised by recorded fixtures.
 *
 *  - `narration.delta`   — a token-by-token chunk as the model streams (makes the DM "type").
 *  - `narration.message` — the fully-aggregated narration for one step (repairs missed deltas).
 *  - `tool`              — id-only signal the AI invoked a Campfire tool; refetch via REST.
 *  - `turn.start`/`turn.end` — bracket a turn with its stop reason + budget snapshot.
 *  - `stuck`/`recovered`/`state`/`vote`/`takeover` — stuck-ladder + session-state signals (#314).
 *
 * Every event carries `campaignId` and an ISO `at`. `{"type":"ping"}` keepalives are not
 * part of this union — they are dropped by the parser.
 */
export type AiDmStreamEvent =
  | { type: 'turn.start'; campaignId: number; at: string }
  | { type: 'narration.delta'; campaignId: number; text: string; at: string }
  | { type: 'narration.message'; campaignId: number; text: string; at: string }
  | { type: 'tool'; campaignId: number; name: string; isError: boolean; proposed: boolean; at: string }
  | {
      type: 'turn.end';
      campaignId: number;
      stopReason: string;
      steps: number;
      tokensUsed: number;
      budgetRemaining: number;
      at: string;
    }
  | { type: 'stuck'; campaignId: number; reason: string; detail: string; state: string; levers: string[]; at: string }
  | { type: 'recovered'; campaignId: number; state: string; at: string }
  | { type: 'state'; campaignId: number; state: string; at: string }
  | { type: 'vote'; campaignId: number; action: string; kind: string; outcome?: string; at: string }
  | { type: 'takeover'; campaignId: number; action: string; memberId: string; at: string };

/** Narrow union of the `type` discriminants for cheap membership checks. */
export type AiDmStreamEventType = AiDmStreamEvent['type'];

export interface AiDmStreamHandlers {
  onEvent: (event: AiDmStreamEvent) => void;
  /** Fires after the stream reconnects following a drop — refetch session state to catch up. */
  onReconnect?: () => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate + narrow an already-JSON-parsed frame into a typed {@link AiDmStreamEvent},
 * or return `null` for keepalive pings, malformed frames, and unknown future event types
 * (forward-compatible: an older client silently ignores an event kind it doesn't model).
 * Exported so the stream parser can be unit-tested against recorded event fixtures without
 * standing up the hook.
 */
export function parseAiDmStreamEvent(value: unknown): AiDmStreamEvent | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  if (typeof type !== 'string') return null;
  // Every real event is campaign-scoped and timestamped; a ping has neither.
  if (typeof value.campaignId !== 'number' || typeof value.at !== 'string') return null;
  const v = value as Record<string, unknown>;

  switch (type) {
    case 'turn.start':
      return { type, campaignId: v.campaignId as number, at: v.at as string };
    case 'narration.delta':
    case 'narration.message':
      if (typeof v.text !== 'string') return null;
      return { type, campaignId: v.campaignId as number, text: v.text, at: v.at as string };
    case 'tool':
      if (typeof v.name !== 'string' || typeof v.isError !== 'boolean' || typeof v.proposed !== 'boolean') return null;
      return {
        type,
        campaignId: v.campaignId as number,
        name: v.name,
        isError: v.isError,
        proposed: v.proposed,
        at: v.at as string,
      };
    case 'turn.end':
      if (
        typeof v.stopReason !== 'string' ||
        typeof v.steps !== 'number' ||
        typeof v.tokensUsed !== 'number' ||
        typeof v.budgetRemaining !== 'number'
      ) {
        return null;
      }
      return {
        type,
        campaignId: v.campaignId as number,
        stopReason: v.stopReason,
        steps: v.steps,
        tokensUsed: v.tokensUsed,
        budgetRemaining: v.budgetRemaining,
        at: v.at as string,
      };
    case 'stuck':
      if (
        typeof v.reason !== 'string' ||
        typeof v.detail !== 'string' ||
        typeof v.state !== 'string' ||
        !Array.isArray(v.levers) ||
        !v.levers.every((l) => typeof l === 'string')
      ) {
        return null;
      }
      return {
        type,
        campaignId: v.campaignId as number,
        reason: v.reason,
        detail: v.detail,
        state: v.state,
        levers: v.levers as string[],
        at: v.at as string,
      };
    case 'recovered':
    case 'state':
      if (typeof v.state !== 'string') return null;
      return { type, campaignId: v.campaignId as number, state: v.state, at: v.at as string };
    case 'vote':
      if (typeof v.action !== 'string' || typeof v.kind !== 'string') return null;
      return {
        type,
        campaignId: v.campaignId as number,
        action: v.action,
        kind: v.kind,
        outcome: typeof v.outcome === 'string' ? v.outcome : undefined,
        at: v.at as string,
      };
    case 'takeover':
      if (typeof v.action !== 'string' || typeof v.memberId !== 'string') return null;
      return {
        type,
        campaignId: v.campaignId as number,
        action: v.action,
        memberId: v.memberId,
        at: v.at as string,
      };
    default:
      // `ping` keepalives and any unknown/future event kind fall through here.
      return null;
  }
}

/**
 * Subscribe to a campaign's AI-DM narration stream for the lifetime of the mount (or until
 * `campaignId`/`enabled` changes). Handlers are read from a ref so a re-render never tears
 * down and reopens the connection. Pass `enabled: false` to hold the connection closed
 * (e.g. the seat mode is `off`/`co_dm` and no one should be watching a player stream).
 */
export function useAiDmStream(
  campaignId: number | undefined,
  handlers: AiDmStreamHandlers,
  options?: { enabled?: boolean },
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled || campaignId === undefined || !Number.isFinite(campaignId)) return;

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

          const res = await fetch(`${API}/campaigns/${campaignId}/ai-dm/stream`, {
            credentials: 'include',
            headers,
            signal: controller.signal,
          });
          // 401/403 = no access (feature off, not a member, seat disabled) — retrying won't heal it.
          if (res.status === 401 || res.status === 403) return;
          if (!res.ok || !res.body) throw new Error(`AI-DM SSE connect failed (${res.status})`);

          if (attempt > 0) handlersRef.current.onReconnect?.();
          attempt = 0;

          const reader = res.body.getReader();
          // Shared incremental SSE parser (#748) — same framing rules as campaign events.
          const parser = new SseParser();
          const consume = (signals: SseParseSignal[]) => {
            for (const signal of signals) {
              if (signal.kind === 'recovered') {
                // Parser discarded mid-stream bytes — stay connected but refetch
                // session/transcript state that may have been skipped.
                if (!disposed) handlersRef.current.onReconnect?.();
                continue;
              }
              if (signal.kind !== 'message') continue;
              const data = signal.message.data;
              if (!data) continue;
              try {
                const parsed = parseAiDmStreamEvent(JSON.parse(data));
                if (parsed && !disposed) handlersRef.current.onEvent(parsed);
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
          throw new Error('AI-DM SSE stream ended');
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
  }, [campaignId, enabled]);
}
