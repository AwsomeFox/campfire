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
 * Issue #427 extends the shared subscription with the authoritative transcript so the
 * encounter-page driver dock has the same shared history as the Table without opening a
 * second stream.
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
import {
  AI_DM_TRANSCRIPT_LIST_MAX_LIMIT,
  type AiDmMode,
  type AiDmTranscriptPage,
} from '@campfire/schema';
import { queryKeys, useAiDmSeat, useAiDmSession, invalidateAiDm, invalidateAiDmToolConfirmations } from '../../lib/query';
import { useCampaignEvents } from '../../lib/useCampaignEvents';
import { useAuth } from '../../app/auth';
import { api, API, ApiError } from '../../lib/api';
import { usePendingHydrate } from './usePendingHydrate';
import { invalidateForToolEvent, resolveToolActivity, toolResource, type ToolChip, type ToolStreamEvent } from './toolActivity';
import {
  transcriptReducer,
  saveTranscript,
  loadTranscript,
  clearTranscript,
  emptyTranscript,
  transcriptEntryId,
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
  /** Authoritative narration transcript (#427 encounter dock). */
  transcript: TranscriptState;
  /** The authoritative transcript request has settled for the current viewer projection. */
  transcriptFetched: boolean;
  /** Durable SSE rows that arrived before the current history request settled. */
  preHydrationLiveEntryIds: ReadonlySet<string>;
  /** Advances whenever the current owner's transcript is reset or rehydrated. */
  transcriptGeneration: number;
  /** Dispatch local transcript actions (echo player lines, rules answers, …). */
  dispatchTranscript: (action: TranscriptAction) => void;
}

