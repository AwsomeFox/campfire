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

  it('author-or-DM delete permission: a non-author non-DM cannot delete (403)', async () => {
    const server = ctx.app.getHttpServer();
    const parent = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({ ...anchor(), body: 'Parent to delete' });
    const parentId = parent.body.id;

    // A non-author, non-DM cannot delete.
    const forbidden = await request(server).delete(`/api/v1/comments/${parentId}`).set(viewer);
    expect(forbidden.status).toBe(403);

    // The comment is untouched — still live, original body.
    const stillThere = await request(server).get(`/api/v1/comments/${parentId}`).set(dm);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.body).toBe('Parent to delete');
    expect(stillThere.body.deletedAt).toBeNull();
  });

  // ── issue #503: tombstone roots while preserving replies ───────────────────
  // The regression: a root author used to be able to permanently destroy other
  // members' replies (delete cascaded to children). Now a root delete tombstones
  // the root (body redacted) and leaves every reply intact and still threaded.
  describe('issue #503 — tombstone root, preserve replies', () => {
    it('author soft-deletes a root: replies SURVIVE and the root becomes a tombstone', async () => {
      const server = ctx.app.getHttpServer();
      const parent = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Root the author will tombstone' });
      const parentId = parent.body.id;
      const reply = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(otherPlayer)
        .send({ ...anchor(), body: 'A reply that must survive the root delete', parentId });
      const replyId = reply.body.id;

      // The AUTHOR (not just the DM) can delete their own root.
      const del = await request(server).delete(`/api/v1/comments/${parentId}`).set(authorPlayer);
      expect(del.status).toBe(200);

      // The reply is STILL readable — the root author did not destroy it.
      const survivingReply = await request(server).get(`/api/v1/comments/${replyId}`).set(otherPlayer);
      expect(survivingReply.status).toBe(200);
      expect(survivingReply.body.body).toBe('A reply that must survive the root delete');
      expect(survivingReply.body.deletedAt).toBeNull();

      // The root is now a tombstone: reachable, body redacted, but the row remains
      // so the reply's parentId still resolves and threading isn't broken.
      const tombstone = await request(server).get(`/api/v1/comments/${parentId}`).set(otherPlayer);
      expect(tombstone.status).toBe(200);
      expect(tombstone.body.body).toBe('[deleted]');
      expect(tombstone.body.deletedAt).not.toBeNull();
      expect(tombstone.body.deletedBy).toBe('dev:author-1');

      // The thread list shows BOTH the tombstone placeholder and the surviving reply.
      const list = await request(server)
        .get(`/api/v1/campaigns/${campaignId}/comments`)
        .query({ entityType: 'session', entityId: sessionId })
        .set(otherPlayer);
      expect(list.status).toBe(200);
      const ids = list.body.map((c: { id: number }) => c.id);
      expect(ids).toContain(parentId);
      expect(ids).toContain(replyId);
      const tombInList = list.body.find((c: { id: number }) => c.id === parentId);
      expect(tombInList.body).toBe('[deleted]');
    });

    it('a DM moderating tombstones the root the same way (replies preserved)', async () => {
      const server = ctx.app.getHttpServer();
      const parent = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(otherPlayer)
        .send({ ...anchor(), body: 'Root a DM will moderate' });
      const parentId = parent.body.id;
      const reply = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Reply under a DM-moderated root', parentId });
      const replyId = reply.body.id;

      const del = await request(server).delete(`/api/v1/comments/${parentId}`).set(dm);
      expect(del.status).toBe(200);

      // Reply survives DM moderation of its parent.
      const survivingReply = await request(server).get(`/api/v1/comments/${replyId}`).set(authorPlayer);
      expect(survivingReply.status).toBe(200);
      expect(survivingReply.body.body).toBe('Reply under a DM-moderated root');

      const tombstone = await request(server).get(`/api/v1/comments/${parentId}`).set(dm);
      expect(tombstone.status).toBe(200);
      expect(tombstone.body.body).toBe('[deleted]');
      expect(tombstone.body.deletedBy).toBe('dev:dm-1');
    });

    it('restore undoes a tombstone: body returns, replies still threaded', async () => {
      const server = ctx.app.getHttpServer();
      const parent = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Root that will be restored' });
      const parentId = parent.body.id;
      const reply = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(otherPlayer)
        .send({ ...anchor(), body: 'Reply present across the tombstone window', parentId });
      const replyId = reply.body.id;

      // Author tombstones, then restores.
      await request(server).delete(`/api/v1/comments/${parentId}`).set(authorPlayer);
      const restored = await request(server).post(`/api/v1/comments/${parentId}/restore`).set(authorPlayer);
      expect(restored.status).toBe(201);
      expect(restored.body.body).toBe('Root that will be restored');
      expect(restored.body.deletedAt).toBeNull();
      expect(restored.body.deletedBy).toBeNull();

      // The reply was never touched and is still there.
      const survivingReply = await request(server).get(`/api/v1/comments/${replyId}`).set(otherPlayer);
      expect(survivingReply.status).toBe(200);
      expect(survivingReply.body.body).toBe('Reply present across the tombstone window');
    });

    it('restore is author-or-DM gated: a non-author non-DM cannot restore', async () => {
      const server = ctx.app.getHttpServer();
      const parent = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Root restore-perm check' });
      const parentId = parent.body.id;
      await request(server).delete(`/api/v1/comments/${parentId}`).set(authorPlayer);

      const forbidden = await request(server).post(`/api/v1/comments/${parentId}/restore`).set(viewer);
      expect(forbidden.status).toBe(403);

      // A DM CAN restore someone else's tombstoned comment (moderation undo).
      const dmRestore = await request(server).post(`/api/v1/comments/${parentId}/restore`).set(dm);
      expect(dmRestore.status).toBe(201);
    });

    it('restore 404s on a comment that is not tombstoned', async () => {
      const server = ctx.app.getHttpServer();
      const live = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Never deleted' });
      const res = await request(server).post(`/api/v1/comments/${live.body.id}/restore`).set(authorPlayer);
      expect(res.status).toBe(404);
    });

    it('a tombstoned root body is redacted for the DM too (no privileged read of original prose)', async () => {
      const server = ctx.app.getHttpServer();
      const parent = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Secret prose that should vanish on tombstone' });
      const parentId = parent.body.id;
      await request(server).delete(`/api/v1/comments/${parentId}`).set(authorPlayer);

      const dmRead = await request(server).get(`/api/v1/comments/${parentId}`).set(dm);
      expect(dmRead.status).toBe(200);
      expect(dmRead.body.body).toBe('[deleted]');
      // The original prose must not leak anywhere in the response.
      expect(JSON.stringify(dmRead.body)).not.toContain('Secret prose');
    });

    it('audits every removal (soft-delete + restore) with actor + role + entity ref', async () => {
      const server = ctx.app.getHttpServer();
      const parent = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Root whose lifecycle is audited' });
      const parentId = parent.body.id;

      // Soft-delete by the author.
      await request(server).delete(`/api/v1/comments/${parentId}`).set(authorPlayer);
      // Restore by the DM (moderation undo).
      await request(server).post(`/api/v1/comments/${parentId}/restore`).set(dm);

      const auditRes = await request(server)
        .get(`/api/v1/campaigns/${campaignId}/audit`)
        .query({ limit: 500 })
        .set(dm);
      expect(auditRes.status).toBe(200);
      const forThisComment = auditRes.body.filter((a: { entityId: number; entityType: string }) =>
        a.entityType === 'comment' && a.entityId === parentId,
      );
      const actions = forThisComment.map((a: { action: string }) => a.action);

      // create + delete + restore all recorded against this comment id.
      expect(actions).toContain('comment.create');
      const del = forThisComment.find((a: { action: string }) => a.action === 'comment.delete');
      expect(del).toBeDefined();
      expect(del.actorRole).toBe('player'); // the author (authorPlayer) soft-deleted.
      expect(del.detail).toContain('tombstoned');
      const restore = forThisComment.find((a: { action: string }) => a.action === 'comment.restore');
      expect(restore).toBeDefined();
      expect(restore.actorRole).toBe('dm'); // the DM restored.
    });

    it('a reply can still anchor to a TOMBSTONED root (thread topology is the point of tombstoning)', async () => {
      // Regression for the resolveParent fix: getRowOrThrow used to 404 a
      // tombstoned parent, so once a root was soft-deleted no further replies
      // could thread under it — the web UI still posted parentId=<tombstoned id>
      // and got a 404. The whole reason we tombstone (not hard-delete) is so the
      // row stays and replies keep their parent. resolveParent now loads the
      // parent with includeDeleted=true, so a reply under a [deleted] placeholder
      // succeeds and re-anchors to the tombstoned root's id.
      const server = ctx.app.getHttpServer();
      const parent = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Root that will be tombstoned, then replied-to' });
      const parentId = parent.body.id;

      // Tombstone the root.
      const del = await request(server).delete(`/api/v1/comments/${parentId}`).set(authorPlayer);
      expect(del.status).toBe(200);
      expect(del.body.deletedAt).not.toBeNull();

      // Now a DIFFERENT member replies under the tombstoned root. Before the fix
      // this 404'd (resolveParent couldn't see the tombstoned parent); now it 201s
      // and the reply's parentId is the tombstoned root's id.
      const reply = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(otherPlayer)
        .send({ ...anchor(), body: 'Reply posted AFTER the root was tombstoned', parentId });
      expect(reply.status).toBe(201);
      expect(reply.body.parentId).toBe(parentId);

      // The reply is readable and threaded under the [deleted] placeholder.
      const thread = await request(server)
        .get(`/api/v1/campaigns/${campaignId}/comments`)
        .query({ entityType: 'session', entityId: sessionId })
        .set(otherPlayer);
      expect(thread.status).toBe(200);
      const tombstonedRoot = thread.body.find((c: { id: number }) => c.id === parentId);
      expect(tombstonedRoot.body).toBe('[deleted]');
      expect(thread.body.map((c: { id: number }) => c.id)).toContain(reply.body.id);
    });

    it('restore does NOT bump updatedAt (no false "edited" badge)', async () => {
      // Regression for the restore updatedAt fix: restore is a lifecycle event,
      // not a content edit. The web UI shows an "edited" badge when updatedAt
      // !== createdAt, so bumping updatedAt on restore would falsely mark a
      // restored comment as edited. updatedAt must stay at its pre-tombstone value.
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Will be tombstoned then restored' });
      const id = created.body.id;
      const createdAt = created.body.createdAt;
      const updatedAtBefore = created.body.updatedAt;

      await request(server).delete(`/api/v1/comments/${id}`).set(authorPlayer);
      const restored = await request(server).post(`/api/v1/comments/${id}/restore`).set(authorPlayer);
      expect(restored.status).toBe(201);
      expect(restored.body.body).toBe('Will be tombstoned then restored');
      expect(restored.body.deletedAt).toBeNull();
      // updatedAt is UNCHANGED by the tombstone+restore cycle — no false "edited".
      expect(restored.body.updatedAt).toBe(updatedAtBefore);
      expect(restored.body.createdAt).toBe(createdAt);
    });

    it('DELETE returns the tombstoned comment (deletedAt/deletedBy on the response, per the OpenAPI shape)', async () => {
      // Regression for the remove() return-shape fix: the controller/OpenAPI
      // describe deletedAt/deletedBy on the returned shape, so remove() returns
      // the tombstoned Comment rather than void — clients don't need a follow-up
      // GET to confirm the deletion took effect.
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Delete-me' });
      const del = await request(server).delete(`/api/v1/comments/${created.body.id}`).set(authorPlayer);
      expect(del.status).toBe(200);
      expect(del.body.id).toBe(created.body.id);
      expect(del.body.body).toBe('[deleted]'); // redacted placeholder, not the original prose
      expect(del.body.deletedAt).not.toBeNull();
      expect(del.body.deletedBy).toBe('dev:author-1');
    });
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
