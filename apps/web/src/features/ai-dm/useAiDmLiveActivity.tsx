/**
 * Live-state relay outside the Table (#344) — the single, app-wide AI-DM stream
 * subscription so surfaces OTHER than the Table page (#339) know the AI is acting:
 * the combat tracker's presence chip, the dashboard's activity/proposal nudge, and
 * (best-effort) the player display's narration ticker.
 *
 * `useAiDmLiveActivityState` is the real subscriber — it owns the ONE
 * `useAiDmStream` connection for a mounted tree and reduces the event stream into a
 * small, render-friendly snapshot. It is mounted exactly once per tab, in
 * `app/Layout.tsx` (the campaign chrome every campaign-scoped page renders inside),
 * gated on `enabled: mode === 'driver'` — matching the shared foundation's rule that
 * only Driver mode opens a connection. `AiDmLiveActivityContext` then hands that one
 * snapshot down to any page that wants it (RunSessionPage, DashboardPage) without
 * each page opening its own stream — this is the "single shared subscription" the
 * issue calls for.
 *
 * Issue #427 extends the shared subscription with the running transcript so the
 * encounter-page driver dock can render narration without opening a second stream.
 *
 * `PlayerDisplayPage` lives OUTSIDE `Layout` (issue #60 mounts it with no chrome), so
 * it cannot reach this context; it may call `useAiDmLiveActivityState` directly for
 * its optional narration ticker. Because the two routes are siblings (never both
 * mounted at once), that still holds "exactly one `/ai-dm/stream` connection per tab."
 *
 * Query invalidation still flows through the shared `toolActivity` map (#338) exactly
 * as it does for the Table page — every `tool` event invalidates the same query keys
 * here, so the encounter tracker / party sheet / map / proposals queue reconcile
 * against server truth even while the Table page is closed.
 */
import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AiDmMode } from '@campfire/schema';
import { useAiDmSeat, useAiDmSession, invalidateAiDm } from '../../lib/query';
import { useAiDmStream, type AiDmStreamEvent } from '../../lib/useAiDmStream';
import { invalidateForToolEvent, resolveToolActivity, toolResource, type ToolChip, type ToolStreamEvent } from './toolActivity';
import {
  transcriptReducer,
  loadTranscript,
  saveTranscript,
  emptyTranscript,
  type TranscriptAction,
  type TranscriptState,
} from './transcript';

/** One resolved encounter-tool activity, timestamped for "just happened" styling + auto-dismiss. */
export interface AiDmEncounterActivity {
  chip: ToolChip;
  at: number;
  /** Source tool event — toast/announce must key off this, not global `lastToolEvent`. */
  event: ToolStreamEvent;
  /** Server-derived encounter the tool mutated, when present (#825). Survives chip re-resolve. */
  encounterId?: number;
}

export interface AiDmLiveActivityState {
  /** The seat's operating mode, once loaded (`undefined` while the seat read is in flight). */
  mode: AiDmMode | undefined;
  /** Whether the shared stream is actually connected (mirrors `mode === 'driver'`). */
  live: boolean;
  /** True between a `turn.start` and its matching `turn.end` — drives "mid-turn" styling. */
  turnActive: boolean;
  /** The most recent `tool` event of any resource, for a generic "AI just acted" signal. */
  lastToolEvent: ToolStreamEvent | null;
  lastToolAt: number | null;
  /** The most recent encounter-facing tool event (encounter/combat + party-state grants). */
  encounterActivity: AiDmEncounterActivity | null;
  /**
   * Monotonic count of `tool` events with `proposed: true` — a DM nav badge / dashboard
   * line bumps off increases in this, not off the raw event: a `useEffect` diffing this
   * value survives StrictMode's double-invoke and reconnect replays cleanly.
   */
  proposalFiledCount: number;
  /** The last fully-aggregated narration line (`narration.message`) — the player-display ticker's feed. */
  lastNarration: string | null;
  /** Client-assembled narration transcript (#427 encounter dock). */
  transcript: TranscriptState;
  /** Dispatch local transcript actions (echo player lines, rules answers, …). */
  dispatchTranscript: (action: TranscriptAction) => void;
}

const INITIAL_STATE: Omit<AiDmLiveActivityState, 'transcript' | 'dispatchTranscript'> = {
  mode: undefined,
  live: false,
  turnActive: false,
  lastToolEvent: null,
  lastToolAt: null,
  encounterActivity: null,
  proposalFiledCount: 0,
  lastNarration: null,
};

const NOOP_DISPATCH: (action: TranscriptAction) => void = () => {};

/**
 * Subscribe to one campaign's AI-DM stream (when its seat is in Driver mode) and
 * reduce events into a live-activity snapshot. Also performs the shared
 * `invalidateForToolEvent` invalidation on every `tool` event — the same seam the
 * Table page uses — so this hook is a complete drop-in even before that page exists.
 */
