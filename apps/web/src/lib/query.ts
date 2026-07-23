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
import type { AiDmSeat } from '@campfire/schema';
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
  /** All encounters in a campaign (the list surface). */
  campaignEncounters: (campaignId: number) => ['campaign', campaignId, 'encounters'] as const,
  campaignCharacters: (campaignId: number) => ['campaign', campaignId, 'characters'] as const,
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

// ---------------------------------------------------------------------------
// AI-DM reads (#338 foundation). Mirror of the server's thin session/seat truth so
// the Table page + levers + co-DM surfaces (#339–#344) all read through one seam.
// ---------------------------------------------------------------------------

/** Low-level turn-loop / pause status (server `AiDmSessionStatus`). */
export type AiDmSessionStatus = 'idle' | 'running' | 'paused';

/** Stuck-ladder lifecycle the player levers act on (server `AiDmLadderState`, #314). */
export type AiDmLadderState = 'running' | 'awaiting_players' | 'paused' | 'human_control';

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
 * The thin server-truth session state (GET /campaigns/:id/ai-dm/session), mirroring the
 * server's `AiDmSessionState`. Deliberately lightweight: the running transcript is
 * client-assembled from the SSE stream (see features/ai-dm/transcript.ts), and a late
 * joiner seeds from `scene` + `lastNarration`.
 */
export interface AiDmSession {
  campaignId: number;
  status: AiDmSessionStatus;
  state: AiDmLadderState;
  scene: string | null;
  lastNarration: string | null;
  lastTurnAt: string | null;
  turnCount: number;
  stuck: AiDmStuckInfo | null;
  levers: string[];
  actingDm: AiDmActingDmGrant | null;
  vote: AiDmTableVote | null;
  takeoverRequestedBy: string | null;
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

/** Mark the AI-DM session + seat reads stale (called from stuck/state/vote/takeover signals). */
export function invalidateAiDm(client: QueryClient, campaignId: number): void {
  void client.invalidateQueries({ queryKey: queryKeys.aiDmSession(campaignId) });
  void client.invalidateQueries({ queryKey: queryKeys.aiDmSeat(campaignId) });
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
      // Same 4xx-is-terminal rule as reads.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 1;
      },
    },
  },
});
