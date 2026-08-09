import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import { DB, DB_HOLDER, type DbHolder, type DrizzleDb } from '../src/db/db.module';
import { campaignMembers, campaigns, characters, encounters, notificationDigestQueue, notifications as notificationRows } from '../src/db/schema';
import type { RequestUser } from '../src/common/user.types';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

type InstrumentedStatementMethod = (...args: unknown[]) => unknown;
type InstrumentedStatement = Partial<Record<'run' | 'get' | 'all' | 'iterate', InstrumentedStatementMethod>>;
type InstrumentedDatabase = { prepare: (source: string) => InstrumentedStatement };

function instrumentSql(ctx: TestAppContext): { executed: string[]; restore: () => void } {
  const raw = ctx.app.get<DbHolder>(DB_HOLDER).raw as unknown as InstrumentedDatabase;
  const executed: string[] = [];
  const originalPrepare = raw.prepare.bind(raw);
  raw.prepare = (source: string) => {
    const statement = originalPrepare(source);
    for (const method of ['run', 'get', 'all', 'iterate'] as const) {
      const originalMethod = statement[method];
      if (typeof originalMethod === 'function') {
        statement[method] = function tracked(...args: unknown[]) {
          executed.push(source);
          return originalMethod.apply(statement, args);
        };
      }
    }
    return statement;
  };
  return {
    executed,
    restore: () => {
      raw.prepare = originalPrepare;
    },
  };
}

/**
 * In-app notifications (issue #11): recap posted, note reply, added to
 * campaign, next session scheduled. Real cookie sessions — notification rows
 * hang off real users.id, so the DEV_AUTH header path (dev:* ids) is out.
 */
describe('notifications (e2e)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>; // user A — campaign creator/dm
  let player: ReturnType<typeof request.agent>; // user B — player
  let dmId: number;
  let playerId: number;
  let campaignId: number;

  type Notification = {
    id: number;
    userId: number;
    campaignId: number;
    type: string;
    title: string;
    body: string;
    entityType: string | null;
    entityId: number | null;
    actorName: string;
    readAt: string | null;
    createdAt: string;
  };

  async function listFor(agent: ReturnType<typeof request.agent>, query = ''): Promise<Notification[]> {
    const res = await agent.get(`/api/v1/notifications${query}`);
    expect(res.status).toBe(200);
    return Array.isArray(res.body) ? res.body : (res.body.items ?? res.body);
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'notif-admin', password: 'admin-password-1' });
    const createDm = await adminAgent.post('/api/v1/users').send({ username: 'notif-dm', password: 'password-dm-1', displayName: 'Dana DM' });
    dmId = createDm.body.id;
    const createPlayer = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'notif-player', password: 'password-pl-1', displayName: 'Pat Player' });
    playerId = createPlayer.body.id;

    dm = request.agent(server);
    await dm.post('/api/v1/auth/login').send({ username: 'notif-dm', password: 'password-dm-1' });
    player = request.agent(server);
    await player.post('/api/v1/auth/login').send({ username: 'notif-player', password: 'password-pl-1' });

    const campaign = await dm.post('/api/v1/campaigns').send({ name: 'Notification Keep' });
    campaignId = campaign.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('starts empty: no notifications, zero unread', async () => {
    expect(await listFor(player)).toEqual([]);
    const count = await player.get('/api/v1/notifications/unread-count');
    expect(count.status).toBe(200);
    // Issue #1590: `membershipChanged` — the account-wide-refresh discriminator the poll
    // that already runs everywhere (not just campaign routes) uses to tell "your role
    // changed" apart from ordinary table activity.
    expect(count.body).toEqual({ count: 0, membershipChanged: false });
  });

  it('added_to_campaign: adding a member notifies the added user (not the acting dm), and flags membershipChanged (#1590)', async () => {
    const add = await dm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
    expect(add.status).toBe(201);

    const mine = await listFor(player);
    const added = mine.filter((n) => n.type === 'added_to_campaign');
    expect(added).toHaveLength(1);
    expect(added[0].campaignId).toBe(campaignId);
    expect(added[0].title).toContain('Notification Keep');
    expect(added[0].title).toContain('player');
    expect(added[0].actorName).toBe('Dana DM');
    expect(added[0].readAt).toBeNull();

    // #1590 — an `added_to_campaign` row is membership-shaped: the newly-added player's
    // poller must be told to refresh /me even though this is a fresh notification, not a
    // reassignment of an existing seat.
    const playerCount = await player.get('/api/v1/notifications/unread-count');
    expect(playerCount.body.membershipChanged).toBe(true);

    const dmList = await listFor(dm);
    expect(dmList.filter((n) => n.type === 'added_to_campaign')).toHaveLength(0);
    // The acting DM has no unread membership-shaped notification of their own.
    const dmCount = await dm.get('/api/v1/notifications/unread-count');
    expect(dmCount.body.membershipChanged).toBe(false);

    // Reading it clears the flag — a stale poll must not keep re-triggering the client's
    // refresh forever.
    const markRead = await player.post(`/api/v1/notifications/${added[0].id}/read`);
    expect(markRead.status).toBe(201);
    const afterRead = await player.get('/api/v1/notifications/unread-count');
    expect(afterRead.body.membershipChanged).toBe(false);
  });

  it('shows always-on attributed safety-hold notices despite a block', async () => {
    const block = await player.post(`/api/v1/campaigns/${campaignId}/safety/blocks`).send({ targetUserId: String(dmId) });
    expect(block.status).toBe(201);

    const hold = await dm.post(`/api/v1/campaigns/${campaignId}/safety/hold`).send({ anonymous: false });
    expect(hold.status).toBe(200);

    const visible = (await listFor(player)).filter((notification) => notification.type === 'safety_hold');
    expect(visible).toHaveLength(1);
    expect((await player.get('/api/v1/notifications/unread-count')).body.count).toBe(1);

    const released = await dm.post(`/api/v1/campaigns/${campaignId}/safety/release`).send({ recovery: 'resume' });
    expect(released.status).toBe(200);
    const lifted = await player.delete(`/api/v1/campaigns/${campaignId}/safety/controls/${block.body.id}`);
    expect(lifted.status).toBe(200);
  });

  it('recap_posted: creating a session with a recap notifies members, not the author', async () => {
    const res = await dm
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .send({ number: 1, title: 'Into the Keep', recap: 'The party met at the tavern and heard rumors of the keep.' });
    expect(res.status).toBe(201);

    const mine = await listFor(player);
    const recaps = mine.filter((n) => n.type === 'recap_posted');
    expect(recaps).toHaveLength(1);
    expect(recaps[0].title).toContain('Session 1');
    expect(recaps[0].body).toContain('tavern');
    expect(recaps[0].entityType).toBe('session');
    expect(recaps[0].entityId).toBe(res.body.id);

    expect((await listFor(dm)).filter((n) => n.type === 'recap_posted')).toHaveLength(0);
  });

  it('recap_posted fires on the empty -> non-empty transition only (no edit spam)', async () => {
    const create = await dm.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ number: 2, title: 'Quiet prep' });
    expect(create.status).toBe(201);
    const sessionId = create.body.id;
    expect((await listFor(player)).filter((n) => n.type === 'recap_posted')).toHaveLength(1); // unchanged

    const post = await dm.patch(`/api/v1/sessions/${sessionId}`).send({ recap: 'We planned the assault.' });
    expect(post.status).toBe(200);
    expect((await listFor(player)).filter((n) => n.type === 'recap_posted')).toHaveLength(2);

    const edit = await dm.patch(`/api/v1/sessions/${sessionId}`).send({ recap: 'We planned the assault carefully.' });
    expect(edit.status).toBe(200);
    expect((await listFor(player)).filter((n) => n.type === 'recap_posted')).toHaveLength(2); // still 2
  });

  it('session_scheduled: setting playedAt to an upcoming date notifies members; past dates do not', async () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const create = await dm
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .send({ number: 3, title: 'Next week', playedAt: future });
    expect(create.status).toBe(201);

    const scheduled = (await listFor(player)).filter((n) => n.type === 'session_scheduled');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].title).toContain(future);

    // Logging a PAST session (playedAt in the past) is not a "next session" event.
    const past = await dm
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .send({ number: 4, title: 'Last month', playedAt: '2020-01-01' });
    expect(past.status).toBe(201);
    expect((await listFor(player)).filter((n) => n.type === 'session_scheduled')).toHaveLength(1);

    // Rescheduling (PATCH playedAt) notifies again.
    const future2 = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const patch = await dm.patch(`/api/v1/sessions/${create.body.id}`).send({ playedAt: future2 });
    expect(patch.status).toBe(200);
    expect((await listFor(player)).filter((n) => n.type === 'session_scheduled')).toHaveLength(2);
  });

  it('note_reply: a shared note on the same entity notifies earlier shared-note authors', async () => {
    // Player starts a party_shared thread on session 1; a private note by the DM must not notify.
    const sessions = await dm.get(`/api/v1/campaigns/${campaignId}/sessions`);
    const sessionId = sessions.body.find((s: { number: number }) => s.number === 1).id;

    const playerNote = await player.post(`/api/v1/campaigns/${campaignId}/notes`).send({
      body: 'I think the innkeeper is hiding something.',
      visibility: 'party_shared',
      entityType: 'session',
      entityId: sessionId,
    });
    expect(playerNote.status).toBe(201);

    const dmPrivate = await dm.post(`/api/v1/campaigns/${campaignId}/notes`).send({
      body: 'Secret prep note.',
      visibility: 'private',
      entityType: 'session',
      entityId: sessionId,
    });
    expect(dmPrivate.status).toBe(201);
    expect((await listFor(player)).filter((n) => n.type === 'note_reply')).toHaveLength(0);

    // DM replies party_shared on the same entity -> player is notified.
    const dmReply = await dm.post(`/api/v1/campaigns/${campaignId}/notes`).send({
      body: 'Agreed — let us press him next time.',
      visibility: 'party_shared',
      entityType: 'session',
      entityId: sessionId,
    });
    expect(dmReply.status).toBe(201);

    const replies = (await listFor(player)).filter((n) => n.type === 'note_reply');
    expect(replies).toHaveLength(1);
    expect(replies[0].actorName).toBe('Dana DM');
    expect(replies[0].body).toContain('press him');
    expect(replies[0].entityType).toBe('session');
    expect(replies[0].entityId).toBe(sessionId);
  });

  it('note_reply: a dm_shared note does NOT notify non-dm thread authors (they cannot see it)', async () => {
    const sessions = await dm.get(`/api/v1/campaigns/${campaignId}/sessions`);
    const sessionId = sessions.body.find((s: { number: number }) => s.number === 1).id;

    const before = (await listFor(player)).filter((n) => n.type === 'note_reply').length;
    // Player writes a dm_shared note on the thread; the player can't see other
    // players' dm_shared notes, so a second dm_shared note must only reach dms.
    const res = await player.post(`/api/v1/campaigns/${campaignId}/notes`).send({
      body: 'DM eyes only: my character is secretly related to the innkeeper.',
      visibility: 'dm_shared',
      entityType: 'session',
      entityId: sessionId,
    });
    expect(res.status).toBe(201);

    // The DM (author of a shared note on this entity) IS notified.
    const dmReplies = (await listFor(dm)).filter((n) => n.type === 'note_reply');
    expect(dmReplies.length).toBeGreaterThanOrEqual(1);
    // The player gets nothing new from their own note.
    expect((await listFor(player)).filter((n) => n.type === 'note_reply')).toHaveLength(before);
  });

  it('note_reply: resolving an inbox item notifies its author', async () => {
    const inbox = await player
      .post(`/api/v1/campaigns/${campaignId}/inbox`)
      .send({ body: 'Can we get a shopping episode next session?' });
    expect(inbox.status).toBe(201);

    const resolve = await dm.post(`/api/v1/notes/${inbox.body.id}/resolve`).send({ resolvedNote: 'Yes — bring gold.' });
    expect(resolve.status).toBe(201);

    const replies = (await listFor(player)).filter((n) => n.type === 'note_reply');
    const resolved = replies.find((n) => n.body.includes('bring gold'));
    expect(resolved).toBeDefined();
    expect(resolved!.title).toContain('resolved your inbox note');
  });

  it('unread-count, mark one read, mark all read', async () => {
    const before = await player.get('/api/v1/notifications/unread-count');
    expect(before.body.count).toBeGreaterThan(0);

    const mine = await listFor(player, '?unread=true');
    expect(mine.length).toBe(before.body.count);

    const markRes = await player.post(`/api/v1/notifications/${mine[0].id}/read`);
    expect(markRes.status).toBe(201);
    expect(markRes.body.readAt).not.toBeNull();

    const after = await player.get('/api/v1/notifications/unread-count');
    expect(after.body.count).toBe(before.body.count - 1);

    const allRes = await player.post('/api/v1/notifications/read-all');
    expect(allRes.status).toBe(201);
    expect(allRes.body.updated).toBe(before.body.count - 1);
    expect((await player.get('/api/v1/notifications/unread-count')).body.count).toBe(0);
    expect(await listFor(player, '?unread=true')).toEqual([]);
  });

  it("marking someone else's notification 404s and does not change it", async () => {
    const dmList = await listFor(dm);
    expect(dmList.length).toBeGreaterThan(0);
    const res = await player.post(`/api/v1/notifications/${dmList[0].id}/read`);
    expect(res.status).toBe(404);
  });

  it('notifications list only ever contains the caller own rows', async () => {
    const mine = await listFor(player);
    expect(mine.every((n) => n.userId === playerId)).toBe(true);
  });

  it('requires auth (401 without a session)', async () => {
    const anon = request(ctx.app.getHttpServer());
    expect((await anon.get('/api/v1/notifications')).status).toBe(401);
    expect((await anon.get('/api/v1/notifications/unread-count')).status).toBe(401);
    expect((await anon.post('/api/v1/notifications/read-all')).status).toBe(401);
  });
});

