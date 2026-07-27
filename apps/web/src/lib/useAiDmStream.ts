/**
 * AI-DM narration stream over SSE (GET /campaigns/:id/ai-dm/stream) — the shared
 * client foundation for the AI-DM web UI (#338).
 *
 * Modelled on {@link useCampaignEvents}: fetch + ReadableStream rather than native
 * EventSource. Reconnects with capped exponential backoff via
 * {@link startSseReconnectLoop} (issue #800). Parser buffer-overrun recovery is
 * separate (`onStreamRecovery`). A proven 401 signals session expiry (#885) and
 * stops until reauth; a campaign/feature 403 stops without clearing identity.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { AiDmTranscriptEvent } from '@campfire/schema';
import { API } from './api';
import { getSessionResumeEpoch, subscribeSessionResume } from './sessionExpiry';
import { sseBlockData, startSseReconnectLoop } from './sseReconnect';

export type AiDmStreamEvent =
  | { type: 'turn.start'; campaignId: number; at: string }
  | { type: 'narration.delta'; campaignId: number; text: string; at: string }
  | { type: 'narration.message'; campaignId: number; text: string; at: string }
  /**
   * #598 — the turn was WITHHELD: a provider content filter or a model refusal ended it, so no
   * `narration.message` follows and nothing was persisted server-side. Two jobs for the client:
   * DISCARD the buffered `narration.delta` text for the open bubble (otherwise `turn.end`
   * promotes those trailing deltas into the permanent transcript), and show a neutral line
   * saying a reply was withheld rather than letting the bubble trail off unexplained.
   * `message` deliberately does not describe WHAT was withheld.
   */
  | {
      type: 'narration.withheld';
      campaignId: number;
      reason: 'content_filter' | 'refusal';
      message: string;
      at: string;
    }
  | {
      type: 'tool';
      campaignId: number;
      name: string;
      isError: boolean;
      proposed: boolean;
      /** Encounter mutated by this tool, when the server could derive it safely (#825). */
      encounterId?: number;
      at: string;
    }
  | {
      type: 'turn.error';
      campaignId: number;
      stopReason: 'provider_error';
      code: string;
      message: string;
      retryable: boolean;
      steps: number;
      tokensUsed: number;
      tokensUsageUnknown?: boolean;
      budgetRemaining: number;
      at: string;
    }
  | {
      type: 'turn.end';
      campaignId: number;
      stopReason: string;
      steps: number;
      tokensUsed: number;
      tokensUsageUnknown?: boolean;
      budgetRemaining: number;
      at: string;
    }
  | { type: 'stuck'; campaignId: number; reason: string; detail: string; state: string; levers: string[]; at: string }
  | { type: 'recovered'; campaignId: number; state: string; at: string }
  | { type: 'state'; campaignId: number; state: string; at: string }
  | { type: 'vote'; campaignId: number; action: string; kind: string; outcome?: string; at: string }
  | { type: 'takeover'; campaignId: number; action: string; memberId: string; at: string }
  /**
   * One durably-persisted transcript event (#572) — the authoritative multi-player table
   * log. Unlike every other frame here this one is BACKED BY A ROW: it carries a stable
   * `eventId` and a per-campaign `seq`, so a client can merge it idempotently with a REST
   * page and resume from its watermark after a disconnect. Crucially it includes the
   * accepted PLAYER ACTION, which had no frame at all before #572 — only the sender ever
   * saw its own submission. Events the viewer may not read are dropped server-side and
   * never reach this stream.
   */
  | { type: 'transcript'; campaignId: number; event: AiDmTranscriptEvent; at: string }
  /** The DM erased the transcript (#572): drop the local copy and refetch — `seq` restarted. */
  | { type: 'transcript.reset'; campaignId: number; at: string }
  // #577 — the server's verdict on the factual claims in the turn that just ended. Thin, like
  // every other signal here: the client refetches GET /ai-dm/grounding for the claim text, the
  // per-citation reasons, and the evidence links.
  | {
      type: 'grounding';
      campaignId: number;
      status: 'clean' | 'unverified';
      supportedCount: number;
      unsupportedCount: number;
      /** Provider NAME and served model id only — the provenance badge, never a secret. */
      provider: string;
      model: string;
      claimIds: number[];
      at: string;
    };

/** Narrow union of the `type` discriminants for cheap membership checks. */
export type AiDmStreamEventType = AiDmStreamEvent['type'];

