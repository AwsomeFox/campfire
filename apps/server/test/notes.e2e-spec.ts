import request from 'supertest';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const authorPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'author-1' };
const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'other-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('notes privacy (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Notes Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('private note: author sees, dm does not', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'My private diary entry', visibility: 'private' });
    expect(createRes.status).toBe(201);
    const noteId = createRes.body.id;

    const authorGet = await request(server).get(`/api/v1/notes/${noteId}`).set(authorPlayer);
    expect(authorGet.status).toBe(200);

    // GET by id 404s (not 403) for hidden notes
    const dmGet = await request(server).get(`/api/v1/notes/${noteId}`).set(dm);
    expect(dmGet.status).toBe(404);

    const otherGet = await request(server).get(`/api/v1/notes/${noteId}`).set(otherPlayer);
    expect(otherGet.status).toBe(404);
  });

  it('dm_shared note: seen by dm and author, not by other player', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'A note for the DM', visibility: 'dm_shared' });
    const noteId = createRes.body.id;

    const dmGet = await request(server).get(`/api/v1/notes/${noteId}`).set(dm);
    expect(dmGet.status).toBe(200);

    const authorGet = await request(server).get(`/api/v1/notes/${noteId}`).set(authorPlayer);
    expect(authorGet.status).toBe(200);

    const otherGet = await request(server).get(`/api/v1/notes/${noteId}`).set(otherPlayer);
    expect(otherGet.status).toBe(404);
  });

  it('party_shared note: seen by everyone', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'Party-wide announcement', visibility: 'party_shared' });
    const noteId = createRes.body.id;

    for (const headers of [dm, authorPlayer, otherPlayer, viewer]) {
      const res = await request(server).get(`/api/v1/notes/${noteId}`).set(headers);
      expect(res.status).toBe(200);
    }
  });

  it('list endpoint filters by visibility', async () => {
    const server = ctx.app.getHttpServer();
    const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/notes`).set(otherPlayer);
    expect(listRes.status).toBe(200);
    // otherPlayer should only see the party_shared note from this suite
    for (const n of listRes.body) {
      expect(n.visibility).toBe('party_shared');
    }
  });

  it('dm may NOT edit others notes; author may edit own', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'Editable note', visibility: 'party_shared' });
    const noteId = createRes.body.id;

    const dmEdit = await request(server).patch(`/api/v1/notes/${noteId}`).set(dm).send({ body: 'DM edited this' });
    expect(dmEdit.status).toBe(403);

    const authorEdit = await request(server)
      .patch(`/api/v1/notes/${noteId}`)
      .set(authorPlayer)
      .send({ body: 'Author edited this' });
    expect(authorEdit.status).toBe(200);
    expect(authorEdit.body.body).toBe('Author edited this');
  });

  it('dm inbox list + resolve', async () => {
    const server = ctx.app.getHttpServer();

    const inboxRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/inbox`)
      .set(viewer)
      .send({ body: 'Quick capture from viewer', authorName: 'Anonymous' });
    expect(inboxRes.status).toBe(201);
    const inboxId = inboxRes.body.id;
    expect(inboxRes.body.kind).toBe('inbox');
    expect(inboxRes.body.visibility).toBe('dm_shared');
    // Punch list item 8: client-supplied `authorName` ('Anonymous') is ignored — the server
    // always stamps the authenticated caller's own name (dev-auth mirrors x-dev-user, 'v-1').
    expect(inboxRes.body.authorName).toBe('v-1');
    expect(inboxRes.body.authorName).not.toBe('Anonymous');

    const listInbox = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox`).set(dm);
    expect(listInbox.status).toBe(200);
    expect(listInbox.body.some((n: { id: number }) => n.id === inboxId)).toBe(true);

    // non-dm cannot list inbox
    const listForbidden = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox`).set(authorPlayer);
    expect(listForbidden.status).toBe(403);

    const resolveRes = await request(server)
      .post(`/api/v1/notes/${inboxId}/resolve`)
      .set(dm)
      .send({ resolvedNote: 'Added to the map' });
    expect(resolveRes.status).toBe(201);
    expect(resolveRes.body.resolved).toBe(true);

    const listInboxAfter = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox`).set(dm);
    expect(listInboxAfter.body.some((n: { id: number }) => n.id === inboxId)).toBe(false);
  });
});

/**
 * Issue #5: entity-anchored notes carry the anchored entity's display name
 * (entityName) so list views can show "The Sunken Crypt" instead of "Quest #12".
 * Resolved server-side at read time, never stored; null when unanchored, when the
 * entity was deleted, and for entity ids belonging to another campaign (no leak).
 */
describe('notes entityName resolution (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let questId: number;
  let npcId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'EntityName Campaign' });
    campaignId = campRes.body.id;

    const questRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'The Sunken Crypt' });
    questId = questRes.body.id;

    const npcRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Mira the Fence' });
    npcId = npcRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('quest-anchored note resolves the quest title on create, list, and get', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'Bring rope next time', visibility: 'party_shared', entityType: 'quest', entityId: questId });
    expect(createRes.status).toBe(201);
    expect(createRes.body.entityName).toBe('The Sunken Crypt');

    const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/notes`).set(authorPlayer);
    const listed = listRes.body.find((n: { id: number }) => n.id === createRes.body.id);
    expect(listed.entityName).toBe('The Sunken Crypt');

    const getRes = await request(server).get(`/api/v1/notes/${createRes.body.id}`).set(authorPlayer);
    expect(getRes.body.entityName).toBe('The Sunken Crypt');
  });

  it('unanchored note has entityName null', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'Free-floating thought' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.entityName).toBeNull();
  });

  it('patching the anchor resolves the new entity name (npc)', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'She knows a buyer' });
    const patchRes = await request(server)
      .patch(`/api/v1/notes/${createRes.body.id}`)
      .set(authorPlayer)
      .send({ entityType: 'npc', entityId: npcId });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.entityName).toBe('Mira the Fence');
  });

  it('untitled session falls back to "Session <number>"; campaign anchor resolves campaign name', async () => {
    const server = ctx.app.getHttpServer();
    const sessionRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({ number: 7 });
    const noteRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'That fight was rough', entityType: 'session', entityId: sessionRes.body.id });
    expect(noteRes.body.entityName).toBe('Session 7');

    const campNoteRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'Campaign-wide reminder', entityType: 'campaign', entityId: campaignId });
    expect(campNoteRes.body.entityName).toBe('EntityName Campaign');
  });

  it('deleted entity: entityName degrades to null', async () => {
    const server = ctx.app.getHttpServer();
    const questRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Doomed Quest' });
    const noteRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'Anchored to a doomed quest', entityType: 'quest', entityId: questRes.body.id });
    expect(noteRes.body.entityName).toBe('Doomed Quest');

    await request(server).delete(`/api/v1/quests/${questRes.body.id}`).set(dm);

    const getRes = await request(server).get(`/api/v1/notes/${noteRes.body.id}`).set(authorPlayer);
    expect(getRes.status).toBe(200);
    expect(getRes.body.entityName).toBeNull();
  });

  it("does not leak another campaign's entity name", async () => {
    const server = ctx.app.getHttpServer();
    const otherCampRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Campaign' });
    const foreignQuestRes = await request(server)
      .post(`/api/v1/campaigns/${otherCampRes.body.id}/quests`)
      .set(dm)
      .send({ title: 'Secret Foreign Quest' });

    const noteRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'Pointing across campaigns', entityType: 'quest', entityId: foreignQuestRes.body.id });
    expect(noteRes.status).toBe(201);
    expect(noteRes.body.entityName).toBeNull();
  });
});

