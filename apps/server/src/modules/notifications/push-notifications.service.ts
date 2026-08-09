import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import webpush, {
  type PushSubscription as WebPushSubscription,
  type RequestOptions,
  type SendResult,
} from 'web-push';
import type {
  BrowserPushStatus,
  BrowserPushSubscription,
  BrowserPushUnsubscribeResult,
  NotificationType,
} from '@campfire/schema';
import { resolvePublicBase } from '../../common/security-config';
import type { RequestUser } from '../../common/user.types';
import { DB, type DrizzleDb } from '../../db/db.module';
import { pushSubscriptions } from '../../db/schema';
import { nowIso } from '../../common/time';

export const WEB_PUSH_TRANSPORT = Symbol('WEB_PUSH_TRANSPORT');

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

const ALLOWED_PUSH_HOSTS = new Set([
  'android.googleapis.com', // legacy Chromium/GCM endpoints supported by web-push
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);

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

    await this.db
      .insert(pushSubscriptions)
      .values({
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: subscription.userAgent,
        createdAt: nowIso(),
        lastUsedAt: null,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          userAgent: subscription.userAgent,
        },
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

  /**
   * Deliver already-gated notification rows. Every error is contained here:
   * push vendors are optional infrastructure and may never roll back or reject
   * the Campfire write that produced the in-app notification.
   */
  async deliver(deliveries: BrowserPushDelivery[]): Promise<void> {
    if (this.publicKey === null || deliveries.length === 0) return;
    const userIds = [...new Set(deliveries.map((delivery) => delivery.userId))];
    const subscriptions = await this.db
      .select()
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, userIds));
    if (subscriptions.length === 0) return;

    const byUser = new Map<number, typeof subscriptions>();
    for (const subscription of subscriptions) {
      const existing = byUser.get(subscription.userId);
      if (existing) existing.push(subscription);
      else byUser.set(subscription.userId, [subscription]);
    }

    await Promise.all(
      deliveries.flatMap((delivery) => {
        const userSubscriptions = byUser.get(delivery.userId) ?? [];
        const payload: PushPayload = {
          title: delivery.title,
          body: plainExcerpt(delivery.body),
          icon: publicPath('/pwa-192x192.png'),
          badge: publicPath('/pwa-192x192.png'),
          tag: `campfire-${delivery.campaignId}-${delivery.type}-${delivery.entityId ?? 'event'}-${delivery.createdAt}`,
          url: pushPath(delivery),
        };
        return userSubscriptions.map(async (subscription) => {
          try {
            await this.transport.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth },
              },
              JSON.stringify(payload),
              {
                TTL: 24 * 60 * 60,
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
        });
      }),
    );
  }
}
