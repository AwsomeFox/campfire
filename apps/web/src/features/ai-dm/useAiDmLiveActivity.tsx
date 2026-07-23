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
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AiDmMode } from '@campfire/schema';
import { useAiDmSeat, invalidateAiDm } from '../../lib/query';
import { useAiDmStream, type AiDmStreamEvent } from '../../lib/useAiDmStream';
import { invalidateForToolEvent, resolveToolActivity, toolResource, type ToolChip, type ToolStreamEvent } from './toolActivity';

/** One resolved encounter-tool activity, timestamped for "just happened" styling + auto-dismiss. */
export interface AiDmEncounterActivity {
  chip: ToolChip;
  at: number;
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
  /** The most recent tool event that touched the encounter/combat resource (chip pre-resolved). */
  encounterActivity: AiDmEncounterActivity | null;
  /**
   * Monotonic count of `tool` events with `proposed: true` — a DM nav badge / dashboard
   * line bumps off increases in this, not off the raw event: a `useEffect` diffing this
   * value survives StrictMode's double-invoke and reconnect replays cleanly.
   */
  proposalFiledCount: number;
  /** The last fully-aggregated narration line (`narration.message`) — the player-display ticker's feed. */
  lastNarration: string | null;
}

const INITIAL_STATE: AiDmLiveActivityState = {
  mode: undefined,
  live: false,
  turnActive: false,
  lastToolEvent: null,
  lastToolAt: null,
  encounterActivity: null,
  proposalFiledCount: 0,
  lastNarration: null,
};

/**
 * Subscribe to one campaign's AI-DM stream (when its seat is in Driver mode) and
 * reduce events into a live-activity snapshot. Also performs the shared
 * `invalidateForToolEvent` invalidation on every `tool` event — the same seam the
 * Table page uses — so this hook is a complete drop-in even before that page exists.
 */
export function useAiDmLiveActivityState(campaignId: number | undefined): AiDmLiveActivityState {
  const queryClient = useQueryClient();
  const seatQuery = useAiDmSeat(campaignId);
  const mode = seatQuery.data?.mode;
  const enabled = mode === 'driver' && campaignId !== undefined;

  const [state, setState] = useState<AiDmLiveActivityState>(INITIAL_STATE);
  // Reset the reduced activity (but not `mode`, which the seat query owns) whenever we
  // stop watching — switching campaigns, or the seat leaving Driver mode — so a stale
  // "AI just acted" chip from a previous campaign never lingers.
  const prevKeyRef = useRef<string>('');
  const key = `${campaignId ?? ''}:${enabled}`;
  useEffect(() => {
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      setState((s) => ({ ...INITIAL_STATE, mode: s.mode }));
    }
  }, [key]);

  useEffect(() => {
    setState((s) => (s.mode === mode ? s : { ...s, mode }));
  }, [mode]);

  useAiDmStream(
    campaignId,
    {
      onEvent: (event: AiDmStreamEvent) => {
        setState((prev) => reduce(prev, event));
        if (event.type === 'tool' && campaignId !== undefined) {
          invalidateForToolEvent(queryClient, event, { campaignId });
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

  return { ...state, live: enabled };
}

function reduce(prev: AiDmLiveActivityState, event: AiDmStreamEvent): AiDmLiveActivityState {
  switch (event.type) {
    case 'turn.start':
      return { ...prev, turnActive: true };
    case 'turn.end':
      return { ...prev, turnActive: false };
    case 'narration.message':
      return { ...prev, lastNarration: event.text };
    case 'tool': {
      const at = Date.now();
      const next: AiDmLiveActivityState = { ...prev, lastToolEvent: event, lastToolAt: at };
      if (event.proposed) next.proposalFiledCount = prev.proposalFiledCount + 1;
      if (toolResource(event.name) === 'encounter') {
        next.encounterActivity = { chip: resolveToolActivity(event, { campaignId: event.campaignId }), at };
      }
      return next;
    }
    default:
      return prev;
  }
}

// ---- Shared context (single subscription -> many consumers) --------------

const AiDmLiveActivityContext = createContext<AiDmLiveActivityState | null>(null);

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
  return useContext(AiDmLiveActivityContext) ?? INITIAL_STATE;
}
