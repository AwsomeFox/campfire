import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { EncounterPresenceActivity, EncounterPresenceEntry, EncounterPresenceSnapshot } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { encounters } from '../../db/schema';
import { CampaignEventsService } from '../events/campaign-events.service';

/** One presence record in the in-memory registry (issue #2209). */
interface PresenceRecord {
  userId: string;
  campaignId: number;
  activity: EncounterPresenceActivity;
  /** Wall-clock ms of the last declare/heartbeat. Reaped by `sweep()` once older than TTL. */
  lastSeenMs: number;
}

/**
 * How long a presence entry survives without a heartbeat before it is expired.
 *
 * The client heartbeats (POST /encounters/:id/presence) on a cadence well inside this
 * window, so a live participant refreshes continually; a participant whose tab closed,
 * crashed, or lost the network stops heartbeating and is reaped after TTL. There is NO
 * background timer (the server module has none anywhere — see the absence of setInterval
 * in src/): expiry is lazy, reaped on the next registry access, which is also when the
 * leave frame is emitted. That is correct because a leave frame only matters to an
 * observer, and an observer's next read/heartbeat is exactly when the registry is touched.
 *
 * Exported mutable so the e2e suite can shrink it to exercise expiry without waiting.
 */
export let ENCOUNTER_PRESENCE_TTL_MS = 45_000;

/** Test-only: shrink the presence TTL to exercise expiry deterministically. */
export function setEncounterPresenceTtlForTests(ms: number): void {
  ENCOUNTER_PRESENCE_TTL_MS = ms;
}

/**
 * Ephemeral, in-memory Co-DM presence registry for encounters (issue #2209, #816 slice 1).
 *
 * Tracks which authenticated users have declared themselves on an encounter's live surface
 * (a coarse `viewing` | `editing` activity) and broadcasts the resulting snapshot as an
 * `encounter.presence` campaign event on the existing SSE stream whenever the set changes
 * (join / activity change / explicit leave / heartbeat-expire).
 *
 * DESIGN NOTES
 *
 *  - In-memory only. Presence is transport-level state (like an SSE keepalive), not a
 *    domain write: it is not persisted and not audited. Restart drops everyone, and a
 *    reconnecting client re-declares (AC: "reconnect restores presence").
 *  - Snapshot, not delta. Each frame carries the full current set for the encounter, so a
 *    late-joining or reconnecting client reconciles by replacing its local state — there is
 *    no persisted history to refetch and no missed-event log to replay.
 *  - Lazy expiry. `sweep()` runs at the top of every public method. It reaps entries whose
 *    last heartbeat is older than TTL and emits a leave snapshot for each affected
 *    encounter. This keeps the registry tidy and the snapshots honest without a timer, and
 *    it is what makes "heartbeat-expire" observable on the wire.
 *  - Secrecy at emit time. A hidden encounter's presence must not reach a non-DM (it would
 *    leak the encounter's existence). The emit helper re-reads the encounter's `hidden`
 *    column fresh and routes the frame through `emitForAudience` with a DM-only predicate
 *    when hidden — the same concurrent-hide defence `EncountersService.emitEncounterEvent`
 *    uses for the encounter.* ticks.
 */
