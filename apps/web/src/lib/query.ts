/**
 * TanStack Query data layer (issue #73).
 *
 * The web app historically hand-rolled its reads (`useState`/`useEffect`/`load()`)
 * and its writes (POST-then-full-refetch, gated behind one global `busy` flag). That
 * pattern is fine at small scale but makes the highest-frequency interaction — a DM
 * spamming HP ±1 in combat — the slowest: every click waits a full round-trip plus a
 * blanket refetch, and the global lock disables *every* control while it's in flight.
 *
 * This module is the shared seam other pages migrate onto incrementally:
 *   - {@link queryClient} — the app-wide client (mounted in App.tsx).
 *   - {@link queryKeys}   — the canonical key registry, so reads and their
 *     invalidations never drift.
 *   - {@link invalidateEncounter} — one helper an SSE event handler (or a mutation's
 *     `onSettled`) calls to mark the encounter's reads stale.
 *
 * Reads still go through {@link api} (cookie auth + dev-role headers + ApiError); Query
 * only owns caching, dedupe, polling, and optimistic writes on top of it.
 */
import { QueryClient, useQuery, type QueryKey, type UseQueryResult } from '@tanstack/react-query';
import type { AiDmSeat, AiDmToolConfirmation, TableSafetyHold } from '@campfire/schema';
import { api, API, ApiError } from './api';

/**
 * Canonical query-key registry. Keeping keys here (rather than inline string arrays
 * scattered across components) means a read and the mutation that invalidates it can't
 * silently disagree about the key shape. Keys are hierarchical: invalidating
 * `['encounter', id]` with the default (prefix) match also re-runs
 * `['encounter', id, 'difficulty']` and `['encounter', id, 'events']`.
 */
export const queryKeys = {
  encounter: (encounterId: number) => ['encounter', encounterId] as const,
  encounterDifficulty: (encounterId: number) => ['encounter', encounterId, 'difficulty'] as const,
  encounterEvents: (encounterId: number) => ['encounter', encounterId, 'events'] as const,
  /** Current-turn workspace (issue #413) — "what can I do now?" for the active combatant. */
  encounterTurn: (encounterId: number) => ['encounter', encounterId, 'turn'] as const,
  /** All encounters in a campaign (the list surface). */
  campaignEncounters: (campaignId: number) => ['campaign', campaignId, 'encounters'] as const,
  campaignCharacters: (campaignId: number) => ['campaign', campaignId, 'characters'] as const,
  /** DM-initiated check requests (issue #415) — the DM-request → player-prompt → roll loop. */
  campaignCheckRequests: (campaignId: number) => ['campaign', campaignId, 'check-requests'] as const,
  /** The campaign member roster (resolves userId → display name for AI-DM lever surfaces, #340). */
  campaignMembers: (campaignId: number) => ['campaign', campaignId, 'members'] as const,
  /** The party roster (alias surface for character/HP/condition writes). */
  campaignParty: (campaignId: number) => ['campaign', campaignId, 'party'] as const,
  /** The campaign dice/roll log. */
  campaignDiceLog: (campaignId: number) => ['campaign', campaignId, 'dice'] as const,
  /** Map + fog-of-war + location discovery state. */
  campaignMap: (campaignId: number) => ['campaign', campaignId, 'map'] as const,
  /** The proposal queue (AI canon edits land here for DM review). */
  campaignProposals: (campaignId: number) => ['campaign', campaignId, 'proposals'] as const,
  // AI-DM foundation (#338). Session is the thin server-truth state (#314); seat is the
  // mode/enabled/budget/instructions config (instructions server-omitted for non-DMs, #261).
  aiDmSession: (campaignId: number) => ['campaign', campaignId, 'ai-dm', 'session'] as const,
  aiDmSeat: (campaignId: number) => ['campaign', campaignId, 'ai-dm', 'seat'] as const,
  /** The #519 readiness checklist: derived from the seat, provider, settings and consent. */
  aiDmReadiness: (campaignId: number) => ['campaign', campaignId, 'ai-dm', 'readiness'] as const,
  /** #577 — the AI's factual claims plus the server's verdict on each (the grounding card). */
  aiDmGrounding: (campaignId: number) => ['campaign', campaignId, 'ai-dm', 'grounding'] as const,
  /** #1558 — confirm-policy tool calls waiting on a DM's approval. */
  aiDmToolConfirmations: (campaignId: number) => ['campaign', campaignId, 'ai-dm', 'tool-confirmations'] as const,
  /** #599 — the table safety hold (X-Card). Read by every campaign surface, not just the table. */
  tableSafety: (campaignId: number) => ['campaign', campaignId, 'safety'] as const,
} satisfies Record<string, (...args: never[]) => QueryKey>;