/**
 * Issue #105: "shared-with-DM notes appear in the DM's scribe view" — but a
 * dm_shared note previously just sat under the DM's "Shared with me" with no
 * signal, so the DM could miss player notes entirely. Sharing a note up to the
 * DM now notifies every dm-role member (type note_shared), giving the promised
 * unread indicator. Real cookie sessions — notifications hang off real users.id.
 */
describe('note_shared notifications (issue #105, e2e)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>; // campaign creator/dm
  let player: ReturnType<typeof request.agent>; // a player
  let playerId: number;
  let campaignId: number;

  type Notification = { id: number; type: string; title: string; body: string; entityType: string | null; entityId: number | null; actorName: string };

  async function sharedFor(agent: ReturnType<typeof request.agent>): Promise<Notification[]> {
    const res = await agent.get('/api/v1/notifications');
    expect(res.status).toBe(200);
    const items: Notification[] = Array.isArray(res.body) ? res.body : (res.body.items ?? res.body);
    return items.filter((n) => n.type === 'note_shared');
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'ns-admin', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'ns-dm', password: 'password-dm-1', displayName: 'Dana DM' });
    const createPlayer = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'ns-player', password: 'password-pl-1', displayName: 'Pat Player' });
    playerId = createPlayer.body.id;

    dm = request.agent(server);
    await dm.post('/api/v1/auth/login').send({ username: 'ns-dm', password: 'password-dm-1' });
    player = request.agent(server);
    await player.post('/api/v1/auth/login').send({ username: 'ns-player', password: 'password-pl-1' });

    const campaign = await dm.post('/api/v1/campaigns').send({ name: 'Scribe Keep' });
    campaignId = campaign.body.id;
    await dm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('creating a dm_shared note notifies the DM (not the author)', async () => {
    const res = await player
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'DM, my character has a secret patron.', visibility: 'dm_shared' });
    expect(res.status).toBe(201);

    const dmShared = await sharedFor(dm);
    expect(dmShared).toHaveLength(1);
    expect(dmShared[0].title).toContain('Pat Player');
    expect(dmShared[0].actorName).toBe('Pat Player');
    expect(dmShared[0].body).toContain('secret patron');

    // The author gets nothing from their own share.
    expect(await sharedFor(player)).toHaveLength(0);
  });

  it('a private note does NOT notify the DM', async () => {
    const before = (await sharedFor(dm)).length;
    const res = await player
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'Just for me.', visibility: 'private' });
    expect(res.status).toBe(201);
    expect((await sharedFor(dm)).length).toBe(before);
  });

  it('carries the entity link when the shared note is anchored', async () => {
    const quest = await dm.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'The Patron' });
    const before = (await sharedFor(dm)).length;

    const res = await player.post(`/api/v1/campaigns/${campaignId}/notes`).send({
      body: 'Relevant to this quest.',
      visibility: 'dm_shared',
      entityType: 'quest',
      entityId: quest.body.id,
    });
    expect(res.status).toBe(201);

    const dmShared = await sharedFor(dm);
    expect(dmShared.length).toBe(before + 1);
    const latest = dmShared[0]; // newest first (ordered by id desc)
    expect(latest.entityType).toBe('quest');
    expect(latest.entityId).toBe(quest.body.id);
  });

  it('patching a private note to dm_shared notifies the DM once; editing the shared body again does not', async () => {
    const created = await player
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'Was private.', visibility: 'private' });
    expect(created.status).toBe(201);
    const before = (await sharedFor(dm)).length;

    // private -> dm_shared: notifies.
    const share = await player.patch(`/api/v1/notes/${created.body.id}`).send({ visibility: 'dm_shared' });
    expect(share.status).toBe(200);
    expect((await sharedFor(dm)).length).toBe(before + 1);

    // body edit of an already-shared note: no re-notify (no spam).
    const edit = await player.patch(`/api/v1/notes/${created.body.id}`).send({ body: 'Was private. Now edited.' });
    expect(edit.status).toBe(200);
    expect((await sharedFor(dm)).length).toBe(before + 1);
  });
});

/**
 * Issue #784: author edits must notify only when audience/recipient expands or
 * changes — typo/body fixes on an already-shared note must not re-ping.
 */
describe('note edit audience notifications (issue #784, e2e)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>;
  let author: ReturnType<typeof request.agent>;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  let authorId: number;
  let aliceId: number;
  let bobId: number;
  let campaignId: number;

  type Notification = { id: number; type: string; title: string; body: string };

  async function sharedFor(agent: ReturnType<typeof request.agent>): Promise<Notification[]> {
    const res = await agent.get('/api/v1/notifications');
    expect(res.status).toBe(200);
    const items: Notification[] = Array.isArray(res.body) ? res.body : (res.body.items ?? res.body);
    return items.filter((n) => n.type === 'note_shared');
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'ne-admin', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'ne-dm', password: 'password-dm-1', displayName: 'Dana DM' });
    authorId = (
      await adminAgent.post('/api/v1/users').send({ username: 'ne-author', password: 'password-au-1', displayName: 'Ada Author' })
    ).body.id;
    aliceId = (
      await adminAgent.post('/api/v1/users').send({ username: 'ne-alice', password: 'password-al-1', displayName: 'Alice' })
    ).body.id;
    bobId = (
      await adminAgent.post('/api/v1/users').send({ username: 'ne-bob', password: 'password-bo-1', displayName: 'Bob' })
    ).body.id;

    dm = request.agent(server);
    await dm.post('/api/v1/auth/login').send({ username: 'ne-dm', password: 'password-dm-1' });
    author = request.agent(server);
    await author.post('/api/v1/auth/login').send({ username: 'ne-author', password: 'password-au-1' });
    alice = request.agent(server);
    await alice.post('/api/v1/auth/login').send({ username: 'ne-alice', password: 'password-al-1' });
    bob = request.agent(server);
    await bob.post('/api/v1/auth/login').send({ username: 'ne-bob', password: 'password-bo-1' });

    const campaign = await dm.post('/api/v1/campaigns').send({ name: 'Edit Notify Keep' });
    campaignId = campaign.body.id;
    await dm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: authorId, role: 'player' });
    await dm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: aliceId, role: 'player' });
    await dm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: bobId, role: 'player' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('party_shared body typo fix does not re-notify the party', async () => {
    const created = await author
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'Party tip about the bridge.', visibility: 'party_shared' });
    expect(created.status).toBe(201);
    const beforeAlice = (await sharedFor(alice)).length;
    const beforeDm = (await sharedFor(dm)).length;

    const edit = await author
      .patch(`/api/v1/notes/${created.body.id}`)
      .send({ body: 'Party tip about the bridge (typo fixed).', expectedUpdatedAt: created.body.updatedAt });
    expect(edit.status).toBe(200);
    expect((await sharedFor(alice)).length).toBe(beforeAlice);
    expect((await sharedFor(dm)).length).toBe(beforeDm);
  });

  it('whisper retarget notifies the new recipient; body edit of the same whisper does not', async () => {
    const created = await author.post(`/api/v1/campaigns/${campaignId}/notes`).send({
      body: 'Only you notice the trap door',
      visibility: 'whisper',
      recipientUserId: String(aliceId),
    });
    expect(created.status).toBe(201);
    expect((await sharedFor(alice)).some((n) => n.body.includes('trap door'))).toBe(true);

    const beforeBob = (await sharedFor(bob)).length;
    const beforeAlice = (await sharedFor(alice)).length;

    const retarget = await author.patch(`/api/v1/notes/${created.body.id}`).send({
      recipientUserId: String(bobId),
      expectedUpdatedAt: created.body.updatedAt,
    });
    expect(retarget.status).toBe(200);
    expect((await sharedFor(bob)).length).toBe(beforeBob + 1);
    // Alice is not re-pinged on retarget away from her.
    expect((await sharedFor(alice)).length).toBe(beforeAlice);

    const beforeBobAfter = (await sharedFor(bob)).length;
    const typo = await author.patch(`/api/v1/notes/${created.body.id}`).send({
      body: 'Only you notice the trap door.',
      expectedUpdatedAt: retarget.body.updatedAt,
    });
    expect(typo.status).toBe(200);
    expect((await sharedFor(bob)).length).toBe(beforeBobAfter);
  });
});

/**
 * Issue #263: notification coverage was incomplete — scheduling, quest changes,
 * party-shared notes and proposals never notified anyone. Each of those now emits
 * a best-effort in-app notification to the right recipient. Real cookie sessions
 * (notifications hang off real users.id, so the DEV_AUTH header path is out).
 */
