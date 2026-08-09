import { Inject, Injectable, Logger, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { and, count, desc, eq, exists, gte, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import {
  CAMPAIGN_LIFECYCLE_NOTIFICATION_TYPES,
  MEMBERSHIP_NOTIFICATION_TYPES,
  NOTIFICATION_CATEGORIES,
  QuietHours,
  defaultNotificationMode,
  isCriticalNotificationCategory,
  notificationCategory,
  type EntityType,
  type Notification,
  type NotificationCampaignPreferences,
  type NotificationCategory,
  type NotificationDeliveryMode,
  type NotificationPreferences,
  type NotificationPreferencesUpdate,
  type NotificationType,
  type QuietHours as QuietHoursType,
  type Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  campaignMembers,
  campaigns,
  characters,
  encounters,
  notificationDigestQueue,
  notificationPreferences,
  notificationQuietHours,
  notifications,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { minRole, type RequestUser } from '../../common/user.types';
import { blockedTargetsOf, suppressedRecipients } from '../../common/safety-controls';
import { decideDelivery, isWithinQuietHours } from './notification-preferences.util';

/**
 * What a domain service passes when something notification-worthy happens.
 * Recipients are resolved here (campaign members / a single user); the caller
 * only describes the event.
 */
export interface NotificationEvent {
  type: NotificationType;
  title: string;
  body?: string;
  entityType?: EntityType | null;
  entityId?: number | null;
  /** Focus a specific comment inside the parent entity thread (issue #446). */
  commentId?: number | null;
  /**
   * Issue #820: optional structured payload persisted as JSON. Schedule
   * lifecycle events pass ScheduleNotificationData so clients localize time.
   */
  data?: Record<string, unknown> | null;
  actorName?: string;
}

export interface ListNotificationsOptions {
  unreadOnly?: boolean;
  limit?: number;
  cursor?: number;
  campaignId?: number;
  type?: string;
  startDate?: string;
  endDate?: string;
}

export interface PaginatedNotifications {
  items: Notification[];
  nextCursor: number | null;
  total: number;
  hasMore: boolean;
}

/** Parse the nullable JSON `data` column into a plain object (or null). */
function parseNotificationData(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw == null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed rows degrade to null — title/body remain usable */
  }
  return null;
}

function toDomain(row: typeof notifications.$inferSelect): Notification {
  return {
    id: row.id,
    userId: row.userId,
    campaignId: row.campaignId,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    entityType: row.entityType as EntityType | null,
    entityId: row.entityId,
    commentId: row.commentId ?? null,
    data: parseNotificationData(row.data),
    actorName: row.actorName,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

/** Return the owner-safe projection without changing the durable DM row. */
function toOwnerSafeDomain(row: typeof notifications.$inferSelect): Notification {
  return toDomain({ ...row, entityType: null, entityId: null, data: null });
}

/**
 * Only real users (numeric users.id) can receive notifications — DEV_AUTH
 * `dev:<name>` synthetic users have no users row to hang them on.
 */
function numericUserId(id: string | number): number | null {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Plain-text excerpt for notification bodies (schema caps body at 1000). */
export function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** How often deferred (digest / quiet-hours) notifications are flushed. */
const DIGEST_FLUSH_INTERVAL_MS = 60_000;
/** Max rows drained per flush tick to avoid full-table scans. */
const DIGEST_BATCH_SIZE = 500;

type SyncDb = DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

type HiddenStatusAudience = 'campaign_member' | 'permanent_dm' | 'character_owner';
type HiddenStatusDisposition = 'allow' | 'redact' | 'project_redact' | 'deny' | 'filter';

interface HiddenStatusReadGuard {
  filteredIds: number[];
  projectedRedactIds: number[];
}

/** Private persistence metadata; deliberately separate from public notification `data`. */
interface HiddenStatusContext {
  encounterId: number;
  characterId: number;
  audience: HiddenStatusAudience;
}

function parseHiddenStatusContext(raw: string | null | undefined): HiddenStatusContext | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Number.isInteger((parsed as HiddenStatusContext).encounterId) &&
      Number.isInteger((parsed as HiddenStatusContext).characterId) &&
      ((parsed as HiddenStatusContext).audience === 'campaign_member' ||
        (parsed as HiddenStatusContext).audience === 'permanent_dm' ||
        (parsed as HiddenStatusContext).audience === 'character_owner')
    ) {
      return parsed as HiddenStatusContext;
    }
  } catch {
    // Malformed private context must fail closed at the next read/flush.
  }
  return null;
}

/** Default (never-configured) quiet hours: disabled. */
function defaultQuietHours(): QuietHoursType {
  return QuietHours.parse({});
}

/**
 * In-app notification store. Deliberately transport-agnostic: rows are written
 * synchronously by domain services and read by polling clients today; a
 * real-time push channel (SSE — issue #4) can later observe the same writes
 * without any change to emitters or the table.
 *
 * Emission is best-effort by design: callers `await` it inside the same request
 * but a notification failure must never fail the triggering write, so both
 * notify* methods swallow errors.
 *
 * Issue #789: fan-out now consults per-user, per-campaign preferences BEFORE a
 * row is written. Each NotificationType maps to a category; the recipient's mode
 * for that category decides immediate delivery, digest deferral, or muting, and
 * quiet hours defer otherwise-immediate rows. Critical categories
 * (access/security) bypass all of this and are always delivered.
 */
@Injectable()
export class NotificationsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotificationsService.name);
  private flushingDigests = false;

  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  /**
   * Drain deferred notifications on a cadence. No boot-time flush (nothing is
   * queued at boot) — just an `.unref()`d interval so it never keeps Node alive,
   * mirroring the audit/rolls sweeps. Best-effort: a failing tick is swallowed.
   */
  onApplicationBootstrap(): void {
    const timer = setInterval(() => {
      void this.flushDigests().catch(() => {
        /* best-effort background flush */
      });
    }, DIGEST_FLUSH_INTERVAL_MS);
    timer.unref();
  }

  /**
   * Notify a single user (e.g. "you were added to a campaign"). Skips the actor themself by
   * default — the usual case is a DM acting on someone ELSE's membership, and self-notifying
   * would just be noise about your own action.
   *
   * `opts.allowSelf` (issue #1640) opts out of that suppression for the one case where actor
   * and recipient being the SAME person still needs the signal: a member removing their own
   * seat (self-leave). The account-wide notification here is what OTHER open tabs of that same
   * user — not the tab that made the request, which already knows synchronously from the
   * response — learn to redirect off a campaign they just left. Role changes never need this
   * (members.service.ts#update self-suppresses on purpose, matching the default here): a DM
   * demoting themselves as part of a co-DM handoff doesn't need every other tab to reload, only
   * to re-render with the new role next time /me is fetched anyway.
   */
  async notifyUser(
    userId: number | string,
    campaignId: number,
    actor: RequestUser | null,
    event: NotificationEvent,
    opts?: { allowSelf?: boolean },
  ): Promise<void> {
    const recipient = numericUserId(userId);
    if (recipient === null) return;
    if (actor && recipient === numericUserId(actor.id) && !opts?.allowSelf) return;
    try {
      await this.dispatch([recipient], campaignId, event, actor?.id ?? null);
    } catch (err) {
      this.logger.warn(`notifyUser failed for user ${recipient} in campaign ${campaignId}: ${String(err)}`);
    }
  }

  /**
   * Like {@link notifyUser} but propagates failures so callers with their own
   * dedup ledger (session reminders) can roll back a claim and retry later.
   */
  async notifyUserStrict(
    userId: number | string,
    campaignId: number,
    actor: RequestUser | null,
    event: NotificationEvent,
  ): Promise<void> {
    const recipient = numericUserId(userId);
    if (recipient === null) return;
    if (actor && recipient === numericUserId(actor.id)) return;
    await this.dispatch([recipient], campaignId, event, actor?.id ?? null);
  }

  /**
   * Notify every campaign member except the actor (e.g. "recap posted").
   *
   * `opts.bypassBlockFilter` (issue #1707) mirrors the `notifyUser(..., null, ...)` pattern
   * `MembersService.remove()` already uses for `removed_from_campaign` (hardened after Codex
   * review on #1653): this is an access-control signal, not sender-authored content, so a
   * recipient who has blocked the acting DM must still learn their campaign just vanished —
   * the #597 "a block stops a notification" rule exists to stop a sender's own content from
   * reaching someone who blocked them, not to hide the fact that access itself changed. The
   * actor is still excluded from the RECIPIENT list as normal (they already know synchronously
   * from their own request). A bypassed lifecycle signal deliberately remains actor-free both
   * in rendered and durable fields: retaining an id would let a later rename attach actor text
   * to this unblockable access-control channel. Other bypass callers retain their actor id.
   */
  async notifyCampaign(
    campaignId: number,
    actor: RequestUser | null,
    event: NotificationEvent,
    opts?: { bypassBlockFilter?: boolean },
  ): Promise<void> {
    try {
      const members = await this.db
        .select({ userId: campaignMembers.userId })
        .from(campaignMembers)
        .where(eq(campaignMembers.campaignId, campaignId));
      const actorId = actor ? numericUserId(actor.id) : null;
      const recipients = members.map((m) => m.userId).filter((id) => actorId === null || id !== actorId);
      const actorFreeLifecycle = opts?.bypassBlockFilter === true && event.type === 'campaign_trashed';
      await this.dispatch(
        recipients,
        campaignId,
        event,
        actorFreeLifecycle ? null : (actor?.id ?? null),
        opts?.bypassBlockFilter ? null : (actor?.id ?? null),
      );
    } catch (err) {
      this.logger.warn(`notifyCampaign failed for campaign ${campaignId}: ${String(err)}`);
    }
  }

  /**
   * Broadcast only while the encounter is visible at the durable-write
   * boundary. The visibility predicate and notification/digest inserts share
   * one SQLite transaction, so a hide that wins before that transaction
   * commits cannot leave an encounter id in a campaign-wide bell or digest.
   *
   * The boolean distinguishes a visible fan-out from a guarded refusal. Its
   * caller may then select a narrower, secrecy-safe recipient set.
   */
  async notifyCampaignIfEncounterVisible(
    campaignId: number,
    encounterId: number,
    characterId: number,
    actor: RequestUser | null,
    event: NotificationEvent,
  ): Promise<boolean> {
    try {
      const members = await this.db
        .select({ userId: campaignMembers.userId })
        .from(campaignMembers)
        .where(eq(campaignMembers.campaignId, campaignId));
      const actorId = actor ? numericUserId(actor.id) : null;
      const recipients = members.map((member) => member.userId).filter((id) => actorId === null || id !== actorId);
      const hiddenStatusContext: HiddenStatusContext = { encounterId, characterId, audience: 'campaign_member' };
      return await this.dispatch(
        recipients,
        campaignId,
        event,
        actor?.id ?? null,
        actor?.id ?? null,
        (tx) => {
          const encounter = tx
            .select({ hidden: encounters.hidden })
            .from(encounters)
            .where(and(eq(encounters.id, encounterId), eq(encounters.campaignId, campaignId)))
            .get();
          return encounter?.hidden === false;
        },
        hiddenStatusContext,
      );
    } catch (err) {
      this.logger.warn(`notifyCampaignIfEncounterVisible failed for encounter ${encounterId} in campaign ${campaignId}: ${String(err)}`);
      return false;
    }
  }

  /** Persist a hidden-status row only while its recipient retains the authority
   * that made the row safe to disclose. */
  async notifyUserIfHiddenEncounterRecipient(
    userId: number | string,
    campaignId: number,
    actor: RequestUser | null,
    event: NotificationEvent,
    authority: { kind: 'permanent_dm'; characterId: number } | { kind: 'character_owner'; characterId: number },
    encounterId: number,
  ): Promise<boolean> {
    const recipient = numericUserId(userId);
    if (recipient === null || (actor && recipient === numericUserId(actor.id))) return true;
    const hiddenStatusContext: HiddenStatusContext = {
      encounterId,
      characterId: authority.characterId,
      audience: authority.kind,
    };
    if (!Number.isInteger(hiddenStatusContext.characterId) || hiddenStatusContext.characterId <= 0 || !Number.isInteger(encounterId) || encounterId <= 0) {
      this.logger.warn(`notifyUserIfHiddenEncounterRecipient refused malformed hidden-status context for user ${recipient} in campaign ${campaignId}`);
      return false;
    }
    try {
      return await this.dispatch([recipient], campaignId, event, actor?.id ?? null, actor?.id ?? null, (tx) => {
        if (authority.kind === 'permanent_dm') {
          return Boolean(
            tx.select({ userId: campaignMembers.userId })
              .from(campaignMembers)
              .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, recipient), eq(campaignMembers.role, 'dm')))
              .get(),
          );
        }
        return Boolean(
          tx.select({ id: characters.id })
            .from(characters)
            .where(and(eq(characters.id, authority.characterId), eq(characters.campaignId, campaignId), eq(characters.ownerUserId, String(recipient))))
            .get(),
        );
      }, hiddenStatusContext);
    } catch (err) {
      this.logger.warn(`notifyUserIfHiddenEncounterRecipient failed for user ${recipient} in campaign ${campaignId}: ${String(err)}`);
      return false;
    }
  }

  /**
   * Notify every campaign member, including an attributed actor. This is deliberately
   * narrow: table-safety signals must never reveal an actor by their missing bell item,
   * but attributed signals still need the durable id so later account privacy changes can
   * rewrite all retained copies. `bypassBlockFilter` preserves the existing critical-table
   * broadcast rule without turning the persisted actor id into the block-filter input.
   */
  async notifyCampaignIncludingActor(
    campaignId: number,
    actorUserId: string,
    event: NotificationEvent,
    opts?: { bypassBlockFilter?: boolean },
  ): Promise<void> {
    try {
      const members = await this.db
        .select({ userId: campaignMembers.userId })
        .from(campaignMembers)
        .where(eq(campaignMembers.campaignId, campaignId));
      await this.dispatch(
        members.map((member) => member.userId),
        campaignId,
        event,
        actorUserId,
        opts?.bypassBlockFilter ? null : actorUserId,
      );
    } catch (err) {
      this.logger.warn(`notifyCampaignIncludingActor failed for campaign ${campaignId}: ${String(err)}`);
    }
  }

  /**
   * Apply per-recipient preference + quiet-hours gating, then write immediate
   * rows and enqueue deferred (digest / quiet-hours) rows in batches. Efficient:
   * at most two preference lookups regardless of recipient count (no N+1), and
   * critical categories short-circuit the lookups entirely.
   */
  private async dispatch(
    recipients: number[],
    campaignId: number,
    event: NotificationEvent,
    actorUserId: string | null,
    blockActorUserId: string | null = actorUserId,
    writeGuard?: (tx: SyncDb) => boolean,
    hiddenStatusContext?: HiddenStatusContext,
  ): Promise<boolean> {
    if (recipients.length === 0) return true;
    const category = notificationCategory(event.type);

    // ISSUE #597 — THE ONE PLACE A BLOCK STOPS A NOTIFICATION.
    //
    // Enforcement sits here, at the recipient-side fan-out chokepoint, and NOT on the
    // sender's request path. That placement is the whole design:
    //
    //  - The sender's write does exactly the same work whether or not they are blocked.
    //    Their whisper is created, their comment is posted, the response is a normal
    //    201 with a normal body. There is no error to read, no status to compare, and
    //    no delivery receipt to inspect — the API has never told a sender whether a
    //    bell rang.
    //  - "No row was written for this recipient" is ALREADY an ordinary outcome here:
    //    a recipient whose category mode is `muted` produces exactly the same absence
    //    (see decideDelivery below), and has since #789. A block therefore adds no new
    //    observable state — it reuses one the sender could never see and could never
    //    distinguish from a preference they have no access to.
    //  - The alternative — refusing the whisper at `resolveWhisperTarget` with "not a
    //    member" or a 403 — was rejected precisely because it IS an oracle: it tells a
    //    harasser they have been blocked, by whom, and exactly when, which is the
    //    moment escalation moves off-platform. A control that announces itself to the
    //    person it protects against is worse than no control.
    //
    // Timing is not a side channel either: the suppression query runs for EVERY
    // dispatch, before the delivery decision, so a blocked and an unblocked send do the
    // same number of round trips. The only difference is which ids come back.
    const suppressed = await suppressedRecipients(this.db, recipients.map(String), {
      campaignId,
      actorUserId: blockActorUserId,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
    });
    const allowed = suppressed.size === 0 ? recipients : recipients.filter((id) => !suppressed.has(String(id)));
    if (allowed.length === 0) return true;

    // Critical categories are always delivered immediately — no gating. Note that the
    // safety filter above applies even here: `access`/`security` bypass a recipient's
    // *preferences*, which are convenience settings, but a block is a safety decision
    // and an abuser must not be able to reach a blocker by choosing an event type.
    if (isCriticalNotificationCategory(category)) {
      let guardPassed = true;
      this.db.transaction((tx) => {
        if (writeGuard && !writeGuard(tx)) {
          guardPassed = false;
          return;
        }
        this.insertRowsTx(tx, allowed, campaignId, event, actorUserId, hiddenStatusContext);
      });
      return guardPassed;
    }

    const now = Date.now();
    const modeByUser = await this.loadModes(allowed, campaignId, category);
    const quietByUser = await this.loadQuietHours(allowed, campaignId);

    const immediate: number[] = [];
    const digest: number[] = [];
    const quiet: number[] = [];
    for (const userId of allowed) {
      const decision = decideDelivery(category, modeByUser.get(userId), quietByUser.get(userId) ?? null, now);
      if (decision.action === 'immediate') immediate.push(userId);
      else if (decision.action === 'muted') continue;
      else if (decision.reason === 'digest') digest.push(userId);
      else quiet.push(userId);
    }

    if (immediate.length > 0 || digest.length > 0 || quiet.length > 0) {
      let guardPassed = true;
      this.db.transaction((tx) => {
        if (writeGuard && !writeGuard(tx)) {
          guardPassed = false;
          return;
        }
        if (immediate.length > 0) this.insertRowsTx(tx, immediate, campaignId, event, actorUserId, hiddenStatusContext);
        if (digest.length > 0) this.enqueueDeferredTx(tx, digest, campaignId, event, 'digest', actorUserId, hiddenStatusContext);
        if (quiet.length > 0) this.enqueueDeferredTx(tx, quiet, campaignId, event, 'quiet_hours', actorUserId, hiddenStatusContext);
      });
      return guardPassed;
    }
    return true;
  }

  /** Stored category mode per recipient (absent => undefined => category default). */
  private async loadModes(
    recipients: number[],
    campaignId: number,
    category: NotificationCategory,
  ): Promise<Map<number, NotificationDeliveryMode>> {
    const rows = await this.db
      .select({ userId: notificationPreferences.userId, mode: notificationPreferences.mode })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.campaignId, campaignId),
          eq(notificationPreferences.category, category),
          inArray(notificationPreferences.userId, recipients),
        ),
      );
    return new Map(rows.map((r) => [r.userId, r.mode as NotificationDeliveryMode]));
  }

  /** Stored quiet-hours per recipient for a campaign (absent => not present). */
  private async loadQuietHours(recipients: number[], campaignId: number): Promise<Map<number, QuietHoursType>> {
    const rows = await this.db
      .select()
      .from(notificationQuietHours)
      .where(
        and(eq(notificationQuietHours.campaignId, campaignId), inArray(notificationQuietHours.userId, recipients)),
      );
    return new Map(rows.map((r) => [r.userId, this.quietHoursToDomain(r)]));
  }

  private quietHoursToDomain(row: typeof notificationQuietHours.$inferSelect): QuietHoursType {
    return {
      enabled: row.enabled,
      startMinute: row.startMinute,
      endMinute: row.endMinute,
      timezone: row.timezone,
    };
  }

  private insertRowsTx(
    tx: SyncDb,
    recipients: number[],
    campaignId: number,
    event: NotificationEvent,
    actorUserId: string | null,
    hiddenStatusContext?: HiddenStatusContext,
  ): void {
    if (recipients.length === 0) return;
    const ts = nowIso();
    const dataJson = event.data == null ? null : JSON.stringify(event.data);
    tx.insert(notifications)
      .values(
        recipients.map((userId) => ({
          userId,
          campaignId,
          type: event.type,
          title: event.title,
          body: event.body ?? '',
          entityType: event.entityType ?? null,
          entityId: event.entityId ?? null,
          commentId: event.commentId ?? null,
          data: dataJson,
          hiddenStatusContext: hiddenStatusContext ? JSON.stringify(hiddenStatusContext) : null,
          actorName: event.actorName ?? '',
          // Issue #597: persist WHO, not just their display name, so a block filed
          // later can filter bell items that already exist.
          actorUserId: actorUserId ?? null,
          readAt: null,
          createdAt: ts,
        })),
      )
      .run();
  }

  /** Persist deferred notifications for later flush (digest cadence / after quiet hours). */
  private enqueueDeferredTx(
    tx: SyncDb,
    recipients: number[],
    campaignId: number,
    event: NotificationEvent,
    reason: 'digest' | 'quiet_hours',
    actorUserId: string | null,
    hiddenStatusContext?: HiddenStatusContext,
  ): void {
    if (recipients.length === 0) return;
    const ts = nowIso();
    const dataJson = event.data == null ? null : JSON.stringify(event.data);
    tx.insert(notificationDigestQueue)
      .values(
        recipients.map((userId) => ({
          userId,
          campaignId,
          type: event.type,
          title: event.title,
          body: event.body ?? '',
          entityType: event.entityType ?? null,
          entityId: event.entityId ?? null,
          commentId: event.commentId ?? null,
          data: dataJson,
          hiddenStatusContext: hiddenStatusContext ? JSON.stringify(hiddenStatusContext) : null,
          actorName: event.actorName ?? '',
          actorUserId: actorUserId ?? null,
          reason,
          createdAt: ts,
        })),
      )
      .run();
  }

  private async enqueueDeferred(
    recipients: number[],
    campaignId: number,
    event: NotificationEvent,
    reason: 'digest' | 'quiet_hours',
    actorUserId: string | null = null,
  ): Promise<void> {
    this.enqueueDeferredTx(this.db, recipients, campaignId, event, reason, actorUserId);
  }

  /**
   * Recheck the authority encoded with a hidden-status row at the exact durable
   * boundary. A visible encounter is readable by any current campaign member;
   * while hidden, only a permanent DM or the current affected-character owner
   * remains entitled. Missing or malformed context fails closed.
   */
  private hiddenStatusAuthorizedTx(
    tx: SyncDb,
    userId: number,
    campaignId: number,
    rawContext: string | null | undefined,
    user?: RequestUser,
  ): HiddenStatusDisposition {
    const context = parseHiddenStatusContext(rawContext);
    if (!context) return 'deny';
    // Digest flushing runs without a request principal. Recipient-facing reads
    // must additionally honour the authenticating PAT's campaign and role cap.
    const tokenContext = user?.tokenContext;
    if (tokenContext && tokenContext.campaignId !== null && tokenContext.campaignId !== campaignId) return 'filter';
    const member = tx
      .select({ role: campaignMembers.role })
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, userId)))
      .get();
    if (!member) return 'deny';
    const encounter = tx
      .select({ hidden: encounters.hidden })
      .from(encounters)
      .where(and(eq(encounters.id, context.encounterId), eq(encounters.campaignId, campaignId)))
      .get();
    if (!encounter) return 'deny';
    if (!encounter.hidden) return 'allow';
    const effectiveRole = user?.devRole ?? (tokenContext ? minRole(tokenContext.scope, member.role as Role) : member.role);
    const isOwner = Boolean(
      tx.select({ id: characters.id })
        .from(characters)
        .where(and(
          eq(characters.id, context.characterId),
          eq(characters.campaignId, campaignId),
          eq(characters.ownerUserId, String(userId)),
        ))
        .get(),
    );
    if (context.audience === 'permanent_dm') {
      if (member.role === 'dm') {
        if (effectiveRole === 'dm') return 'allow';
        return isOwner ? 'project_redact' : 'filter';
      }
      return isOwner ? 'redact' : 'deny';
    }
    if (context.audience === 'character_owner') return isOwner ? 'allow' : 'deny';
    if (member.role === 'dm') {
      if (effectiveRole === 'dm') return 'allow';
      return isOwner ? 'project_redact' : 'filter';
    }
    return isOwner ? 'redact' : 'deny';
  }

  /**
   * Remove private-context rows whose recipient has durably lost access, while
   * returning PAT-scoped rows for request-only filtering or owner-safe
   * projection. Callers keep their exposing SELECT or UPDATE in this same
   * transaction: a membership demotion or ownership transfer cannot land
   * between cleanup and the row returned from the bell endpoint.
   */
  private purgeUnauthorizedHiddenStatusNotificationsTx(tx: SyncDb, user: RequestUser, userId: number): HiddenStatusReadGuard {
    const guarded = tx
      .select({ id: notifications.id, campaignId: notifications.campaignId, hiddenStatusContext: notifications.hiddenStatusContext })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNotNull(notifications.hiddenStatusContext)))
      .all();
    const dispositions = guarded.map((row) => ({
      id: row.id,
      disposition: this.hiddenStatusAuthorizedTx(tx, userId, row.campaignId, row.hiddenStatusContext, user),
    }));
    const unauthorizedIds = dispositions.filter((row) => row.disposition === 'deny').map((row) => row.id);
    const redactIds = dispositions.filter((row) => row.disposition === 'redact').map((row) => row.id);
    const filteredIds = dispositions.filter((row) => row.disposition === 'filter').map((row) => row.id);
    const projectedRedactIds = dispositions.filter((row) => row.disposition === 'project_redact').map((row) => row.id);
    if (unauthorizedIds.length > 0) {
      tx.delete(notifications).where(inArray(notifications.id, unauthorizedIds)).run();
    }
    if (redactIds.length > 0) {
      tx.update(notifications)
        .set({ entityType: null, entityId: null, data: null })
        .where(inArray(notifications.id, redactIds))
        .run();
    }
    return { filteredIds, projectedRedactIds };
  }

  /**
   * Drain the deferred queue into real notifications. A queued row is delivered
   * only when its recipient is NOT currently inside their quiet-hours window, so
   * quiet-hours holds naturally wait out the window while digest items flush on
   * the next cadence. Returns the number of rows delivered. Batched per campaign
   * so quiet-hours are looked up once per campaign, never per row.
   */
  async flushDigests(nowMs: number = Date.now()): Promise<{ delivered: number }> {
    if (this.flushingDigests) return { delivered: 0 };
    this.flushingDigests = true;
    try {
      let delivered = 0;
      while (true) {
        const queued = this.db.select().from(notificationDigestQueue).limit(DIGEST_BATCH_SIZE).all();
        if (queued.length === 0) break;

        const byCampaign = new Map<number, typeof queued>();
        for (const row of queued) {
          const list = byCampaign.get(row.campaignId);
          if (list) list.push(row);
          else byCampaign.set(row.campaignId, [row]);
        }

        const deliverRows: Array<typeof notifications.$inferInsert> = [];
        const deliveredIds: number[] = [];
        const removedIds: number[] = [];

        for (const [campaignId, rows] of byCampaign) {
          const recipients = [...new Set(rows.map((r) => r.userId))];
          const quietByUser = await this.loadQuietHours(recipients, campaignId);
          for (const row of rows) {
            const quiet = quietByUser.get(row.userId);
            if (!quiet || !isWithinQuietHours(quiet, nowMs)) {
              deliverRows.push({
                userId: row.userId,
                campaignId: row.campaignId,
                type: row.type,
                title: row.title,
                body: row.body,
                entityType: row.entityType,
                entityId: row.entityId,
                commentId: row.commentId,
                data: row.data,
                hiddenStatusContext: row.hiddenStatusContext,
                actorName: row.actorName,
                actorUserId: row.actorUserId,
                readAt: null,
                createdAt: row.createdAt,
              });
              deliveredIds.push(row.id);
            }
          }
        }

        const authorizedDeliverRows: Array<typeof notifications.$inferInsert> = [];
        const authorizedDeliveredIds: number[] = [];
        this.db.transaction((tx) => {
          for (let index = 0; index < deliverRows.length; index += 1) {
            const row = deliverRows[index];
            const disposition = row.hiddenStatusContext
              ? this.hiddenStatusAuthorizedTx(tx, row.userId, row.campaignId, row.hiddenStatusContext)
              : 'allow';
            if (disposition === 'deny') {
              removedIds.push(deliveredIds[index]);
              continue;
            }
            authorizedDeliverRows.push(disposition === 'redact' ? { ...row, entityType: null, entityId: null, data: null } : row);
            authorizedDeliveredIds.push(deliveredIds[index]);
          }
          const heldRows = queued.filter((row) => !deliveredIds.includes(row.id));
          for (const row of heldRows) {
            if (row.hiddenStatusContext && this.hiddenStatusAuthorizedTx(tx, row.userId, row.campaignId, row.hiddenStatusContext) === 'deny') {
              removedIds.push(row.id);
            }
          }
          if (authorizedDeliverRows.length > 0) tx.insert(notifications).values(authorizedDeliverRows).run();
          const consumedIds = [...authorizedDeliveredIds, ...removedIds];
          if (consumedIds.length > 0) tx.delete(notificationDigestQueue).where(inArray(notificationDigestQueue.id, consumedIds)).run();
        });

        if (authorizedDeliveredIds.length === 0 && removedIds.length === 0) break;
        delivered += authorizedDeliveredIds.length;

        if (queued.length < DIGEST_BATCH_SIZE) break;
      }
      return { delivered };
    } finally {
      this.flushingDigests = false;
    }
  }

  /** Campaign member roles keyed by users.id — for visibility-aware fan-out (note replies). */
  async memberRoles(campaignId: number): Promise<Map<number, string>> {
    const rows = await this.db
      .select({ userId: campaignMembers.userId, role: campaignMembers.role })
      .from(campaignMembers)
      .where(eq(campaignMembers.campaignId, campaignId));
    return new Map(rows.map((r) => [r.userId, r.role]));
  }

  // ---------- preferences (issue #789) ----------

  /** Membership check keyed by users.id; returns the campaign name or null when not a member. */
  private async membershipCampaignName(userId: number, campaignId: number): Promise<string | null> {
    const [row] = await this.db
      .select({ name: campaigns.name })
      .from(campaignMembers)
      .innerJoin(campaigns, eq(campaigns.id, campaignMembers.campaignId))
      .where(and(eq(campaignMembers.userId, userId), eq(campaignMembers.campaignId, campaignId)))
      .limit(1);
    return row?.name ?? null;
  }

  private resolveCampaignPreferences(
    campaignId: number,
    campaignName: string,
    modeRows: Array<{ campaignId: number; category: string; mode: string }>,
    quiet: QuietHoursType,
  ): NotificationCampaignPreferences {
    const stored = new Map(
      modeRows.filter((r) => r.campaignId === campaignId).map((r) => [r.category, r.mode as NotificationDeliveryMode]),
    );
    const categories = {} as Record<NotificationCategory, NotificationDeliveryMode>;
    for (const category of NOTIFICATION_CATEGORIES) {
      categories[category] = isCriticalNotificationCategory(category)
        ? 'immediate' // always-on: reported as immediate, never editable
        : stored.get(category) ?? defaultNotificationMode(category);
    }
    return { campaignId, campaignName, categories, quietHours: quiet };
  }

  /** All of the caller's per-campaign preferences (defaults filled in), one entry per membership. */
  async getPreferences(user: RequestUser): Promise<NotificationPreferences> {
    const userId = numericUserId(user.id);
    if (userId === null) return { campaigns: [] };

    const memberships = await this.db
      .select({ campaignId: campaignMembers.campaignId, name: campaigns.name })
      .from(campaignMembers)
      .innerJoin(campaigns, eq(campaigns.id, campaignMembers.campaignId))
      .where(eq(campaignMembers.userId, userId));

    const modeRows = await this.db
      .select({
        campaignId: notificationPreferences.campaignId,
        category: notificationPreferences.category,
        mode: notificationPreferences.mode,
      })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));

    const quietRows = await this.db
      .select()
      .from(notificationQuietHours)
      .where(eq(notificationQuietHours.userId, userId));
    const quietByCampaign = new Map(quietRows.map((r) => [r.campaignId, this.quietHoursToDomain(r)]));

    const campaignsOut = memberships.map((m) =>
      this.resolveCampaignPreferences(
        m.campaignId,
        m.name,
        modeRows,
        quietByCampaign.get(m.campaignId) ?? defaultQuietHours(),
      ),
    );
    return { campaigns: campaignsOut };
  }

  /**
   * Upsert the caller's preferences for one campaign. 404s (never 403) when the
   * caller is not a member so ids don't leak. Attempts to change a critical
   * category are silently ignored (it stays always-on). Returns the resolved
   * settings for that campaign.
   */
  async setPreferences(
    user: RequestUser,
    campaignId: number,
    update: NotificationPreferencesUpdate,
  ): Promise<NotificationCampaignPreferences> {
    const userId = numericUserId(user.id);
    const campaignName = userId === null ? null : await this.membershipCampaignName(userId, campaignId);
    if (userId === null || campaignName === null) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    const ts = nowIso();

    if (update.categories) {
      for (const [category, mode] of Object.entries(update.categories) as Array<
        [NotificationCategory, NotificationDeliveryMode]
      >) {
        if (isCriticalNotificationCategory(category)) continue; // always-on: not editable
        await this.db
          .insert(notificationPreferences)
          .values({ userId, campaignId, category, mode, createdAt: ts, updatedAt: ts })
          .onConflictDoUpdate({
            target: [
              notificationPreferences.userId,
              notificationPreferences.campaignId,
              notificationPreferences.category,
            ],
            set: { mode, updatedAt: ts },
          });
      }
    }

    if (update.quietHours) {
      const [existing] = await this.db
        .select()
        .from(notificationQuietHours)
        .where(and(eq(notificationQuietHours.userId, userId), eq(notificationQuietHours.campaignId, campaignId)))
        .limit(1);
      const base = existing ? this.quietHoursToDomain(existing) : defaultQuietHours();
      const merged: QuietHoursType = { ...base, ...update.quietHours };
      await this.db
        .insert(notificationQuietHours)
        .values({
          userId,
          campaignId,
          enabled: merged.enabled,
          startMinute: merged.startMinute,
          endMinute: merged.endMinute,
          timezone: merged.timezone,
          createdAt: ts,
          updatedAt: ts,
        })
        .onConflictDoUpdate({
          target: [notificationQuietHours.userId, notificationQuietHours.campaignId],
          set: {
            enabled: merged.enabled,
            startMinute: merged.startMinute,
            endMinute: merged.endMinute,
            timezone: merged.timezone,
            updatedAt: ts,
          },
        });
    }

    // Re-read the resolved state for the response.
    const modeRows = await this.db
      .select({
        campaignId: notificationPreferences.campaignId,
        category: notificationPreferences.category,
        mode: notificationPreferences.mode,
      })
      .from(notificationPreferences)
      .where(and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.campaignId, campaignId)));
    const [quietRow] = await this.db
      .select()
      .from(notificationQuietHours)
      .where(and(eq(notificationQuietHours.userId, userId), eq(notificationQuietHours.campaignId, campaignId)))
      .limit(1);
    return this.resolveCampaignPreferences(
      campaignId,
      campaignName,
      modeRows,
      quietRow ? this.quietHoursToDomain(quietRow) : defaultQuietHours(),
    );
  }

  // ---------- recipient-facing reads ----------

  /**
   * Issue #601 — hide notifications that point at a QUARANTINED comment.
   *
   * A notification's `body` is an EXCERPT of the comment, copied at post time and
   * never revisited. Quarantine withholds the comment itself, but without this
   * predicate the first ~100 characters of the abusive text stay sitting in the bell
   * menu of the very person the quarantine exists to shield. Digest delivery inserts
   * into this same table, so filtering on read covers that path too.
   *
   * The row is dropped rather than blanked: a notification whose only purpose is to
   * point at content nobody may now read has no purpose left. Applied to the unread
   * COUNT as well as the list, so the badge cannot advertise an item the list will
   * never show — a phantom unread the user can never clear.
   */
  private static quarantinedCommentFilter(): SQL {
    return sql`(${notifications.commentId} IS NULL OR NOT EXISTS (
      SELECT 1 FROM comments c
      WHERE c.id = ${notifications.commentId} AND c.quarantined_at IS NOT NULL
    ))`;
  }

  /**
   * Issue #597: bell items whose actor the reader now BLOCKS are dropped from the list
   * AND from the unread count — same "never advertise what the list will not show"
   * rule the quarantine filter above follows, so a block cannot leave behind a phantom
   * unread badge the reader can only clear by looking at the thing they blocked.
   *
   * Backward-looking on purpose: dispatch already stops NEW items, but the point of
   * blocking somebody is usually that they have already been in your inbox. Rows
   * predating the actor_user_id column carry NULL and are left alone — the server
   * cannot honestly attribute them, and guessing from the display name would be a
   * misattribution risk (two members may share a name).
   *
   * A sender-side `mute_sender` is deliberately NOT applied here: a mute means "stop
   * pinging me", not "erase what you already sent me".
   * Safety holds are likewise exempt: they are always-on table-wide security signals.
   * Applying an actor block at read time would contradict their dispatch policy and make
   * attributed and anonymous holds observably different.
   */
  private static blockedActorFilter(blockedActorIds: string[]): SQL {
    return or(
      isNull(notifications.actorUserId),
      inArray(notifications.type, [...CAMPAIGN_LIFECYCLE_NOTIFICATION_TYPES, 'safety_hold']),
      notInArray(notifications.actorUserId, blockedActorIds),
    )!;
  }

  /**
   * Issue #1707 — the trashed-campaign hiding rule every read path below applies (a stale
   * `recap_posted` about a now-dead campaign shouldn't clutter the bell) must NOT also hide
   * {@link CAMPAIGN_LIFECYCLE_NOTIFICATION_TYPES}: that type IS the announcement that the
   * campaign just died, written in the same request that stamps `deletedAt`, so a plain
   * `isNull(campaigns.deletedAt)` filter would make it invisible to every reader from the
   * moment it is created — silently defeating the account-wide backstop it exists to drive
   * (see that constant's doc comment for the full "stuck badge" failure mode this avoids).
   * One helper, applied everywhere `campaigns.deletedAt` gates notification visibility, so a
   * query added later can't reintroduce the hidden-forever bug at just one call site.
   */
  private static campaignVisibleForNotifications(): SQL {
    return or(
      isNull(campaigns.deletedAt),
      inArray(notifications.type, [...CAMPAIGN_LIFECYCLE_NOTIFICATION_TYPES]),
    )!;
  }

  async listForUser(
    user: RequestUser,
    opts: ListNotificationsOptions = {},
  ): Promise<PaginatedNotifications> {
    const userId = numericUserId(user.id);
    if (userId === null) {
      return { items: [], nextCursor: null, total: 0, hasMore: false };
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

    const conditions = [
      eq(notifications.userId, userId),
      NotificationsService.campaignVisibleForNotifications(),
      NotificationsService.quarantinedCommentFilter(),
    ];
    const blocked = await blockedTargetsOf(this.db, user.id, null);
    if (blocked.size > 0) conditions.push(NotificationsService.blockedActorFilter([...blocked]));
    if (opts.unreadOnly) conditions.push(isNull(notifications.readAt));
    if (opts.campaignId) conditions.push(eq(notifications.campaignId, opts.campaignId));
    if (opts.type) conditions.push(eq(notifications.type, opts.type));

    if (opts.startDate) {
      const startIso = opts.startDate.includes('T') ? opts.startDate : `${opts.startDate}T00:00:00.000Z`;
      conditions.push(gte(notifications.createdAt, startIso));
    }
    if (opts.endDate) {
      const endIso = opts.endDate.includes('T') ? opts.endDate : `${opts.endDate}T23:59:59.999Z`;
      conditions.push(lte(notifications.createdAt, endIso));
    }

    const { total, rows, projectedRedactIds } = this.db.transaction((tx) => {
      const { filteredIds, projectedRedactIds } = this.purgeUnauthorizedHiddenStatusNotificationsTx(tx, user, userId);
      const readConditions = filteredIds.length > 0
        ? [...conditions, notInArray(notifications.id, filteredIds)]
        : conditions;
      const [countRow] = tx
        .select({ value: count() })
        .from(notifications)
        .innerJoin(campaigns, eq(campaigns.id, notifications.campaignId))
        .where(and(...readConditions))
        .all();
      const total = countRow?.value ?? 0;

      const pageConditions = opts.cursor && Number.isInteger(opts.cursor) && opts.cursor > 0
        ? [...readConditions, lt(notifications.id, opts.cursor)]
        : readConditions;

      const rows = tx
        .select({ notification: notifications })
        .from(notifications)
        .innerJoin(campaigns, eq(campaigns.id, notifications.campaignId))
        .where(and(...pageConditions))
        .orderBy(desc(notifications.id))
        .limit(limit + 1)
        .all();
      return { total, rows, projectedRedactIds };
    });

    const hasMore = rows.length > limit;
    const pagedRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pagedRows.map((row) => (
      projectedRedactIds.includes(row.notification.id) ? toOwnerSafeDomain(row.notification) : toDomain(row.notification)
    ));
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    return {
      items,
      nextCursor,
      total,
      hasMore,
    };
  }

  async unreadCount(user: RequestUser): Promise<number> {
    return (await this.unreadSummary(user)).count;
  }

  /**
   * Issue #1590 — the bell-badge poll's payload, extended with a discriminator the account-wide
   * `/me` refresh needs. `count` alone cannot tell "a recap posted" from "your role changed and
   * every cached membership in this tab is now wrong": both just increment a number. This adds
   * `membershipChanged` — true when at least one UNREAD row is one of
   * {@link MEMBERSHIP_NOTIFICATION_TYPES} — computed in the SAME query and over the SAME
   * user-scoped row set `count` already reads, so it discloses nothing new: this endpoint has
   * never returned anyone's notifications but the caller's own.
   *
   * `unreadCount` (above) stays a bare number for its one other caller, the `get_unread_notification_count`
   * MCP tool — an AI agent has no `/me` cache to invalidate, so the flag would be dead weight there.
   */
  async unreadSummary(user: RequestUser): Promise<{ count: number; membershipChanged: boolean }> {
    const userId = numericUserId(user.id);
    if (userId === null) return { count: 0, membershipChanged: false };
    const blocked = await blockedTargetsOf(this.db, user.id, null);
    const conditions: SQL[] = [
      eq(notifications.userId, userId),
      isNull(notifications.readAt),
      NotificationsService.campaignVisibleForNotifications(),
      NotificationsService.quarantinedCommentFilter(),
    ];
    if (blocked.size > 0) conditions.push(NotificationsService.blockedActorFilter([...blocked]));
    const membershipTypeMatch = sql.join(
      MEMBERSHIP_NOTIFICATION_TYPES.map((type) => sql`${notifications.type} = ${type}`),
      sql` OR `,
    );
    const row = this.db.transaction((tx) => {
      const { filteredIds } = this.purgeUnauthorizedHiddenStatusNotificationsTx(tx, user, userId);
      const readConditions = filteredIds.length > 0
        ? [...conditions, notInArray(notifications.id, filteredIds)]
        : conditions;
      return tx
        .select({
          value: count(),
          membershipSignal: sql<number>`max(case when ${membershipTypeMatch} then 1 else 0 end)`,
        })
        .from(notifications)
        .innerJoin(campaigns, eq(campaigns.id, notifications.campaignId))
        .where(and(...readConditions))
        .get();
    });
    return { count: row?.value ?? 0, membershipChanged: (row?.membershipSignal ?? 0) === 1 };
  }

  /** Recipient-only; someone else's notification 404s (not 403) so ids don't leak. */
  async markRead(id: number, user: RequestUser): Promise<Notification> {
    const userId = numericUserId(user.id);
    if (userId === null) throw new NotFoundException(`Notification ${id} not found`);
    return this.db.transaction((tx) => {
      const { filteredIds, projectedRedactIds } = this.purgeUnauthorizedHiddenStatusNotificationsTx(tx, user, userId);
      if (filteredIds.includes(id)) throw new NotFoundException(`Notification ${id} not found`);
      const joined = tx
        .select({ notification: notifications })
        .from(notifications)
        .innerJoin(campaigns, eq(campaigns.id, notifications.campaignId))
        .where(and(eq(notifications.id, id), NotificationsService.campaignVisibleForNotifications()))
        .get();
      const row = joined?.notification;
      if (!row || row.userId !== userId) throw new NotFoundException(`Notification ${id} not found`);
      if (row.readAt) return projectedRedactIds.includes(id) ? toOwnerSafeDomain(row) : toDomain(row);
      const updated = tx
        .update(notifications)
        .set({ readAt: nowIso() })
        .where(eq(notifications.id, id))
        .returning()
        .get();
      return projectedRedactIds.includes(id) ? toOwnerSafeDomain(updated) : toDomain(updated);
    });
  }

  async markUnread(id: number, user: RequestUser): Promise<Notification> {
    const userId = numericUserId(user.id);
    if (userId === null) throw new NotFoundException(`Notification ${id} not found`);
    return this.db.transaction((tx) => {
      const { filteredIds, projectedRedactIds } = this.purgeUnauthorizedHiddenStatusNotificationsTx(tx, user, userId);
      if (filteredIds.includes(id)) throw new NotFoundException(`Notification ${id} not found`);
      const joined = tx
        .select({ notification: notifications })
        .from(notifications)
        .innerJoin(campaigns, eq(campaigns.id, notifications.campaignId))
        .where(and(eq(notifications.id, id), NotificationsService.campaignVisibleForNotifications()))
        .get();
      const row = joined?.notification;
      if (!row || row.userId !== userId) throw new NotFoundException(`Notification ${id} not found`);
      if (!row.readAt) return projectedRedactIds.includes(id) ? toOwnerSafeDomain(row) : toDomain(row);
      const updated = tx
        .update(notifications)
        .set({ readAt: null })
        .where(eq(notifications.id, id))
        .returning()
        .get();
      return projectedRedactIds.includes(id) ? toOwnerSafeDomain(updated) : toDomain(updated);
    });
  }

  async markReadBulk(
    user: RequestUser,
    opts: { ids?: number[]; campaignId?: number; all?: boolean } = {},
  ): Promise<{ updated: number; updatedIds: number[] }> {
    const userId = numericUserId(user.id);
    if (userId === null) return { updated: 0, updatedIds: [] };

    if (!opts.all && !opts.campaignId && (!opts.ids || opts.ids.length === 0)) {
      return { updated: 0, updatedIds: [] };
    }

    const conditions = [
      eq(notifications.userId, userId),
      isNull(notifications.readAt),
      or(
        inArray(notifications.type, [...CAMPAIGN_LIFECYCLE_NOTIFICATION_TYPES]),
        exists(
          this.db
            .select({ one: sql`1` })
            .from(campaigns)
            .where(and(eq(campaigns.id, notifications.campaignId), isNull(campaigns.deletedAt))),
        ),
      )!,
    ];

    if (opts.ids && opts.ids.length > 0) {
      conditions.push(inArray(notifications.id, opts.ids));
    }
    if (opts.campaignId) {
      conditions.push(eq(notifications.campaignId, opts.campaignId));
    }

    const updated = this.db.transaction((tx) => {
      const { filteredIds } = this.purgeUnauthorizedHiddenStatusNotificationsTx(tx, user, userId);
      return tx
        .update(notifications)
        .set({ readAt: nowIso() })
        .where(and(...conditions, ...(filteredIds.length > 0 ? [notInArray(notifications.id, filteredIds)] : [])))
        .returning({ id: notifications.id })
        .all();
    });

    const updatedIds = updated.map((r) => r.id);
    return { updated: updatedIds.length, updatedIds };
  }

  async markUnreadBulk(
    user: RequestUser,
    opts: { ids?: number[]; campaignId?: number; all?: boolean } = {},
  ): Promise<{ updated: number; updatedIds: number[] }> {
    const userId = numericUserId(user.id);
    if (userId === null) return { updated: 0, updatedIds: [] };

    if (!opts.all && !opts.campaignId && (!opts.ids || opts.ids.length === 0)) {
      return { updated: 0, updatedIds: [] };
    }

    const conditions = [
      eq(notifications.userId, userId),
      isNotNull(notifications.readAt),
      or(
        inArray(notifications.type, [...CAMPAIGN_LIFECYCLE_NOTIFICATION_TYPES]),
        exists(
          this.db
            .select({ one: sql`1` })
            .from(campaigns)
            .where(and(eq(campaigns.id, notifications.campaignId), isNull(campaigns.deletedAt))),
        ),
      )!,
    ];

    if (opts.ids && opts.ids.length > 0) {
      conditions.push(inArray(notifications.id, opts.ids));
    }
    if (opts.campaignId) {
      conditions.push(eq(notifications.campaignId, opts.campaignId));
    }

    const updated = this.db.transaction((tx) => {
      const { filteredIds } = this.purgeUnauthorizedHiddenStatusNotificationsTx(tx, user, userId);
      return tx
        .update(notifications)
        .set({ readAt: null })
        .where(and(...conditions, ...(filteredIds.length > 0 ? [notInArray(notifications.id, filteredIds)] : [])))
        .returning({ id: notifications.id })
        .all();
    });

    const updatedIds = updated.map((r) => r.id);
    return { updated: updatedIds.length, updatedIds };
  }

  async markAllRead(user: RequestUser): Promise<{ updated: number; updatedIds: number[] }> {
    return this.markReadBulk(user, { all: true });
  }
}
