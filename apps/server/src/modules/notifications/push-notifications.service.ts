import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import webpush, {
  type PushSubscription as WebPushSubscription,
  type RequestOptions,
  type SendResult,
} from 'web-push';
import {
  MEMBERSHIP_NOTIFICATION_TYPES,
  type BrowserPushStatus,
  type BrowserPushSubscription,
  type BrowserPushUnsubscribeResult,
  type NotificationType,
} from '@campfire/schema';
import { resolvePublicBase } from '../../common/security-config';
import type { RequestUser } from '../../common/user.types';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignMembers, pushSubscriptions, users } from '../../db/schema';
import { nowIso } from '../../common/time';

export const WEB_PUSH_TRANSPORT = Symbol('WEB_PUSH_TRANSPORT');
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;
export const MAX_CONCURRENT_PUSH_SENDS = 8;

/** Narrow transport seam so delivery is deterministic in integration tests. */
export interface WebPushTransport {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: WebPushSubscription,
    payload?: string | Buffer | null,
    options?: RequestOptions,
  ): Promise<SendResult>;
}

export const DEFAULT_WEB_PUSH_TRANSPORT: WebPushTransport = {
  setVapidDetails: webpush.setVapidDetails.bind(webpush),
  sendNotification: webpush.sendNotification.bind(webpush),
};

export interface BrowserPushDelivery {
  userId: number;
  campaignId: number;
  type: NotificationType;
  title: string;
  body: string;
  entityId: number | null;
  createdAt: string;
  critical: boolean;
}

interface PushPayload {
  title: string;
  body: string;
  icon: string;
  badge: string;
  tag: string;
  url: string;
}

interface QueuedPushSend {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const ALLOWED_PUSH_HOSTS = new Set([
  'android.googleapis.com', // legacy Chromium/GCM endpoints supported by web-push
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);
const MEMBERSHIP_EXEMPT_TYPES = new Set<NotificationType>(MEMBERSHIP_NOTIFICATION_TYPES);

/**
 * A subscription endpoint becomes an authenticated server-side outbound request.
 * Limit it to browser-vendor push services so a forged API body cannot turn the
 * Campfire server into an SSRF client for arbitrary HTTPS hosts.
 */
export function isAllowedBrowserPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_PUSH_HOSTS.has(host) || host.endsWith('.notify.windows.com');
  } catch {
    return false;
  }
}