describe('coverage gaps: scheduling / quests / party notes / proposals (issue #263, e2e)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>; // campaign creator/dm
  let player: ReturnType<typeof request.agent>; // a player
  let coDm: ReturnType<typeof request.agent>;
  let spectator: ReturnType<typeof request.agent>;
  let guestDm: ReturnType<typeof request.agent>;
  // Venue/room/template MUTATION is @ServerRoles('admin'); applying a template
  // only needs `dm` on the target campaign. Both agents are therefore needed to
  // exercise the apply path end to end.
  let admin: ReturnType<typeof request.agent>;
  let playerId: number;
  let coDmId: number;
  let spectatorId: number;
  let guestDmId: number;
  let campaignId: number;

  type Notification = {
    id: number;
    campaignId: number;
    type: string;
    title: string;
    body: string;
    entityType: string | null;
    entityId: number | null;
    actorName: string;
    data?: Record<string, unknown> | null;
  };

  async function listFor(agent: ReturnType<typeof request.agent>): Promise<Notification[]> {
    const res = await agent.get('/api/v1/notifications');
    expect(res.status).toBe(200);
    return Array.isArray(res.body) ? res.body : (res.body.items ?? res.body);
  }
  const ofType = (rows: Notification[], type: string) => rows.filter((n) => n.type === type);

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    admin = adminAgent;
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'cov-admin', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'cov-dm', password: 'password-dm-1', displayName: 'Dana DM' });
    const createPlayer = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'cov-player', password: 'password-pl-1', displayName: 'Pat Player' });
    playerId = createPlayer.body.id;
    const createCoDm = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'cov-co-dm', password: 'password-codm-1', displayName: 'Cora Co-DM' });
    coDmId = createCoDm.body.id;
    const createSpectator = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'cov-spectator', password: 'password-spec-1', displayName: 'Sam Spectator' });
    spectatorId = createSpectator.body.id;
    const createGuestDm = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'cov-guest-dm', password: 'password-guest-dm-1', displayName: 'Gale Guest DM' });
    guestDmId = createGuestDm.body.id;

    dm = request.agent(server);
    await dm.post('/api/v1/auth/login').send({ username: 'cov-dm', password: 'password-dm-1' });
    player = request.agent(server);
    await player.post('/api/v1/auth/login').send({ username: 'cov-player', password: 'password-pl-1' });
    coDm = request.agent(server);
    await coDm.post('/api/v1/auth/login').send({ username: 'cov-co-dm', password: 'password-codm-1' });
    spectator = request.agent(server);
    await spectator.post('/api/v1/auth/login').send({ username: 'cov-spectator', password: 'password-spec-1' });
    guestDm = request.agent(server);
    await guestDm.post('/api/v1/auth/login').send({ username: 'cov-guest-dm', password: 'password-guest-dm-1' });

    const campaign = await dm.post('/api/v1/campaigns').send({ name: 'Coverage Keep' });
    campaignId = campaign.body.id;
    await dm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('scheduling a session notifies the party (not the scheduling DM)', async () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const res = await dm
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .send({ scheduledAt: future, title: 'Game night' });
    expect(res.status).toBe(201);

    const scheduled = ofType(await listFor(player), 'session_scheduled');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].title).toContain('Game night');
    expect(scheduled[0].actorName).toBe('Dana DM');
    // Issue #446: schedule row id is stamped so the UI can open the exact card.
    expect(scheduled[0].entityId).toBe(res.body.id);
    expect(scheduled[0].entityType).toBeNull();
    // Issue #820: structured metadata carries the instant (no UTC date baked into title).
    expect(scheduled[0].data).toMatchObject({
      kind: 'schedule',
      scheduleId: res.body.id,
      changeType: 'created',
      scheduledAt: res.body.scheduledAt,
    });
    expect(scheduled[0].title).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(scheduled[0].title).not.toMatch(/scheduled for \d{4}-\d{2}-\d{2}/);
    // The scheduling DM does not notify themselves.
    expect(ofType(await listFor(dm), 'session_scheduled')).toHaveLength(0);
  });

  it('venue/VTT-link and notes changes notify once; title-only edits stay silent; cancel notifies', async () => {
    const future = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    const created = await dm
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .send({ scheduledAt: future, title: 'Lifecycle night' });
    expect(created.status).toBe(201);
    const scheduleId = created.body.id as number;
    const before = ofType(await listFor(player), 'session_scheduled').length;

    // Title-only: no ping.
    const titleOnly = await dm.patch(`/api/v1/schedule/${scheduleId}`).send({ title: 'Lifecycle night (renamed)' });
    expect(titleOnly.status).toBe(200);
    expect(ofType(await listFor(player), 'session_scheduled')).toHaveLength(before);

    // Venue (VTT link) + notes: one coalesced update ping, field names only.
    const venueNotes = await dm.patch(`/api/v1/schedule/${scheduleId}`).send({
      location: 'https://vtt.example/room/secret-invite',
      notes: 'private prep: surprise dragon',
    });
    expect(venueNotes.status).toBe(200);
    const afterVenue = ofType(await listFor(player), 'session_scheduled');
    expect(afterVenue).toHaveLength(before + 1);
    const updatePing = afterVenue[0];
    expect(updatePing.data).toMatchObject({
      kind: 'schedule',
      scheduleId,
      changeType: 'updated',
      changedFields: expect.arrayContaining(['venue', 'notes']),
    });
    expect(updatePing.title).toMatch(/updated/i);
    expect(JSON.stringify(updatePing)).not.toMatch(/secret-invite|surprise dragon/i);

    // Cancellation notifies with a cancelled snapshot.
    const cancel = await dm.delete(`/api/v1/schedule/${scheduleId}`).send({});
    expect(cancel.status).toBe(200);
    const afterCancel = ofType(await listFor(player), 'session_scheduled');
    expect(afterCancel).toHaveLength(before + 2);
    expect(afterCancel[0].data).toMatchObject({
      kind: 'schedule',
      scheduleId,
      changeType: 'cancelled',
    });
    expect(afterCancel[0].title).toMatch(/cancelled/i);
  });

  /**
   * Issue #588 — the organized-play routes are schedule writes too.
   *
   * `PATCH /schedule/:id` now REFUSES to move an occurrence of a series and
   * points callers at `POST /organized-play/occurrences/:id/reschedule`, so a
   * path that persisted a notification was replaced by one that emitted only an
   * ephemeral SSE ping. A member who did not happen to have the app open when the
   * coordinator moved or cancelled the night learned nothing — no bell, no
   * digest, no offline catch-up — and would still have turned up.
   *
   * One notification per request, anchored on the SOONEST affected night, rather
   * than one per occurrence: a series action is a single decision, and fanning it
   * out per row would put up to MAX_SERIES_OCCURRENCES bells in the tray for one
   * click.
   */
  it('organized-play series writes notify the party the same way the one-off path does', async () => {
    const startDate = new Date(Date.now() + 21 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const before = ofType(await listFor(player), 'session_scheduled').length;

    const series = await dm.post(`/api/v1/campaigns/${campaignId}/series`).send({
      title: 'Organized night',
      timezone: 'UTC',
      startDate,
      startTime: '18:00',
      freq: 'weekly',
      count: 3,
    });
    expect(series.status).toBe(201);
    const occurrences = series.body.occurrences as Array<{ id: number; scheduledAt: string }>;

    const afterCreate = ofType(await listFor(player), 'session_scheduled');
    expect(afterCreate).toHaveLength(before + 1); // one, not three
    expect(afterCreate[0].data).toMatchObject({
      kind: 'schedule',
      scheduleId: occurrences[0].id, // the soonest night
      changeType: 'created',
    });

    // Moving ONE occurrence behaves exactly like PATCH /schedule/:id would have.
    const moved = await dm
      .post(`/api/v1/organized-play/occurrences/${occurrences[1].id}/reschedule`)
      .send({ scheduledAt: new Date(Date.parse(occurrences[1].scheduledAt) + 3600 * 1000).toISOString() });
    expect(moved.status).toBe(201);
    const afterMove = ofType(await listFor(player), 'session_scheduled');
    expect(afterMove).toHaveLength(before + 2);
    expect(afterMove[0].data).toMatchObject({
      kind: 'schedule',
      scheduleId: occurrences[1].id,
      changeType: 'rescheduled',
      changedFields: ['time'],
    });

    // A re-seat is the organized-play analogue of a title-only edit: room, DM and
    // capacity never reach the party's copy of the night, so it stays silent.
    const reseated = await dm.post(`/api/v1/organized-play/occurrences/${occurrences[2].id}/reassign`).send({ capacity: 4 });
    expect(reseated.status).toBe(201);
    expect(ofType(await listFor(player), 'session_scheduled')).toHaveLength(before + 2);

    // Cancelling the series must reach members who are not watching the page.
    const cancelled = await dm.delete(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).send({ reason: 'venue flooded' });
    expect(cancelled.status).toBe(200);
    const afterCancel2 = ofType(await listFor(player), 'session_scheduled');
    expect(afterCancel2).toHaveLength(before + 3);
    expect(afterCancel2[0].data).toMatchObject({ kind: 'schedule', changeType: 'cancelled' });
    expect(afterCancel2[0].title).toMatch(/cancelled/i);
    // Reasons are prose the coordinator wrote; the ping carries field names only.
    expect(JSON.stringify(afterCancel2[0])).not.toMatch(/venue flooded/i);
  });

  /**
   * Applying a template is the sixth write path, and the one that can put the
   * MOST nights on a member's calendar in a single call (slots x occurrences).
   * The first version of the organized-play fan-out covered the other five and
   * missed this one — silent by omission, and indistinguishable at the call site
   * from `reassignOccurrence`, which is silent on purpose. Hence the path table
   * on `notifyOccurrenceChange` and the explicit markers at every write site.
   */
  it('applying a template notifies the party that a block of nights was added', async () => {
    const venue = await admin.post('/api/v1/organized-play/venues').send({ name: 'Template Hall', timezone: 'UTC' });
    expect(venue.status).toBe(201);
    const room = await admin.post(`/api/v1/organized-play/venues/${venue.body.id}/rooms`).send({ name: 'Hall A', capacity: 6 });
    expect(room.status).toBe(201);

    const startDate = new Date(Date.now() + 28 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const weekday = new Date(`${startDate}T00:00:00.000Z`).getUTCDay();
    const template = await admin.post('/api/v1/organized-play/templates').send({
      name: 'League Night',
      venueId: venue.body.id,
      timezone: 'UTC',
      freq: 'weekly',
      interval: 1,
      count: 3,
      slots: [{ weekday, title: 'Table 1', roomId: room.body.id, startTime: '18:00', durationMinutes: 180, capacity: 6 }],
    });
    expect(template.status).toBe(201);

    const before = ofType(await listFor(player), 'session_scheduled').length;
    const applied = await dm
      .post(`/api/v1/organized-play/templates/${template.body.id}/apply`)
      .send({ campaignId, startDate });
    expect(applied.status).toBe(201);
    expect(applied.body.occurrencesCreated).toBe(3);

    const after = ofType(await listFor(player), 'session_scheduled');
    // One for the request, not one per created night.
    expect(after).toHaveLength(before + 1);
    expect(after[0].data).toMatchObject({ kind: 'schedule', changeType: 'created' });
  });

  it("a player's RSVP notifies the DM (not the RSVPing player)", async () => {
    const future = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
    const sched = await dm.post(`/api/v1/campaigns/${campaignId}/schedule`).send({ scheduledAt: future, title: 'RSVP night' });
    expect(sched.status).toBe(201);

    const rsvp = await player.put(`/api/v1/schedule/${sched.body.id}/rsvp`).send({ status: 'yes' });
    expect(rsvp.status).toBe(200);

    const dmRsvps = ofType(await listFor(dm), 'session_rsvp');
    expect(dmRsvps).toHaveLength(1);
    expect(dmRsvps[0].title).toContain('Pat Player');
    expect(dmRsvps[0].title).toContain('yes');
    expect(dmRsvps[0].entityId).toBe(sched.body.id);
    // The RSVPing player is not notified about their own availability.
    expect(ofType(await listFor(player), 'session_rsvp')).toHaveLength(0);
  });

  it("a player's RSVP note-only update notifies the DM with note-specific copy", async () => {
    const future = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
    const sched = await dm.post(`/api/v1/campaigns/${campaignId}/schedule`).send({ scheduledAt: future, title: 'RSVP note night' });
    expect(sched.status).toBe(201);
    const scheduleId = sched.body.id as number;

    const initial = await player.put(`/api/v1/schedule/${scheduleId}/rsvp`).send({ status: 'yes' });
    expect(initial.status).toBe(200);

    const noteOnly = await player
      .put(`/api/v1/schedule/${scheduleId}/rsvp`)
      .send({ note: 'Running 15 minutes late' });
    expect(noteOnly.status).toBe(200);

    const dmRsvps = ofType(await listFor(dm), 'session_rsvp').filter((n) => n.entityId === scheduleId);
    expect(dmRsvps).toHaveLength(2);
    expect(dmRsvps[0].title).toMatch(/updated their RSVP note/i);
    expect(dmRsvps[0].title).not.toMatch(/RSVP'd yes/i);
  });

  it("a player's RSVP status+note update notifies the DM with both status and note change copy", async () => {
    const future = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
    const sched = await dm
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .send({ scheduledAt: future, title: 'RSVP status+note night' });
    expect(sched.status).toBe(201);
    const scheduleId = sched.body.id as number;

    const initial = await player.put(`/api/v1/schedule/${scheduleId}/rsvp`).send({ status: 'yes' });
    expect(initial.status).toBe(200);

    const statusAndNote = await player
      .put(`/api/v1/schedule/${scheduleId}/rsvp`)
      .send({ status: 'no', note: 'Can only join for the first hour' });
    expect(statusAndNote.status).toBe(200);

    const dmRsvps = ofType(await listFor(dm), 'session_rsvp').filter((n) => n.entityId === scheduleId);
    expect(dmRsvps).toHaveLength(2);
    expect(dmRsvps[0].title).toMatch(/RSVP'd no/i);
    expect(dmRsvps[0].title).toMatch(/updated their note/i);
  });

  it('completing a visible quest notifies the party; the acting DM is not notified', async () => {
    // #754: omit defaults to DM-only (no completion ping); create visible for this case.
    const quest = await dm.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Slay the dragon', hidden: false });
    expect(quest.status).toBe(201);

    const done = await dm.post(`/api/v1/quests/${quest.body.id}/status`).send({ status: 'completed' });
    expect(done.status).toBe(201);

    const questNotifs = ofType(await listFor(player), 'quest_updated');
    expect(questNotifs).toHaveLength(1);
    expect(questNotifs[0].title).toContain('Slay the dragon');
    expect(questNotifs[0].entityType).toBe('quest');
    expect(questNotifs[0].entityId).toBe(quest.body.id);
    expect(ofType(await listFor(dm), 'quest_updated')).toHaveLength(0);
  });

  it('a HIDDEN quest stays silent to players until it is revealed (then notifies)', async () => {
    const hidden = await dm.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Secret pact', hidden: true });
    expect(hidden.status).toBe(201);

    // Completing a still-hidden quest must NOT notify players (its existence is dm-only).
    const complete = await dm.post(`/api/v1/quests/${hidden.body.id}/status`).send({ status: 'completed' });
    expect(complete.status).toBe(201);
    const before = ofType(await listFor(player), 'quest_updated').length;

    // Revealing it (hidden -> visible) DOES notify the party.
    const reveal = await dm.patch(`/api/v1/quests/${hidden.body.id}`).send({ hidden: false });
    expect(reveal.status).toBe(200);
    const after = ofType(await listFor(player), 'quest_updated');
    expect(after.length).toBe(before + 1);
    expect(after[0].title).toContain('Secret pact');
  });

  it('keeps hidden-encounter downed and died notifications to permanent DMs and the affected owner, while visible encounters still notify the party (#2112)', async () => {
    const hiddenCampaign = await dm.post('/api/v1/campaigns').send({ name: 'Hidden Notification Keep' });
    expect(hiddenCampaign.status).toBe(201);
    const hiddenCampaignId = hiddenCampaign.body.id as number;

    for (const [userId, role] of [[playerId, 'player'], [coDmId, 'dm'], [spectatorId, 'player'], [guestDmId, 'player']] as const) {
      const add = await dm.post(`/api/v1/campaigns/${hiddenCampaignId}/members`).send({ userId, role });
      expect(add.status).toBe(201);
    }
    const guestGrant = await dm
      .post(`/api/v1/campaigns/${hiddenCampaignId}/members/grants`)
      .send({ granteeUserId: guestDmId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(guestGrant.status).toBe(201);

    const ownerCharacter = await player
      .post(`/api/v1/campaigns/${hiddenCampaignId}/characters`)
      .send({ name: 'Hidden Hero', hpCurrent: 10, hpMax: 10 });
    expect(ownerCharacter.status).toBe(201);
    const hiddenEncounter = await dm
      .post(`/api/v1/campaigns/${hiddenCampaignId}/encounters`)
      .send({ name: 'Unseen Ambush', hidden: true });
    expect(hiddenEncounter.status).toBe(201);
    // Encounter creation auto-seeds active characters into its roster.
    const hiddenRoster = await dm.get(`/api/v1/encounters/${hiddenEncounter.body.id}`);
    expect(hiddenRoster.status).toBe(200);
    const hiddenCombatant = hiddenRoster.body.combatants.find(
      (combatant: { characterId: number | null }) => combatant.characterId === ownerCharacter.body.id,
    );
    expect(hiddenCombatant).toBeDefined();

    const statusNotifications = async (
      agent: ReturnType<typeof request.agent>,
      title: string,
      expected: number,
      encounterId?: number,
    ) => {
      let matching: Notification[] = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        matching = (await listFor(agent)).filter(
          (notification) =>
            notification.type === 'character_downed' &&
            notification.campaignId === hiddenCampaignId &&
            notification.title === title &&
            (encounterId === undefined || notification.entityId === encounterId),
        );
        if (matching.length === expected) {
          // Notification dispatch is intentionally best-effort and starts after
          // the encounter PATCH. Keep an absence assertion alive long enough to
          // catch a delayed forbidden fan-out, while positive assertions return
          // as soon as their expected row is durable.
          if (expected > 0) return matching;
          await new Promise((resolve) => setTimeout(resolve, 50));
          matching = (await listFor(agent)).filter(
            (notification) =>
              notification.type === 'character_downed' &&
              notification.campaignId === hiddenCampaignId &&
              notification.title === title &&
              (encounterId === undefined || notification.entityId === encounterId),
          );
          if (matching.length === 0) return matching;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for ${expected} ${title} notifications; found ${matching.length}`);
    };

    // #2112: a co-DM demoted after recipient discovery cannot retain the
    // hidden encounter id through the awaited durable notification write.
    const db = ctx.app.get<DrizzleDb>(DB);
    const notifications = ctx.app.get(NotificationsService);
    const guardedNotify = notifications.notifyUserIfHiddenEncounterRecipient.bind(notifications);
    const demoteAtWrite = jest.spyOn(notifications, 'notifyUserIfHiddenEncounterRecipient').mockImplementation(async (...args) => {
      if (args[0] === coDmId && args[4].kind === 'permanent_dm') {
        db.update(campaignMembers)
          .set({ role: 'player' })
          .where(and(eq(campaignMembers.campaignId, hiddenCampaignId), eq(campaignMembers.userId, coDmId)))
          .run();
      }
      return guardedNotify(...args);
    });
    try {
      const downed = await dm
        .patch(`/api/v1/encounters/${hiddenEncounter.body.id}/combatants/${hiddenCombatant.id}`)
        .send({ hpSet: 0 });
      expect(downed.status).toBe(200);
    } finally {
      demoteAtWrite.mockRestore();
    }

    const ownerDowned = await statusNotifications(player, 'Character downed!', 1);
    const coDmDowned = await statusNotifications(coDm, 'Character downed!', 0);
    const guestDmDowned = await statusNotifications(guestDm, 'Character downed!', 0);
    const spectatorDowned = await statusNotifications(spectator, 'Character downed!', 0);
    expect(ownerDowned[0].title).toBe('Character downed!');
    expect(ownerDowned[0].body).toContain('Hidden Hero was downed');
    expect(ownerDowned[0].entityType).toBeNull();
    expect(ownerDowned[0].entityId).toBeNull();
    expect(ownerDowned[0]).not.toHaveProperty('hiddenStatusContext');
    expect(coDmDowned).toEqual([]);
    // A guest/co-DM may inspect the hidden encounter while their grant is active,
    // but no durable status row may survive a later revoke, handback, or expiry.
    expect(guestDmDowned).toEqual([]);
    expect(spectatorDowned).toEqual([]);

    db.update(campaignMembers)
      .set({ role: 'dm' })
      .where(and(eq(campaignMembers.campaignId, hiddenCampaignId), eq(campaignMembers.userId, coDmId)))
      .run();

    const handBack = await guestDm
      .post(`/api/v1/campaigns/${hiddenCampaignId}/members/grants/${guestGrant.body.id}/handback`)
      .send();
    expect(handBack.status).toBe(201);

    const died = await dm
      .patch(`/api/v1/encounters/${hiddenEncounter.body.id}/combatants/${hiddenCombatant.id}`)
      .send({ deathState: 'dead' });
    expect(died.status).toBe(200);

    const ownerDied = await statusNotifications(player, 'Character died!', 1);
    const coDmDied = await statusNotifications(coDm, 'Character died!', 1);
    const guestDmDied = await statusNotifications(guestDm, 'Character died!', 0);
    const spectatorDied = await statusNotifications(spectator, 'Character died!', 0);
    const ownerDeathNotice = ownerDied[0];
    expect(ownerDeathNotice?.body).toContain('Hidden Hero has died');
    expect(ownerDeathNotice?.entityType).toBeNull();
    expect(ownerDeathNotice?.entityId).toBeNull();
    expect(coDmDied.some((notification) => notification.title === 'Character died!' && notification.entityId === hiddenEncounter.body.id)).toBe(true);
    expect(guestDmDied).toEqual([]);
    expect(spectatorDied).toEqual([]);

    // #2112: if a recipient is both a permanent co-DM and the character owner,
    // a demotion at the durable-write boundary must fall back to their still
    // authorized personal-status notification, with no encounter deep-link.
    const dualRoleCharacter = await coDm
      .post(`/api/v1/campaigns/${hiddenCampaignId}/characters`)
      // A DM-created character is otherwise intentionally unowned. Establish
      // the dual DM + current-owner authority this regression covers.
      .send({ name: 'Dual Role Hero', hpCurrent: 10, hpMax: 10, ownerUserId: String(coDmId) });
    expect(dualRoleCharacter.status).toBe(201);
    const dualRoleEncounter = await dm
      .post(`/api/v1/campaigns/${hiddenCampaignId}/encounters`)
      .send({ name: 'Dual Role Ambush', hidden: true });
    expect(dualRoleEncounter.status).toBe(201);
    const dualRoleRoster = await dm.get(`/api/v1/encounters/${dualRoleEncounter.body.id}`);
    const dualRoleCombatant = dualRoleRoster.body.combatants.find(
      (combatant: { characterId: number | null }) => combatant.characterId === dualRoleCharacter.body.id,
    );
    expect(dualRoleCombatant).toBeDefined();

    const demoteDualRoleDmAtWrite = jest.spyOn(notifications, 'notifyUserIfHiddenEncounterRecipient').mockImplementation(async (...args) => {
      if (args[0] === coDmId && args[4].kind === 'permanent_dm') {
        db.update(campaignMembers)
          .set({ role: 'player' })
          .where(and(eq(campaignMembers.campaignId, hiddenCampaignId), eq(campaignMembers.userId, coDmId)))
          .run();
      }
      if (args[0] === coDmId && args[4].kind === 'character_owner') {
        db.update(encounters).set({ hidden: false }).where(eq(encounters.id, dualRoleEncounter.body.id)).run();
      }
      return guardedNotify(...args);
    });
    try {
      const dualRoleDowned = await dm
        .patch(`/api/v1/encounters/${dualRoleEncounter.body.id}/combatants/${dualRoleCombatant.id}`)
        .send({ hpSet: 0 });
      expect(dualRoleDowned.status).toBe(200);
    } finally {
      demoteDualRoleDmAtWrite.mockRestore();
    }

    const dualRoleOwnerDowned = await statusNotifications(coDm, 'Character downed!', 1, dualRoleEncounter.body.id);
    expect(dualRoleOwnerDowned[0].body).toContain('Dual Role Hero was downed');
    expect(dualRoleOwnerDowned[0].entityId).toBe(dualRoleEncounter.body.id);
    expect((await statusNotifications(spectator, 'Character downed!', 1, dualRoleEncounter.body.id))[0].entityId).toBe(dualRoleEncounter.body.id);

    // #2112: ownership may move after the initial recipient snapshot but
    // before the stale owner's guarded write. The former owner is skipped;
    // one bounded refreshed pass must notify the current owner safely.
    const transferredOwnerCharacter = await player
      .post(`/api/v1/campaigns/${hiddenCampaignId}/characters`)
      .send({ name: 'Transferred Owner Hero', hpCurrent: 10, hpMax: 10 });
    expect(transferredOwnerCharacter.status).toBe(201);
    const transferredOwnerEncounter = await dm
      .post(`/api/v1/campaigns/${hiddenCampaignId}/encounters`)
      .send({ name: 'Transferred Owner Ambush', hidden: true });
    expect(transferredOwnerEncounter.status).toBe(201);
    const transferredOwnerRoster = await dm.get(`/api/v1/encounters/${transferredOwnerEncounter.body.id}`);
    const transferredOwnerCombatant = transferredOwnerRoster.body.combatants.find(
      (combatant: { characterId: number | null }) => combatant.characterId === transferredOwnerCharacter.body.id,
    );
    expect(transferredOwnerCombatant).toBeDefined();
    const transferOwnerAtWrite = jest.spyOn(notifications, 'notifyUserIfHiddenEncounterRecipient').mockImplementation(async (...args) => {
      if (args[0] === playerId && args[4].kind === 'character_owner' && args[5] === transferredOwnerEncounter.body.id) {
        db.update(characters)
          .set({ ownerUserId: String(spectatorId) })
          .where(eq(characters.id, transferredOwnerCharacter.body.id))
          .run();
      }
      return guardedNotify(...args);
    });
    try {
      expect((await dm
        .patch(`/api/v1/encounters/${transferredOwnerEncounter.body.id}/combatants/${transferredOwnerCombatant.id}`)
        .send({ hpSet: 0 })).status).toBe(200);
    } finally {
      transferOwnerAtWrite.mockRestore();
    }
    expect((await listFor(player)).find(
      (row) => row.body.includes('Transferred Owner Hero was downed'),
    )).toBeUndefined();
    const transferredOwnerNotice = (await statusNotifications(
      spectator,
      'Character downed!',
      1,
      transferredOwnerEncounter.body.id,
    ))[0];
    expect(transferredOwnerNotice).toMatchObject({ entityType: null, entityId: null });

    db.update(campaignMembers)
      .set({ role: 'dm' })
      .where(and(eq(campaignMembers.campaignId, hiddenCampaignId), eq(campaignMembers.userId, coDmId)))
      .run();

    const visibleCharacter = await player
      .post(`/api/v1/campaigns/${hiddenCampaignId}/characters`)
      .send({ name: 'Visible Hero', hpCurrent: 10, hpMax: 10 });
    expect(visibleCharacter.status).toBe(201);
    const visibleEncounter = await dm
      .post(`/api/v1/campaigns/${hiddenCampaignId}/encounters`)
      .send({ name: 'Open Fight', hidden: false });
    expect(visibleEncounter.status).toBe(201);
    const visibleRoster = await dm.get(`/api/v1/encounters/${visibleEncounter.body.id}`);
    expect(visibleRoster.status).toBe(200);
    const visibleCombatant = visibleRoster.body.combatants.find(
      (combatant: { characterId: number | null }) => combatant.characterId === visibleCharacter.body.id,
    );
    expect(visibleCombatant).toBeDefined();

    const visibleDowned = await dm
      .patch(`/api/v1/encounters/${visibleEncounter.body.id}/combatants/${visibleCombatant.id}`)
      .send({ hpSet: 0 });
    expect(visibleDowned.status).toBe(200);
    const spectatorVisible = await statusNotifications(spectator, 'Character downed!', 1, visibleEncounter.body.id);
    expect(spectatorVisible[0].title).toBe('Character downed!');
    expect(spectatorVisible[0].entityId).toBe(visibleEncounter.body.id);

    // #2112 P1: make the only real interleaving deterministic. The encounter
    // starts visible, recipient resolution begins, then another DM hides it at
    // the campaign-fan-out boundary. The guarded transaction must decline the
    // broad durable write and fall back to the hidden-recipient policy.
    const raceCharacter = await player
      .post(`/api/v1/campaigns/${hiddenCampaignId}/characters`)
      .send({ name: 'Race Hero', hpCurrent: 10, hpMax: 10 });
    expect(raceCharacter.status).toBe(201);
    const raceEncounter = await dm
      .post(`/api/v1/campaigns/${hiddenCampaignId}/encounters`)
      .send({ name: 'Race Window', hidden: false });
    expect(raceEncounter.status).toBe(201);
    const raceRoster = await dm.get(`/api/v1/encounters/${raceEncounter.body.id}`);
    const raceCombatant = raceRoster.body.combatants.find(
      (combatant: { characterId: number | null }) => combatant.characterId === raceCharacter.body.id,
    );
    expect(raceCombatant).toBeDefined();

    const notifyWhenVisible = notifications.notifyCampaignIfEncounterVisible.bind(notifications);
    const hideAtFanout = jest.spyOn(notifications, 'notifyCampaignIfEncounterVisible').mockImplementation(async (...args) => {
      if (args[1] === raceEncounter.body.id) {
        db.update(encounters).set({ hidden: true }).where(eq(encounters.id, raceEncounter.body.id)).run();
      }
      return notifyWhenVisible(...args);
    });
    try {
      const racedDowned = await dm
        .patch(`/api/v1/encounters/${raceEncounter.body.id}/combatants/${raceCombatant.id}`)
        .send({ hpSet: 0 });
      expect(racedDowned.status).toBe(200);
    } finally {
      hideAtFanout.mockRestore();
    }

    const racedStatusNotifications = async (agent: ReturnType<typeof request.agent>, expected: number) => {
      let matching: Notification[] = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        matching = (await listFor(agent)).filter(
          (notification) => notification.type === 'character_downed' && notification.body.includes('Race Hero was downed'),
        );
        if (matching.length === expected) {
          if (expected > 0) return matching;
          await new Promise((resolve) => setTimeout(resolve, 50));
          matching = (await listFor(agent)).filter(
            (notification) => notification.type === 'character_downed' && notification.body.includes('Race Hero was downed'),
          );
          if (matching.length === 0) return matching;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for ${expected} raced hidden-status notifications; found ${matching.length}`);
    };

    const raceOwner = await racedStatusNotifications(player, 1);
    const raceCoDm = await racedStatusNotifications(coDm, 1);
    expect(await racedStatusNotifications(spectator, 0)).toEqual([]);
    expect(raceOwner[0].entityType).toBeNull();
    expect(raceOwner[0].entityId).toBeNull();
    expect(raceCoDm[0].entityId).toBe(raceEncounter.body.id);

    // The inverse transition is also a durable-write race: an initially
    // hidden encounter can be revealed after broad fan-out declines but before
    // the first narrow recipient write. Retry broad delivery once and do not
    // duplicate the recipients that may already have received a narrow row.
    const revealRaceCharacter = await player
      .post(`/api/v1/campaigns/${hiddenCampaignId}/characters`)
      .send({ name: 'Reveal Race Hero', hpCurrent: 10, hpMax: 10 });
    expect(revealRaceCharacter.status).toBe(201);
    const revealRaceEncounter = await dm
      .post(`/api/v1/campaigns/${hiddenCampaignId}/encounters`)
      .send({ name: 'Reveal Race Window', hidden: true });
    expect(revealRaceEncounter.status).toBe(201);
    const revealRaceRoster = await dm.get(`/api/v1/encounters/${revealRaceEncounter.body.id}`);
    const revealRaceCombatant = revealRaceRoster.body.combatants.find(
      (combatant: { characterId: number | null }) => combatant.characterId === revealRaceCharacter.body.id,
    );
    expect(revealRaceCombatant).toBeDefined();
    const revealAtNarrowWrite = jest.spyOn(notifications, 'notifyUserIfHiddenEncounterRecipient').mockImplementation(async (...args) => {
      if (args[5] === revealRaceEncounter.body.id) {
        db.update(encounters).set({ hidden: false }).where(eq(encounters.id, revealRaceEncounter.body.id)).run();
      }
      return guardedNotify(...args);
    });
    try {
      expect((await dm
        .patch(`/api/v1/encounters/${revealRaceEncounter.body.id}/combatants/${revealRaceCombatant.id}`)
        .send({ hpSet: 0 })).status).toBe(200);
    } finally {
      revealAtNarrowWrite.mockRestore();
    }
    const waitForRevealRace = async (agent: ReturnType<typeof request.agent>) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const rows = (await listFor(agent)).filter((row) => row.body.includes('Reveal Race Hero was downed'));
        if (rows.length === 1) return rows[0];
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Timed out waiting for one reveal-race notification');
    };
    expect((await waitForRevealRace(player)).entityId).toBe(revealRaceEncounter.body.id);
    expect((await waitForRevealRace(coDm)).entityId).toBe(revealRaceEncounter.body.id);
    expect((await waitForRevealRace(spectator)).entityId).toBe(revealRaceEncounter.body.id);

    // A muted co-DM produces no narrow durable row, but its suppressed path
    // must still observe a reveal and restart the visible fan-out.
    const suppressedRevealCharacter = await player.post(`/api/v1/campaigns/${hiddenCampaignId}/characters`)
      .send({ name: 'Suppressed Reveal Hero', hpCurrent: 10, hpMax: 10 });
    const suppressedRevealEncounter = await dm.post(`/api/v1/campaigns/${hiddenCampaignId}/encounters`)
      .send({ name: 'Suppressed Reveal Window', hidden: true });
    const suppressedRevealRoster = await dm.get(`/api/v1/encounters/${suppressedRevealEncounter.body.id}`);
    const suppressedRevealCombatant = suppressedRevealRoster.body.combatants.find(
      (combatant: { characterId: number | null }) => combatant.characterId === suppressedRevealCharacter.body.id,
    );
    const coDmMute = await coDm.post(`/api/v1/campaigns/${hiddenCampaignId}/safety/mutes`)
      .send({ entityType: 'encounter', entityId: suppressedRevealEncounter.body.id });
    expect(coDmMute.status).toBe(201);
    const revealAtSuppressedWrite = jest.spyOn(notifications, 'notifyUserIfHiddenEncounterRecipient').mockImplementation(async (...args) => {
      if (args[0] === coDmId && args[5] === suppressedRevealEncounter.body.id) {
        db.update(encounters).set({ hidden: false }).where(eq(encounters.id, suppressedRevealEncounter.body.id)).run();
      }
      return guardedNotify(...args);
    });
    try {
      expect((await dm.patch(`/api/v1/encounters/${suppressedRevealEncounter.body.id}/combatants/${suppressedRevealCombatant.id}`)
        .send({ hpSet: 0 })).status).toBe(200);
    } finally {
      revealAtSuppressedWrite.mockRestore();
    }
    let suppressedRows: Notification[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      suppressedRows = (await listFor(spectator)).filter((row) => row.body.includes('Suppressed Reveal Hero was downed'));
      if (suppressedRows.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(suppressedRows).toHaveLength(1);
    expect(suppressedRows[0].entityId).toBe(suppressedRevealEncounter.body.id);
  });

  it('removes persisted hidden-status rows when a recipient loses DM or owner authority, including before digest delivery (#2112)', async () => {
    const campaign = await dm.post('/api/v1/campaigns').send({ name: 'Hidden Status Read Guard' });
    expect(campaign.status).toBe(201);
    const guardedCampaignId = campaign.body.id as number;
    for (const [userId, role] of [[playerId, 'player'], [coDmId, 'dm'], [spectatorId, 'player']] as const) {
      expect((await dm.post(`/api/v1/campaigns/${guardedCampaignId}/members`).send({ userId, role })).status).toBe(201);
    }
    // A second campaign gives the PAT regression a real campaign binding to
    // enforce; the co-DM must not read this campaign's private rows through it.
    expect((await dm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: coDmId, role: 'dm' })).status).toBe(201);

    const db = ctx.app.get<DrizzleDb>(DB);
    const notifications = ctx.app.get(NotificationsService);
    const waitForStoredRow = async (userId: number, body: string, deferred = false) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const rows = deferred
          ? db.select().from(notificationDigestQueue).where(and(eq(notificationDigestQueue.userId, userId), eq(notificationDigestQueue.campaignId, guardedCampaignId))).all()
          : db.select().from(notificationRows).where(and(eq(notificationRows.userId, userId), eq(notificationRows.campaignId, guardedCampaignId))).all();
        if (rows.some((row) => row.body.includes(body))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for ${deferred ? 'deferred' : 'immediate'} hidden-status row: ${body}`);
    };
    const createHiddenCombatant = async (name: string, hidden = true, owner = player) => {
      const character = await owner
        .post(`/api/v1/campaigns/${guardedCampaignId}/characters`)
        // DMs may create unowned characters; this helper's explicit `owner`
        // argument must still produce an owned character when exercising the
        // dual-role read and delivery paths.
        .send({ name, hpCurrent: 10, hpMax: 10, ...(owner === coDm ? { ownerUserId: String(coDmId) } : {}) });
      expect(character.status).toBe(201);
      const encounter = await dm
        .post(`/api/v1/campaigns/${guardedCampaignId}/encounters`)
        .send({ name: `${name} Encounter`, hidden });
      expect(encounter.status).toBe(201);
      const roster = await dm.get(`/api/v1/encounters/${encounter.body.id}`);
      const combatant = roster.body.combatants.find(
        (row: { characterId: number | null }) => row.characterId === character.body.id,
      );
      expect(combatant).toBeDefined();
      return { character, encounter, combatant };
    };

    const demoted = await createHiddenCombatant('Demotion Read Hero');
    expect((await dm
      .patch(`/api/v1/encounters/${demoted.encounter.body.id}/combatants/${demoted.combatant.id}`)
      .send({ hpSet: 0 })).status).toBe(200);
    await waitForStoredRow(coDmId, 'Demotion Read Hero was downed');
    const demotionRow = db.select().from(notificationRows).where(and(
      eq(notificationRows.userId, coDmId),
      eq(notificationRows.campaignId, guardedCampaignId),
      sql`${notificationRows.body} like ${'%Demotion Read Hero was downed%'}`,
    )).get();
    expect(demotionRow).toBeDefined();
    db.update(campaignMembers)
      .set({ role: 'player' })
      .where(and(eq(campaignMembers.campaignId, guardedCampaignId), eq(campaignMembers.userId, coDmId)))
      .run();
    // The same transaction that authorizes the row also performs the mark, so
    // a demotion cannot slip between a prior cleanup pass and this mutation.
    expect((await coDm.post(`/api/v1/notifications/${demotionRow!.id}/read`).send()).status).toBe(404);
    expect((await listFor(coDm)).some((row) => row.body.includes('Demotion Read Hero was downed'))).toBe(false);
    expect(db.select().from(notificationRows).where(and(eq(notificationRows.userId, coDmId), eq(notificationRows.campaignId, guardedCampaignId))).all()
      .some((row) => row.body.includes('Demotion Read Hero was downed'))).toBe(false);

    db.update(campaignMembers)
      .set({ role: 'dm' })
      .where(and(eq(campaignMembers.campaignId, guardedCampaignId), eq(campaignMembers.userId, coDmId)))
      .run();

    // A recipient who is both the permanent DM and affected-character owner
    // loses the full DM projection on demotion, but keeps the owner-safe row.
    const dualRole = await createHiddenCombatant('Dual Role Read Hero', true, coDm);
    expect((await dm
      .patch(`/api/v1/encounters/${dualRole.encounter.body.id}/combatants/${dualRole.combatant.id}`)
      .send({ hpSet: 0 })).status).toBe(200);
    await waitForStoredRow(coDmId, 'Dual Role Read Hero was downed');
    db.update(campaignMembers)
      .set({ role: 'player' })
      .where(and(eq(campaignMembers.campaignId, guardedCampaignId), eq(campaignMembers.userId, coDmId)))
      .run();
    const dualRoleAfterDemotion = (await listFor(coDm)).find((row) => row.body.includes('Dual Role Read Hero was downed'));
    expect(dualRoleAfterDemotion).toMatchObject({ entityType: null, entityId: null });
    const dualRoleRow = db.select().from(notificationRows).where(and(
      eq(notificationRows.userId, coDmId),
      eq(notificationRows.campaignId, guardedCampaignId),
      sql`${notificationRows.body} like ${'%Dual Role Read Hero was downed%'}`,
    )).get();
    expect(dualRoleRow).toMatchObject({ entityType: null, entityId: null, data: null });
    db.update(campaignMembers)
      .set({ role: 'dm' })
      .where(and(eq(campaignMembers.campaignId, guardedCampaignId), eq(campaignMembers.userId, coDmId)))
      .run();

    const server = ctx.app.getHttpServer();
    const viewerToken = await coDm.post('/api/v1/tokens').send({
      name: 'hidden-status-viewer-read',
      scope: 'viewer',
      writeScope: 'none',
      campaignId: guardedCampaignId,
    });
    expect(viewerToken.status).toBe(201);
    const viewerScoped = await createHiddenCombatant('Viewer PAT Read Hero');
    expect((await dm
      .patch(`/api/v1/encounters/${viewerScoped.encounter.body.id}/combatants/${viewerScoped.combatant.id}`)
      .send({ hpSet: 0 })).status).toBe(200);
    await waitForStoredRow(coDmId, 'Viewer PAT Read Hero was downed');
    const viewerRead = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${viewerToken.body.token}`);
    expect(viewerRead.status).toBe(200);
    expect((viewerRead.body.items ?? viewerRead.body).some((row: Notification) => row.body.includes('Viewer PAT Read Hero was downed'))).toBe(false);
    expect(db.select().from(notificationRows).where(and(eq(notificationRows.userId, coDmId), eq(notificationRows.campaignId, guardedCampaignId))).all()
      .some((row) => row.body.includes('Viewer PAT Read Hero was downed'))).toBe(true);
    expect((await listFor(coDm)).some((row) => row.body.includes('Viewer PAT Read Hero was downed'))).toBe(true);

    // A same-campaign PAT capped below DM remains entitled to the affected
    // character's owner-safe status projection, without rewriting the durable
    // full-DM row that the ordinary session may still read.
    const scopedOwner = await createHiddenCombatant('Scoped Owner PAT Hero', true, coDm);
    expect((await dm
      .patch(`/api/v1/encounters/${scopedOwner.encounter.body.id}/combatants/${scopedOwner.combatant.id}`)
      .send({ hpSet: 0 })).status).toBe(200);
    await waitForStoredRow(coDmId, 'Scoped Owner PAT Hero was downed');
    const scopedOwnerRead = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${viewerToken.body.token}`);
    expect(scopedOwnerRead.status).toBe(200);
    expect((scopedOwnerRead.body.items ?? scopedOwnerRead.body).find(
      (row: Notification) => row.body.includes('Scoped Owner PAT Hero was downed'),
    )).toMatchObject({ entityType: null, entityId: null });
    const scopedOwnerRow = db.select().from(notificationRows).where(and(
      eq(notificationRows.userId, coDmId),
      eq(notificationRows.campaignId, guardedCampaignId),
      sql`${notificationRows.body} like ${'%Scoped Owner PAT Hero was downed%'}`,
    )).get();
    expect(scopedOwnerRow).toMatchObject({ entityType: 'encounter', entityId: scopedOwner.encounter.body.id });
    expect((await listFor(coDm)).find((row) => row.body.includes('Scoped Owner PAT Hero was downed')))
      .toMatchObject({ entityType: 'encounter', entityId: scopedOwner.encounter.body.id });

    const boundToken = await coDm.post('/api/v1/tokens').send({
      name: 'hidden-status-bound-read',
      scope: 'dm',
      writeScope: 'none',
      campaignId,
    });
    expect(boundToken.status).toBe(201);
    const boundScoped = await createHiddenCombatant('Bound PAT Read Hero');
    expect((await dm
      .patch(`/api/v1/encounters/${boundScoped.encounter.body.id}/combatants/${boundScoped.combatant.id}`)
      .send({ hpSet: 0 })).status).toBe(200);
    await waitForStoredRow(coDmId, 'Bound PAT Read Hero was downed');
    const boundRead = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${boundToken.body.token}`);
    expect(boundRead.status).toBe(200);
    expect((boundRead.body.items ?? boundRead.body).some((row: Notification) => row.body.includes('Bound PAT Read Hero was downed'))).toBe(false);
    expect(db.select().from(notificationRows).where(and(eq(notificationRows.userId, coDmId), eq(notificationRows.campaignId, guardedCampaignId))).all()
      .some((row) => row.body.includes('Bound PAT Read Hero was downed'))).toBe(true);
    expect((await listFor(coDm)).some((row) => row.body.includes('Bound PAT Read Hero was downed'))).toBe(true);

    // A scope-capped request may retain more private rows than SQLite accepts
    // in a single `NOT IN` predicate. Its request-only filtering must neither
    // expose nor delete those rows; a later loss of durable authority must
    // purge the same oversized set without exceeding SQLite's bind limit.
    const sqliteVariableLimitRows = 32_767;
    const sqliteGuardTitle = 'SQLite guarded notification';
    const scopedVisibleRows = db.insert(notificationRows).values([
      {
        userId: coDmId,
        campaignId: guardedCampaignId,
        type: 'quest_updated',
        title: 'Scoped visible notification one',
        body: 'Visible to the scoped PAT',
        entityType: null,
        entityId: null,
        commentId: null,
        data: null,
        hiddenStatusContext: null,
        actorName: '',
        actorUserId: null,
        readAt: null,
        createdAt: new Date().toISOString(),
      },
      {
        userId: coDmId,
        campaignId: guardedCampaignId,
        type: 'quest_updated',
        title: 'Scoped visible notification two',
        body: 'Also visible to the scoped PAT',
        entityType: null,
        entityId: null,
        commentId: null,
        data: null,
        hiddenStatusContext: null,
        actorName: '',
        actorUserId: null,
        readAt: null,
        createdAt: new Date().toISOString(),
      },
    ]).returning().all();
    const sqliteGuardContext = JSON.stringify({
      encounterId: demoted.encounter.body.id,
      characterId: demoted.character.body.id,
      audience: 'permanent_dm',
    });
    const sqliteGuardCreatedAt = new Date().toISOString();
    for (let start = 0; start < sqliteVariableLimitRows; start += 500) {
      const rows = Array.from({ length: Math.min(500, sqliteVariableLimitRows - start) }, () => ({
        userId: coDmId,
        campaignId: guardedCampaignId,
        type: 'quest_updated',
        title: sqliteGuardTitle,
        body: 'SQLite guarded notification body',
        entityType: 'encounter',
        entityId: demoted.encounter.body.id,
        commentId: null,
        data: null,
        hiddenStatusContext: sqliteGuardContext,
        actorName: '',
        actorUserId: null,
        readAt: null,
        createdAt: sqliteGuardCreatedAt,
      }));
      db.insert(notificationRows).values(rows).run();
    }
    const scopedGuardUser: RequestUser = {
      id: String(coDmId),
      name: 'Co-DM',
      serverRole: 'user',
      tokenContext: {
        tokenId: 0,
        name: 'hidden-status-viewer-read',
        scope: 'viewer',
        writeScope: 'none',
        campaignId: guardedCampaignId,
        adminEnabled: false,
      },
    };
    const scopedGuardRead = await notifications.listForUser(scopedGuardUser, {
      campaignId: guardedCampaignId,
      type: 'quest_updated',
      limit: 1,
    });
    expect(scopedGuardRead.items.some((row) => row.title === sqliteGuardTitle)).toBe(false);
    expect(scopedGuardRead).toMatchObject({ total: 2, hasMore: true });
    expect(scopedGuardRead.items).toHaveLength(1);
    expect(scopedGuardRead.items[0].id).toBe(scopedVisibleRows[1].id);
    const scopedGuardSecondPage = await notifications.listForUser(scopedGuardUser, {
      campaignId: guardedCampaignId,
      type: 'quest_updated',
      limit: 1,
      cursor: scopedGuardRead.nextCursor!,
    });
    expect(scopedGuardSecondPage).toMatchObject({ total: 2, hasMore: false });
    expect(scopedGuardSecondPage.items.map((row) => row.id)).toEqual([scopedVisibleRows[0].id]);
    const boundedPatPoll = instrumentSql(ctx);
    try {
      await notifications.unreadSummary(scopedGuardUser);
    } finally {
      boundedPatPoll.restore();
    }
    const notificationScans = boundedPatPoll.executed.filter((source) => /from\s+["`]notifications["`]/i.test(source));
    expect(notificationScans.length).toBeGreaterThan(2);
    expect(notificationScans.every((source) => /limit\s+\?/i.test(source))).toBe(true);
    const scopedBulkRead = await notifications.markReadBulk(scopedGuardUser, { campaignId: guardedCampaignId, all: true });
    expect(scopedBulkRead.updatedIds).toEqual(expect.arrayContaining(scopedVisibleRows.map((row) => row.id)));
    expect(db.select().from(notificationRows).where(eq(notificationRows.title, sqliteGuardTitle)).all().every((row) => row.readAt === null)).toBe(true);
    const scopedBulkUnread = await notifications.markUnreadBulk(scopedGuardUser, { ids: scopedVisibleRows.map((row) => row.id) });
    expect(scopedBulkUnread.updatedIds).toEqual(expect.arrayContaining(scopedVisibleRows.map((row) => row.id)));
    expect(db.select({ value: sql<number>`count(*)` }).from(notificationRows).where(and(
      eq(notificationRows.userId, coDmId),
      eq(notificationRows.campaignId, guardedCampaignId),
      eq(notificationRows.title, sqliteGuardTitle),
    )).get()?.value).toBe(sqliteVariableLimitRows);
    db.update(campaignMembers)
      .set({ role: 'player' })
      .where(and(eq(campaignMembers.campaignId, guardedCampaignId), eq(campaignMembers.userId, coDmId)))
      .run();
    await notifications.unreadSummary({ id: String(coDmId), name: 'Co-DM', serverRole: 'user' });
    expect(db.select({ value: sql<number>`count(*)` }).from(notificationRows).where(and(
      eq(notificationRows.userId, coDmId),
      eq(notificationRows.campaignId, guardedCampaignId),
      eq(notificationRows.title, sqliteGuardTitle),
    )).get()?.value).toBe(0);
    db.update(campaignMembers)
      .set({ role: 'dm' })
      .where(and(eq(campaignMembers.campaignId, guardedCampaignId), eq(campaignMembers.userId, coDmId)))
      .run();

    // Context preloads use their own ID lists. Distinct, nonexistent entity
    // references make the guard deny these rows after exercising both the
    // encounter and character lookup batches without creating 32,767 entities.
    const sqlitePreloadTitle = 'SQLite preload notification';
    for (let start = 0; start < sqliteVariableLimitRows; start += 500) {
      const rows = Array.from({ length: Math.min(500, sqliteVariableLimitRows - start) }, (_, offset) => {
        const id = start + offset + 1;
        return {
          userId: coDmId,
          campaignId: guardedCampaignId,
          type: 'character_downed',
          title: sqlitePreloadTitle,
          body: 'SQLite preload notification body',
          entityType: 'encounter',
          entityId: 1_000_000 + id,
          commentId: null,
          data: null,
          hiddenStatusContext: JSON.stringify({
            encounterId: 1_000_000 + id,
            characterId: 2_000_000 + id,
            audience: 'permanent_dm',
          }),
          actorName: '',
          actorUserId: null,
          readAt: null,
          createdAt: sqliteGuardCreatedAt,
        };
      });
      db.insert(notificationRows).values(rows).run();
    }
    await notifications.unreadSummary({ id: String(coDmId), name: 'Co-DM', serverRole: 'user' });
    expect(db.select({ value: sql<number>`count(*)` }).from(notificationRows).where(and(
      eq(notificationRows.userId, coDmId),
      eq(notificationRows.campaignId, guardedCampaignId),
      eq(notificationRows.title, sqlitePreloadTitle),
    )).get()?.value).toBe(0);

    // The membership preload has a separate campaign-ID predicate. Distinct
    // campaigns with no seats exercise that path before the guard denies and
    // removes the rows without needing a matching encounter or character.
    const sqliteCampaignPreloadTitle = 'SQLite campaign preload notification';
    for (let start = 0; start < sqliteVariableLimitRows; start += 500) {
      const campaignRows = Array.from({ length: Math.min(500, sqliteVariableLimitRows - start) }, (_, offset) => {
        const id = 3_000_000 + start + offset + 1;
        return { id, name: `SQLite preload campaign ${id}`, createdAt: sqliteGuardCreatedAt, updatedAt: sqliteGuardCreatedAt };
      });
      db.insert(campaigns).values(campaignRows).run();
      db.insert(notificationRows).values(campaignRows.map((campaign) => ({
        userId: coDmId,
        campaignId: campaign.id,
        type: 'character_downed',
        title: sqliteCampaignPreloadTitle,
        body: 'SQLite campaign preload notification body',
        entityType: 'encounter',
        entityId: demoted.encounter.body.id,
        commentId: null,
        data: null,
        hiddenStatusContext: sqliteGuardContext,
        actorName: '',
        actorUserId: null,
        readAt: null,
        createdAt: sqliteGuardCreatedAt,
      }))).run();
    }
    await notifications.unreadSummary({ id: String(coDmId), name: 'Co-DM', serverRole: 'user' });
    expect(db.select({ value: sql<number>`count(*)` }).from(notificationRows).where(eq(
      notificationRows.title,
      sqliteCampaignPreloadTitle,
    )).get()?.value).toBe(0);

    expect((await coDm.put(`/api/v1/notifications/preferences/${guardedCampaignId}`).send({ categories: { live_play: 'digest' } })).status).toBe(200);
    const visibleThenHidden = await createHiddenCombatant('Visible Then Hidden Hero', false);
    expect((await dm
      .patch(`/api/v1/encounters/${visibleThenHidden.encounter.body.id}/combatants/${visibleThenHidden.combatant.id}`)
      .send({ hpSet: 0 })).status).toBe(200);
    await waitForStoredRow(playerId, 'Visible Then Hidden Hero was downed');
    await waitForStoredRow(spectatorId, 'Visible Then Hidden Hero was downed');
    await waitForStoredRow(coDmId, 'Visible Then Hidden Hero was downed', true);
    db.update(encounters).set({ hidden: true }).where(eq(encounters.id, visibleThenHidden.encounter.body.id)).run();

    const ownerAfterHide = (await listFor(player)).find((row) => row.body.includes('Visible Then Hidden Hero was downed'));
    expect(ownerAfterHide).toMatchObject({ entityType: null, entityId: null });
    expect((await listFor(spectator)).some((row) => row.body.includes('Visible Then Hidden Hero was downed'))).toBe(false);
    expect(db.select().from(notificationRows).where(and(eq(notificationRows.userId, spectatorId), eq(notificationRows.campaignId, guardedCampaignId))).all()
      .some((row) => row.body.includes('Visible Then Hidden Hero was downed'))).toBe(false);
    await notifications.flushDigests();
    const dmAfterHide = (await listFor(coDm)).find((row) => row.body.includes('Visible Then Hidden Hero was downed'));
    expect(dmAfterHide).toMatchObject({ entityType: 'encounter', entityId: visibleThenHidden.encounter.body.id });

    // A visible-fan-out row retains the campaign-member audience. Once the
    // encounter is hidden, a same-campaign viewer PAT for the co-DM who owns
    // the character receives only the transient owner-safe projection.
    expect((await coDm.put(`/api/v1/notifications/preferences/${guardedCampaignId}`).send({ categories: { live_play: 'immediate' } })).status).toBe(200);
    const scopedVisibleOwner = await createHiddenCombatant('Scoped Visible Owner PAT Hero', false, coDm);
    expect((await dm
      .patch(`/api/v1/encounters/${scopedVisibleOwner.encounter.body.id}/combatants/${scopedVisibleOwner.combatant.id}`)
      .send({ hpSet: 0 })).status).toBe(200);
    await waitForStoredRow(coDmId, 'Scoped Visible Owner PAT Hero was downed');
    db.update(encounters).set({ hidden: true }).where(eq(encounters.id, scopedVisibleOwner.encounter.body.id)).run();
    const scopedVisibleOwnerRead = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${viewerToken.body.token}`);
    expect(scopedVisibleOwnerRead.status).toBe(200);
    expect((scopedVisibleOwnerRead.body.items ?? scopedVisibleOwnerRead.body).find(
      (row: Notification) => row.body.includes('Scoped Visible Owner PAT Hero was downed'),
    )).toMatchObject({ entityType: null, entityId: null });
    const scopedVisibleOwnerRow = db.select().from(notificationRows).where(and(
      eq(notificationRows.userId, coDmId),
      eq(notificationRows.campaignId, guardedCampaignId),
      sql`${notificationRows.body} like ${'%Scoped Visible Owner PAT Hero was downed%'}`,
    )).get();
    expect(scopedVisibleOwnerRow).toMatchObject({
      entityType: 'encounter',
      entityId: scopedVisibleOwner.encounter.body.id,
    });

    // If a visible encounter is hidden at the durable fan-out boundary, the
    // owner-safe fallback must still respect the recipient's existing mute of
    // that encounter even though its public payload has no entity identity.
    const mutedOwner = await createHiddenCombatant('Muted Owner Fallback Hero', false, coDm);
    const mute = await coDm
      .post(`/api/v1/campaigns/${guardedCampaignId}/safety/mutes`)
      .send({ entityType: 'encounter', entityId: mutedOwner.encounter.body.id });
    expect(mute.status).toBe(201);
    const notifyMutedWhenVisible = notifications.notifyCampaignIfEncounterVisible.bind(notifications);
    const hideMutedAtFanout = jest.spyOn(notifications, 'notifyCampaignIfEncounterVisible').mockImplementation(async (...args) => {
      if (args[1] === mutedOwner.encounter.body.id) {
        db.update(encounters).set({ hidden: true }).where(eq(encounters.id, mutedOwner.encounter.body.id)).run();
      }
      return notifyMutedWhenVisible(...args);
    });
    try {
      expect((await dm
        .patch(`/api/v1/encounters/${mutedOwner.encounter.body.id}/combatants/${mutedOwner.combatant.id}`)
        .send({ hpSet: 0 })).status).toBe(200);
    } finally {
      hideMutedAtFanout.mockRestore();
    }
    expect((await listFor(coDm)).some((row) => row.body.includes('Muted Owner Fallback Hero was downed'))).toBe(false);
    expect((await coDm.delete(`/api/v1/campaigns/${guardedCampaignId}/safety/controls/${mute.body.id}`)).status).toBe(200);

    // Bell polling must not re-run membership, encounter, and ownership
    // lookups for every retained hidden-status row. Several rows now exercise
    // the guard, yet each authorization table is prepared exactly once.
    const retainedHiddenRows = db.select().from(notificationRows).where(and(
      eq(notificationRows.userId, coDmId),
      eq(notificationRows.campaignId, guardedCampaignId),
    )).all().filter((row) => row.hiddenStatusContext !== null);
    expect(retainedHiddenRows.length).toBeGreaterThan(1);
    const queryProbe = instrumentSql(ctx);
    try {
      const scopedOwnerUser: RequestUser = {
        id: String(coDmId),
        name: 'Co-DM',
        serverRole: 'user',
        tokenContext: {
          tokenId: 0,
          name: 'hidden-status-viewer-read',
          scope: 'viewer',
          writeScope: 'none',
          campaignId: guardedCampaignId,
          adminEnabled: false,
        },
      };
      expect((await notifications.unreadSummary(scopedOwnerUser)).count).toBeGreaterThan(0);
    } finally {
      queryProbe.restore();
    }
    for (const table of ['campaign_members', 'encounters', 'characters']) {
      expect(queryProbe.executed.filter((source) => new RegExp(`from\\s+["\`]${table}["\`]`, 'i').test(source))).toHaveLength(1);
    }
    expect((await coDm.put(`/api/v1/notifications/preferences/${guardedCampaignId}`).send({ categories: { live_play: 'digest' } })).status).toBe(200);

    const removed = await createHiddenCombatant('Removal Digest Hero');
    expect((await dm
      .patch(`/api/v1/encounters/${removed.encounter.body.id}/combatants/${removed.combatant.id}`)
      .send({ hpSet: 0 })).status).toBe(200);
    await waitForStoredRow(coDmId, 'Removal Digest Hero was downed', true);
    db.delete(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, guardedCampaignId), eq(campaignMembers.userId, coDmId)))
      .run();
    await notifications.flushDigests();
    expect((await listFor(coDm)).some((row) => row.body.includes('Removal Digest Hero was downed'))).toBe(false);
    expect(db.select().from(notificationDigestQueue).where(and(eq(notificationDigestQueue.userId, coDmId), eq(notificationDigestQueue.campaignId, guardedCampaignId))).all()
      .some((row) => row.body.includes('Removal Digest Hero was downed'))).toBe(false);

    const transferred = await createHiddenCombatant('Ownership Transfer Hero');
    expect((await dm
      .patch(`/api/v1/encounters/${transferred.encounter.body.id}/combatants/${transferred.combatant.id}`)
      .send({ hpSet: 0 })).status).toBe(200);
    await waitForStoredRow(playerId, 'Ownership Transfer Hero was downed');
    const transferRow = db.select().from(notificationRows).where(and(
      eq(notificationRows.userId, playerId),
      eq(notificationRows.campaignId, guardedCampaignId),
      sql`${notificationRows.body} like ${'%Ownership Transfer Hero was downed%'}`,
    )).get();
    expect(transferRow).toBeDefined();
    db.update(characters)
      .set({ ownerUserId: String(spectatorId) })
      .where(and(eq(characters.id, transferred.character.body.id), eq(characters.campaignId, guardedCampaignId)))
      .run();
    // Ownership transfer is guarded at the same mark/read boundary as a
    // membership demotion; the old owner cannot mutate or observe the row.
    expect((await player.post(`/api/v1/notifications/${transferRow!.id}/read`).send()).status).toBe(404);
    expect((await listFor(player)).some((row) => row.body.includes('Ownership Transfer Hero was downed'))).toBe(false);
    expect(db.select().from(notificationRows).where(and(eq(notificationRows.userId, playerId), eq(notificationRows.campaignId, guardedCampaignId))).all()
      .some((row) => row.body.includes('Ownership Transfer Hero was downed'))).toBe(false);
  });

  it('sharing a note with the party notifies the party (not the author)', async () => {
    const res = await player
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'The bridge is trapped, everyone.', visibility: 'party_shared' });
    expect(res.status).toBe(201);

    const dmShared = ofType(await listFor(dm), 'note_shared').filter((n) => n.body.includes('bridge is trapped'));
    expect(dmShared).toHaveLength(1);
    expect(dmShared[0].title).toContain('shared a note with the party');
    expect(dmShared[0].actorName).toBe('Pat Player');
    // The author gets nothing from their own party share.
    expect(ofType(await listFor(player), 'note_shared').filter((n) => n.body.includes('bridge is trapped'))).toHaveLength(0);
  });

  it('submitting a proposal notifies the DM; approving it notifies the proposer', async () => {
    // Player proposes a new quest (?proposed=true) — the DM is pinged.
    const propose = await player
      .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
      .send({ title: 'A player-pitched quest' });
    expect(propose.status).toBe(202);
    const proposalId = propose.body.proposal.id;

    const submitted = ofType(await listFor(dm), 'proposal_submitted');
    expect(submitted.length).toBeGreaterThanOrEqual(1);
    expect(submitted[0].title).toContain('Pat Player');
    expect(submitted[0].title).toContain('quest');
    // The proposing player is not notified of their own submission.
    expect(ofType(await listFor(player), 'proposal_submitted')).toHaveLength(0);

    // DM approves -> the proposer is told the verdict.
    const approve = await dm.post(`/api/v1/proposals/${proposalId}/approve`).send({ note: 'love it' });
    expect(approve.status).toBe(201);

    const resolved = ofType(await listFor(player), 'proposal_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].title).toContain('approved');
    expect(resolved[0].body).toContain('love it');
    expect(resolved[0].actorName).toBe('Dana DM');
    // The approving DM does not notify themselves.
    expect(ofType(await listFor(dm), 'proposal_resolved')).toHaveLength(0);
  });

  it('rejecting a proposal notifies the proposer', async () => {
    const propose = await player
      .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
      .send({ title: 'A doomed pitch' });
    expect(propose.status).toBe(202);

    const before = ofType(await listFor(player), 'proposal_resolved').length;
    const reject = await dm.post(`/api/v1/proposals/${propose.body.proposal.id}/reject`).send({ note: 'not this time' });
    expect(reject.status).toBe(201);

    const resolved = ofType(await listFor(player), 'proposal_resolved');
    expect(resolved.length).toBe(before + 1);
    expect(resolved[0].title).toContain('rejected');
    expect(resolved[0].body).toContain('not this time');
  });
});

