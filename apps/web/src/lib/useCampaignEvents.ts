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
 * 403 OR 404 (issue #1707 — trash yields 404 for a still-a-member subscriber, see
 * `CampaignEventsHandlers.onForbidden`) stops without clearing identity (retrying won't help).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { CombatantKind, type CampaignEvent } from '@campfire/schema';
import { useAuth } from '../app/auth';
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
  /**
   * Fires the instant this campaign's stream terminally loses access (issue #1640, widened
   * by #1707) — the subscriber is no longer a member (removed), OR the campaign itself was
   * trashed. See `sseReconnect.ts`'s `onForbidden` for the full mechanism: the server closes
   * the stream reactively the moment either happens (#527 for revocation, #867 for trash), so
   * a tab with this campaign open learns about it on the very next reconnect attempt, not on
   * the next unrelated request that happens to fail.
   *
   * Two different statuses on that reconnect, both routed here: revocation (member removed,
   * campaign still exists) yields 403; trash (campaign gone, but a still-intact
   * `campaignMembers` row means THIS user still resolves as a member per
   * `assertLifecycleAccess`) yields 404 instead — see that function's own docstring
   * ("Trashed + member → 404, matching GET /campaigns/:id"). `treatNotFoundAsForbidden: true`
   * below is what folds the 404 case in; it is opt-in on `startSseReconnectLoop` specifically
   * for this endpoint, not a change to the shared 401/403 classifier, because a 404 is
   * genuinely retryable on other streams (e.g. the AI-DM stream).
   */
  onForbidden?: () => void;
}

export type CampaignEventsStatus = SseStreamStatus;

/**
 * Runtime guard for the CampaignEvent union (issue #527 widened it to a
 * discriminated union; #582 added treasury.updated; #790 added schedule.updated;
 * #421 added character.updated; #437 added membership.updated).
 */
const ENCOUNTER_EVENT_TYPES = new Set(['encounter.updated', 'encounter.deleted', 'encounter.ping', 'encounter.turn_changed']);
export function isCampaignEvent(value: unknown): value is CampaignEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string' || typeof v.campaignId !== 'number' || typeof v.at !== 'string') return false;
  if (ENCOUNTER_EVENT_TYPES.has(v.type)) {
    if (typeof v.encounterId !== 'number') return false;
    if (v.type !== 'encounter.turn_changed') return true;
    return (
      (v.round === undefined || (typeof v.round === 'number' && Number.isInteger(v.round) && v.round >= 0))
      && (v.turnIndex === undefined || (typeof v.turnIndex === 'number' && Number.isInteger(v.turnIndex) && v.turnIndex >= 0))
      && (v.turnVersion === undefined || (typeof v.turnVersion === 'number' && Number.isInteger(v.turnVersion) && v.turnVersion >= 0))
      && (v.currentCombatantId === undefined || v.currentCombatantId === null || typeof v.currentCombatantId === 'number')
      && (v.combatantKind === undefined || v.combatantKind === null || CombatantKind.safeParse(v.combatantKind).success)
      && (v.turnReverted === undefined || v.turnReverted === true)
    );
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
  if (v.type === 'party.rest.updated') {
    return typeof v.batchId === 'number' && Array.isArray(v.characterIds) && v.characterIds.every((id) => typeof id === 'number');
  }
  // Issue #415: DM check-request lifecycle. Thin — id-only; the client refetches the request
  // payload over the permission-checked REST read.
  if (v.type === 'check.requested' || v.type === 'check.resolved') {
    return typeof v.requestId === 'number' && typeof v.characterId === 'number' && typeof v.userId === 'string';
  }
  if (v.type === 'dice.rolled') {
    return typeof v.rollId === 'number' && (v.encounterId === undefined || typeof v.encounterId === 'number');
  }
  if (v.type === 'campaign.updated') {
    return true;
  }
  if (v.type === 'campaign.trashed') {
    // Issue #867: control signal — server filters it from the data path; accept
    // the shape so the guard stays honest if filtering ever changes.
    return true;
  }
  // Issue #599: the table safety hold flipped. `active` is the ENTIRE payload — no actor, no
  // reason — because this frame reaches every connected browser and an anonymous hold that put
  // the activator on the wire would not be anonymous. Clients refetch GET /campaigns/:id/safety,
  // which is where the anonymity rules are actually enforced.
  if (v.type === 'safety.hold') {
    return typeof v.active === 'boolean';
  }
  if (v.type === 'player-display-scene') {
    return typeof v.scene === 'string';
  }
  // Issue #2212 (#816 slice 2): ephemeral Co-DM presence snapshot. A full roster
  // REPLACE, not a delta — a late/reconnecting client reconciles by swapping its local
  // set for `members` (see EncounterPresenceSnapshot). `userId` is the membership-roster
  // identity space (no secret) and a hidden encounter's frames are routed DM-only at emit
  // time, so this guard is a pure structural check; it carries no secrecy of its own.
  if (v.type === 'encounter.presence') {
    return (
      typeof v.encounterId === 'number'
      && Array.isArray(v.members)
      && v.members.every(
        (m) =>
          m !== null
          && typeof m === 'object'
          && typeof (m as { userId?: unknown }).userId === 'string'
          && ((m as { activity?: unknown }).activity === 'viewing'
            || (m as { activity?: unknown }).activity === 'editing'),
      )
    );
  }
  // AI-DM stream events (Issue #880)
  const AI_DM_TYPES = new Set([
    'turn.start', 'narration.delta', 'narration.message', 'narration.withheld',
    'turn.cancelled', 'turn.error', 'turn.end', 'stuck', 'recovered', 'state',
    'phase', 'vote', 'takeover', 'secret-approval', 'tool-confirmation',
    'transcript', 'session.reset', 'transcript.reset', 'grounding', 'tool'
  ]);
  if (AI_DM_TYPES.has(v.type as string)) {
    return true;
  }
  return false;
}

