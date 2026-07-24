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

  it('snapshots an owned speaking character and preserves account + character history after rename/deletion', async () => {
    const server = ctx.app.getHttpServer();
    const character = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(authorPlayer)
      .send({ name: 'Seraphine Vale', portraitUrl: 'https://images.example.test/seraphine.png' });
    expect(character.status).toBe(201);

    const ic = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({
        ...anchor(),
        body: 'I draw my sword and step forward.',
        inCharacter: true,
        characterId: character.body.id,
      });
    expect(ic.status).toBe(201);
    expect(ic.body).toMatchObject({
      inCharacter: true,
      characterId: character.body.id,
      characterName: 'Seraphine Vale',
      characterAvatarUrl: 'https://images.example.test/seraphine.png',
      authorUserId: 'dev:author-1',
      authorName: 'author-1',
    });

    await request(server)
      .patch(`/api/v1/characters/${character.body.id}`)
      .set(authorPlayer)
      .send({ name: 'Seraphine the Renamed', portraitUrl: 'https://images.example.test/new.png' })
      .expect(200);
    await request(server).delete(`/api/v1/characters/${character.body.id}`).set(authorPlayer).expect(200);

    const historical = await request(server).get(`/api/v1/comments/${ic.body.id}`).set(otherPlayer);
    expect(historical.status).toBe(200);
    expect(historical.body).toMatchObject({
      characterId: character.body.id,
      characterName: 'Seraphine Vale',
      characterAvatarUrl: 'https://images.example.test/seraphine.png',
      authorUserId: 'dev:author-1',
      authorName: 'author-1',
    });

    // Body edits may not revise the immutable persona attribution.
    const changedPersona = await request(server)
      .patch(`/api/v1/comments/${ic.body.id}`)
      .set(authorPlayer)
      .send({ inCharacter: false });
    expect(changedPersona.status).toBe(400);
    const bodyEdit = await request(server)
      .patch(`/api/v1/comments/${ic.body.id}`)
      .set(authorPlayer)
      .send({ body: 'I lower my sword, but keep watch.' });
    expect(bodyEdit.status).toBe(200);
    expect(bodyEdit.body).toMatchObject({
      characterName: 'Seraphine Vale',
      characterAvatarUrl: 'https://images.example.test/seraphine.png',
    });
  });

  it('rejects missing, foreign-owned, cross-campaign, removed, and misplaced character ids', async () => {
    const server = ctx.app.getHttpServer();
    const foreignOwned = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(otherPlayer)
      .send({ name: 'Not Your Voice' });
    expect(foreignOwned.status).toBe(201);

    const otherCampaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Voices' });
    const crossCampaign = await request(server)
      .post(`/api/v1/campaigns/${otherCampaign.body.id}/characters`)
      .set(authorPlayer)
      .send({ name: 'Elsewhere' });
    const removed = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(authorPlayer)
      .send({ name: 'Gone Voice' });
    await request(server).delete(`/api/v1/characters/${removed.body.id}`).set(authorPlayer).expect(200);

    const post = (payload: Record<string, unknown>) =>
      request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Persona validation', ...payload });

    expect((await post({ inCharacter: true })).status).toBe(400);
    expect((await post({ inCharacter: true, characterId: foreignOwned.body.id })).status).toBe(403);
    expect((await post({ inCharacter: true, characterId: crossCampaign.body.id })).status).toBe(404);
    expect((await post({ inCharacter: true, characterId: removed.body.id })).status).toBe(404);
    expect((await post({ characterId: foreignOwned.body.id })).status).toBe(400);

    // Snapshot fields are response-only: DTO strictness prevents attribution forgery.
    const forged = await post({
      inCharacter: true,
      characterId: foreignOwned.body.id,
      characterName: 'Forged label',
      characterAvatarUrl: 'https://evil.example/forged.png',
    });
    expect(forged.status).toBe(400);
  });

  it('drops an unsafe portrait URL from the immutable snapshot', async () => {
    const server = ctx.app.getHttpServer();
    const character = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(authorPlayer)
      .send({ name: 'Safe Label', portraitUrl: 'javascript:alert(1)' });
    const result = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({ ...anchor(), body: 'No active content avatar.', inCharacter: true, characterId: character.body.id });
    expect(result.status).toBe(201);
    expect(result.body.characterName).toBe('Safe Label');
    expect(result.body.characterAvatarUrl).toBeNull();
  });

  it('validates absolute attachment portrait URLs instead of treating them as remote HTTPS', async () => {
    const server = ctx.app.getHttpServer();
    const tinyPng = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
        '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
      'hex',
    );
    const portrait = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(authorPlayer)
      .field('kind', 'portrait')
      .attach('file', tinyPng, { filename: 'ic.png', contentType: 'image/png' });
    expect(portrait.status).toBe(201);
    const absolutePortrait = `https://cdn.example.test/api/v1/attachments/${portrait.body.id}/file`;

    const character = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(authorPlayer)
      .send({ name: 'Absolute Portrait', portraitUrl: absolutePortrait });
    expect(character.status).toBe(201);

    const ok = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({
        ...anchor(),
        body: 'Absolute attachment avatar must normalize and validate.',
        inCharacter: true,
        characterId: character.body.id,
      });
    expect(ok.status).toBe(201);
    // Stored as the canonical relative route after campaign/kind/visibility checks.
    expect(ok.body.characterAvatarUrl).toBe(`/api/v1/attachments/${portrait.body.id}/file`);

    // A hidden map attachment must not sneak through as a "remote" HTTPS URL.
    const hiddenMap = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'map')
      .attach('file', tinyPng, { filename: 'map.png', contentType: 'image/png' });
    expect(hiddenMap.status).toBe(201);
    const badCharacter = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(authorPlayer)
      .send({
        name: 'Hidden Map Voice',
        portraitUrl: `https://cdn.example.test/api/v1/attachments/${hiddenMap.body.id}/file`,
      });
    const dropped = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({
        ...anchor(),
        body: 'Unsafe absolute attachment avatar dropped.',
        inCharacter: true,
        characterId: badCharacter.body.id,
      });
    expect(dropped.status).toBe(201);
    expect(dropped.body.characterAvatarUrl).toBeNull();
  });

  it('rejects no-op comment updates that would only bump updatedAt/editedAt', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(authorPlayer)
      .send({ ...anchor(), body: 'Leave me alone', inCharacter: false });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const before = await request(server).get(`/api/v1/comments/${id}`).set(authorPlayer);
    expect(before.status).toBe(200);

    const empty = await request(server).patch(`/api/v1/comments/${id}`).set(authorPlayer).send({});
    expect(empty.status).toBe(400);
    const echoFlag = await request(server)
      .patch(`/api/v1/comments/${id}`)
      .set(authorPlayer)
      .send({ inCharacter: false });
    expect(echoFlag.status).toBe(400);
    const sameBody = await request(server)
      .patch(`/api/v1/comments/${id}`)
      .set(authorPlayer)
      .send({ body: 'Leave me alone' });
    expect(sameBody.status).toBe(400);

    // Moderator no-ops must not stamp editedAt either.
    const dmNoop = await request(server)
      .patch(`/api/v1/comments/${id}`)
      .set(dm)
      .send({ inCharacter: false });
    expect(dmNoop.status).toBe(400);

    const after = await request(server).get(`/api/v1/comments/${id}`).set(authorPlayer);
    expect(after.status).toBe(200);
    expect(after.body.updatedAt).toBe(before.body.updatedAt);
    expect(after.body.editedAt).toBeNull();
    expect(after.body.editedBy).toBeNull();
    expect(after.body.body).toBe('Leave me alone');
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

  // ── issue #783: honest edit attribution (no DM forgery under a player's name) ─
  // The regression: a DM could edit any player's comment and the row kept the
  // PLAYER as author with only a generic "edited" marker — so the player was the
  // apparent author of prose the player never wrote. Now a non-author edit stamps
  // edited_at/edited_by (distinct from the author of record) and never overwrites
  // author_user_id/author_name, so the UI can honestly render "edited by DM Y".
  describe('issue #783 — DM edit records the editor, never the author', () => {
    it('a DM editing a player comment preserves the player as author and records the DM as editor', async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Player authored this' });
      const id = created.body.id;

      // The DM rewrites the body (moderation). It succeeds — the moderation path
      // is still allowed — but the attribution must be honest.
      const dmEdit = await request(server)
        .patch(`/api/v1/comments/${id}`)
        .set(dm)
        .send({ body: 'DM rewrote the player text' });
      expect(dmEdit.status).toBe(200);
      expect(dmEdit.body.body).toBe('DM rewrote the player text');

      // The PLAYER stays the author of record — the DM did not forge authorship.
      expect(dmEdit.body.authorUserId).toBe('dev:author-1');
      expect(dmEdit.body.authorName).toBe('author-1');

      // The DM is recorded as the editor, with a timestamp distinct from createdAt.
      expect(dmEdit.body.editedBy).toBe('dev:dm-1');
      expect(dmEdit.body.editedAt).not.toBeNull();
      expect(dmEdit.body.editedAt).not.toBe(dmEdit.body.createdAt);
    });

    it('a self-edit (the author editing their own comment) does NOT record an editor', async () => {
      // The trust fix only cares about NON-author edits — a self-edit is ordinary,
      // and stamping editedBy there would be noise. updated_at still bumps (the
      // generic "edited" badge), but editedBy/editedAt stay null so the UI doesn't
      // falsely claim a moderator touched it.
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Self-edit me' });
      const id = created.body.id;

      const selfEdit = await request(server)
        .patch(`/api/v1/comments/${id}`)
        .set(authorPlayer)
        .send({ body: 'Author rewrote their own text' });
      expect(selfEdit.status).toBe(200);
      expect(selfEdit.body.body).toBe('Author rewrote their own text');
      expect(selfEdit.body.authorUserId).toBe('dev:author-1');
      expect(selfEdit.body.editedBy).toBeNull();
      expect(selfEdit.body.editedAt).toBeNull();
      // updated_at still advances for the generic "edited" badge.
      expect(selfEdit.body.updatedAt).not.toBe(selfEdit.body.createdAt);
    });

    it('editedBy/editedAt are visible to OTHER members reading the thread (public attribution)', async () => {
      // Provenance must survive a fresh read: a third party who lists the thread
      // sees that the DM (not the player) authored the current body. This is the
      // acceptance criterion "Existing DM-edited comments reveal editor".
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(otherPlayer)
        .send({ ...anchor(), body: 'Other player wrote this' });
      const id = created.body.id;
      await request(server).patch(`/api/v1/comments/${id}`).set(dm).send({ body: 'DM moderated it' });

      // A different member reads the comment via GET — editor provenance is present.
      const read = await request(server).get(`/api/v1/comments/${id}`).set(authorPlayer);
      expect(read.status).toBe(200);
      expect(read.body.body).toBe('DM moderated it');
      expect(read.body.authorUserId).toBe('dev:other-1');
      expect(read.body.authorName).toBe('other-1');
      expect(read.body.editedBy).toBe('dev:dm-1');
      expect(read.body.editedAt).not.toBeNull();

      // And via the thread list (the path the UI renders from).
      const list = await request(server)
        .get(`/api/v1/campaigns/${campaignId}/comments`)
        .query({ entityType: 'session', entityId: sessionId })
        .set(authorPlayer);
      const inList = list.body.find((c: { id: number }) => c.id === id);
      expect(inList.editedBy).toBe('dev:dm-1');
      expect(inList.authorUserId).toBe('dev:other-1');
    });

    it('audits a moderator edit distinctly (actor=DM, detail flags it; self-edit has no such detail)', async () => {
      // The audit log is the durable provenance path: an incident reviewer must be
      // able to tell a DM-rewritten player comment from an ordinary author edit.
      const server = ctx.app.getHttpServer();
      const playerComment = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(otherPlayer)
        .send({ ...anchor(), body: 'Audited player comment' });
      const playerId = playerComment.body.id;
      // DM moderates the player's comment.
      await request(server).patch(`/api/v1/comments/${playerId}`).set(dm).send({ body: 'Audited DM rewrite' });

      // A separate self-edit for contrast.
      const ownComment = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(authorPlayer)
        .send({ ...anchor(), body: 'Audited self comment' });
      const ownId = ownComment.body.id;
      await request(server).patch(`/api/v1/comments/${ownId}`).set(authorPlayer).send({ body: 'Audited self rewrite' });

      const auditRes = await request(server)
        .get(`/api/v1/campaigns/${campaignId}/audit`)
        .query({ limit: 500 })
        .set(dm);
      expect(auditRes.status).toBe(200);
      const updates = auditRes.body.filter(
        (a: { action: string; entityType: string; entityId: number }) =>
          a.action === 'comment.update' && a.entityType === 'comment',
      );

      const modRow = updates.find((a: { entityId: number }) => a.entityId === playerId);
      expect(modRow).toBeDefined();
      expect(modRow.actorRole).toBe('dm');
      expect(modRow.actor).toBe('dev:dm-1');
      expect(modRow.detail).toContain('moderator edit');

      // The self-edit row has the player as actor and no moderator-edit detail.
      const selfRow = updates.find((a: { entityId: number }) => a.entityId === ownId);
      expect(selfRow).toBeDefined();
      expect(selfRow.actorRole).toBe('player');
      expect(selfRow.actor).toBe('dev:author-1');
      expect(selfRow.detail).not.toContain('moderator edit');
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