export interface AiDmStreamHandlers {
  onEvent: (event: AiDmStreamEvent) => void;
  /** Fires after the stream reconnects following a transport drop — refetch session state. */
  onReconnect?: () => void;
  /**
   * Fires when the SSE parser discards mid-stream bytes while the connection
   * stays up. Distinct from {@link onReconnect}; wire the same catch-up refetch
   * when transcript/session state may have skipped events.
   */
  onStreamRecovery?: () => void;
}


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
    case 'narration.withheld': {
      // #598: an unrecognized reason is NOT dropped — a frame this client cannot fully model is
      // still a retraction it must honour, and returning null here would leave the withheld
      // deltas sitting in the bubble. Fall back to the more conservative label instead.
      if (typeof v.message !== 'string') return null;
      const reason = v.reason === 'refusal' ? 'refusal' : 'content_filter';
      return { type, campaignId: v.campaignId as number, reason, message: v.message, at: v.at as string };
    }
    case 'tool': {
      if (typeof v.name !== 'string' || typeof v.isError !== 'boolean' || typeof v.proposed !== 'boolean') return null;
      // Optional encounterId (#825): accept a positive int, ignore malformed values so an
      // older/newer server never breaks the stream. Never accept names — identity is id-only.
      const encounterId =
        typeof v.encounterId === 'number' && Number.isInteger(v.encounterId) && v.encounterId > 0
          ? v.encounterId
          : undefined;
      return {
        type,
        campaignId: v.campaignId as number,
        name: v.name,
        isError: v.isError,
        proposed: v.proposed,
        ...(encounterId !== undefined ? { encounterId } : {}),
        at: v.at as string,
      };
    }
    case 'turn.error':
      if (
        v.stopReason !== 'provider_error' ||
        typeof v.code !== 'string' ||
        typeof v.message !== 'string' ||
        typeof v.retryable !== 'boolean' ||
        typeof v.steps !== 'number' ||
        typeof v.tokensUsed !== 'number' ||
        typeof v.budgetRemaining !== 'number'
      ) {
        return null;
      }
      return {
        type,
        campaignId: v.campaignId as number,
        stopReason: 'provider_error',
        code: v.code,
        message: v.message,
        retryable: v.retryable,
        steps: v.steps,
        tokensUsed: v.tokensUsed,
        ...(v.tokensUsageUnknown === true ? { tokensUsageUnknown: true } : {}),
        budgetRemaining: v.budgetRemaining,
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
        ...(v.tokensUsageUnknown === true ? { tokensUsageUnknown: true } : {}),
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
    case 'transcript': {
      // Structural validation only: `seq` and `eventId` are what the merge keys off, so a
      // frame missing either is unusable and dropped rather than folded in half-formed.
      const event = v.event;
      if (!isRecord(event)) return null;
      if (typeof event.eventId !== 'string' || typeof event.seq !== 'number' || !Number.isInteger(event.seq)) {
        return null;
      }
      if (typeof event.kind !== 'string' || typeof event.at !== 'string') return null;
      return { type, campaignId: v.campaignId as number, event: event as unknown as AiDmTranscriptEvent, at: v.at as string };
    }
    case 'transcript.reset':
      return { type, campaignId: v.campaignId as number, at: v.at as string };
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

/** Re-export shared SSE block parser (stable import path for existing callers). */
export { sseBlockData };

/**
 * Subscribe to a campaign's AI-DM narration stream for the lifetime of the mount (or until
 * `campaignId`/`enabled`/resume epoch changes). Pass `enabled: false` to hold the
 * connection closed.
 */
export function useAiDmStream(
  campaignId: number | undefined,
  handlers: AiDmStreamHandlers,
  options?: { enabled?: boolean },
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const enabled = options?.enabled ?? true;
  const resumeEpoch = useSyncExternalStore(subscribeSessionResume, getSessionResumeEpoch, () => 0);

  useEffect(() => {
    if (!enabled || campaignId === undefined || !Number.isFinite(campaignId)) return;

    const loop = startSseReconnectLoop({
      url: `${API}/campaigns/${campaignId}/ai-dm/stream`,
      onData: (data) => {
        try {
          const parsed = parseAiDmStreamEvent(JSON.parse(data));
          if (parsed) handlersRef.current.onEvent(parsed);
        } catch {
          /* malformed frame — skip */
        }
      },
      onReconnect: () => handlersRef.current.onReconnect?.(),
      onStreamRecovery: () => handlersRef.current.onStreamRecovery?.(),
    });

    return () => loop.dispose();
  }, [campaignId, enabled, resumeEpoch]);
}