/**
 * Invalidate every read scoped to one encounter (the encounter itself, its difficulty
 * derivation, and its combat log). Called from the SSE handler and from mutation
 * `onSettled` so a change — ours or another member's — reconciles against server truth.
 * The prefix match on `['encounter', id]` sweeps the child keys in one call.
 */
export function invalidateEncounter(client: QueryClient, encounterId: number): void {
  void client.invalidateQueries({ queryKey: queryKeys.encounter(encounterId) });
}

/**
 * Invalidate campaign character reads (issue #421). Called from the run-session SSE
 * handler on `character.updated` so inline encounter cards reconcile sheet edits
 * (actions/stats/saves/skills/slots) without requiring an encounterId on the frame.
 */
export function invalidateCampaignCharacters(client: QueryClient, campaignId: number): void {
  void client.invalidateQueries({ queryKey: queryKeys.campaignCharacters(campaignId) });
  void client.invalidateQueries({ queryKey: queryKeys.campaignParty(campaignId) });
}

/**
 * Invalidate the DM check-request feed (issue #415). Called from the run-session SSE handler on
 * `check.requested` / `check.resolved` so the DM's request panel and the targeted player's prompt
 * reconcile without a manual reload.
 */
export function invalidateCampaignCheckRequests(client: QueryClient, campaignId: number): void {
  void client.invalidateQueries({ queryKey: queryKeys.campaignCheckRequests(campaignId) });
}

// ---------------------------------------------------------------------------
// AI-DM reads (#338 foundation). Mirror of the server's thin session/seat truth so
// the Table page + levers + co-DM surfaces (#339–#344) all read through one seam.
// ---------------------------------------------------------------------------

/** Low-level turn-loop / pause status (server `AiDmSessionStatus`). */
export type AiDmSessionStatus = 'idle' | 'running' | 'paused';

/**
 * Session lifecycle phase (server `AiDmSessionPhase`, #1043). Orthogonal to `status` and
 * `state`: a seat can be paused during `greeting` or stuck during `wrap_up`. Defaults to
 * `active`, which is the behaviour every table had before the lifecycle existed.
 */
export type AiDmSessionPhase = 'greeting' | 'active' | 'wrap_up' | 'ended';

/** Stuck-ladder lifecycle the player levers act on (server `AiDmLadderState`, #314). */
export type AiDmLadderState =
  | 'running'
  | 'awaiting_players'
  | 'paused'
  | 'human_control'
  /** #1051 — the AI narrates, a DM confirms every mechanical commit. Not a frozen state. */
  | 'collaborative';

/** Snapshot of the current stuck condition; null when healthy (server `AiDmStuckInfo`, #314). */
export interface AiDmStuckInfo {
  reason: string;
  detail: string;
  since: string;
  turn: number;
}

/** A revocable, audited grant of the DM seat to a human (server `AiDmActingDmGrant`, #314). */
export interface AiDmActingDmGrant {
  memberId: string;
  grantedBy: string;
  grantedAt: string;
  note: string | null;
}

/** A lightweight table vote to override/pause the seat (server `AiDmTableVote`, #314). */
export interface AiDmTableVote {
  id: string;
  kind: 'override' | 'pause';
  openedBy: string;
  openedAt: string;
  ballots: Record<string, boolean>;
  threshold: number;
  resolved: boolean;
  outcome: 'passed' | 'failed' | null;
}

/**
 * The seat's most recent committed action a DM can still reverse (#1501), mirroring the
 * server's `DriverLastUndoableCommit`. Null when nothing undoable was committed. The DM-only
 * "Undo the AI's last action" control reads this; the undo itself is enforced server-side.
 */
export interface DriverLastUndoableCommit {
  encounterId: number;
  actorCombatantId: number;
  chainId: string;
  actionName: string;
  committedAt: string;
}

