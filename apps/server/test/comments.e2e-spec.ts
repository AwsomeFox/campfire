import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const authorPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'author-1' };
const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'other-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('comments / threaded discussion (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let sessionId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Discussion Campaign' });
    campaignId = camp.body.id;
    const sess = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({ title: 'Session One', recap: 'We fought a goblin.' });
    sessionId = sess.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  function anchor() {
    return { entityType: 'session' as const, entityId: sessionId };
  }

  it('create + list a comment on a recap', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({ ...anchor(), body: 'Loved that goblin fight!' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.body).toBe('Loved that goblin fight!');
    expect(createRes.body.entityType).toBe('session');
    expect(createRes.body.entityId).toBe(sessionId);
    expect(createRes.body.parentId).toBeNull();
    expect(createRes.body.inCharacter).toBe(false);
    // authorName is stamped from the authenticated caller, not client-supplied.
    expect(createRes.body.authorName).toBe('author-1');

    const listRes = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/comments`)
      .query({ entityType: 'session', entityId: sessionId })
      .set(authorPlayer);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((c: { id: number }) => c.id === createRes.body.id)).toBe(true);
  });

  it('member visibility: all campaign members see the thread', async () => {
    const server = ctx.app.getHttpServer();
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({ ...anchor(), body: 'A shared discussion post' });

    for (const headers of [dm, authorPlayer, otherPlayer, viewer]) {
      const res = await request(server)
        .get(`/api/v1/campaigns/${campaignId}/comments`)
        .query({ entityType: 'session', entityId: sessionId })
        .set(headers);
      expect(res.status).toBe(200);
      expect(res.body.some((c: { body: string }) => c.body === 'A shared discussion post')).toBe(true);
    }
  });

  it('threading: a reply carries parentId', async () => {
    const server = ctx.app.getHttpServer();
    const parent = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({ ...anchor(), body: 'What was the goblin guarding?' });
    const parentId = parent.body.id;

    const reply = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(dm)
      .send({ ...anchor(), body: 'A cursed amulet — you missed it!', parentId });
    expect(reply.status).toBe(201);
    expect(reply.body.parentId).toBe(parentId);

    // Reply-to-a-reply re-anchors to the top-level ancestor (one visual level).
    const nested = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(otherPlayer)
      .send({ ...anchor(), body: 'Ugh, next time.', parentId: reply.body.id });
    expect(nested.status).toBe(201);
    expect(nested.body.parentId).toBe(parentId);
  });

  it('parentId must reference a comment on the same entity', async () => {
    const server = ctx.app.getHttpServer();
    // Comment anchored to the campaign entity, not the session.
    const onCampaign = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({ entityType: 'campaign', entityId: campaignId, body: 'General campaign chatter' });
    const foreignParentId = onCampaign.body.id;

    const badReply = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({ ...anchor(), body: 'reply pointing at the wrong thread', parentId: foreignParentId });
    expect(badReply.status).toBe(400);
  });

  it('inCharacter flag round-trips', async () => {
    const server = ctx.app.getHttpServer();
    const ic = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({ ...anchor(), body: 'I draw my sword and step forward.', inCharacter: true });
    expect(ic.status).toBe(201);
    expect(ic.body.inCharacter).toBe(true);
  });

  it('author-or-DM edit permission', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({ ...anchor(), body: 'Original text' });
    const id = created.body.id;

    // A different player may NOT edit.
    const otherEdit = await request(server)
      .patch(`/api/v1/comments/${id}`)
      .set(otherPlayer)
      .send({ body: 'Hijacked' });
    expect(otherEdit.status).toBe(403);

    // The author may edit.
    const authorEdit = await request(server)
      .patch(`/api/v1/comments/${id}`)
      .set(authorPlayer)
      .send({ body: 'Author edited' });
    expect(authorEdit.status).toBe(200);
    expect(authorEdit.body.body).toBe('Author edited');

    // The DM may edit anyone's comment (moderation).
    const dmEdit = await request(server)
      .patch(`/api/v1/comments/${id}`)
      .set(dm)
      .send({ body: 'DM moderated' });
    expect(dmEdit.status).toBe(200);
    expect(dmEdit.body.body).toBe('DM moderated');
  });

  it('author-or-DM delete permission + reply cascade', async () => {
    const server = ctx.app.getHttpServer();
    const parent = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({ ...anchor(), body: 'Parent to delete' });
    const parentId = parent.body.id;
    const reply = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(otherPlayer)
      .send({ ...anchor(), body: 'A reply that should cascade', parentId });
    const replyId = reply.body.id;

    // A non-author, non-DM cannot delete.
    const forbidden = await request(server).delete(`/api/v1/comments/${parentId}`).set(viewer);
    expect(forbidden.status).toBe(403);

    // The DM deletes the parent; the reply cascades away.
    const del = await request(server).delete(`/api/v1/comments/${parentId}`).set(dm);
    expect(del.status).toBe(200);

    const gone = await request(server).get(`/api/v1/comments/${parentId}`).set(dm);
    expect(gone.status).toBe(404);
    const replyGone = await request(server).get(`/api/v1/comments/${replyId}`).set(dm);
    expect(replyGone.status).toBe(404);
  });

  // Anchored-entity secrecy (issue #230, re: #123): a comment thread must be at least
  // as secret as the entity it hangs off. A hidden quest/NPC leaks neither its existence
  // nor its discussion to a non-DM — listing/posting 404s exactly as the entity's own GET
  // does — while the DM works normally and a visible entity is unchanged.
  describe('anchored-entity secrecy', () => {
    let hiddenQuestId: number;
    let hiddenNpcId: number;

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      const q = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'The Secret Betrayal', hidden: true });
      hiddenQuestId = q.body.id;
      const n = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'The Masked Traitor', hidden: true });
      hiddenNpcId = n.body.id;
      // The DM seeds a thread on each hidden entity — the very content that must not leak.
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(dm)
        .send({ entityType: 'quest', entityId: hiddenQuestId, body: 'DM-only plotting on a hidden quest' });
    });

    it('non-DM cannot LIST comments on a hidden quest/npc (404, existence not leaked)', async () => {
      const server = ctx.app.getHttpServer();
      for (const headers of [authorPlayer, otherPlayer, viewer]) {
        const quest = await request(server)
          .get(`/api/v1/campaigns/${campaignId}/comments`)
          .query({ entityType: 'quest', entityId: hiddenQuestId })
          .set(headers);
        expect(quest.status).toBe(404);
        const npc = await request(server)
          .get(`/api/v1/campaigns/${campaignId}/comments`)
          .query({ entityType: 'npc', entityId: hiddenNpcId })
          .set(headers);
        expect(npc.status).toBe(404);
      }
    });

    it('non-DM cannot CREATE a comment on a hidden quest/npc (404)', async () => {
      const server = ctx.app.getHttpServer();
      const quest = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ entityType: 'quest', entityId: hiddenQuestId, body: 'Trying to speculate on a secret' });
      expect(quest.status).toBe(404);
      const npc = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(otherPlayer)
        .send({ entityType: 'npc', entityId: hiddenNpcId, body: 'Who is the traitor?' });
      expect(npc.status).toBe(404);
    });

    it('the DM can list and create comments on a hidden entity', async () => {
      const server = ctx.app.getHttpServer();
      const list = await request(server)
        .get(`/api/v1/campaigns/${campaignId}/comments`)
        .query({ entityType: 'quest', entityId: hiddenQuestId })
        .set(dm);
      expect(list.status).toBe(200);
      expect(list.body.some((c: { body: string }) => c.body === 'DM-only plotting on a hidden quest')).toBe(true);

      const create = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(dm)
        .send({ entityType: 'npc', entityId: hiddenNpcId, body: 'Reminder: reveal at session 5' });
      expect(create.status).toBe(201);
    });

    it('once revealed, a non-DM can list/create on the (formerly hidden) entity', async () => {
      const server = ctx.app.getHttpServer();
      const reveal = await request(server).patch(`/api/v1/quests/${hiddenQuestId}`).set(dm).send({ hidden: false });
      expect(reveal.status).toBe(200);

      const list = await request(server)
        .get(`/api/v1/campaigns/${campaignId}/comments`)
        .query({ entityType: 'quest', entityId: hiddenQuestId })
        .set(authorPlayer);
      expect(list.status).toBe(200);

      const create = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ entityType: 'quest', entityId: hiddenQuestId, body: 'Now I can finally comment!' });
      expect(create.status).toBe(201);
    });
  });

  it('rejects an unknown body key (strict DTO)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({ ...anchor(), body: 'ok', bogus: true });
    expect(res.status).toBe(400);
  });
});