function numericUserId(user: RequestUser): number | null {
  const id = Number(user.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function publicPath(path: string): string {
  const base = resolvePublicBase();
  if (base === '/') return path;
  return path === '/' ? `${base}/` : `${base}${path}`;
}

function pushPath(delivery: BrowserPushDelivery): string {
  if (delivery.type === 'removed_from_campaign' || delivery.type === 'campaign_trashed') {
    return publicPath('/');
  }
  // A stable, authorization-safe destination. The notification center retains
  // the full server-approved item and its entity deep link without duplicating
  // the web router's type-to-route mapping in the server.
  return publicPath(`/c/${delivery.campaignId}/notifications`);
}

function plainExcerpt(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function statusCodeOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' ? value : null;
}

/**
 * User-scoped Web Push subscription persistence and best-effort delivery.
 * VAPID is optional: without all three environment values the feature reports
 * `configured: false` and the rest of Campfire remains fully functional.
 */
@Injectable()
export class PushNotificationsService {
  private readonly logger = new Logger(PushNotificationsService.name);
  private readonly publicKey: string | null;
  private readonly sendQueue: QueuedPushSend[] = [];
  private activeSends = 0;

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    @Inject(WEB_PUSH_TRANSPORT) private readonly transport: WebPushTransport,
  ) {
    const subject = process.env.VAPID_SUBJECT?.trim() ?? '';
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? '';
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? '';
    if (!subject || !publicKey || !privateKey) {
      this.publicKey = null;
      return;
    }
    try {
      this.transport.setVapidDetails(subject, publicKey, privateKey);
      this.publicKey = publicKey;
    } catch {
      this.publicKey = null;
      this.logger.warn('Browser push disabled: invalid VAPID configuration');
    }
  }

  status(): BrowserPushStatus {
    return { configured: this.publicKey !== null, publicKey: this.publicKey };
  }

  async subscribe(user: RequestUser, subscription: BrowserPushSubscription): Promise<BrowserPushStatus> {
    if (this.publicKey === null) {
      throw new ServiceUnavailableException('Browser push is not configured on this server');
    }
    const userId = numericUserId(user);
    if (userId === null) {
      throw new BadRequestException('Browser push requires a persistent user account');
    }
    if (!isAllowedBrowserPushEndpoint(subscription.endpoint)) {
      throw new BadRequestException('Unsupported browser push endpoint');
    }

    const createdAt = nowIso();
    this.db.transaction((tx) => {
      tx.insert(pushSubscriptions)
        .values({
          userId,
          endpoint: subscription.endpoint,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          userAgent: subscription.userAgent,
          createdAt,
          lastUsedAt: null,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            userId,
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth,
            userAgent: subscription.userAgent,
            createdAt,
          },
        })
        .run();

      const owned = tx
        .select({
          id: pushSubscriptions.id,
          endpoint: pushSubscriptions.endpoint,
        })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId))
        .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id))
        .all();
      const excess = owned.length - MAX_PUSH_SUBSCRIPTIONS_PER_USER;
      if (excess <= 0) return;

      // Always retain the endpoint from this request. Pruning the oldest other
      // rows gives a bounded replacement policy and also repairs pre-cap data.
      const pruneIds = owned
        .filter((row) => row.endpoint !== subscription.endpoint)
        .slice(0, excess)
        .map((row) => row.id);
      if (pruneIds.length > 0) {
        tx.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, pruneIds)).run();
      }
    });
    return this.status();
  }

  async unsubscribe(user: RequestUser, endpoint: string): Promise<BrowserPushUnsubscribeResult> {
    const userId = numericUserId(user);
    if (userId === null) return { removed: false };
    const result = await this.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
    return { removed: result.changes > 0 };
  }

  private enqueueSend(run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sendQueue.push({ run, resolve, reject });
      this.drainSendQueue();
    });
  }

  private drainSendQueue(): void {
    while (this.activeSends < MAX_CONCURRENT_PUSH_SENDS) {
      const queued = this.sendQueue.shift();
      if (!queued) return;
      this.activeSends += 1;
      void queued.run().then(
        () => {
          this.activeSends -= 1;
          queued.resolve();
          this.drainSendQueue();
        },
        (error: unknown) => {
          this.activeSends -= 1;
          queued.reject(error);
          this.drainSendQueue();
        },
      );
    }
  }

  /**
   * Deliver already-materialized notification rows. Preferences and quiet hours
   * are not re-evaluated, but account state and campaign membership are checked
   * immediately before vendor fan-out. Membership lifecycle notifications are
   * exempt because losing access is the event they must report. Every error is
   * contained here: push vendors are optional infrastructure and may never roll
   * back or reject the Campfire write that produced the in-app notification.
   */
  async deliver(deliveries: BrowserPushDelivery[]): Promise<void> {
    if (this.publicKey === null || deliveries.length === 0) return;
    const membershipGated = deliveries.filter((delivery) => !MEMBERSHIP_EXEMPT_TYPES.has(delivery.type));
    const currentMembershipKeys = new Set<string>();
    if (membershipGated.length > 0) {
      const userIds = [...new Set(membershipGated.map((delivery) => delivery.userId))];
      const campaignIds = [...new Set(membershipGated.map((delivery) => delivery.campaignId))];
      const memberships = await this.db
        .select({ userId: campaignMembers.userId, campaignId: campaignMembers.campaignId })
        .from(campaignMembers)
        .where(
          and(
            inArray(campaignMembers.userId, userIds),
            inArray(campaignMembers.campaignId, campaignIds),
          ),
        );
      for (const membership of memberships) {
        currentMembershipKeys.add(`${membership.campaignId}:${membership.userId}`);
      }
    }

    const authorizedDeliveries = deliveries.filter(
      (delivery) =>
        MEMBERSHIP_EXEMPT_TYPES.has(delivery.type) ||
        currentMembershipKeys.has(`${delivery.campaignId}:${delivery.userId}`),
    );
    if (authorizedDeliveries.length === 0) return;

    const userIds = [...new Set(authorizedDeliveries.map((delivery) => delivery.userId))];
    const subscriptions = await this.db
      .select({
        id: pushSubscriptions.id,
        userId: pushSubscriptions.userId,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .innerJoin(users, eq(pushSubscriptions.userId, users.id))
      .where(and(inArray(pushSubscriptions.userId, userIds), eq(users.disabled, false)));
    if (subscriptions.length === 0) return;

    const byUser = new Map<number, typeof subscriptions>();
    for (const subscription of subscriptions) {
      const existing = byUser.get(subscription.userId);
      if (existing) existing.push(subscription);
      else byUser.set(subscription.userId, [subscription]);
    }

    await Promise.all(
      authorizedDeliveries.flatMap((delivery) => {
        const userSubscriptions = byUser.get(delivery.userId) ?? [];
        const payload: PushPayload = {
          title: delivery.title,
          body: plainExcerpt(delivery.body),
          icon: publicPath('/pwa-192x192.png'),
          badge: publicPath('/pwa-192x192.png'),
          tag: `campfire-${delivery.campaignId}-${delivery.type}-${delivery.entityId ?? 'event'}-${delivery.createdAt}`,
          url: pushPath(delivery),
        };
        return userSubscriptions.map((subscription) => this.enqueueSend(async () => {
          try {
            await this.transport.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth },
              },
              JSON.stringify(payload),
              {
                // Campaign excerpts must not sit in a vendor queue after access
                // is revoked. Deliver immediately or discard; the in-app row is
                // the durable notification source.
                TTL: 0,
                timeout: 5_000,
                urgency: delivery.critical ? 'high' : 'normal',
              },
            );
            await this.db
              .update(pushSubscriptions)
              .set({ lastUsedAt: nowIso() })
              .where(eq(pushSubscriptions.id, subscription.id));
          } catch (error) {
            const statusCode = statusCodeOf(error);
            if (statusCode === 404 || statusCode === 410) {
              await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
              return;
            }
            this.logger.warn(
              `Browser push delivery failed for user ${delivery.userId}` +
                (statusCode === null ? '' : ` (status ${statusCode})`),
            );
          }
        }));
      }),
    );
  }
}