/**
 * The thin server-truth session state (GET /campaigns/:id/ai-dm/session), mirroring the
 * server's `AiDmSessionState`. Deliberately lightweight: the running transcript is
 * client-assembled from the SSE stream (see features/ai-dm/transcript.ts), and a late
 * joiner seeds from `scene` + `lastNarration`.
 */
export interface AiDmSession {
  campaignId: number;
  status: AiDmSessionStatus;
  state: AiDmLadderState;
  /** Session lifecycle phase (#1043). */
  phase: AiDmSessionPhase;
  scene: string | null;
  lastNarration: string | null;
  lastTurnAt: string | null;
  turnCount: number;
  stuck: AiDmStuckInfo | null;
  levers: string[];
  actingDm: AiDmActingDmGrant | null;
  vote: AiDmTableVote | null;
  takeoverRequestedBy: string | null;
  /**
   * How many past table events the AI can draw on for conversation memory (#1038). Derived
   * server-side from the durable transcript on every read, so it reflects a DM purge or
   * retention pruning immediately. Optional: a server predating #1038 simply omits it.
   */
  historyLength?: number;
  /** The seat's last reversible action commit (#1501), or null when there is nothing to undo. */
  lastUndoableCommit?: DriverLastUndoableCommit | null;
}

/**
 * The AI-DM seat config (GET /campaigns/:id/ai-dm). `instructions` is server-omitted for
 * non-DM callers (#261), hence the union with `Omit<…, 'instructions'>`. The seat `mode`
 * (`off` | `co_dm` | `driver`) drives the page shell (design point 7).
 */
export type AiDmSeatView = AiDmSeat | Omit<AiDmSeat, 'instructions'>;

/**
 * Watch the thin AI-DM session state. Refetched by the SSE hook's `onReconnect` and by the
 * stuck/state/vote/takeover stream signals; kept short-`staleTime` so at-the-table surfaces
 * reconcile quickly. Stops (via the shared retry rule) on a 4xx — the server enforces the
 * role matrix, the client just surfaces it.
 */
export function useAiDmSession(campaignId: number | undefined): UseQueryResult<AiDmSession> {
  return useQuery({
    queryKey: campaignId !== undefined ? queryKeys.aiDmSession(campaignId) : ['ai-dm', 'session', 'disabled'],
    queryFn: () => api.get<AiDmSession>(`${API}/campaigns/${campaignId}/ai-dm/session`),
    enabled: campaignId !== undefined && Number.isFinite(campaignId),
  });
}

/** Read the AI-DM seat config (mode / enabled / budget / instructions-when-DM). */
export function useAiDmSeat(campaignId: number | undefined): UseQueryResult<AiDmSeatView> {
  return useQuery({
    queryKey: campaignId !== undefined ? queryKeys.aiDmSeat(campaignId) : ['ai-dm', 'seat', 'disabled'],
    queryFn: () => api.get<AiDmSeatView>(`${API}/campaigns/${campaignId}/ai-dm`),
    enabled: campaignId !== undefined && Number.isFinite(campaignId),
  });
}

/**
 * Mark the AI-DM session + seat + readiness reads stale (called from stuck/state/vote/takeover
 * signals). Readiness is derived from the seat's budget/mode and the metered usage a turn
 * spends, so it goes stale on exactly the same signals — without this the onboarding checklist
 * and the per-turn cost estimate keep rendering pre-turn numbers (#519).
 */
/**
 * One confirm-policy tool call waiting on a DM (#474), as returned by
 * GET /campaigns/:id/ai-dm/tool-confirmations. DM-only server-side.
 *
 * #1495 — re-exported from `@campfire/schema` rather than redefined here: this used to be a
 * web-only literal union for `profile`/`policy` that independently listed the same values the
 * server's `DriverSessionProfile`/`DriverToolPolicyClass` list, so a server-side profile change
 * could compile while this copy silently drifted out of sync (AGENTS.md: shared domain shapes
 * live in the schema package, not redefined in the server or web app).
 */
export type { AiDmToolConfirmation };

/**
 * Watch the pending tool-confirmation queue (#1558).
 *
 * `enabled` is the caller's, because the endpoint is DM-only and a player polling it would
 * generate a steady drip of 403s. A modest poll backs up the SSE signal for the same reason the
 * safety hold polls: this is a queue whose whole failure mode is a SILENT stall, and a dead SSE
 * connection is exactly the condition under which the DM most needs the list to still arrive.
 */
