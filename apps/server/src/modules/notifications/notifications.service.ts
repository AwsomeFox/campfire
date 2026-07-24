import { Inject, Injectable, Logger, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { and, count, desc, eq, exists, gte, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import {
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
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  campaignMembers,
  campaigns,
  notificationDigestQueue,
  notificationPreferences,
  notificationQuietHours,
  notifications,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import type { RequestUser } from '../../common/user.types';
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

  /** Notify a single user (e.g. "you were added to a campaign"). Skips the actor themself. */
  async notifyUser(userId: number | string, campaignId: number, actor: RequestUser | null, event: NotificationEvent): Promise<void> {
    const recipient = numericUserId(userId);
    if (recipient === null) return;
    if (actor && recipient === numericUserId(actor.id)) return;
    try {
      await this.dispatch([recipient], campaignId, event);
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
    await this.dispatch([recipient], campaignId, event);
  }

  /** Notify every campaign member except the actor (e.g. "recap posted"). */
  async notifyCampaign(campaignId: number, actor: RequestUser | null, event: NotificationEvent): Promise<void> {
    try {
      const members = await this.db
        .select({ userId: campaignMembers.userId })
        .from(campaignMembers)
        .where(eq(campaignMembers.campaignId, campaignId));
      const actorId = actor ? numericUserId(actor.id) : null;
      const recipients = members.map((m) => m.userId).filter((id) => actorId === null || id !== actorId);
      await this.dispatch(recipients, campaignId, event);
    } catch (err) {
      this.logger.warn(`notifyCampaign failed for campaign ${campaignId}: ${String(err)}`);
    }
  }

  /**
   * Apply per-recipient preference + quiet-hours gating, then write immediate
   * rows and enqueue deferred (digest / quiet-hours) rows in batches. Efficient:
   * at most two preference lookups regardless of recipient count (no N+1), and
   * critical categories short-circuit the lookups entirely.
   */
  private async dispatch(recipients: number[], campaignId: number, event: NotificationEvent): Promise<void> {
    if (recipients.length === 0) return;
    const category = notificationCategory(event.type);

    // Critical categories are always delivered immediately — no gating.
    if (isCriticalNotificationCategory(category)) {
      await this.insertRows(recipients, campaignId, event);
      return;
    }

    const now = Date.now();
    const modeByUser = await this.loadModes(recipients, campaignId, category);
    const quietByUser = await this.loadQuietHours(recipients, campaignId);

    const immediate: number[] = [];
    const digest: number[] = [];
    const quiet: number[] = [];
    for (const userId of recipients) {
      const decision = decideDelivery(category, modeByUser.get(userId), quietByUser.get(userId) ?? null, now);
      if (decision.action === 'immediate') immediate.push(userId);
      else if (decision.action === 'muted') continue;
      else if (decision.reason === 'digest') digest.push(userId);
      else quiet.push(userId);
    }

    if (immediate.length > 0 || digest.length > 0 || quiet.length > 0) {
      this.db.transaction((tx) => {
        if (immediate.length > 0) this.insertRowsTx(tx, immediate, campaignId, event);
        if (digest.length > 0) this.enqueueDeferredTx(tx, digest, campaignId, event, 'digest');
        if (quiet.length > 0) this.enqueueDeferredTx(tx, quiet, campaignId, event, 'quiet_hours');
      });
    }
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

  private insertRowsTx(tx: SyncDb, recipients: number[], campaignId: number, event: NotificationEvent): void {
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
          actorName: event.actorName ?? '',
          readAt: null,
          createdAt: ts,
        })),
      )
      .run();
  }

  private async insertRows(recipients: number[], campaignId: number, event: NotificationEvent): Promise<void> {
    this.insertRowsTx(this.db, recipients, campaignId, event);
  }

  /** Persist deferred notifications for later flush (digest cadence / after quiet hours). */
  private enqueueDeferredTx(
    tx: SyncDb,
    recipients: number[],
    campaignId: number,
    event: NotificationEvent,
    reason: 'digest' | 'quiet_hours',
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
          actorName: event.actorName ?? '',
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
  ): Promise<void> {
    this.enqueueDeferredTx(this.db, recipients, campaignId, event, reason);
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

        for (const [campaignId, rows] of byCampaign) {
          const recipients = [...new Set(rows.map((r) => r.userId))];
          const quietByUser = await this.loadQuietHours(recipients, campaignId);
          for (const row of rows) {
            const quiet = quietByUser.get(row.userId);
            if (quiet && isWithinQuietHours(quiet, nowMs)) continue;
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
              actorName: row.actorName,
              readAt: null,
              createdAt: row.createdAt,
            });
            deliveredIds.push(row.id);
          }
        }

        if (deliveredIds.length === 0) break;

        this.db.transaction((tx) => {
          tx.insert(notifications).values(deliverRows).run();
          tx.delete(notificationDigestQueue).where(inArray(notificationDigestQueue.id, deliveredIds)).run();
        });
        delivered += deliveredIds.length;

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
      isNull(campaigns.deletedAt),
    ];
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

    const [countRow] = await this.db
      .select({ value: count() })
      .from(notifications)
      .innerJoin(campaigns, eq(campaigns.id, notifications.campaignId))
      .where(and(...conditions));
    const total = countRow?.value ?? 0;

    if (opts.cursor && Number.isInteger(opts.cursor) && opts.cursor > 0) {
      conditions.push(lt(notifications.id, opts.cursor));
    }

    const rows = await this.db
      .select({ notification: notifications })
      .from(notifications)
      .innerJoin(campaigns, eq(campaigns.id, notifications.campaignId))
      .where(and(...conditions))
      .orderBy(desc(notifications.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pagedRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pagedRows.map((row) => toDomain(row.notification));
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    return {
      items,
      nextCursor,
      total,
      hasMore,
    };
  }

  async unreadCount(user: RequestUser): Promise<number> {
    const userId = numericUserId(user.id);
    if (userId === null) return 0;
    const [row] = await this.db
      .select({ value: count() })
      .from(notifications)
      .innerJoin(campaigns, eq(campaigns.id, notifications.campaignId))
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), isNull(campaigns.deletedAt)));
    return row?.value ?? 0;
  }

  /** Recipient-only; someone else's notification 404s (not 403) so ids don't leak. */
  async markRead(id: number, user: RequestUser): Promise<Notification> {
    const userId = numericUserId(user.id);
    const [joined] = await this.db
      .select({ notification: notifications })
      .from(notifications)
      .innerJoin(campaigns, eq(campaigns.id, notifications.campaignId))
      .where(and(eq(notifications.id, id), isNull(campaigns.deletedAt)))
      .limit(1);
    const row = joined?.notification;
    if (!row || userId === null || row.userId !== userId) {
      throw new NotFoundException(`Notification ${id} not found`);
    }
    if (row.readAt) return toDomain(row);
    const [updated] = await this.db
      .update(notifications)
      .set({ readAt: nowIso() })
      .where(eq(notifications.id, id))
      .returning();
    return toDomain(updated);
  }

  async markUnread(id: number, user: RequestUser): Promise<Notification> {
    const userId = numericUserId(user.id);
    const [joined] = await this.db
      .select({ notification: notifications })
      .from(notifications)
      .innerJoin(campaigns, eq(campaigns.id, notifications.campaignId))
      .where(and(eq(notifications.id, id), isNull(campaigns.deletedAt)))
      .limit(1);
    const row = joined?.notification;
    if (!row || userId === null || row.userId !== userId) {
      throw new NotFoundException(`Notification ${id} not found`);
    }
    if (!row.readAt) return toDomain(row);
    const [updated] = await this.db
      .update(notifications)
      .set({ readAt: null })
      .where(eq(notifications.id, id))
      .returning();
    return toDomain(updated);
  }

  async markReadBulk(
    user: RequestUser,
    opts: { ids?: number[]; campaignId?: number; all?: boolean } = {},
  ): Promise<{ updated: number; updatedIds: number[] }> {
    const userId = numericUserId(user.id);
    if (userId === null) return { updated: 0, updatedIds: [] };

    if (opts.ids && opts.ids.length === 0) return { updated: 0, updatedIds: [] };

    const conditions = [
      eq(notifications.userId, userId),
      isNull(notifications.readAt),
      exists(
        this.db
          .select({ one: sql`1` })
          .from(campaigns)
          .where(and(eq(campaigns.id, notifications.campaignId), isNull(campaigns.deletedAt))),
      ),
    ];

    if (opts.ids && opts.ids.length > 0) {
      conditions.push(inArray(notifications.id, opts.ids));
    }
    if (opts.campaignId) {
      conditions.push(eq(notifications.campaignId, opts.campaignId));
    }

    const updated = await this.db
      .update(notifications)
      .set({ readAt: nowIso() })
      .where(and(...conditions))
      .returning({ id: notifications.id });

    const updatedIds = updated.map((r) => r.id);
    return { updated: updatedIds.length, updatedIds };
  }

  async markUnreadBulk(
    user: RequestUser,
    opts: { ids?: number[]; campaignId?: number; all?: boolean } = {},
  ): Promise<{ updated: number; updatedIds: number[] }> {
    const userId = numericUserId(user.id);
    if (userId === null) return { updated: 0, updatedIds: [] };

    if (opts.ids && opts.ids.length === 0) return { updated: 0, updatedIds: [] };

    const conditions = [
      eq(notifications.userId, userId),
      isNotNull(notifications.readAt),
      exists(
        this.db
          .select({ one: sql`1` })
          .from(campaigns)
          .where(and(eq(campaigns.id, notifications.campaignId), isNull(campaigns.deletedAt))),
      ),
    ];

    if (opts.ids && opts.ids.length > 0) {
      conditions.push(inArray(notifications.id, opts.ids));
    }
    if (opts.campaignId) {
      conditions.push(eq(notifications.campaignId, opts.campaignId));
    }

    const updated = await this.db
      .update(notifications)
      .set({ readAt: null })
      .where(and(...conditions))
      .returning({ id: notifications.id });

    const updatedIds = updated.map((r) => r.id);
    return { updated: updatedIds.length, updatedIds };
  }

  async markAllRead(user: RequestUser): Promise<{ updated: number; updatedIds: number[] }> {
    return this.markReadBulk(user, { all: true });
  }
}