export function useAiDmLiveActivityState(campaignId: number | undefined): AiDmLiveActivityState {
  const queryClient = useQueryClient();
  const seatQuery = useAiDmSeat(campaignId);
  const sessionQuery = useAiDmSession(campaignId);
  const mode = seatQuery.data?.mode;
  const session = sessionQuery.data;
  const enabled = mode === 'driver' && campaignId !== undefined;

  const [state, setState] = useState(INITIAL_STATE);
  const [transcript, dispatchTranscript] = useReducer(
    transcriptReducer,
    campaignId,
    (id) => (id !== undefined ? loadTranscript(id) : emptyTranscript),
  );

  const seededRef = useRef(false);

  // Reset activity + transcript when campaign or driver mode changes.
  const prevKeyRef = useRef<string>('');
  const key = `${campaignId ?? ''}:${enabled}`;
  useEffect(() => {
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      setState((s) => ({ ...INITIAL_STATE, mode: s.mode }));
      seededRef.current = false;
      if (campaignId !== undefined) {
        dispatchTranscript({ type: 'hydrate', state: enabled ? loadTranscript(campaignId) : emptyTranscript });
      } else {
        dispatchTranscript({ type: 'reset' });
      }
    }
  }, [key, campaignId, enabled]);

  useEffect(() => {
    setState((s) => (s.mode === mode ? s : { ...s, mode }));
  }, [mode]);

  useEffect(() => {
    if (!enabled || campaignId === undefined) return;
    saveTranscript(campaignId, transcript);
  }, [campaignId, enabled, transcript]);

  // Seed join-context from thin session state when local transcript is empty.
  useEffect(() => {
    if (!enabled || campaignId === undefined) return;
    if (transcript.entries.length > 0) {
      if (!seededRef.current) seededRef.current = true;
      return;
    }
    if (seededRef.current) return;
    if (!seatQuery.isFetched || !sessionQuery.isFetched) return;
    if (session?.scene || session?.lastNarration) {
      dispatchTranscript({ type: 'seed', scene: session.scene, lastNarration: session.lastNarration });
    }
    seededRef.current = true;
  }, [
    enabled,
    campaignId,
    transcript.entries.length,
    seatQuery.isFetched,
    sessionQuery.isFetched,
    session,
  ]);

  const stableDispatch = useCallback((action: TranscriptAction) => {
    dispatchTranscript(action);
  }, []);

  useAiDmStream(
    campaignId,
    {
      onEvent: (event: AiDmStreamEvent) => {
        setState((prev) => reduce(prev, event));
        if (enabled) {
          dispatchTranscript({ type: 'stream', event });
        }
        if (campaignId === undefined) return;
        if (event.type === 'tool') {
          invalidateForToolEvent(queryClient, event, {
            campaignId,
            encounterId: event.encounterId,
          });
        } else if (
          event.type === 'state' ||
          event.type === 'stuck' ||
          event.type === 'recovered' ||
          event.type === 'vote' ||
          event.type === 'takeover'
        ) {
          invalidateAiDm(queryClient, campaignId);
        }
      },
      onReconnect: () => {
        if (campaignId !== undefined) invalidateAiDm(queryClient, campaignId);
      },
      onStreamRecovery: () => {
        if (campaignId !== undefined) invalidateAiDm(queryClient, campaignId);
      },
    },
    { enabled },
  );

  return {
    ...state,
    live: enabled,
    transcript,
    dispatchTranscript: stableDispatch,
  };
}

function reduce(prev: typeof INITIAL_STATE, event: AiDmStreamEvent): typeof INITIAL_STATE {
  switch (event.type) {
    case 'turn.start':
      return { ...prev, turnActive: true };
    case 'turn.end':
    case 'turn.error':
      return { ...prev, turnActive: false };
    case 'narration.message':
      return { ...prev, lastNarration: event.text };
    case 'tool': {
      const at = Date.now();
      const next = { ...prev, lastToolEvent: event, lastToolAt: at };
      if (event.proposed) next.proposalFiledCount = prev.proposalFiledCount + 1;
      const resource = toolResource(event.name);
      if (resource === 'encounter' || resource === 'party') {
        next.encounterActivity = {
          chip: resolveToolActivity(event, {
            campaignId: event.campaignId,
            encounterId: event.encounterId,
          }),
          at,
          event,
          encounterId: event.encounterId,
        };
      }
      return next;
    }
    default:
      return prev;
  }
}

// ---- Shared context (single subscription -> many consumers) --------------

const AiDmLiveActivityContext = createContext<AiDmLiveActivityState | null>(null);

const INERT_CONTEXT: AiDmLiveActivityState = {
  ...INITIAL_STATE,
  transcript: emptyTranscript,
  dispatchTranscript: NOOP_DISPATCH,
};

/** Provide a pre-computed snapshot (from one `useAiDmLiveActivityState` call) to descendants. */
export function AiDmLiveActivityProvider({
  value,
  children,
}: {
  value: AiDmLiveActivityState;
  children: ReactNode;
}) {
  return <AiDmLiveActivityContext.Provider value={value}>{children}</AiDmLiveActivityContext.Provider>;
}

/**
 * Read the app-level AI-DM live-activity snapshot mounted in `Layout`. Returns the
 * inert default (mode undefined, nothing live) when rendered outside the provider —
 * e.g. a page under test in isolation — rather than throwing, since every surface
 * here treats "no signal yet" as "render nothing" anyway.
 */
export function useAiDmLiveActivity(): AiDmLiveActivityState {
  return useContext(AiDmLiveActivityContext) ?? INERT_CONTEXT;
}
