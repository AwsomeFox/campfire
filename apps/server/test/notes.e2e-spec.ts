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

/**
 * Issue #36: resolved-item history. Resolving may link the entity the item became
 * (entityType + entityId); GET /campaigns/:cid/inbox?resolved=true lists resolved
 * items (newest resolution first) so the DM has a history view.
 */
describe('inbox resolved history (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Inbox History Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function submitInbox(body: string): Promise<number> {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/inbox`)
      .set(authorPlayer)
      .send({ body });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it('resolve with an entity link stores it; resolved list shows it, open list does not', async () => {
    const server = ctx.app.getHttpServer();

    const questRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Track down the smugglers' });
    expect(questRes.status).toBe(201);
    const questId = questRes.body.id;

    const inboxId = await submitInbox('The harbormaster mentioned smugglers');

    const resolveRes = await request(server)
      .post(`/api/v1/notes/${inboxId}/resolve`)
      .set(dm)
      .send({ resolvedNote: 'Became a quest', entityType: 'quest', entityId: questId });
    expect(resolveRes.status).toBe(201);
    expect(resolveRes.body.resolved).toBe(true);
    expect(resolveRes.body.entityType).toBe('quest');
    expect(resolveRes.body.entityId).toBe(questId);

    // gone from the open list
    const openList = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox`).set(dm);
    expect(openList.status).toBe(200);
    expect(openList.body.some((n: { id: number }) => n.id === inboxId)).toBe(false);

    // present in the resolved history, with note + entity link intact
    const resolvedList = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`).set(dm);
    expect(resolvedList.status).toBe(200);
    const item = resolvedList.body.find((n: { id: number }) => n.id === inboxId);
    expect(item).toBeDefined();
    expect(item.resolved).toBe(true);
    expect(item.resolvedNote).toBe('Became a quest');
    expect(item.entityType).toBe('quest');
    expect(item.entityId).toBe(questId);
  });

  it('resolve without an entity link still lands in history with a null link', async () => {
    const server = ctx.app.getHttpServer();
    const inboxId = await submitInbox('Just a question, no entity');

    const resolveRes = await request(server)
      .post(`/api/v1/notes/${inboxId}/resolve`)
      .set(dm)
      .send({ resolvedNote: 'Answered at the table' });
    expect(resolveRes.status).toBe(201);
    expect(resolveRes.body.entityType).toBeNull();
    expect(resolveRes.body.entityId).toBeNull();

    const resolvedList = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`).set(dm);
    const item = resolvedList.body.find((n: { id: number }) => n.id === inboxId);
    expect(item).toBeDefined();
    expect(item.resolvedNote).toBe('Answered at the table');
    expect(item.entityType).toBeNull();
  });

  it('resolved history is sorted newest resolution first', async () => {
    const server = ctx.app.getHttpServer();
    const firstId = await submitInbox('Resolved first');
    const secondId = await submitInbox('Resolved second');

    await request(server).post(`/api/v1/notes/${firstId}/resolve`).set(dm).send({ resolvedNote: 'one' });
    // ensure a distinct updatedAt timestamp for the second resolution
    await new Promise((r) => setTimeout(r, 5));
    await request(server).post(`/api/v1/notes/${secondId}/resolve`).set(dm).send({ resolvedNote: 'two' });

    const resolvedList = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`).set(dm);
    const ids: number[] = resolvedList.body.map((n: { id: number }) => n.id);
    expect(ids.indexOf(secondId)).toBeLessThan(ids.indexOf(firstId));
  });

  it('entityType without entityId (and vice versa) is rejected', async () => {
    const server = ctx.app.getHttpServer();
    const inboxId = await submitInbox('Half-linked resolution attempt');

    const missingId = await request(server)
      .post(`/api/v1/notes/${inboxId}/resolve`)
      .set(dm)
      .send({ resolvedNote: 'oops', entityType: 'quest' });
    expect(missingId.status).toBe(400);

    const missingType = await request(server)
      .post(`/api/v1/notes/${inboxId}/resolve`)
      .set(dm)
      .send({ resolvedNote: 'oops', entityId: 1 });
    expect(missingType.status).toBe(400);

    // item is still open after the failed attempts
    const openList = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox`).set(dm);
    expect(openList.body.some((n: { id: number }) => n.id === inboxId)).toBe(true);
  });

  it('non-dm cannot list the resolved history', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`).set(authorPlayer);
    expect(res.status).toBe(403);
  });
});
