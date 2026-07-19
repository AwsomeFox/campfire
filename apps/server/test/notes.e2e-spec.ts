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
