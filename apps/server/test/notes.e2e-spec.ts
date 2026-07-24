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
    for (const n of listRes.body.items) {
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
    expect(listInbox.body.items.some((n: { id: number }) => n.id === inboxId)).toBe(true);

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
    expect(listInboxAfter.body.items.some((n: { id: number }) => n.id === inboxId)).toBe(false);
  });
});

/**
 * Issue #65: free-text search over a player's own notes. GET /campaigns/:cid/notes?q=
 * filters by body (case-insensitive substring), composes with mine=true and the
 * visibility rules, and never surfaces notes the caller can't already see.
 */
describe('notes search (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Search Campaign' });
    campaignId = campRes.body.id;

    // authorPlayer's own notes
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'The one about the relic in the vault', visibility: 'private' });
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'Remember to buy more torches', visibility: 'private' });
    // a party_shared note from another player (visible to authorPlayer) that also mentions "relic"
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(otherPlayer)
      .send({ body: 'The RELIC glows near water', visibility: 'party_shared' });
    // a private note from another player mentioning "relic" — must NOT be visible to authorPlayer
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(otherPlayer)
      .send({ body: 'Secret relic theory', visibility: 'private' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('q filters by body, case-insensitively', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/campaigns/${campaignId}/notes?q=relic`).set(authorPlayer);
    expect(res.status).toBe(200);
    const bodies = res.body.items.map((n: { body: string }) => n.body).sort();
    // authorPlayer's own "relic" note + the party_shared one; NOT other player's private note
    expect(bodies).toEqual(['The RELIC glows near water', 'The one about the relic in the vault']);
  });

  it('q composes with mine=true (only the caller\'s own matching notes)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/notes?q=relic&mine=true`)
      .set(authorPlayer);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].body).toBe('The one about the relic in the vault');
  });

  it('q never surfaces notes the caller cannot see', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/campaigns/${campaignId}/notes?q=secret`).set(authorPlayer);
    expect(res.status).toBe(200);
    // "Secret relic theory" is otherPlayer's private note — invisible to authorPlayer.
    expect(res.body.items).toHaveLength(0);
  });

  it('blank/whitespace q returns all visible notes (no-op filter)', async () => {
    const server = ctx.app.getHttpServer();
    const all = await request(server).get(`/api/v1/campaigns/${campaignId}/notes`).set(authorPlayer);
    const blank = await request(server).get(`/api/v1/campaigns/${campaignId}/notes?q=%20%20`).set(authorPlayer);
    expect(blank.status).toBe(200);
    expect(blank.body.items).toHaveLength(all.body.items.length);
    expect(blank.body.total).toBe(all.body.total);
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
    const listed = listRes.body.items.find((n: { id: number }) => n.id === createRes.body.id);
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
 * Issue #127: per-player whisper (targeted note visibility). A `whisper` note is a
 * per-player secret channel — visible ONLY to its author, the single targeted
 * recipient, and any DM (oversight). A non-target, non-DM member must never receive it
 * over any read path. Real cookie sessions so the recipient is validated against actual
 * campaign membership (dev-auth has no members rows).
 */
describe('notes whisper — per-player targeted visibility (e2e)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let targetAgent: ReturnType<typeof request.agent>;
  let otherAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let targetUserId: number;
  let otherUserId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'whisper-dm', password: 'dm-password-1' });
    await dmAgent
      .post('/api/v1/users')
      .send({ username: 'whisper-target', password: 'target-password-1', displayName: 'The Rogue', serverRole: 'user' });
    await dmAgent
      .post('/api/v1/users')
      .send({ username: 'whisper-other', password: 'other-password-1', displayName: 'The Bard', serverRole: 'user' });

    targetAgent = request.agent(server);
    await targetAgent.post('/api/v1/auth/login').send({ username: 'whisper-target', password: 'target-password-1' });
    otherAgent = request.agent(server);
    await otherAgent.post('/api/v1/auth/login').send({ username: 'whisper-other', password: 'other-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Whisper Campaign' });
    campaignId = campRes.body.id;

    targetUserId = (await targetAgent.get('/api/v1/me')).body.user.id;
    otherUserId = (await otherAgent.get('/api/v1/me')).body.user.id;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: targetUserId, role: 'player' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: otherUserId, role: 'player' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('DM whispers to one player: author + target + DM see it, a non-target player never does', async () => {
    // The DM whispers a secret to the rogue alone.
    const createRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'Only you notice the trap door', visibility: 'whisper', recipientUserId: String(targetUserId) });
    expect(createRes.status).toBe(201);
    expect(createRes.body.visibility).toBe('whisper');
    expect(createRes.body.recipientUserId).toBe(String(targetUserId));
    // recipient display name resolved server-side (like entityName), never stored.
    expect(createRes.body.recipientName).toBe('The Rogue');
    const noteId = createRes.body.id;

    // GET by id: author (DM) + target see it; the non-target player 404s (not 403 — ids don't leak).
    expect((await dmAgent.get(`/api/v1/notes/${noteId}`)).status).toBe(200);
    expect((await targetAgent.get(`/api/v1/notes/${noteId}`)).status).toBe(200);
    expect((await otherAgent.get(`/api/v1/notes/${noteId}`)).status).toBe(404);

    // List endpoint: target sees the whisper; the non-target player never receives it,
    // and any whisper it does surface must be one they're the recipient of.
    const targetList = await targetAgent.get(`/api/v1/campaigns/${campaignId}/notes`);
    expect(targetList.body.items.some((n: { id: number }) => n.id === noteId)).toBe(true);

    const otherList = await otherAgent.get(`/api/v1/campaigns/${campaignId}/notes`);
    expect(otherList.body.items.some((n: { id: number }) => n.id === noteId)).toBe(false);
    for (const n of otherList.body.items as Array<{ visibility: string; recipientUserId: string | null }>) {
      if (n.visibility === 'whisper') expect(n.recipientUserId).toBe(String(otherUserId));
    }

    // DM oversight: the whisper is in the DM's list too (it enters the campaign record).
    const dmList = await dmAgent.get(`/api/v1/campaigns/${campaignId}/notes`);
    expect(dmList.body.items.some((n: { id: number }) => n.id === noteId)).toBe(true);
  });

  it('free-text search never leaks a whisper to a non-target', async () => {
    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'The vault password is SPARROW', visibility: 'whisper', recipientUserId: String(targetUserId) });

    // The target can find their own whisper by body text…
    const targetHit = await targetAgent.get(`/api/v1/campaigns/${campaignId}/notes?q=sparrow`);
    expect(targetHit.body.items.length).toBeGreaterThan(0);
    // …but the non-target searching the same word gets nothing.
    const otherHit = await otherAgent.get(`/api/v1/campaigns/${campaignId}/notes?q=sparrow`);
    expect(otherHit.body.items).toHaveLength(0);
  });

  it('a player may whisper another player; the DM still sees it, a third player does not', async () => {
    const createRes = await targetAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'I think the Bard is the traitor', visibility: 'whisper', recipientUserId: String(otherUserId) });
    expect(createRes.status).toBe(201);
    const noteId = createRes.body.id;

    expect((await otherAgent.get(`/api/v1/notes/${noteId}`)).status).toBe(200); // recipient
    expect((await targetAgent.get(`/api/v1/notes/${noteId}`)).status).toBe(200); // author
    expect((await dmAgent.get(`/api/v1/notes/${noteId}`)).status).toBe(200); // DM oversight
  });

  it('a whisper with no recipient, or to a non-member, is rejected', async () => {
    const noRecipient = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'whisper to nobody', visibility: 'whisper' });
    expect(noRecipient.status).toBe(400);

    const nonMember = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'whisper to a stranger', visibility: 'whisper', recipientUserId: '9999999' });
    expect(nonMember.status).toBe(400);
  });

  it('switching a whisper to another visibility clears its recipient', async () => {
    const createRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'was a whisper', visibility: 'whisper', recipientUserId: String(targetUserId) });
    const noteId = createRes.body.id;
    expect(createRes.body.recipientUserId).toBe(String(targetUserId));

    const patchRes = await dmAgent.patch(`/api/v1/notes/${noteId}`).send({ visibility: 'party_shared' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.visibility).toBe('party_shared');
    expect(patchRes.body.recipientUserId).toBeNull();

    // now party-visible: the previously-excluded player can see it
    expect((await otherAgent.get(`/api/v1/notes/${noteId}`)).status).toBe(200);
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
    expect(openList.body.items.some((n: { id: number }) => n.id === inboxId)).toBe(false);

    // present in the resolved history, with note + entity link intact
    const resolvedList = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`).set(dm);
    expect(resolvedList.status).toBe(200);
    const item = resolvedList.body.items.find((n: { id: number }) => n.id === inboxId);
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
    const item = resolvedList.body.items.find((n: { id: number }) => n.id === inboxId);
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
    const ids: number[] = resolvedList.body.items.map((n: { id: number }) => n.id);
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
    expect(openList.body.items.some((n: { id: number }) => n.id === inboxId)).toBe(true);
  });

  it('non-dm cannot list the resolved history', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`).set(authorPlayer);
    expect(res.status).toBe(403);
  });
});

/**
 * Issue #608: bounded newest-first cursor pagination for notes + inbox.
 * Default page is a NoteListPage (never an unbounded array); cursors are stable
 * under mid-list inserts; search/visibility filters compose with paging.
 */
describe('notes pagination (e2e, issue #608)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  const server = () => ctx.app.getHttpServer();

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(server()).post('/api/v1/campaigns').set(dm).send({ name: 'Pagination Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('defaults to a bounded newest-first page with total/hasMore/nextCursor', async () => {
    // Seed enough notes to cross the default page size.
    for (let i = 0; i < 55; i++) {
      const res = await request(server())
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .set(authorPlayer)
        .send({ body: `Paged note ${i.toString().padStart(3, '0')}`, visibility: 'private' });
      expect(res.status).toBe(201);
    }

    const page1 = await request(server()).get(`/api/v1/campaigns/${campaignId}/notes`).set(authorPlayer);
    expect(page1.status).toBe(200);
    expect(page1.body).toMatchObject({
      limit: 50,
      hasMore: true,
    });
    expect(page1.body.total).toBeGreaterThanOrEqual(55);
    expect(page1.body.items).toHaveLength(50);
    expect(typeof page1.body.nextCursor).toBe('string');
    // Newest first: ids strictly descending.
    const ids = page1.body.items.map((n: { id: number }) => n.id);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => b - a));

    const page2 = await request(server())
      .get(`/api/v1/campaigns/${campaignId}/notes`)
      .query({ cursor: page1.body.nextCursor })
      .set(authorPlayer);
    expect(page2.status).toBe(200);
    expect(page2.body.items.length).toBeGreaterThan(0);
    // No overlap between pages.
    const page2Ids = new Set(page2.body.items.map((n: { id: number }) => n.id));
    for (const id of ids) expect(page2Ids.has(id)).toBe(false);
    // Continuation stays strictly older than the last id of page 1.
    expect(Math.max(...page2.body.items.map((n: { id: number }) => n.id))).toBeLessThan(ids[ids.length - 1]);
  });

  it('exact recent-five query returns the five newest notes', async () => {
    const res = await request(server())
      .get(`/api/v1/campaigns/${campaignId}/notes`)
      .query({ limit: 5 })
      .set(authorPlayer);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.items).toHaveLength(5);
    const ids = res.body.items.map((n: { id: number }) => n.id);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => b - a));
  });

  it('visibility + q filters remain correct under pagination', async () => {
    await request(server())
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'Unique relic filter token alpha', visibility: 'private' });
    await request(server())
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(authorPlayer)
      .send({ body: 'Unique relic filter token beta', visibility: 'party_shared' });

    const filtered = await request(server())
      .get(`/api/v1/campaigns/${campaignId}/notes`)
      .query({ q: 'Unique relic filter token', visibility: 'private', limit: 10 })
      .set(authorPlayer);
    expect(filtered.status).toBe(200);
    expect(filtered.body.items.length).toBeGreaterThanOrEqual(1);
    for (const n of filtered.body.items) {
      expect(n.visibility).toBe('private');
      expect(n.body.toLowerCase()).toContain('unique relic filter token');
    }
  });

  it('rejects an invalid cursor with 400', async () => {
    const res = await request(server())
      .get(`/api/v1/campaigns/${campaignId}/notes`)
      .query({ cursor: '%%%not-a-cursor%%%' })
      .set(authorPlayer);
    expect(res.status).toBe(400);
  });

  it('pages thousands of rows with stable cursors under interleaved inserts', async () => {
    // Sequential seed — the Nest test HTTP server resets under large Promise.all bursts.
    for (let i = 0; i < 1100; i++) {
      const res = await request(server())
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .set(authorPlayer)
        .send({ body: `Bulk note ${i}`, visibility: 'private' });
      expect(res.status).toBe(201);
    }

    const seen = new Set<number>();
    let cursor: string | undefined;
    let pages = 0;
    let interleavedInserts = 0;

    for (;;) {
      const res = await request(server())
        .get(`/api/v1/campaigns/${campaignId}/notes`)
        .query({ limit: 100, ...(cursor ? { cursor } : {}) })
        .set(authorPlayer);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.length).toBeLessThanOrEqual(100);
      for (const n of res.body.items as Array<{ id: number }>) {
        expect(seen.has(n.id)).toBe(false);
        seen.add(n.id);
      }
      pages += 1;

      // Interleave inserts while paging. Newest-first keyset means inserts land
      // ahead of the cursor (not on later pages) — they must not duplicate rows
      // already returned or break the walk.
      if (interleavedInserts < 10) {
        const inserted = await request(server())
          .post(`/api/v1/campaigns/${campaignId}/notes`)
          .set(authorPlayer)
          .send({ body: `Interleaved insert ${interleavedInserts}`, visibility: 'private' });
        expect(inserted.status).toBe(201);
        interleavedInserts += 1;
      }

      if (!res.body.hasMore) break;
      expect(typeof res.body.nextCursor).toBe('string');
      cursor = res.body.nextCursor as string;
      // Safety valve — should finish well under this with limit 100.
      expect(pages).toBeLessThan(40);
    }

    expect(interleavedInserts).toBe(10);
    // Full walk of the pre-seeded thousands with no duplicate ids across pages.
    expect(seen.size).toBeGreaterThanOrEqual(1100);
    expect(pages).toBeGreaterThan(10);
  }, 180_000);

  it('inbox open + history pages are bounded newest-first', async () => {
    for (let i = 0; i < 12; i++) {
      const created = await request(server())
        .post(`/api/v1/campaigns/${campaignId}/inbox`)
        .set(authorPlayer)
        .send({ body: `Inbox page item ${i}` });
      expect(created.status).toBe(201);
      if (i < 6) {
        await request(server())
          .post(`/api/v1/notes/${created.body.id}/resolve`)
          .set(dm)
          .send({ resolvedNote: `done ${i}` });
      }
    }

    const open = await request(server())
      .get(`/api/v1/campaigns/${campaignId}/inbox`)
      .query({ limit: 5 })
      .set(dm);
    expect(open.status).toBe(200);
    expect(open.body.limit).toBe(5);
    expect(open.body.items).toHaveLength(5);
    expect(open.body.hasMore).toBe(true);
    const openIds = open.body.items.map((n: { id: number }) => n.id);
    expect(openIds).toEqual([...openIds].sort((a: number, b: number) => b - a));

    const history = await request(server())
      .get(`/api/v1/campaigns/${campaignId}/inbox`)
      .query({ resolved: true, limit: 5 })
      .set(dm);
    expect(history.status).toBe(200);
    expect(history.body.items).toHaveLength(5);
    expect(history.body.hasMore).toBe(true);
    expect(typeof history.body.nextCursor).toBe('string');
  });
});