@Injectable()
export class EncounterPresenceService {
  /** encounterId -> (userId -> record). A user may be present on several encounters. */
  private readonly registry = new Map<number, Map<string, PresenceRecord>>();

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly events: CampaignEventsService,
  ) {}

  /**
   * Declare (or refresh) presence for `(userId, encounterId)`. Emits a snapshot when the
   * caller is newly present OR their activity changed; a pure heartbeat (same activity)
   * only refreshes `lastSeenMs` and emits nothing. Always returns the current snapshot.
   */
  declare(input: {
    encounterId: number;
    campaignId: number;
    userId: string;
    activity: EncounterPresenceActivity;
  }): EncounterPresenceSnapshot {
    this.sweep();
    const { encounterId, campaignId, userId, activity } = input;
    const now = Date.now();
    const bucket = this.registry.get(encounterId);
    const existing = bucket?.get(userId);
    // A real change the table needs to hear about: a brand-new participant, or an activity
    // transition (viewing -> editing). A same-activity heartbeat is silent on the wire.
    const changed = !existing || existing.activity !== activity;
    const record: PresenceRecord = { userId, campaignId, activity, lastSeenMs: now };
    if (bucket) {
      bucket.set(userId, record);
    } else {
      this.registry.set(encounterId, new Map([[userId, record]]));
    }
    if (changed) this.emitSnapshot(encounterId, campaignId);
    // readSnapshot (not snapshot): the sweep at the top already reaped stale entries.
    return this.readSnapshot(encounterId);
  }

  /**
   * Remove `(userId, encounterId)` from the registry. Emits a snapshot when the caller was
   * actually present (a leave for someone never present is a no-op on the wire). Returns
   * the resulting snapshot regardless, so a client tearing down its tab gets a confirming
   * body without a second round-trip.
   */
  leave(input: { encounterId: number; userId: string }): EncounterPresenceSnapshot {
    this.sweep();
    const { encounterId, userId } = input;
    const bucket = this.registry.get(encounterId);
    const record = bucket?.get(userId);
    let campaignId = record?.campaignId ?? 0;
    if (record) {
      campaignId = record.campaignId;
      bucket!.delete(userId);
      if (bucket!.size === 0) this.registry.delete(encounterId);
      this.emitSnapshot(encounterId, campaignId);
    }
    // readSnapshot with the campaignId captured before the bucket was emptied.
    return { campaignId, encounterId, members: this.readMembers(encounterId) };
  }

  /**
   * Read the current presence set for an encounter (also the shape returned by declare/
   * leave). Sweeps first so a caller never observes an already-expired participant.
   */
  snapshot(encounterId: number): EncounterPresenceSnapshot {
    this.sweep();
    return this.readSnapshot(encounterId);
  }

  /**
   * Force a sweep now. Public for the e2e suite, which shrinks the TTL and calls this to
   * assert expiry deterministically rather than racing the lazy-reap window.
   */
  expireNow(): void {
    this.sweep();
  }

  // ---- internals ----

  /** Reap entries older than TTL and emit a leave snapshot for each affected encounter. */
  private sweep(): void {
    const cutoff = Date.now() - ENCOUNTER_PRESENCE_TTL_MS;
    const expired: Array<{ encounterId: number; campaignId: number }> = [];
    for (const [encounterId, bucket] of this.registry) {
      let touched = false;
      let campaignId: number | undefined;
      for (const [userId, record] of bucket) {
        if (record.lastSeenMs < cutoff) {
          bucket.delete(userId);
          touched = true;
          campaignId = record.campaignId;
        }
      }
      if (touched && campaignId !== undefined) {
        if (bucket.size === 0) this.registry.delete(encounterId);
        expired.push({ encounterId, campaignId });
      }
    }
    // Emit after the mutation so each snapshot reflects the reaped set. Order is stable
    // enough (Map insertion order by encounterId) and each frame is self-describing.
    for (const { encounterId, campaignId } of expired) {
      this.emitSnapshot(encounterId, campaignId);
    }
  }

  private readSnapshot(encounterId: number): EncounterPresenceSnapshot {
    const bucket = this.registry.get(encounterId);
    const first = bucket?.values().next().value as PresenceRecord | undefined;
    const campaignId = first?.campaignId ?? 0;
    return { campaignId, encounterId, members: this.readMembers(encounterId) };
  }

  private readMembers(encounterId: number): EncounterPresenceEntry[] {
    const bucket = this.registry.get(encounterId);
    return bucket
      ? Array.from(bucket.values())
          .map((r) => ({ userId: r.userId, activity: r.activity }))
          .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
      : [];
  }

  /**
   * Emit the current snapshot for an encounter, role-routing at emit time. A hidden
   * encounter's presence is DM-only (a non-DM must not learn it exists); a visible
   * encounter's presence reaches every campaign member via the normal SSE fan-out.
   * `hidden` is re-read fresh to defend against a concurrent hide, mirroring
   * `EncountersService.emitEncounterEvent`.
   */
  private emitSnapshot(encounterId: number, campaignId: number): void {
    const snapshot = this.readSnapshot(encounterId);
    const hidden = this.currentHidden(encounterId);
    // No audience predicate => the frame fans out to every campaign member. A hidden
    // encounter constrains that to DMs only.
    const audience = hidden ? (viewer: { role: string }) => viewer.role === 'dm' : undefined;
    this.events.emitForAudience(
      { type: 'encounter.presence', campaignId, encounterId, members: snapshot.members },
      audience,
    );
  }

  /** Fresh single-row read of an encounter's `hidden` flag. A missing row reads hidden. */
  private currentHidden(encounterId: number): boolean {
    const row = this.db
      .select({ hidden: encounters.hidden })
      .from(encounters)
      .where(eq(encounters.id, encounterId))
      .get();
    return row ? Boolean(row.hidden) : true;
  }
}