export function useAiDmToolConfirmations(
  campaignId: number | undefined,
  enabled: boolean,
): UseQueryResult<AiDmToolConfirmation[]> {
  return useQuery({
    queryKey:
      campaignId !== undefined ? queryKeys.aiDmToolConfirmations(campaignId) : ['ai-dm', 'tool-confirmations', 'disabled'],
    queryFn: () => api.get<AiDmToolConfirmation[]>(`${API}/campaigns/${campaignId}/ai-dm/tool-confirmations`),
    enabled: enabled && campaignId !== undefined && Number.isFinite(campaignId),
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function invalidateAiDmToolConfirmations(client: QueryClient, campaignId: number): void {
  void client.invalidateQueries({ queryKey: queryKeys.aiDmToolConfirmations(campaignId) });
}

/**
 * Watch the table safety hold (#599).
 *
 * `refetchInterval` is deliberate and deliberately short. Every other read in this file is
 * happy to wait for an SSE tick, because being a few seconds stale about a quest title costs
 * nothing. Being stale about whether the table has stopped costs the exact thing the feature
 * exists to buy, and SSE is the layer most likely to be quietly dead (a sleeping laptop, a
 * proxy that dropped the stream, a tab restored from bfcache). The poll is the floor under the
 * event: the event makes it feel instant, the poll makes it eventually true regardless.
 */
export function useTableSafety(campaignId: number | undefined): UseQueryResult<TableSafetyHold> {
  return useQuery({
    queryKey: campaignId !== undefined ? queryKeys.tableSafety(campaignId) : ['safety', 'disabled'],
    queryFn: () => api.get<TableSafetyHold>(`${API}/campaigns/${campaignId}/safety`),
    enabled: campaignId !== undefined && Number.isFinite(campaignId),
    staleTime: 0,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
}

/** Mark the table safety hold stale (SSE `safety.hold` tick, or after activating/releasing). */
export function invalidateTableSafety(client: QueryClient, campaignId: number): void {
  void client.invalidateQueries({ queryKey: queryKeys.tableSafety(campaignId) });
}

export function invalidateAiDm(client: QueryClient, campaignId: number): void {
  void client.invalidateQueries({ queryKey: queryKeys.aiDmSession(campaignId) });
  void client.invalidateQueries({ queryKey: queryKeys.aiDmSeat(campaignId) });
  void client.invalidateQueries({ queryKey: queryKeys.aiDmReadiness(campaignId) });
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // At-the-table surfaces want fresh data when you tab back in.
      refetchOnWindowFocus: true,
      // A 4xx (not-found, forbidden, validation) won't heal by retrying — surface it
      // immediately. Transient 5xx / network errors get a couple of retries.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
      // Slightly stale-tolerant by default; live reads set their own refetchInterval.
      staleTime: 5_000,
    },
    mutations: {
      // Issue #580: NO automatic retry by default. Reads are safe to repeat; mutations
      // are not. This app's mutations include relative writes (HP deltas, turn advance),
      // and a retry of one whose response was merely lost re-applies the damage or skips
      // a combatant's turn. The old default — retry once on any network/5xx — made every
      // endpoint retryable whether or not it could survive being replayed.
      //
      // Retry is now opt-IN, via useKeyedMutation (lib/keyedMutation.ts), which enables it
      // only alongside the idempotency key that makes it safe. Opting in without a key is
      // not expressible, which is the point: a new endpoint cannot inherit retry it has
      // not been protected for.
      retry: false,
      // Issue #1534: fail fast offline instead of pausing. TanStack Query v5 defaults
      // mutations to networkMode 'online', which PAUSES a mutation when the browser
      // reports offline — the promise never settles, so onError rollback paths never
      // run and the optimistic UI stays stuck. 'always' lets the request fail and the
      // existing per-mutation onError/onError handlers (e.g. HP rollback in
      // RunSessionPage, undo-state clear in UndoSnackbar) fire as intended. Reads keep
      // their own network handling via the banners in Layout.tsx (#579 / #581).
      networkMode: 'always',
    },
  },
});