/**
 * Issue #832: posting to the DM scribe inbox notifies every current DM except the
 * author. Real cookie sessions — notifications hang off users.id.
 */
describe('inbox submission notifies DMs (issue #832, e2e)', () => {
  let ctx: TestAppContext;
  let creatorDm: ReturnType<typeof request.agent>;
  let coDm: ReturnType<typeof request.agent>;
  let coDmId: number;
  let player: ReturnType<typeof request.agent>;
  let campaignId: number;

  type Notification = {
    id: number;
    type: string;
    title: string;
    body: string;
    entityType: string | null;
    entityId: number | null;
    actorName: string;
    readAt: string | null;
  };

  async function listFor(agent: ReturnType<typeof request.agent>): Promise<Notification[]> {
    const res = await agent.get('/api/v1/notifications');
    expect(res.status).toBe(200);
    return Array.isArray(res.body) ? res.body : (res.body.items ?? res.body);
  }

  const ofType = (rows: Notification[], type: string) => rows.filter((n) => n.type === type);

  /** Inbox create fans out inbox_submitted off the request path; let that settle before asserts. */
  const settleInboxNotify = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'inbox832-admin', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'inbox832-dm', password: 'password-dm-1', displayName: 'Creator DM' });
    const coCreate = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'inbox832-co-dm', password: 'password-co-1', displayName: 'Co DM' });
    coDmId = coCreate.body.id;
    await adminAgent.post('/api/v1/users').send({ username: 'inbox832-player', password: 'password-pl-1', displayName: 'Pat Player' });

    creatorDm = request.agent(server);
    await creatorDm.post('/api/v1/auth/login').send({ username: 'inbox832-dm', password: 'password-dm-1' });
    coDm = request.agent(server);
    await coDm.post('/api/v1/auth/login').send({ username: 'inbox832-co-dm', password: 'password-co-1' });
    player = request.agent(server);
    await player.post('/api/v1/auth/login').send({ username: 'inbox832-player', password: 'password-pl-1' });

    const campaign = await creatorDm.post('/api/v1/campaigns').send({ name: 'Inbox Notify Keep' });
    campaignId = campaign.body.id;
    const playerMe = await player.get('/api/v1/me');
    await creatorDm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerMe.body.user.id, role: 'player' });
    await creatorDm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: coDmId, role: 'dm' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a player inbox post notifies every DM with a deep-link id; the player gets nothing', async () => {
    const inbox = await player
      .post(`/api/v1/campaigns/${campaignId}/inbox`)
      .send({ body: 'Can we explore the catacombs next session?' });
    expect(inbox.status).toBe(201);
    const inboxId = inbox.body.id as number;
    await settleInboxNotify();

    const creatorNotifs = ofType(await listFor(creatorDm), 'inbox_submitted');
    expect(creatorNotifs).toHaveLength(1);
    expect(creatorNotifs[0].title).toContain('Pat Player');
    expect(creatorNotifs[0].body).toContain('catacombs');
    expect(creatorNotifs[0].entityId).toBe(inboxId);
    expect(creatorNotifs[0].actorName).toBe('Pat Player');
    expect(creatorNotifs[0].readAt).toBeNull();

    const coNotifs = ofType(await listFor(coDm), 'inbox_submitted');
    expect(coNotifs).toHaveLength(1);
    expect(coNotifs[0].entityId).toBe(inboxId);

    expect(ofType(await listFor(player), 'inbox_submitted')).toHaveLength(0);
  });

  it('a DM author posting to their own inbox does not notify themselves', async () => {
    const beforeCreator = ofType(await listFor(creatorDm), 'inbox_submitted').length;
    const beforeCo = ofType(await listFor(coDm), 'inbox_submitted').length;

    const inbox = await creatorDm.post(`/api/v1/campaigns/${campaignId}/inbox`).send({ body: 'DM self-capture' });
    expect(inbox.status).toBe(201);
    await settleInboxNotify();

    expect(ofType(await listFor(creatorDm), 'inbox_submitted')).toHaveLength(beforeCreator);
    expect(ofType(await listFor(coDm), 'inbox_submitted')).toHaveLength(beforeCo + 1);
    const coNotifs = ofType(await listFor(coDm), 'inbox_submitted');
    const selfCapture = coNotifs.find((n) => n.body.includes('DM self-capture'));
    expect(selfCapture).toBeDefined();
    expect(selfCapture!.title).toContain('Creator DM');
  });

  it('a campaign with no other DMs still succeeds without notifying anyone when the sole DM is the author', async () => {
    const lone = await creatorDm.post('/api/v1/campaigns').send({ name: 'Solo DM Inbox' });
    expect(lone.status).toBe(201);
    const loneId = lone.body.id as number;

    const before = ofType(await listFor(creatorDm), 'inbox_submitted').length;
    const post = await creatorDm.post(`/api/v1/campaigns/${loneId}/inbox`).send({ body: 'Solo note' });
    expect(post.status).toBe(201);
    await settleInboxNotify();
    expect(ofType(await listFor(creatorDm), 'inbox_submitted')).toHaveLength(before);
  });

  it('keeps inbox create durable when inbox_submitted notification delivery fails', async () => {
    const db = ctx.app.get<DrizzleDb>(DB);
    await db.run(sql`
      CREATE TRIGGER fail_inbox_submitted_notification
      BEFORE INSERT ON notifications
      WHEN NEW.type = 'inbox_submitted'
      BEGIN
        SELECT RAISE(ABORT, 'simulated notification failure');
      END
    `);
    try {
      const beforeCo = ofType(await listFor(coDm), 'inbox_submitted').length;
      const inbox = await player
        .post(`/api/v1/campaigns/${campaignId}/inbox`)
        .send({ body: 'Notify failure must not block inbox create' });
      expect(inbox.status).toBe(201);
      expect(inbox.body.body).toContain('Notify failure');
      await settleInboxNotify();
      expect(ofType(await listFor(coDm), 'inbox_submitted')).toHaveLength(beforeCo);
    } finally {
      await db.run(sql`DROP TRIGGER IF EXISTS fail_inbox_submitted_notification`);
    }
  });
});

