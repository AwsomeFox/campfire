import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  TABLE_SAFETY_HOLD_ERROR_CODE,
  type SafetyHoldRecovery,
  type TableSafetyHold,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { tableSafetyHolds } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { NotificationsService } from '../notifications/notifications.service';

type AttributedSafetyActor = { id: string; name: string };
type SafetyActor = AttributedSafetyActor | string | null;

function safetyActorName(actor: SafetyActor): string | null {
  if (actor === null) return null;
  return typeof actor === 'string' ? actor : actor.name;
}

function isAttributedSafetyActor(actor: SafetyActor): actor is AttributedSafetyActor {
  return actor !== null && typeof actor !== 'string';
}

/**
 * The table safety hold — an X-Card with teeth (issue #599).
 *
 * WHAT WAS BROKEN. Session zero let a table WRITE DOWN that it uses an X-Card
 * (`SessionZero.safetyTools` is free text), and then gave nobody a way to actually pull
 * one. Encounters had no stop at all. The AI seat had a pause, but it was DM-only, and the
 * table's only participant-reachable levers were a vote and a takeover request — both of
 * which are consensus mechanisms. A safety tool that needs consensus is not a safety tool:
 * it asks the person who is least able to speak up to speak up, and then to wait.
 *
 * THE FOUR DESIGN DECISIONS THIS SERVICE ENCODES
 *
 * 1. IMMEDIACY OVER CORRECTNESS-UNDER-CONCURRENCY. {@link activate} is an idempotent upsert
 *    that cannot fail: activating an already-active hold returns the existing hold unchanged
 *    and reports success. There is no state machine to reject a transition, no compare-and-set,
 *    no "already paused" conflict. Two participants tapping in the same tick both get 200 and
 *    the table pauses once. Pausing twice is harmless; pausing late is not, and every
 *    correctness guarantee that could make a pause fail is worth less than the pause.
 *
 *    The first activation's `activatedAt` is what the table keeps — a second tap during a live
 *    hold must not make the stop look newer than it is, or a facilitator scrolling back cannot
 *    tell when play actually stopped.
 *
 * 2. ASYMMETRIC AUTHORITY. Activation takes `requireMember` — every member of the campaign,
 *    including a viewer, with no role floor and no reason field. Release takes `requireRole('dm')`.
 *    That asymmetry is the whole safety property: because only a facilitator can UNDO a hold,
 *    it costs nothing to let anyone CREATE one. (Enforced in the controller, which is where
 *    role checks live in this codebase.)
 *
 * 3. ANONYMITY IS STRUCTURAL, NOT A PROJECTION. An anonymous activation never hands this
 *    service an identity — the controller drops it — so there is no column, no cache entry,
 *    and no audit field holding one. Three back doors are closed explicitly:
 *      (a) the AUDIT ROW is written under a synthetic actor with `requestId: null`, because
 *          requestId is a DM-queryable filter and correlating it against any other row written
 *          in the same request would re-attribute the "anonymous" event;
 *      (b) the SSE FRAME carries `{ active }` and nothing else, so no connected browser ever
 *          receives the actor, and so an attributed and an anonymous hold produce a
 *          byte-identical frame;
 *      (c) the NOTIFICATION goes to EVERY member including the activator. `notifyCampaign`
 *          normally excludes the actor, which would have made the one participant who did not
 *          get the ping the one who raised it — attribution by conspicuous absence, delivered
 *          to the whole table. Anonymous holds pass a null actor; attributed holds retain a
 *          stable id but use the same include-everyone fan-out, so delivery is not a signal.
 *    What none of this closes is documented on {@link TableSafetyHold.activatedByName}: the
 *    server operator, and deduction at a very small table.
 *
 * 4. DURABILITY, BECAUSE A RESTART MUST NOT UN-PAUSE A TABLE. The hold is a row, not
 *    in-process state, and every gate ({@link assertNotHeld}) reads that row. A deploy in the
 *    middle of a held session comes back held. The AI seat's own restart-safe control state
 *    (#559) reaches the same conclusion independently and is reconciled against this row on
 *    hydration, so the two cannot disagree about whether the seat may speak.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not reach into the AI driver. The driver
 * registers a freeze hook here ({@link registerFreezeHook}) and this module never imports it,
 * which is what keeps `AiDriverModule -> SafetyModule` a one-way edge. Hooks are fired
 * best-effort and their failures are swallowed: the durable hold is the contract, and a
 * driver that cannot be reached must not be able to stop a participant from stopping play.
 */
