import request from 'supertest';
import type { SendResult } from 'web-push';
import { eq } from 'drizzle-orm';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { comments, memberSafetyControls, notificationDigestQueue } from '../src/db/schema';
import { nowIso } from '../src/common/time';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import {
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  WEB_PUSH_TRANSPORT,
  type WebPushTransport,
} from '../src/modules/notifications/push-notifications.service';
import { closeTestApp, createTestAppNoDevAuth, type TestAppContext } from './test-app';

describe('browser push notifications (issue #1323, e2e)', () => {
  let ctx: TestAppContext;
  let admin: ReturnType<typeof request.agent>;
  let player: ReturnType<typeof request.agent>;
  let adminId: number;
  let playerId: number;
  let campaignId: number;
  let previousVapid: Record<string, string | undefined>;

  const sendNotification = jest.fn<Promise<SendResult>, Parameters<WebPushTransport['sendNotification']>>(async () => ({
    statusCode: 201,
    body: '',
    headers: {},
  }));
  const transport: WebPushTransport = {
    setVapidDetails: jest.fn(),
    sendNotification,
  };
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/campfire-issue-1323',
    keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
    userAgent: 'Campfire integration test',
  };

  async function waitForCalls(count: number): Promise<void> {
    for (let attempt = 0; attempt < 100 && sendNotification.mock.calls.length < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sendNotification).toHaveBeenCalledTimes(count);
  }

  beforeAll(async () => {
    previousVapid = {
      VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: process.env.VAPID_SUBJECT,
    };
    process.env.VAPID_PUBLIC_KEY = 'test-public-vapid-key';
    process.env.VAPID_PRIVATE_KEY = 'test-private-vapid-key';
    process.env.VAPID_SUBJECT = 'mailto:admin@example.test';

    ctx = await createTestAppNoDevAuth({ overrides: [{ token: WEB_PUSH_TRANSPORT, useValue: transport }] });
    const server = ctx.app.getHttpServer();
    admin = request.agent(server);
    adminId = (await admin.post('/api/v1/auth/setup').send({
      username: 'push-admin',
      password: 'admin-password-1',
    })).body.user.id;
    const createdPlayer = await admin
      .post('/api/v1/users')
      .send({ username: 'push-player', password: 'player-password-1', displayName: 'Push Player' });
    playerId = createdPlayer.body.id;

    const dm = request.agent(server);
    await dm.post('/api/v1/auth/login').send({ username: 'push-admin', password: 'admin-password-1' });
    player = request.agent(server);
    await player.post('/api/v1/auth/login').send({ username: 'push-player', password: 'player-password-1' });
    campaignId = (await dm.post('/api/v1/campaigns').send({ name: 'Push Keep' })).body.id;
    await dm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    for (const [key, value] of Object.entries(previousVapid)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('persists an authenticated browser subscription and rejects arbitrary outbound hosts', async () => {
    const status = await player.get('/api/v1/notifications/push-status');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ configured: true, publicKey: 'test-public-vapid-key' });

    const forged = await player.post('/api/v1/notifications/push-subscribe').send({
      ...subscription,
      endpoint: 'https://internal.example.test/push',
    });
    expect(forged.status).toBe(400);

    const subscribed = await player.post('/api/v1/notifications/push-subscribe').send(subscription);
    expect(subscribed.status).toBe(201);
    expect(subscribed.body.configured).toBe(true);
  });

  it('pushes an immediate in-app row with a minimal same-origin deep link', async () => {
    const notifications = ctx.app.get(NotificationsService);
    await notifications.notifyUser(playerId, campaignId, null, {
      type: 'note_shared',
      title: 'A note was shared',
      body: 'A short player-visible excerpt.',
      entityType: 'quest',
      entityId: 42,
    });
    await waitForCalls(1);

    const [sentSubscription, rawPayload, options] = sendNotification.mock.calls[0];
    expect(sentSubscription.endpoint).toBe(subscription.endpoint);
    expect(options).toEqual(expect.objectContaining({ urgency: 'normal', timeout: 5_000 }));
    const payload = JSON.parse(String(rawPayload));
    expect(payload).toEqual(expect.objectContaining({
      title: 'A note was shared',
      body: 'A short player-visible excerpt.',
      url: `/c/${campaignId}/notifications`,
    }));
    expect(payload).not.toHaveProperty('userId');
    expect(payload).not.toHaveProperty('data');
  });

  it('suppresses push while quiet/digest rows are deferred and pushes only when each row flushes', async () => {
    const notifications = ctx.app.get(NotificationsService);
    const now = new Date();
    const nowMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
    const quietEnd = (nowMinute + 60) % 1440;
    const outsideMinute = (quietEnd + 120) % 1440;
    const outsideQuiet = Date.UTC(2026, 0, 15, Math.floor(outsideMinute / 60), outsideMinute % 60);

    await player.put(`/api/v1/notifications/preferences/${campaignId}`).send({
      quietHours: { enabled: true, startMinute: nowMinute, endMinute: quietEnd, timezone: 'UTC' },
    });
    await notifications.notifyUser(playerId, campaignId, null, {
      type: 'note_shared',
      title: 'Held for quiet hours',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sendNotification).toHaveBeenCalledTimes(1);
    await notifications.flushDigests(outsideQuiet);
    await waitForCalls(2);

    await player.put(`/api/v1/notifications/preferences/${campaignId}`).send({
      categories: { quests: 'digest' },
      quietHours: { enabled: false },
    });
    await notifications.notifyUser(playerId, campaignId, null, {
      type: 'quest_updated',
      title: 'Held for digest',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sendNotification).toHaveBeenCalledTimes(2);
    await notifications.flushDigests();
    await waitForCalls(3);
  });

  it('rechecks quarantine and block safety filters before deferred push delivery', async () => {
    const notifications = ctx.app.get(NotificationsService);
    const db = ctx.app.get<DrizzleDb>(DB);
    await player.put(`/api/v1/notifications/preferences/${campaignId}`).send({
      categories: { comments: 'digest' },
      quietHours: { enabled: false },
    });
    const sessionId = (await admin
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .send({ number: 1, title: 'Deferred safety' })).body.id;
    await new Promise((resolve) => setTimeout(resolve, 25));
    sendNotification.mockClear();

    const parentOne = (await player.post(`/api/v1/campaigns/${campaignId}/comments`).send({
      entityType: 'session', entityId: sessionId, body: 'First parent',
    })).body.id;
    const quarantinedReply = (await admin.post(`/api/v1/campaigns/${campaignId}/comments`).send({
      entityType: 'session', entityId: sessionId, parentId: parentOne, body: 'QUARANTINED PUSH LEAK',
    })).body.id;
    expect(db.select({ id: notificationDigestQueue.id }).from(notificationDigestQueue)
      .where(eq(notificationDigestQueue.commentId, quarantinedReply)).get()).toBeDefined();
    db.update(comments).set({ quarantinedAt: nowIso() }).where(eq(comments.id, quarantinedReply)).run();
    expect((await notifications.flushDigests()).delivered).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sendNotification).not.toHaveBeenCalled();
    expect(db.select({ id: notificationDigestQueue.id }).from(notificationDigestQueue)
      .where(eq(notificationDigestQueue.commentId, quarantinedReply)).get()).toBeUndefined();

    const parentTwo = (await player.post(`/api/v1/campaigns/${campaignId}/comments`).send({
      entityType: 'session', entityId: sessionId, body: 'Second parent',
    })).body.id;
    const blockedReply = (await admin.post(`/api/v1/campaigns/${campaignId}/comments`).send({
      entityType: 'session', entityId: sessionId, parentId: parentTwo, body: 'BLOCKED ACTOR PUSH LEAK',
    })).body.id;
    expect(db.select({ id: notificationDigestQueue.id }).from(notificationDigestQueue)
      .where(eq(notificationDigestQueue.commentId, blockedReply)).get()).toBeDefined();
    db.insert(memberSafetyControls).values({
      campaignId: null,
      kind: 'block',
      ownerUserId: String(playerId),
      targetUserId: String(adminId),
      threadEntityType: null,
      threadEntityId: null,
      reason: '',
      createdAt: nowIso(),
      liftedAt: null,
    }).run();
    expect((await notifications.flushDigests()).delivered).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sendNotification).not.toHaveBeenCalled();
    expect(db.select({ id: notificationDigestQueue.id }).from(notificationDigestQueue)
      .where(eq(notificationDigestQueue.commentId, blockedReply)).get()).toBeUndefined();
  });

  it('does not deliver to an account after an administrator disables it', async () => {
    const deliveriesBefore = sendNotification.mock.calls.length;
    expect((await admin.patch(`/api/v1/users/${playerId}`).send({ disabled: true })).status).toBe(200);

    await ctx.app.get(NotificationsService).notifyUser(playerId, campaignId, null, {
      type: 'note_shared',
      title: 'Disabled accounts must not receive this',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sendNotification).toHaveBeenCalledTimes(deliveriesBefore);

    expect((await admin.patch(`/api/v1/users/${playerId}`).send({ disabled: false })).status).toBe(200);
    player = request.agent(ctx.app.getHttpServer());
    expect((await player.post('/api/v1/auth/login').send({
      username: 'push-player',
      password: 'player-password-1',
    })).status).toBe(201);
  });

  it('prunes a subscription rejected as gone by the browser push service', async () => {
    const deliveriesBefore = sendNotification.mock.calls.length;
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    const notifications = ctx.app.get(NotificationsService);
    await notifications.notifyUser(playerId, campaignId, null, {
      type: 'note_shared',
      title: 'Dead subscription probe',
    });
    await waitForCalls(deliveriesBefore + 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    await notifications.notifyUser(playerId, campaignId, null, {
      type: 'note_shared',
      title: 'Must not retry the dead endpoint',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sendNotification).toHaveBeenCalledTimes(deliveriesBefore + 1);

    // Restore a live row for the explicit unsubscribe contract below.
    expect((await player.post('/api/v1/notifications/push-subscribe').send(subscription)).status).toBe(201);
  });

  it('unsubscribes only the caller-owned endpoint and stops future delivery', async () => {
    const deliveriesBefore = sendNotification.mock.calls.length;
    const removed = await player
      .delete('/api/v1/notifications/push-subscribe')
      .send({ endpoint: subscription.endpoint });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ removed: true });

    await ctx.app.get(NotificationsService).notifyUser(playerId, campaignId, null, {
      type: 'note_shared',
      title: 'No browser delivery',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sendNotification).toHaveBeenCalledTimes(deliveriesBefore);
  });

  it('atomically detaches the supplied browser endpoint during logout', async () => {
    expect((await player.post('/api/v1/notifications/push-subscribe').send(subscription)).status).toBe(201);
    expect(
      (await player.post('/api/v1/auth/logout').send({ pushEndpoint: subscription.endpoint })).status,
    ).toBe(204);

    player = request.agent(ctx.app.getHttpServer());
    expect(
      (await player.post('/api/v1/auth/login').send({
        username: 'push-player',
        password: 'player-password-1',
      })).status,
    ).toBe(201);
    const deliveriesBefore = sendNotification.mock.calls.length;
    await ctx.app.get(NotificationsService).notifyUser(playerId, campaignId, null, {
      type: 'note_shared',
      title: 'The signed-out browser must stay detached',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sendNotification).toHaveBeenCalledTimes(deliveriesBefore);
  });

  it('bounds each account to the newest browser subscriptions', async () => {
    sendNotification.mockClear();
    const endpoints = Array.from(
      { length: MAX_PUSH_SUBSCRIPTIONS_PER_USER + 1 },
      (_, index) => `https://fcm.googleapis.com/fcm/send/campfire-cap-${index}`,
    );
    for (const endpoint of endpoints) {
      expect((await player.post('/api/v1/notifications/push-subscribe').send({
        ...subscription,
        endpoint,
      })).status).toBe(201);
    }

    await ctx.app.get(NotificationsService).notifyUser(playerId, campaignId, null, {
      type: 'note_shared',
      title: 'Bounded browser fan-out',
    });
    await waitForCalls(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
    const deliveredEndpoints = sendNotification.mock.calls.map(([sent]) => sent.endpoint);
    expect(deliveredEndpoints).not.toContain(endpoints[0]);
    expect(deliveredEndpoints).toContain(endpoints.at(-1));
  });
});