describe('Issue #550: notification pagination, filtering, bulk operations & undo (e2e)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>;
  let player: ReturnType<typeof request.agent>;
  let playerId: number;
  let campaign1Id: number;
  let campaign2Id: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'p550-admin', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'p550-dm', password: 'password-dm-1', displayName: 'DM 550' });
    const createPlayer = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'p550-player', password: 'password-pl-1', displayName: 'Player 550' });
    playerId = createPlayer.body.id;

    dm = request.agent(server);
    await dm.post('/api/v1/auth/login').send({ username: 'p550-dm', password: 'password-dm-1' });
    player = request.agent(server);
    await player.post('/api/v1/auth/login').send({ username: 'p550-player', password: 'password-pl-1' });

    const c1 = await dm.post('/api/v1/campaigns').send({ name: 'Campaign Alpha' });
    campaign1Id = c1.body.id;
    await dm.post(`/api/v1/campaigns/${campaign1Id}/members`).send({ userId: playerId, role: 'player' });

    const c2 = await dm.post('/api/v1/campaigns').send({ name: 'Campaign Beta' });
    campaign2Id = c2.body.id;
    await dm.post(`/api/v1/campaigns/${campaign2Id}/members`).send({ userId: playerId, role: 'player' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('supports cursor pagination across 35 items', async () => {
    for (let i = 1; i <= 35; i++) {
      await dm.post(`/api/v1/campaigns/${campaign1Id}/sessions`).send({ number: i, title: `Session ${i}`, recap: `Recap ${i}` });
    }

    const unreadCountRes = await player.get('/api/v1/notifications/unread-count');
    expect(unreadCountRes.body.count).toBe(37);

    const page1 = await player.get('/api/v1/notifications?limit=20');
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(20);
    expect(page1.body.total).toBe(37);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.nextCursor).toBeDefined();

    const cursor = page1.body.nextCursor;
    const page2 = await player.get(`/api/v1/notifications?limit=20&cursor=${cursor}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(17);
    expect(page2.body.hasMore).toBe(false);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('filters by campaign, type, date range, and unread status', async () => {
    for (let i = 1; i <= 5; i++) {
      await dm.post(`/api/v1/campaigns/${campaign2Id}/sessions`).send({ number: i + 100, title: `Beta Session ${i}`, recap: `Beta Recap ${i}` });
    }

    const resC2 = await player.get(`/api/v1/notifications?campaignId=${campaign2Id}`);
    expect(resC2.status).toBe(200);
    expect(resC2.body.items.every((n: any) => n.campaignId === campaign2Id)).toBe(true);
    expect(resC2.body.items.filter((n: any) => n.type === 'recap_posted')).toHaveLength(5);

    const resType = await player.get('/api/v1/notifications?type=recap_posted');
    expect(resType.status).toBe(200);
    expect(resType.body.items.length).toBeGreaterThanOrEqual(40);

    const resUnread = await player.get('/api/v1/notifications?unread=true');
    expect(resUnread.status).toBe(200);
    expect(resUnread.body.items.every((n: any) => n.readAt === null)).toBe(true);
  });

  it('bulk mark read by IDs, by campaign, all, and bulk mark unread for undo', async () => {
    const initialList = await player.get('/api/v1/notifications?limit=5');
    const idsToMark = initialList.body.items.map((n: any) => n.id);

    const markResult = await player.post('/api/v1/notifications/mark-read').send({ ids: idsToMark });
    expect(markResult.status).toBe(201);
    expect(markResult.body.updated).toBe(5);
    expect([...markResult.body.updatedIds].sort()).toEqual([...idsToMark].sort());

    const countAfter5 = await player.get('/api/v1/notifications/unread-count');
    expect(countAfter5.body.count).toBe(37);

    const undoResult = await player.post('/api/v1/notifications/mark-unread').send({ ids: idsToMark });
    expect(undoResult.status).toBe(201);
    expect(undoResult.body.updated).toBe(5);

    const countRestored = await player.get('/api/v1/notifications/unread-count');
    expect(countRestored.body.count).toBe(42);

    const c2Mark = await player.post('/api/v1/notifications/mark-read').send({ campaignId: campaign2Id });
    expect(c2Mark.status).toBe(201);
    expect(c2Mark.body.updated).toBe(6);

    const allMark = await player.post('/api/v1/notifications/mark-read').send({ all: true });
    expect(allMark.status).toBe(201);
    expect(allMark.body.updated).toBe(36);

    const finalCount = await player.get('/api/v1/notifications/unread-count');
    expect(finalCount.body.count).toBe(0);

    const singleUnread = await player.post(`/api/v1/notifications/${idsToMark[0]}/unread`);
    expect(singleUnread.status).toBe(201);
    expect(singleUnread.body.readAt).toBeNull();
    expect((await player.get('/api/v1/notifications/unread-count')).body.count).toBe(1);

    const singleRead = await player.post(`/api/v1/notifications/${idsToMark[0]}/read`);
    expect(singleRead.status).toBe(201);
    expect(singleRead.body.readAt).not.toBeNull();
    expect((await player.get('/api/v1/notifications/unread-count')).body.count).toBe(0);
  });

  it('paginates 205 notifications without gaps or duplicates', async () => {
    const c3 = await dm.post('/api/v1/campaigns').send({ name: 'Campaign Gamma' });
    const campaign3Id = c3.body.id;
    await dm.post(`/api/v1/campaigns/${campaign3Id}/members`).send({ userId: playerId, role: 'player' });

    for (let i = 1; i <= 205; i++) {
      await dm.post(`/api/v1/campaigns/${campaign3Id}/sessions`).send({
        number: i + 200,
        title: `Gamma Session ${i}`,
        recap: `Gamma recap ${i}`,
      });
    }

    const unreadCountRes = await player.get('/api/v1/notifications/unread-count');
    const totalUnread = unreadCountRes.body.count as number;
    expect(totalUnread).toBeGreaterThanOrEqual(205);

    const seen = new Set<number>();
    let cursor: number | null = null;
    let pages = 0;
    let expectedTotal: number | null = null;
    while (pages < 20) {
      const query = cursor ? `?limit=50&cursor=${cursor}` : '?limit=50';
      const page = await player.get(`/api/v1/notifications${query}`);
      expect(page.status).toBe(200);
      if (expectedTotal === null) expectedTotal = page.body.total as number;
      expect(page.body.total).toBe(expectedTotal);
      for (const row of page.body.items as Array<{ id: number }>) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      if (!page.body.hasMore) {
        expect(page.body.nextCursor).toBeNull();
        break;
      }
      cursor = page.body.nextCursor;
      pages += 1;
    }
    expect(seen.size).toBe(expectedTotal);
  });

  it('keeps pagination stable when new notifications arrive between pages', async () => {
    const before = await player.get('/api/v1/notifications/unread-count');
    const page1 = await player.get('/api/v1/notifications?limit=20');
    expect(page1.status).toBe(200);

    await dm.post(`/api/v1/campaigns/${campaign1Id}/sessions`).send({
      number: 999,
      title: 'Concurrent arrival',
      recap: 'Arrived while paging',
    });

    const page2 = await player.get(`/api/v1/notifications?limit=20&cursor=${page1.body.nextCursor}`);
    expect(page2.status).toBe(200);
    const after = await player.get('/api/v1/notifications/unread-count');
    expect(after.body.count).toBe(before.body.count + 1);

    const mergedIds = [...page1.body.items, ...page2.body.items].map((row: { id: number }) => row.id);
    expect(new Set(mergedIds).size).toBe(mergedIds.length);
  });

  it('rejects bulk mark-read without ids, campaignId, or all', async () => {
    const invalid = await player.post('/api/v1/notifications/mark-read').send({});
    expect(invalid.status).toBe(400);
  });
});