@Injectable()
export class TableSafetyService {
  private readonly logger = new Logger(TableSafetyService.name);

  /**
   * Side effects to run when a campaign's hold state flips. Registered by
   * {@link AiDriverService} at construction so the freeze reaches the live AI session
   * without this module depending on the driver. Never awaited and never trusted.
   */
  private readonly freezeHooks: Array<(campaignId: number, held: boolean) => void> = [];

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly events: CampaignEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Register a side effect fired (best-effort) whenever a campaign's hold state flips. */
  registerFreezeHook(hook: (campaignId: number, held: boolean) => void): void {
    this.freezeHooks.push(hook);
  }

  private fireFreezeHooks(campaignId: number, held: boolean): void {
    for (const hook of this.freezeHooks) {
      try {
        hook(campaignId, held);
      } catch (err) {
        // A hook is a downstream freeze, not the freeze itself. The row is already written
        // and every gate already reads it, so a throwing hook must be loud and inert — never
        // a reason the participant's stop request fails.
        this.logger.error(`Safety freeze hook failed for campaign ${campaignId}`, err);
      }
    }
  }

  /** The campaign's hold state. A campaign that has never held returns the inert default. */
  getHold(campaignId: number): TableSafetyHold {
    const row = this.readRow(campaignId);
    if (!row) {
      return {
        campaignId,
        active: false,
        activatedAt: null,
        activatedByName: null,
        anonymous: true,
        activationCount: 0,
        releasedAt: null,
        releasedByName: null,
        recovery: null,
        facilitatorNote: null,
        updatedAt: nowIso(),
      };
    }
    return {
      campaignId,
      active: row.active,
      activatedAt: row.activatedAt ?? null,
      activatedByName: row.activatedByName ?? null,
      anonymous: row.anonymous,
      activationCount: row.activationCount ?? 0,
      releasedAt: row.releasedAt ?? null,
      releasedByName: row.releasedBy ?? null,
      recovery: (row.recovery as SafetyHoldRecovery | null) ?? null,
      facilitatorNote: row.facilitatorNote ?? null,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Is play frozen for this campaign right now?
   *
   * Reads the row on every call rather than caching. This sits on encounter turn advancement,
   * not on a hot loop, and the alternative — an in-memory mirror — has exactly one failure mode
   * (a stale `false`) and that failure mode is "the table did not stop when someone asked it to".
   * A primary-key lookup in better-sqlite3 is cheap enough that trading it for that risk would
   * be a bad bargain at a hundred times the cost.
   *
   * A read failure returns `false` deliberately. Failing OPEN here is the lesser evil: a
   * database that cannot be read is already a broken server, and the alternative — failing
   * closed — would wedge every encounter in the install behind an error nobody can clear,
   * turning a transient read fault into a table-wide denial of play. The activation path itself
   * does not swallow errors, so a participant whose stop request fails is told so.
   */
  isHeld(campaignId: number): boolean {
    try {
      return this.readRow(campaignId)?.active === true;
    } catch (err) {
      this.logger.error(`Failed to read safety hold for campaign ${campaignId}`, err);
      return false;
    }
  }

  /**
   * The gate every play-advancement path calls. Throws 409 with a stable code so clients can
   * render the safety banner rather than a generic conflict.
   *
   * The message names no participant and gives no reason, because there is no participant or
   * reason to name — a paused table looks identical from the outside whoever paused it.
   */
  assertNotHeld(campaignId: number): void {
    if (!this.isHeld(campaignId)) return;
    throw new ConflictException({
      code: TABLE_SAFETY_HOLD_ERROR_CODE,
      message:
        'The table is paused by a safety hold. A facilitator must resolve it before play continues.',
    });
  }

  /**
   * Raise a hold. Idempotent, unilateral, and never throws on a race.
   *
   * Anonymous activations receive null. Attributed HTTP calls retain a stable id only for their
   * notification row, while legacy direct callers may still provide just a display name.
   */
  async activate(campaignId: number, actor: SafetyActor): Promise<TableSafetyHold> {
    const actorName = safetyActorName(actor);
    const anonymous = actorName === null;
    const ts = nowIso();
    const existing = this.readRow(campaignId);
    const alreadyHeld = existing?.active === true;

    if (!alreadyHeld) {
      // A single UPSERT, not read-then-write: the whole point is that this cannot lose a race
      // or reject. `activated_at` uses excluded.* only on this transition, so a re-activation
      // during a live hold (handled by the early-out below) can never move the timestamp.
      this.db
        .insert(tableSafetyHolds)
        .values({
          campaignId,
          active: true,
          activatedAt: ts,
          activatedByName: actorName,
          anonymous,
          activationCount: 1,
          releasedAt: null,
          releasedBy: null,
          recovery: null,
          facilitatorNote: null,
          updatedAt: ts,
        })
        .onConflictDoUpdate({
          target: tableSafetyHolds.campaignId,
          set: {
            active: true,
            activatedAt: ts,
            activatedByName: actorName,
            anonymous,
            activationCount: sql`${tableSafetyHolds.activationCount} + 1`,
            // The previous hold's resolution is cleared: `recovery` describes how the CURRENT
            // hold ended, and a live hold has not ended.
            releasedAt: null,
            releasedBy: null,
            recovery: null,
            facilitatorNote: null,
            updatedAt: ts,
          },
        })
        .run();
    }

    // Fire even on a redundant activation. The hook is idempotent (the driver's freeze is a
    // "set paused", not a toggle), and re-firing is how a second tap repairs a table whose
    // first tap wrote the row but whose driver freeze failed.
    this.fireFreezeHooks(campaignId, true);

    if (!alreadyHeld) {
      await this.recordActivation(campaignId, actor, anonymous);
    }
    return this.getHold(campaignId);
  }

  /**
   * Release a hold. Facilitator only (enforced at the controller).
   *
   * Releasing is NOT the same as resuming: only `recovery: 'resume'` tells downstream hooks to
   * un-freeze. Every other disposition — rewind, veil, scene change, end — leaves the AI seat
   * paused, because in all four the facilitator is about to change the fiction and the seat
   * must not narrate into the gap before they have. The facilitator resumes explicitly
   * afterwards via the seat's own resume, which is now unblocked.
   */
  async release(
    campaignId: number,
    facilitatorName: string,
    recovery: SafetyHoldRecovery,
    note: string | null,
    facilitatorUserId?: string,
  ): Promise<TableSafetyHold> {
    const ts = nowIso();
    // Idempotent in the same way activation is: releasing an already-released table is a no-op
    // that succeeds. A facilitator double-tapping "resume" must not see an error.
    this.db
      .insert(tableSafetyHolds)
      .values({
        campaignId,
        active: false,
        activatedAt: null,
        activatedByName: null,
        anonymous: true,
        activationCount: 0,
        releasedAt: ts,
        releasedBy: facilitatorName,
        recovery,
        facilitatorNote: note,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: tableSafetyHolds.campaignId,
        set: {
          active: false,
          // The activating participant's name is CLEARED on release, not retained as history.
          // An attributed hold was attributed for the duration of the stop so the table could
          // talk to them; it is not a permanent record of who needed the table to stop.
          activatedByName: null,
          releasedAt: ts,
          releasedBy: facilitatorName,
          recovery,
          facilitatorNote: note,
          updatedAt: ts,
        },
      })
      .run();

    this.fireFreezeHooks(campaignId, false);
    await this.recordRelease(campaignId, facilitatorName, recovery, note, facilitatorUserId);
    return this.getHold(campaignId);
  }

  // ---- broadcast / audit ---------------------------------------------------------

  private async recordActivation(
    campaignId: number,
    actor: SafetyActor,
    anonymous: boolean,
  ): Promise<void> {
    const actorName = safetyActorName(actor);
    this.emitHoldEvent(campaignId, true);
    await this.audit
      .log({
        // The audit ACTOR is the mechanism, never the person, for the anonymous case. For an
        // attributed hold the name the participant chose to attach is recorded in `detail`,
        // not in `actor`, so the actor column stays a stable filter for "safety holds" rather
        // than becoming a per-participant index of who has needed one.
        actor: anonymous ? 'table-safety:anonymous' : `table-safety:${actorName}`,
        actorRole: 'player',
        action: 'safety.hold.activated',
        entityType: 'campaign',
        entityId: campaignId,
        campaignId,
        detail: anonymous ? 'safety hold raised (anonymous)' : `safety hold raised by ${actorName}`,
        // See the doc on AuditService.log: an anonymous row must not carry the correlation id
        // that could join it back to an attributed row from the same request.
        ...(anonymous ? { requestId: null } : {}),
      })
      .catch((err) => this.logger.error(`Safety hold audit failed for campaign ${campaignId}`, err));

    await this.notifyTable(
      campaignId,
      'The table is paused',
      anonymous
        ? 'Someone at the table used the safety hold. Play is paused until a facilitator resolves it.'
        : `${actorName} used the safety hold. Play is paused until a facilitator resolves it.`,
      isAttributedSafetyActor(actor) ? actor : null,
    );
  }

  private async recordRelease(
    campaignId: number,
    facilitatorName: string,
    recovery: SafetyHoldRecovery,
    note: string | null,
    facilitatorUserId?: string,
  ): Promise<void> {
    this.emitHoldEvent(campaignId, false);
    await this.audit
      .log({
        actor: `table-safety:${facilitatorName}`,
        actorRole: 'dm',
        action: 'safety.hold.released',
        entityType: 'campaign',
        entityId: campaignId,
        campaignId,
        detail: `safety hold released with recovery=${recovery}${note ? ` — ${note}` : ''}`,
      })
      .catch((err) => this.logger.error(`Safety release audit failed for campaign ${campaignId}`, err));

    await this.notifyTable(
      campaignId,
      'The table safety hold was resolved',
      `${facilitatorName} resolved the hold (${recovery}).${note ? ` ${note}` : ''}`,
      facilitatorUserId ? { id: facilitatorUserId, name: facilitatorName } : null,
    );
  }

  private emitHoldEvent(campaignId: number, active: boolean): void {
    try {
      this.events.emit({ type: 'safety.hold', campaignId, active });
    } catch (err) {
      this.logger.error(`Safety hold event emit failed for campaign ${campaignId}`, err);
    }
  }

  /**
   * Notify the whole table, including the actor, always. Anonymous holds retain no identity.
   *
   * `notifyCampaign` excludes the actor from the recipient list, which is right for "Ana
   * updated the quest" and catastrophic here: the one member who did not get the ping would be
   * the member who raised the hold, which is attribution by absence — the exact back door the
   * anonymity promise has to close. Attributed holds retain the stable id in the notification
   * row, but use specialized fan-out so the recipient pattern remains identical and a later
   * rename/deletion can rewrite it.
   */
  private async notifyTable(
    campaignId: number,
    title: string,
    body: string,
    actor: AttributedSafetyActor | null,
  ): Promise<void> {
    try {
      const event = {
        type: 'safety_hold',
        title,
        body,
        entityType: null,
        entityId: null,
        actorName: actor?.name ?? '',
      } as const;
      if (actor) {
        await this.notifications.notifyCampaignIncludingActor(campaignId, actor.id, event, { bypassBlockFilter: true });
      } else {
        await this.notifications.notifyCampaign(campaignId, null, event);
      }
    } catch {
      /* best-effort — a notification failure must never break the stop */
    }
  }

  private readRow(campaignId: number): typeof tableSafetyHolds.$inferSelect | undefined {
    return this.db
      .select()
      .from(tableSafetyHolds)
      .where(eq(tableSafetyHolds.campaignId, campaignId))
      .limit(1)
      .get() as typeof tableSafetyHolds.$inferSelect | undefined;
  }
}
