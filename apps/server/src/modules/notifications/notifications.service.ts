import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { EntityType, Notification, NotificationType } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignMembers, notifications } from '../../db/schema';
import { nowIso } from '../../common/time';
import type { RequestUser } from '../../common/user.types';

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
  actorName?: string;
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

/**
 * In-app notification store. Deliberately transport-agnostic: rows are written
 * synchronously by domain services and read by polling clients today; a
 * real-time push channel (SSE — issue #4) can later observe the same writes
 * without any change to emitters or the table.
 *
 * Emission is best-effort by design: callers `await` it inside the same request
 * but a notification failure must never fail the triggering write, so both
 * notify* methods swallow errors.
 */
@Injectable()
export class NotificationsService {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  /** Notify a single user (e.g. "you were added to a campaign"). Skips the actor themself. */
  async notifyUser(userId: number | string, campaignId: number, actor: RequestUser | null, event: NotificationEvent): Promise<void> {
    const recipient = numericUserId(userId);
    if (recipient === null) return;
    if (actor && String(recipient) === actor.id) return;
    try {
      await this.insertRows([recipient], campaignId, event);
    } catch {
      /* best-effort — never fail the triggering write */
    }
  }

  /** Notify every campaign member except the actor (e.g. "recap posted"). */
  async notifyCampaign(campaignId: number, actor: RequestUser | null, event: NotificationEvent): Promise<void> {
    try {
      const members = await this.db
        .select({ userId: campaignMembers.userId })
        .from(campaignMembers)
        .where(eq(campaignMembers.campaignId, campaignId));
      const recipients = members.map((m) => m.userId).filter((id) => !actor || String(id) !== actor.id);
      await this.insertRows(recipients, campaignId, event);
    } catch {
      /* best-effort — never fail the triggering write */
    }
  }

  private async insertRows(recipients: number[], campaignId: number, event: NotificationEvent): Promise<void> {
    if (recipients.length === 0) return;
    const ts = nowIso();
    await this.db.insert(notifications).values(
      recipients.map((userId) => ({
        userId,
        campaignId,
        type: event.type,
        title: event.title,
        body: event.body ?? '',
        entityType: event.entityType ?? null,
        entityId: event.entityId ?? null,
        commentId: event.commentId ?? null,
        actorName: event.actorName ?? '',
        readAt: null,
        createdAt: ts,
      })),
    );
  }

  /** Campaign member roles keyed by users.id — for visibility-aware fan-out (note replies). */
  async memberRoles(campaignId: number): Promise<Map<number, string>> {
    const rows = await this.db
      .select({ userId: campaignMembers.userId, role: campaignMembers.role })
      .from(campaignMembers)
      .where(eq(campaignMembers.campaignId, campaignId));
    return new Map(rows.map((r) => [r.userId, r.role]));
  }

  // ---------- recipient-facing reads ----------

  async listForUser(user: RequestUser, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Notification[]> {
    const userId = numericUserId(user.id);
    if (userId === null) return [];
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where = opts.unreadOnly
      ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
      : eq(notifications.userId, userId);
    const rows = await this.db.select().from(notifications).where(where).orderBy(desc(notifications.id)).limit(limit);
    return rows.map(toDomain);
  }

  async unreadCount(user: RequestUser): Promise<number> {
    const userId = numericUserId(user.id);
    if (userId === null) return 0;
    const rows = await this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return rows.length;
  }

  /** Recipient-only; someone else's notification 404s (not 403) so ids don't leak. */
  async markRead(id: number, user: RequestUser): Promise<Notification> {
    const userId = numericUserId(user.id);
    const [row] = await this.db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
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

  async markAllRead(user: RequestUser): Promise<{ updated: number }> {
    const userId = numericUserId(user.id);
    if (userId === null) return { updated: 0 };
    const updated = await this.db
      .update(notifications)
      .set({ readAt: nowIso() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return { updated: updated.length };
  }
}