/**
 * Punch list item 8, real-session variant: proves the authorName override isn't a
 * dev-auth-only artifact — a real logged-in user's displayName wins over a spoofed
 * client-supplied authorName too.
 */
describe('inbox authorName spoofing (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let memberAgent: ReturnType<typeof request.agent>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'inbox-dm', password: 'dm-password-1' });
    await dmAgent.post('/api/v1/users').send({
      username: 'inbox-member',
      password: 'member-password-1',
      displayName: 'Real Display Name',
      serverRole: 'user',
    });

    memberAgent = request.agent(server);
    await memberAgent.post('/api/v1/auth/login').send({ username: 'inbox-member', password: 'member-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Inbox Spoof Campaign' });
    campaignId = campRes.body.id;
    const meRes = await memberAgent.get('/api/v1/me');
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: meRes.body.user.id, role: 'player' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a real user posting inbox with a spoofed authorName gets their own displayName stamped instead', async () => {
    const res = await memberAgent
      .post(`/api/v1/campaigns/${campaignId}/inbox`)
      .send({ body: 'Trying to impersonate the DM', authorName: 'The DM' });
    expect(res.status).toBe(201);
    expect(res.body.authorName).toBe('Real Display Name');
    expect(res.body.authorName).not.toBe('The DM');
  });
});
