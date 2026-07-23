import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * In-app notifications (issue #11): recap posted, note reply, added to
 * campaign, next session scheduled. Real cookie sessions — notification rows
 * hang off real users.id, so the DEV_AUTH header path (dev:* ids) is out.
 */
describe('notifications (e2e)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>; // user A — campaign creator/dm
  let player: ReturnType<typeof request.agent>; // user B — player
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
    return res.body;
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'notif-admin', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'notif-dm', password: 'password-dm-1', displayName: 'Dana DM' });
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
    expect(count.body).toEqual({ count: 0 });
  });

  it('added_to_campaign: adding a member notifies the added user (not the acting dm)', async () => {
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

    const dmList = await listFor(dm);
    expect(dmList.filter((n) => n.type === 'added_to_campaign')).toHaveLength(0);
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
    return (res.body as Notification[]).filter((n) => n.type === 'note_shared');
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
 * Issue #263: notification coverage was incomplete — scheduling, quest changes,
 * party-shared notes and proposals never notified anyone. Each of those now emits
 * a best-effort in-app notification to the right recipient. Real cookie sessions
 * (notifications hang off real users.id, so the DEV_AUTH header path is out).
 */
describe('coverage gaps: scheduling / quests / party notes / proposals (issue #263, e2e)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>; // campaign creator/dm
  let player: ReturnType<typeof request.agent>; // a player
  let playerId: number;
  let campaignId: number;

  type Notification = { id: number; type: string; title: string; body: string; entityType: string | null; entityId: number | null; actorName: string };

  async function listFor(agent: ReturnType<typeof request.agent>): Promise<Notification[]> {
    const res = await agent.get('/api/v1/notifications');
    expect(res.status).toBe(200);
    return res.body as Notification[];
  }
  const ofType = (rows: Notification[], type: string) => rows.filter((n) => n.type === type);

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'cov-admin', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'cov-dm', password: 'password-dm-1', displayName: 'Dana DM' });
    const createPlayer = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'cov-player', password: 'password-pl-1', displayName: 'Pat Player' });
    playerId = createPlayer.body.id;

    dm = request.agent(server);
    await dm.post('/api/v1/auth/login').send({ username: 'cov-dm', password: 'password-dm-1' });
    player = request.agent(server);
    await player.post('/api/v1/auth/login').send({ username: 'cov-player', password: 'password-pl-1' });

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
    // The scheduling DM does not notify themselves.
    expect(ofType(await listFor(dm), 'session_scheduled')).toHaveLength(0);
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