const INITIAL_STATE: Omit<AiDmLiveActivityState, 'transcript' | 'transcriptFetched' | 'preHydrationLiveEntryIds' | 'transcriptGeneration' | 'dispatchTranscript'> = {
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
  // #573: the reducer starts EMPTY and is hydrated by the key effect below, never by a
  // lazy initializer. The initializer ran on the very first render — before `/me` had
  // resolved — so it was structurally incapable of knowing whose cache it was reading.
  // The cost is that cached scrollback paints one commit later than it used to.
  const [transcript, dispatchTranscript] = useReducer(transcriptReducer, emptyTranscript);

  const seededRef = useRef(false);
  /**
   * The shared hydrate/identity latch (#572, #573). It owns two things here:
   *
   * (a) A hydrate dispatched by the key effect below has not been applied yet. The key
   *     effect, the save effect and the seed effect all run in the SAME commit, and
   *     effects see the pre-dispatch `transcript`. Without this latch the seed effect read
   *     `entries.length === 0` on the very pass that queued a hydrate of the cached
   *     scrollback, seeded a 2-line join-context placeholder over it, and then persisted
   *     that placeholder — destroying the cached transcript for every surface sharing the
   *     store. Skip exactly one pass so the seed decision is made against hydrated state.
   *
   * (b) The established viewer, which is null until `/me` resolves. This provider is
   *     mounted in `Layout` for every campaign-scoped page, so it is one of the earliest
   *     things to run after a reload — exactly the window in which a slow auth check used
   *     to let it read the previous account's cache.
   */
  const { me, ready, roleIn } = useAuth();
  const pendingHydrate = usePendingHydrate({ ready, userId: me?.user.id ?? null });
  const viewerId = pendingHydrate.viewerId;
  // The durable transcript is role-projected by the server. Keep role in the reducer
  // ownership key so a live promotion/demotion resets and rehydrates before the dock can
  // render the prior projection.
  const effectiveRole = campaignId === undefined ? null : roleIn(campaignId);

  // Keep a separate cache namespace from AiTablePage: both surfaces now read the same
  // authoritative server events, but the Layout provider remains mounted when moving between
  // routes and must not overwrite the Table page's paint cache during that transition.
  const key = `${viewerId ?? ''}:${campaignId ?? ''}:${enabled}:${effectiveRole ?? ''}`;

  /**
   * Which `key` the reducer state currently belongs to.
   *
   * The save effect is declared — and therefore RUNS — before the key effect that advances
   * this ref, which is the whole point: on the commit that re-points the reducer, the save
   * effect still sees the OLD owner, mismatches, and skips. Without it the switch commit
   * wrote the PREVIOUS key's entries under the NEW key — and since `saveTranscript` never
   * writes an empty state, the hydrate that followed could not overwrite the mistake when
   * the new key's own cache was empty, so the wrong transcript stuck. That was already
   * true across campaigns before #573 (`AiTablePage` has always guarded it this way; this
   * hook did not); with a user in the key it would have laundered a transcript across
   * ACCOUNTS, which is the exact leak this issue is about.
   */
  const transcriptOwnerRef = useRef<string>('');
  // A transcript reset keeps the same owner key but invalidates every earlier history
  // request. Incrementing this independently prevents a slow pre-reset response from
  // restoring rows the DM just erased.
  const transcriptRequestGenerationRef = useRef(0);
  const lastSeqRef = useRef(0);
  const [transcriptFetched, setTranscriptFetched] = useState(false);
  const [preHydrationLiveEntryIds, setPreHydrationLiveEntryIds] = useState<ReadonlySet<string>>(new Set());
  const preHydrationLiveEntryIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [transcriptGeneration, setTranscriptGeneration] = useState(0);

  useEffect(() => {
    lastSeqRef.current = transcript.lastSeq ?? 0;
  }, [transcript.lastSeq]);

  const fetchTranscript = useCallback(
    async (ownerKey: string, after?: number, requestGeneration = transcriptRequestGenerationRef.current) => {
      if (campaignId === undefined) return;
      let watermark = after;
      for (let page = 0; page < 20; page += 1) {
        try {
          const result = await api.get<AiDmTranscriptPage>(
            `${API}/campaigns/${campaignId}/ai-dm/transcript?limit=${AI_DM_TRANSCRIPT_LIST_MAX_LIMIT}` +
              (watermark ? `&after=${watermark}` : ''),
          );
          // The Layout provider survives viewer and campaign changes. An old request must not
          // fold into the newly-owned reducer, even when the response happens to win a race.
          if (
            transcriptOwnerRef.current !== ownerKey
            || transcriptRequestGenerationRef.current !== requestGeneration
          ) return;
          if (result.items.length > 0) {
            dispatchTranscript({ type: 'serverEvents', events: result.items });
          } else if (watermark === undefined) {
            // `saveTranscript` intentionally does not persist an empty state, so remove
            // this viewer's stale paint cache explicitly before reconciling the empty
            // authoritative response. Any genuine transcript frames that won the fetch
            // race are retained below and will be saved again by the normal effect.
            clearTranscript(viewerId, campaignId, 'activity');
            dispatchTranscript({
              type: 'reconcileEmptyAuthoritative',
              keepEntryIds: preHydrationLiveEntryIdsRef.current,
            });
          }
          const last = result.items[result.items.length - 1];
          if (watermark === undefined || !result.hasMore || !last) return;
          watermark = last.seq;
        } catch (err) {
          // A 403/404 is not a transient history-read failure: this viewer no longer has
          // authority to retain the projection (or the campaign is gone). Match the Table
          // surface by purging both cache scopes and the in-memory activity transcript.
          // Keep the owner/generation guard so an old request cannot clear a new viewer.
          if (
            err instanceof ApiError
            && (err.status === 403 || err.status === 404)
            && transcriptOwnerRef.current === ownerKey
            && transcriptRequestGenerationRef.current === requestGeneration
          ) {
            clearTranscript(viewerId, campaignId);
            clearTranscript(viewerId, campaignId, 'activity');
            // Invalidate every overlapping history read before an older authorized response
            // can repopulate this projection after access has been revoked.
            ++transcriptRequestGenerationRef.current;
            lastSeqRef.current = 0;
            preHydrationLiveEntryIdsRef.current = new Set();
            setPreHydrationLiveEntryIds(preHydrationLiveEntryIdsRef.current);
            setTranscriptGeneration((generation) => generation + 1);
            dispatchTranscript({ type: 'reset' });
            dispatchTranscript({ type: 'authoritative' });
          }
          // A live stream remains useful when transcript history is temporarily unavailable.
          return;
        }
      }
    },
    [campaignId, viewerId],
  );

  useEffect(() => {
    if (!enabled || campaignId === undefined || viewerId === null || effectiveRole === null) return;
    if (transcriptOwnerRef.current !== key) return;
    saveTranscript(viewerId, campaignId, transcript, 'activity', effectiveRole);
  }, [campaignId, effectiveRole, enabled, transcript, viewerId, key]);

  // Reset activity + transcript when the viewer, campaign or driver mode changes.
  const prevKeyRef = useRef<string>('');
  useEffect(() => {
    if (prevKeyRef.current === key) return;
    // Nothing may be hydrated until `/me` has answered; the next pass (once `ready` flips)
    // re-runs this effect with a real key. Leaving `prevKeyRef` unadvanced is deliberate.
    if (pendingHydrate.identityPending) return;
    prevKeyRef.current = key;
    setState((s) => ({ ...INITIAL_STATE, mode: s.mode }));
    seededRef.current = false;
    setTranscriptFetched(!enabled);
    preHydrationLiveEntryIdsRef.current = new Set();
    setPreHydrationLiveEntryIds(preHydrationLiveEntryIdsRef.current);
    setTranscriptGeneration((generation) => generation + 1);
    pendingHydrate.mark();
    transcriptOwnerRef.current = key;
    const requestGeneration = ++transcriptRequestGenerationRef.current;
    if (campaignId !== undefined && viewerId !== null) {
      dispatchTranscript({
        type: 'hydrate',
        // Old thin-stream activity snapshots have no projection marker and are rejected by
        // loadTranscript. Current authoritative snapshots paint immediately only when their
        // server role projection matches this viewer's effective role.
        state: effectiveRole === null
          ? emptyTranscript
          : loadTranscript(viewerId, campaignId, 'activity', effectiveRole),
      });
      if (enabled) {
        dispatchTranscript({ type: 'authoritative' });
        void fetchTranscript(key, undefined, requestGeneration).finally(() => {
          if (
            transcriptOwnerRef.current === key
            && transcriptRequestGenerationRef.current === requestGeneration
          ) setTranscriptFetched(true);
        });
      }
    } else {
      dispatchTranscript({ type: 'reset' });
    }
  }, [
    key,
    campaignId,
    enabled,
    viewerId,
    effectiveRole,
    fetchTranscript,
    pendingHydrate,
    pendingHydrate.identityPending,
  ]);

  useEffect(() => {
    setState((s) => (s.mode === mode ? s : { ...s, mode }));
  }, [mode]);

  // Seed join-context from thin session state when local transcript is empty.
  useEffect(() => {
    if (!enabled || campaignId === undefined) return;
    if (transcript.entries.length > 0) {
      if (!seededRef.current) seededRef.current = true;
      return;
    }
    if (seededRef.current) return;
    // A hydrate is queued but not yet applied — deciding "empty, so seed" here would
    // overwrite the scrollback that hydrate is about to restore. Also covers the identity
    // change that auto-marks the latch.
    if (pendingHydrate.consume()) return;
    // #573: a seeded placeholder is still table content, and persisting it under a viewer
    // we have not established yet is the same leak in the other direction.
    if (pendingHydrate.identityPending || viewerId === null) return;
    if (!seatQuery.isFetched || !sessionQuery.isFetched) return;
    // The server transcript, not a scene/last-narration approximation, is the shared history.
    // Only seed if that read settled empty or failed.
    if (!transcriptFetched) return;
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
    viewerId,
    transcriptFetched,
    pendingHydrate.identityPending,
  ]);

  const stableDispatch = useCallback((action: TranscriptAction) => {
    dispatchTranscript(action);
  }, []);

  useCampaignEvents(
    enabled ? campaignId : undefined,
    {
      onEvent: (event) => {
        if (!transcriptFetched && event.type === 'transcript') {
          // Some durable rows fold into a single DM bubble (`dm:<turnId>`), rather than
          // retaining their server event id. Keep the final rendered id so go-live does
          // not baseline an SSE addition that arrived during hydration.
          const next = new Set(preHydrationLiveEntryIdsRef.current)
            .add(transcriptEntryId(event.event));
          preHydrationLiveEntryIdsRef.current = next;
          setPreHydrationLiveEntryIds(next);
        }
        setState((prev) => reduce(prev, event));
        if (enabled) {
          dispatchTranscript({ type: 'stream', event: event as any });
        }
        if (campaignId === undefined) return;
        if (event.type === 'tool') {
          invalidateForToolEvent(queryClient, event, {
            campaignId,
            encounterId: event.encounterId,
          });
        } else if (event.type === 'tool-confirmation') {
          // #1494: thin signal — refetch the authoritative pending-confirmation
          // queue. Without this the encounter-panel dock would only update on its
          // 30s poll, so a newly-blocked AI action could arrive half a minute late
          // on the one surface a DM mid-combat is looking at. Mirrors AiTablePage's
          // handler (#1558); React Query deduplicates, so both surfaces invalidating
          // on the same key is a no-op extra.
          invalidateAiDmToolConfirmations(queryClient, campaignId);
          // #1501: mirror AiTablePage — an approved mechanical commit arms the undo lever
          // server-side, so refetch the session to surface it. See AiTablePage for the full why.
          if (event.action === 'approved') invalidateAiDm(queryClient, campaignId);
        } else if (event.type === 'transcript.reset') {
          // The stream reducer has cleared the live projection. Remove its paint cache as
          // well (for both the shared activity dock and the sibling Table route) — empty
          // state is intentionally never persisted — and invalidate every pre-reset request
          // before fetching the now-empty server history.
          clearTranscript(viewerId, campaignId);
          clearTranscript(viewerId, campaignId, 'activity');
          lastSeqRef.current = 0;
          setTranscriptFetched(false);
          preHydrationLiveEntryIdsRef.current = new Set();
          setPreHydrationLiveEntryIds(preHydrationLiveEntryIdsRef.current);
          setTranscriptGeneration((generation) => generation + 1);
          const requestGeneration = ++transcriptRequestGenerationRef.current;
          void fetchTranscript(key, undefined, requestGeneration).finally(() => {
            if (
              transcriptOwnerRef.current === key
              && transcriptRequestGenerationRef.current === requestGeneration
            ) setTranscriptFetched(true);
          });
        } else if (event.type === 'grounding') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.aiDmGrounding(campaignId) });
        } else if (
          event.type === 'state' ||
          event.type === 'stuck' ||
          event.type === 'recovered' ||
          event.type === 'vote' ||
          event.type === 'takeover' ||
          // #1043: the lifecycle phase is thin server truth like every sibling above. This hook
          // drives surfaces outside the AI Table, which would otherwise never hear that the
          // session opened or ended unless the viewer was the one who pressed the button.
          event.type === 'phase'
        ) {
          invalidateAiDm(queryClient, campaignId);
        }
      },
      onReconnect: () => {
        if (campaignId !== undefined) {
          void fetchTranscript(key, lastSeqRef.current || undefined);
          invalidateAiDm(queryClient, campaignId);
        }
      },
      onStreamRecovery: () => {
        if (campaignId !== undefined) {
          void fetchTranscript(key, lastSeqRef.current || undefined);
          invalidateAiDm(queryClient, campaignId);
        }
      },
    },
    effectiveRole,
  );

  // The owner-changing hydrate runs after render. Never hand a new role, campaign, or
  // viewer the prior owner's projection for that one render in between; the provider
  // deliberately paints empty until its key effect has established the new owner.
  const visibleTranscript = transcriptOwnerRef.current === key ? transcript : emptyTranscript;

  return {
    ...state,
    live: enabled,
    transcript: visibleTranscript,
    transcriptFetched: transcriptOwnerRef.current === key && transcriptFetched,
    preHydrationLiveEntryIds,
    transcriptGeneration,
    dispatchTranscript: stableDispatch,
  };
}

function reduce(prev: typeof INITIAL_STATE, event: any): typeof INITIAL_STATE {
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
  transcriptFetched: false,
  preHydrationLiveEntryIds: new Set(),
  transcriptGeneration: 0,
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
