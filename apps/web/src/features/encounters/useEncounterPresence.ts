/**
 * Co-DM encounter presence — the web client half of the ephemeral presence
 * foundation delivered by issue #2209 (#816 slice 1). This hook is the UI layer
 * (issue #2212, #816 slice 2): while a DM holds open a RUNNING encounter, it:
 *
 *  - DECLARES the caller present (`POST /encounters/:id/presence`) on open and on
 *    every coarse-activity change (`viewing` ↔ `editing`), seeding the local roster
 *    from the snapshot the server returns (AC #2212.2).
 *  - HEARTBEATS that declaration on a cadence well inside the server's 45s TTL
 *    (default 30s) while the tab is visible, so the lease never silently expires
 *    (AC #2212.3).
 *  - LEAVES (`DELETE /encounters/:id/presence`) on unmount / navigate-away / loss of
 *    eligibility, via a `keepalive` fetch so the leave survives page teardown.
 *  - exposes the live roster (reconciled from those POST responses AND from
 *    `encounter.presence` SSE frames routed through {@link EncounterPresenceApi.applySnapshot})
 *    for the runner to render "Alice and Bob are here" (AC #2212.1, #2212.4).
 *
 * Presence is transport-level state, not a domain write (see the schema doc on
 * `EncounterPresenceSnapshot`): it is in-memory only, never audited, and the secrecy
 * invariant — a hidden encounter's presence reaches DMs only — is enforced server-side
 * at emit time (#2209). This hook therefore sends `activity` and reconciles whatever
 * `members` it receives; it performs NO client-side hiding (AC #2212.7).
 *
 * Only DMs declare (AC #2212.2: "When a DM opens a running encounter …"); pass
 * `enabled` false for everyone else. A DM never appears in their own indicator — the
 * caller filters `members` by the current user's id (AC #2212.5) — but the roster this
 * hook holds DOES include the caller, because they legitimately declared.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  EncounterPresenceActivity,
  EncounterPresenceEntry,
  EncounterPresenceSnapshot,
} from '@campfire/schema';
import { api, API } from '../../lib/api';

export interface UseEncounterPresenceOptions {
  campaignId: number;
  encounterId: number;
  /**
   * Only eligible viewers declare. Callers should pass `isDm && encounter.status ===
   * 'running'` (AC #2212.2). When false the hook declares/heartbeats nothing and leaves
   * any prior declaration, so it is safe to mount unconditionally.
   */
  enabled: boolean;
  /**
   * Coarse activity to declare. The hook re-declares when this changes (the server
   * broadcasts a fresh snapshot on an activity change), so a Co-DM's "editing" surfaces
   * promptly rather than waiting for the next heartbeat.
   */
  activity: EncounterPresenceActivity;
  /** Heartbeat cadence in ms. Defaults to 30s — well inside the 45s server TTL. */
  heartbeatMs?: number;
}

export interface EncounterPresenceApi {
  /** Current presence roster (a snapshot — replace, never patch). Includes the caller. */
  members: EncounterPresenceEntry[];
  /** Replace the roster from an `encounter.presence` SSE frame (or any fresh snapshot). */
  applySnapshot: (members: EncounterPresenceEntry[]) => void;
  /** Re-declare immediately (used on SSE reconnect/recovery to restore presence). */
  redeclare: () => void;
}

/** Default heartbeat interval (ms). Server presence TTL is 45s; this stays well inside. */
export const ENCOUNTER_PRESENCE_HEARTBEAT_MS = 30_000;

export function useEncounterPresence({
  encounterId,
  enabled,
  activity,
  heartbeatMs = ENCOUNTER_PRESENCE_HEARTBEAT_MS,
}: UseEncounterPresenceOptions): EncounterPresenceApi {
  const [members, setMembers] = useState<EncounterPresenceEntry[]>([]);

  // A snapshot is a full replace (see EncounterPresenceSnapshot), so the setter is a
  // trivial stable callback the SSE handler can call without entering the effect deps.
  const applySnapshot = useCallback((next: EncounterPresenceEntry[]) => {
    setMembers(next);
  }, []);

  // Declare (or refresh) presence. The response is the post-declare snapshot, which we
  // reconcile into local state — a same-activity heartbeat still returns the full set, so
  // this keeps the roster fresh even between SSE frames. Best-effort: a failed declare
  // (e.g. a transient network blip, or the encounter being ended/trashed concurrently)
  // leaves the previous roster in place; the next heartbeat, reconnect re-declare, or SSE
  // frame re-syncs.
  const declare = useCallback(
    async (act: EncounterPresenceActivity): Promise<void> => {
      try {
        const snap = await api.post<EncounterPresenceSnapshot>(
          `${API}/encounters/${encounterId}/presence`,
          { activity: act },
        );
        setMembers(snap.members);
      } catch {
        /* best-effort — heartbeat / reconnect / SSE re-sync */
      }
    },
    [encounterId],
  );

  // Latest activity/enabled, read inside the heartbeat tick and `redeclare` without
  // restarting those effects on every activity flip.
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // AC #2212.2: declare on open and re-declare on a coarse-activity change so a Co-DM's
  // "editing" is reflected without waiting for the heartbeat. `activity` is a two-state
  // hint tied to discrete DM actions, so this is one declare per action — not a storm.
  useEffect(() => {
    if (!enabled) return;
    void declare(activity);
  }, [enabled, encounterId, activity, declare]);

  // AC #2212.3: heartbeat while the tab is visible. The server TTL is 45s; 30s keeps the
  // lease safe across one missed tick. Pauses while hidden (AC: "while the encounter tab
  // is visible") and re-declares immediately on becoming visible — if the tab was hidden
  // past the TTL the server already reaped the entry, and this restores it.
  useEffect(() => {
    if (!enabled) return;

    let handle: ReturnType<typeof setInterval> | undefined;
    const tick = (): void => {
      void declare(activityRef.current);
    };
    const stop = (): void => {
      if (handle !== undefined) {
        clearInterval(handle);
        handle = undefined;
      }
    };
    const start = (): void => {
      if (handle === undefined) handle = setInterval(tick, heartbeatMs);
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        tick();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stop();
    };
  }, [enabled, encounterId, heartbeatMs, declare]);

  // Re-declare immediately on SSE reconnect/recovery — a long outage may have crossed the
  // TTL and let the server reap this entry, so reconnect restores presence rather than
  // waiting up to a heartbeat. No-op when presence is not enabled.
  const redeclare = useCallback((): void => {
    if (!enabledRef.current) return;
    void declare(activityRef.current);
  }, [declare]);

  // AC #2212.2: leave on unmount / navigate-away / loss of eligibility. `keepalive` so the
  // DELETE survives page teardown; a dropped leave is harmless (the server reaps the entry
  // at its TTL). Clearing local state keeps a re-enabled hook from flashing stale names.
  useEffect(() => {
    if (!enabled) return;
    const id = encounterId;
    return () => {
      void api
        .delete(`${API}/encounters/${id}/presence`, { keepalive: true })
        .catch(() => {
          /* best-effort — TTL reap covers a dropped leave */
        });
      setMembers([]);
    };
  }, [enabled, encounterId]);

  return { members, applySnapshot, redeclare };
}
