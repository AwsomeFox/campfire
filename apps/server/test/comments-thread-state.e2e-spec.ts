import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #829 — discussion watch/mute/read-state. Real cookie sessions are required:
 * notification fan-out and thread-state rows hang off real numeric users.id, so the
 * DEV_AUTH header path (dev:* ids) cannot exercise them.
 */
describe('comments thread state / watch-mute-read (e2e, issue #829)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>;
  let playerA: ReturnType<typeof request.agent>; // a session attendee (owns a character)
  let playerB: ReturnType<typeof request.agent>; // a non-attendee player
  let aId: number;
  let bId: number;
  let campaignId: number;
  let session1: number; // attendance = [A]; used for facilitator/mute/read tests
  let session2: number; // attendance = [A]; used for the attendee-notification test
  let aCharacterId: number;

  type Notification = {
    id: number;
    userId: number;
    campaignId: number;
    type: string;
    entityType: string | null;
    entityId: number | null;
    commentId: number | null;
    readAt: string | null;
  };

  async function notificationsFor(agent: ReturnType<typeof request.agent>): Promise<Notification[]> {
    const res = await agent.get(`/api/v1/notifications?campaignId=${campaignId}`);
    expect(res.status).toBe(200);
    return Array.isArray(res.body) ? res.body : (res.body.items ?? []);
  }

  function commentReplies(list: Notification[], anchor: { type: string; id: number }): Notification[] {
    return list.filter(
      (n) =>
        n.type === 'comment_reply' &&
        n.entityType === anchor.type &&
        n.entityId === anchor.id,
    );
  }

  async function markAllRead(agent: ReturnType<typeof request.agent>): Promise<void> {
    const list = await notificationsFor(agent);
    for (const n of list) {
      if (n.readAt === null) await agent.post(`/api/v1/notifications/${n.id}/read`).expect(201);
    }
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const admin = request.agent(server);
    await admin.post('/api/v1/auth/setup').send({ username: 'admin-ts', password: 'admin-password-1' });
    const makeUser = async (username: string, display: string) => {
      const res = await admin
        .post('/api/v1/users')
        .send({ username, password: `${username}-pw-1`, displayName: display });
      expect(res.status).toBe(201);
      return res.body.id as number;
    };
    await makeUser('ts-dm', 'Dana DM'); // DM is the campaign creator; its id is not needed directly.
    aId = await makeUser('ts-a', 'Ali Attendee');
    bId = await makeUser('ts-b', 'Bo Bystander');

    dm = request.agent(server);
    await dm.post('/api/v1/auth/login').send({ username: 'ts-dm', password: 'ts-dm-pw-1' });
    playerA = request.agent(server);
    await playerA.post('/api/v1/auth/login').send({ username: 'ts-a', password: 'ts-a-pw-1' });
    playerB = request.agent(server);
    await playerB.post('/api/v1/auth/login').send({ username: 'ts-b', password: 'ts-b-pw-1' });

    const camp = await dm.post('/api/v1/campaigns').send({ name: 'Threadstate Keep' });
    campaignId = camp.body.id;
    await dm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: aId, role: 'player' }).expect(201);
    await dm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: bId, role: 'player' }).expect(201);

    const charA = await playerA.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Ali Hero' });
    aCharacterId = charA.body.id;

    const s1 = await dm.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ title: 'Session One', recap: 'A quiet arrival.' });
    session1 = s1.body.id;
    const s2 = await dm.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ title: 'Session Two', recap: 'A loud departure.' });
    session2 = s2.body.id;
    await dm.put(`/api/v1/sessions/${session1}/attendance`).send({ characterIds: [aCharacterId] }).expect(200);
    await dm.put(`/api/v1/sessions/${session2}/attendance`).send({ characterIds: [aCharacterId] }).expect(200);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('auto-subscribes the author and surfaces state via GET thread-state', async () => {
    const post = await playerA
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'session', entityId: session1, body: 'I open the door.' })
      .expect(201);
    const state = await playerA
      .get(`/api/v1/campaigns/${campaignId}/comments/thread-state`)
      .query({ entityType: 'session', entityId: session1 })
      .expect(200);
    expect(state.body).toMatchObject({
      campaignId,
      entityType: 'session',
      entityId: session1,
      watching: true,
      muted: false,
    });
    // The author has no unread of their own post.
    expect(state.body.unreadCount).toBe(0);
    expect(state.body.lastReadCommentId).toBeNull();
    void post;
  });

  it('a first post notifies facilitators (DMs) — and does NOT broadcast to a non-attendee player', async () => {
    await markAllRead(dm);
    await markAllRead(playerB);

    await playerA
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'session', entityId: session1, body: 'Anyone home?' })
      .expect(201);

    const dmList = await notificationsFor(dm);
    const dmReplies = commentReplies(dmList, { type: 'session', id: session1 });
    expect(dmReplies.length).toBeGreaterThan(0);
    expect(dmReplies.some((n) => n.commentId !== null)).toBe(true);

    // The non-attendee player heard nothing — no campaign-wide broadcast.
    const bList = await notificationsFor(playerB);
    expect(commentReplies(bList, { type: 'session', id: session1 })).toHaveLength(0);
  });

  it('a first post notifies session attendees (their character owners)', async () => {
    // session2: the DM authors the first post, so the attendee (player A) — not the
    // author — is the intended audience and is notified. Player B (non-attendee) is not.
    await markAllRead(playerA);
    await markAllRead(playerB);

    await dm
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'session', entityId: session2, body: 'The door creaks open.' })
      .expect(201);

    const aList = await notificationsFor(playerA);
    expect(commentReplies(aList, { type: 'session', id: session2 }).length).toBeGreaterThan(0);
    const bList = await notificationsFor(playerB);
    expect(commentReplies(bList, { type: 'session', id: session2 })).toHaveLength(0);
  });

  it('a reply notifies the watchers the thread auto-subscribed (the prior author)', async () => {
    // playerA already posted on session1 (watching). The DM replies; playerA is notified.
    await markAllRead(playerA);
    await dm
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'session', entityId: session1, body: 'Yes, come in.' })
      .expect(201);
    const aList = await notificationsFor(playerA);
    // At least one comment_reply for session1 arrived for A (the watching prior author).
    expect(commentReplies(aList, { type: 'session', id: session1 }).length).toBeGreaterThan(0);
  });

  it('mute suppresses notifications for the muted member, and un-mute restores them', async () => {
    await dm
      .put(`/api/v1/campaigns/${campaignId}/comments/thread-state`)
      .send({ entityType: 'session', entityId: session1, muted: true })
      .expect(200);
    const muted = await dm
      .get(`/api/v1/campaigns/${campaignId}/comments/thread-state`)
      .query({ entityType: 'session', entityId: session1 })
      .expect(200);
    expect(muted.body.muted).toBe(true);

    await markAllRead(dm);
    await playerA
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'session', entityId: session1, body: 'muted test post' })
      .expect(201);
    const duringMute = await notificationsFor(dm);
    // The muted DM received NO new (unread) comment_reply on session1.
    expect(
      duringMute.some(
        (n) => n.type === 'comment_reply' && n.entityType === 'session' && n.entityId === session1 && n.readAt === null,
      ),
    ).toBe(false);

    // Un-mute and post again; the DM is notified once more.
    await dm
      .put(`/api/v1/campaigns/${campaignId}/comments/thread-state`)
      .send({ entityType: 'session', entityId: session1, muted: false })
      .expect(200);
    await markAllRead(dm);
    await playerA
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'session', entityId: session1, body: 'un-muted test post' })
      .expect(201);
    const afterUnmute = await notificationsFor(dm);
    expect(
      afterUnmute.some(
        (n) => n.type === 'comment_reply' && n.entityType === 'session' && n.entityId === session1 && n.readAt === null,
      ),
    ).toBe(true);
  });

  it('mark-read advances the cursor, clears unread, and never moves the cursor backward', async () => {
    // playerA has unread from the DM's replies on session1. Bump a baseline read first.
    const before = await playerA
      .get(`/api/v1/campaigns/${campaignId}/comments/thread-state`)
      .query({ entityType: 'session', entityId: session1 })
      .expect(200);
    const baselineCursor = before.body.lastReadCommentId;

    // New comment from the DM creates unread for playerA.
    const fresh = await dm
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'session', entityId: session1, body: 'unread-marker' })
      .expect(201);
    const unread = await playerA
      .get(`/api/v1/campaigns/${campaignId}/comments/thread-state`)
      .query({ entityType: 'session', entityId: session1 })
      .expect(200);
    expect(unread.body.unreadCount).toBeGreaterThan(0);

    // Mark read up to the fresh comment: unread drops to zero and the cursor advanced.
    await playerA
      .post(`/api/v1/campaigns/${campaignId}/comments/thread-state/read`)
      .send({ entityType: 'session', entityId: session1, commentId: fresh.body.id })
      .expect(200);
    const readNow = await playerA
      .get(`/api/v1/campaigns/${campaignId}/comments/thread-state`)
      .query({ entityType: 'session', entityId: session1 })
      .expect(200);
    expect(readNow.body.unreadCount).toBe(0);
    expect(readNow.body.lastReadCommentId).toBe(fresh.body.id);

    // Marking an OLDER comment read never moves the cursor backward.
    if (baselineCursor !== null) {
      await playerA
        .post(`/api/v1/campaigns/${campaignId}/comments/thread-state/read`)
        .send({ entityType: 'session', entityId: session1, commentId: baselineCursor })
        .expect(200);
      const still = await playerA
        .get(`/api/v1/campaigns/${campaignId}/comments/thread-state`)
        .query({ entityType: 'session', entityId: session1 })
        .expect(200);
      expect(still.body.lastReadCommentId).toBe(fresh.body.id);
      expect(still.body.unreadCount).toBe(0);
    }
  });

  it('unread-summary and inbox surface the unread thread; reading clears the inbox', async () => {
    // Make sure playerA has at least one unread on session1.
    await dm
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'session', entityId: session1, body: 'inbox-marker' })
      .expect(201);
    const summary = await playerA
      .get(`/api/v1/campaigns/${campaignId}/comments/unread-summary`)
      .query({ entityType: 'session' })
      .expect(200);
    const entry = summary.body.items.find((i: { entityType: string; entityId: number }) => i.entityType === 'session' && i.entityId === session1);
    expect(entry).toBeDefined();
    expect(entry.unreadCount).toBeGreaterThan(0);

    const inbox = await playerA.get(`/api/v1/campaigns/${campaignId}/comments/inbox`).expect(200);
    const inboxEntry = inbox.body.items.find((i: { entityType: string; entityId: number }) => i.entityType === 'session' && i.entityId === session1);
    expect(inboxEntry).toBeDefined();
    expect(inboxEntry.unreadCount).toBeGreaterThan(0);
    expect(inboxEntry.entityName).toBe('Session One');

    // Mark the thread read: it leaves the inbox and the summary.
    await playerA
      .post(`/api/v1/campaigns/${campaignId}/comments/thread-state/read`)
      .send({ entityType: 'session', entityId: session1 })
      .expect(200);
    const inboxAfter = await playerA.get(`/api/v1/campaigns/${campaignId}/comments/inbox`).expect(200);
    expect(inboxAfter.body.items.find((i: { entityType: string; entityId: number }) => i.entityType === 'session' && i.entityId === session1)).toBeUndefined();
  });

  it('secrecy: a hidden entity thread 404s for a non-DM (thread-state is not a probe)', async () => {
    const quest = await dm.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Hidden Thread Quest', hidden: true }).expect(201);
    // DM can read state on it (and posting first auto-subscribes DMs).
    await dm
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'quest', entityId: quest.body.id, body: 'dm-only first post' })
      .expect(201);
    await dm
      .get(`/api/v1/campaigns/${campaignId}/comments/thread-state`)
      .query({ entityType: 'quest', entityId: quest.body.id })
      .expect(200);
    // A player cannot see the hidden quest's thread — thread-state 404s like the entity.
    await playerA
      .get(`/api/v1/campaigns/${campaignId}/comments/thread-state`)
      .query({ entityType: 'quest', entityId: quest.body.id })
      .expect(404);
  });
});
