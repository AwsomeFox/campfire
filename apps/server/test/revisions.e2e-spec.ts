import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

/**
 * Issue #157 — optimistic concurrency (expectedUpdatedAt / 409) + prose revision
 * history & restore. Verifies:
 *   - a stale expectedUpdatedAt PATCH 409s and does NOT mutate the row;
 *   - a matching expectedUpdatedAt PATCH succeeds;
 *   - omitting expectedUpdatedAt is unchanged back-compat (unconditional write);
 *   - a prose update snapshots the PRIOR content into entity_revisions;
 *   - list + restore round-trips (restore is itself recorded);
 *   - notes get the concurrency guard but not the (dm-only) history endpoint.
 */
describe('revisions + optimistic concurrency (e2e) — #157', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name: 'Revisions Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('sessions (recap)', () => {
    let sessionId: number;

    beforeAll(async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/campaigns/${campaignId}/sessions`)
        .set(dm)
        .send({ number: 1, recap: 'v1' });
      expect(res.status).toBe(201);
      sessionId = res.body.id;
    });

    it('a stale expectedUpdatedAt PATCH 409s and does NOT change the row', async () => {
      const server = ctx.app.getHttpServer();
      const before = await request(server).get(`/api/v1/sessions/${sessionId}`).set(dm);
      expect(before.body.recap).toBe('v1');

      const conflict = await request(server)
        .patch(`/api/v1/sessions/${sessionId}`)
        .set(dm)
        .send({ recap: 'CLOBBER', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('STALE_WRITE');

      const after = await request(server).get(`/api/v1/sessions/${sessionId}`).set(dm);
      expect(after.body.recap).toBe('v1'); // untouched
      expect(after.body.updatedAt).toBe(before.body.updatedAt);
    });

    it('a matching expectedUpdatedAt PATCH succeeds and records the prior recap as a revision', async () => {
      const server = ctx.app.getHttpServer();
      const current = await request(server).get(`/api/v1/sessions/${sessionId}`).set(dm);

      const ok = await request(server)
        .patch(`/api/v1/sessions/${sessionId}`)
        .set(dm)
        .send({ recap: 'v2', expectedUpdatedAt: current.body.updatedAt });
      expect(ok.status).toBe(200);
      expect(ok.body.recap).toBe('v2');

      const revs = await request(server).get(`/api/v1/revisions/session/${sessionId}`).set(dm);
      expect(revs.status).toBe(200);
      expect(revs.body).toHaveLength(1);
      expect(revs.body[0].snapshot.recap).toBe('v1'); // the PRIOR content
      expect(revs.body[0].entityType).toBe('session');
      expect(revs.body[0].entityId).toBe(sessionId);
    });

    it('omitting expectedUpdatedAt is unchanged back-compat (unconditional write)', async () => {
      const server = ctx.app.getHttpServer();
      const ok = await request(server).patch(`/api/v1/sessions/${sessionId}`).set(dm).send({ recap: 'v3' });
      expect(ok.status).toBe(200);
      expect(ok.body.recap).toBe('v3');

      const revs = await request(server).get(`/api/v1/revisions/session/${sessionId}`).set(dm);
      expect(revs.body).toHaveLength(2); // v2 (prior to v3) + v1 (prior to v2)
      expect(revs.body[0].snapshot.recap).toBe('v2'); // newest-first
      expect(revs.body[1].snapshot.recap).toBe('v1');
    });

    it('an unchanged recap does not grow the history', async () => {
      const server = ctx.app.getHttpServer();
      await request(server).patch(`/api/v1/sessions/${sessionId}`).set(dm).send({ recap: 'v3' }); // same value
      const revs = await request(server).get(`/api/v1/revisions/session/${sessionId}`).set(dm);
      expect(revs.body).toHaveLength(2); // still 2 — no snapshot for a no-op prose change
    });

    it('list + restore round-trips (restore re-applies a prior snapshot and is itself recorded)', async () => {
      const server = ctx.app.getHttpServer();
      const revs = await request(server).get(`/api/v1/revisions/session/${sessionId}`).set(dm);
      const v1Revision = revs.body.find((r: { snapshot: { recap?: string } }) => r.snapshot.recap === 'v1');
      expect(v1Revision).toBeDefined();

      const restored = await request(server)
        .post(`/api/v1/revisions/session/${sessionId}/${v1Revision.id}/restore`)
        .set(dm);
      expect(restored.status).toBe(201);

      const after = await request(server).get(`/api/v1/sessions/${sessionId}`).set(dm);
      expect(after.body.recap).toBe('v1'); // prior snapshot re-applied

      // The restore captured the pre-restore content ('v3') as a new revision → 3 total.
      const revsAfter = await request(server).get(`/api/v1/revisions/session/${sessionId}`).set(dm);
      expect(revsAfter.body).toHaveLength(3);
      expect(revsAfter.body[0].snapshot.recap).toBe('v3');
    });

    it('a non-dm cannot list or restore revisions', async () => {
      const server = ctx.app.getHttpServer();
      const player = { 'x-dev-role': 'player', 'x-dev-user': 'player-1' };
      const revs = await request(server).get(`/api/v1/revisions/session/${sessionId}`).set(player);
      expect(revs.status).toBe(403);
    });

    it('soft-deleting the session preserves its revisions (recoverable via restore, issue #116)', async () => {
      const server = ctx.app.getHttpServer();
      const throwaway = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/sessions`)
        .set(dm)
        .send({ number: 50, recap: 'temp-a' });
      const tid = throwaway.body.id;
      await request(server).patch(`/api/v1/sessions/${tid}`).set(dm).send({ recap: 'temp-b' });
      const before = await request(server).get(`/api/v1/revisions/session/${tid}`).set(dm);
      expect(before.body).toHaveLength(1);

      const del = await request(server).delete(`/api/v1/sessions/${tid}`).set(dm);
      expect(del.status).toBe(200);

      // Delete is now a soft-delete (issue #116) — the session is trashed but recoverable,
      // so its revision history is deliberately preserved (not dropped) for restore.
      const after = await request(server).get(`/api/v1/revisions/session/${tid}`).set(dm);
      expect(after.status).toBe(200);
      expect(after.body).toHaveLength(1);
    });
  });

  describe('quests (body)', () => {
    let questId: number;

    beforeAll(async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'The Sunken Crypt', body: 'qbody1' });
      expect(res.status).toBe(201);
      questId = res.body.id;
    });

    it('stale 409 leaves the body untouched; matching succeeds and snapshots the prior body', async () => {
      const server = ctx.app.getHttpServer();
      const conflict = await request(server)
        .patch(`/api/v1/quests/${questId}`)
        .set(dm)
        .send({ body: 'CLOBBER', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
      expect(conflict.status).toBe(409);

      const mid = await request(server).get(`/api/v1/quests/${questId}`).set(dm);
      expect(mid.body.body).toBe('qbody1');

      const ok = await request(server)
        .patch(`/api/v1/quests/${questId}`)
        .set(dm)
        .send({ body: 'qbody2', expectedUpdatedAt: mid.body.updatedAt });
      expect(ok.status).toBe(200);

      const revs = await request(server).get(`/api/v1/revisions/quest/${questId}`).set(dm);
      expect(revs.status).toBe(200);
      expect(revs.body).toHaveLength(1);
      expect(revs.body[0].snapshot.body).toBe('qbody1');
    });
  });

  describe('notes (concurrency only — no history endpoint)', () => {
    let noteId: number;

    beforeAll(async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .set(dm)
        .send({ body: 'note-v1', visibility: 'private' });
      expect(res.status).toBe(201);
      noteId = res.body.id;
    });

    it('a stale expectedUpdatedAt PATCH 409s; a matching one succeeds', async () => {
      const server = ctx.app.getHttpServer();
      const conflict = await request(server)
        .patch(`/api/v1/notes/${noteId}`)
        .set(dm)
        .send({ body: 'CLOBBER', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
      expect(conflict.status).toBe(409);

      const current = await request(server).get(`/api/v1/notes/${noteId}`).set(dm);
      expect(current.body.body).toBe('note-v1'); // untouched

      const ok = await request(server)
        .patch(`/api/v1/notes/${noteId}`)
        .set(dm)
        .send({ body: 'note-v2', expectedUpdatedAt: current.body.updatedAt });
      expect(ok.status).toBe(200);
      expect(ok.body.body).toBe('note-v2');
    });

    it('the revision-history endpoint rejects note as an unsupported entity type', async () => {
      const server = ctx.app.getHttpServer();
      const revs = await request(server).get(`/api/v1/revisions/note/${noteId}`).set(dm);
      expect(revs.status).toBe(400);
    });
  });
});