/**
 * Subscribe to one campaign's event stream.
 *
 * `reconnectKey` is for a caller whose server-side event projection can change without a
 * campaign or account change (for example, an in-place membership role update). Changing it
 * disposes the old request and opens a new one under the current server authorization.
 */
export function useCampaignEvents(
  campaignId: number | undefined,
  handlers: CampaignEventsHandlers,
  reconnectKey?: unknown,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const resumeEpoch = useSyncExternalStore(subscribeSessionResume, getSessionResumeEpoch, () => 0);
  // Issue #1446 review fix (round 6): the stream's lifecycle is (identity × campaign), not
  // campaign alone. `resumeEpoch` only bumps after a PROVEN 401 (see sessionExpiry.ts) —
  // it does not cover an AuthProvider `/me` refresh that swaps the signed-in account
  // without an intervening 401 (e.g. a dev-auth identity flip, or any future in-place
  // reauth). Without `userId` in this effect's key, that kind of account switch leaves the
  // OLD identity's authenticated connection running: the new account sees a false
  // "never connects" (no restart means no fresh `connected`), AND — the serious half — the
  // tab keeps consuming campaign frames delivered on the PREVIOUS account's authenticated
  // request, which is cross-account data reaching a session that should no longer receive
  // it. Clearing a page-local status variable (RunSessionPage's `eventStatus`) cannot fix
  // this; the underlying stream itself has to tear down and re-establish under the new
  // credentials, which only this hook's own effect can do.
  const { me, roleIn } = useAuth();
  const userId = me?.user.id ?? null;
  // #1511: audience-routed dice events depend on the current effective campaign
  // role. A membership refresh may retain the same account id while promoting or
  // demoting it, so role must also restart the authenticated stream.
  const viewerRole = campaignId === undefined ? null : roleIn(campaignId);

  useEffect(() => {
    if (campaignId === undefined || !Number.isFinite(campaignId)) return;

    const loop = startSseReconnectLoop({
      url: `${API}/campaigns/${campaignId}/events`,
      trackBrowserOnline: true,
      // Issue #1707: a trashed campaign's reconnect 404s for a still-a-member subscriber
      // (not 403 — see this hook's `onForbidden` doc above), and that 404 must be just as
      // terminal here as a 403, or a stale tab retries a dead endpoint forever.
      treatNotFoundAsForbidden: true,
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
      onForbidden: () => handlersRef.current.onForbidden?.(),
    });

    return () => loop.dispose();
  }, [campaignId, resumeEpoch, userId, viewerRole, reconnectKey]);
}
