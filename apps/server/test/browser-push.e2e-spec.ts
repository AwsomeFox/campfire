import request from 'supertest';
import type { SendResult } from 'web-push';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import {
  WEB_PUSH_TRANSPORT,
  type WebPushTransport,
} from '../src/modules/notifications/push-notifications.service';
import { closeTestApp, createTestAppNoDevAuth, type TestAppContext } from './test-app';

describe('browser push notifications (issue #1323, e2e)', () => {
  let ctx: TestAppContext;
  let player: ReturnType<typeof request.agent>;
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
    const admin = request.agent(server);
    await admin.post('/api/v1/auth/setup').send({ username: 'push-admin', password: 'admin-password-1' });
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

  it('prunes a subscription rejected as gone by the browser push service', async () => {
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    const notifications = ctx.app.get(NotificationsService);
    await notifications.notifyUser(playerId, campaignId, null, {
      type: 'note_shared',
      title: 'Dead subscription probe',
    });
    await waitForCalls(4);
    await new Promise((resolve) => setTimeout(resolve, 25));

    await notifications.notifyUser(playerId, campaignId, null, {
      type: 'note_shared',
      title: 'Must not retry the dead endpoint',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sendNotification).toHaveBeenCalledTimes(4);

    // Restore a live row for the explicit unsubscribe contract below.
    expect((await player.post('/api/v1/notifications/push-subscribe').send(subscription)).status).toBe(201);
  });

  it('unsubscribes only the caller-owned endpoint and stops future delivery', async () => {
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
    expect(sendNotification).toHaveBeenCalledTimes(4);
  });
});
