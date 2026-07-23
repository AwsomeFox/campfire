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
 *   - notes get the concurrency guard AND history — gated on the note's OWN visibility
 *     (a private note's history is invisible to a non-author, even a DM) and restore is
 *     author-only (issue #233).
 */
const authorPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'author-1' };
const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'other-1' };

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

  describe('npcs (body)', () => {
    let npcId: number;

    beforeAll(async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Varric', body: 'nbody1' });
      expect(res.status).toBe(201);
      npcId = res.body.id;
    });

    it('a stale expectedUpdatedAt PATCH 409s (the web-sent guard); a matching one succeeds + snapshots', async () => {
      const server = ctx.app.getHttpServer();
      const conflict = await request(server)
        .patch(`/api/v1/npcs/${npcId}`)
        .set(dm)
        .send({ body: 'CLOBBER', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('STALE_WRITE');

      const mid = await request(server).get(`/api/v1/npcs/${npcId}`).set(dm);
      expect(mid.body.body).toBe('nbody1'); // untouched

      const ok = await request(server)
        .patch(`/api/v1/npcs/${npcId}`)
        .set(dm)
        .send({ body: 'nbody2', expectedUpdatedAt: mid.body.updatedAt });
      expect(ok.status).toBe(200);

      const revs = await request(server).get(`/api/v1/revisions/npc/${npcId}`).set(dm);
      expect(revs.status).toBe(200);
      expect(revs.body).toHaveLength(1);
      expect(revs.body[0].snapshot.body).toBe('nbody1');
    });
  });

  describe('notes (concurrency + visibility-gated history — #233)', () => {
    let noteId: number;

    beforeAll(async () => {
      // A PRIVATE note authored by a player, so the redaction guard is exercised: its
      // history must stay invisible to everyone but the author (not even a DM).
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .set(authorPlayer)
        .send({ body: 'note-v1', visibility: 'private' });
      expect(res.status).toBe(201);
      noteId = res.body.id;
    });

    it('a stale expectedUpdatedAt PATCH 409s; a matching one succeeds and records the prior body', async () => {
      const server = ctx.app.getHttpServer();
      const conflict = await request(server)
        .patch(`/api/v1/notes/${noteId}`)
        .set(authorPlayer)
        .send({ body: 'CLOBBER', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
      expect(conflict.status).toBe(409);

      const current = await request(server).get(`/api/v1/notes/${noteId}`).set(authorPlayer);
      expect(current.body.body).toBe('note-v1'); // untouched

      const ok = await request(server)
        .patch(`/api/v1/notes/${noteId}`)
        .set(authorPlayer)
        .send({ body: 'note-v2', expectedUpdatedAt: current.body.updatedAt });
      expect(ok.status).toBe(200);
      expect(ok.body.body).toBe('note-v2');

      // The PRIOR body is now snapshotted into the note's revision history (#233).
      const revs = await request(server).get(`/api/v1/revisions/note/${noteId}`).set(authorPlayer);
      expect(revs.status).toBe(200);
      expect(revs.body).toHaveLength(1);
      expect(revs.body[0].snapshot.body).toBe('note-v1');
      expect(revs.body[0].entityType).toBe('note');
      expect(revs.body[0].entityId).toBe(noteId);
    });

    it("a private note's history is invisible to a non-author — even a DM (404, no redaction back-door)", async () => {
      const server = ctx.app.getHttpServer();
      // A blanket dm-gate would have leaked this; the note-visibility gate 404s instead.
      expect((await request(server).get(`/api/v1/revisions/note/${noteId}`).set(dm)).status).toBe(404);
      expect((await request(server).get(`/api/v1/revisions/note/${noteId}`).set(otherPlayer)).status).toBe(404);
    });

    it('restore is author-only and re-applies the prior body (itself recorded)', async () => {
      const server = ctx.app.getHttpServer();
      const revs = await request(server).get(`/api/v1/revisions/note/${noteId}`).set(authorPlayer);
      const revisionId = revs.body[0].id;

      // A non-author (even a DM who can't see the private note) cannot restore it.
      expect((await request(server).post(`/api/v1/revisions/note/${noteId}/${revisionId}/restore`).set(dm)).status).toBe(404);

      // The author restores 'note-v1'; the current 'note-v2' is captured first, so history grows to 2.
      const restore = await request(server)
        .post(`/api/v1/revisions/note/${noteId}/${revisionId}/restore`)
        .set(authorPlayer);
      expect(restore.status).toBe(201);
      expect(restore.body.revisions).toHaveLength(2);

      const after = await request(server).get(`/api/v1/notes/${noteId}`).set(authorPlayer);
      expect(after.body.body).toBe('note-v1'); // re-applied
    });

    it("a dm_shared note's history is visible to a DM, but restore stays author-only (403)", async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .set(authorPlayer)
        .send({ body: 'shared-v1', visibility: 'dm_shared' });
      const sharedId = created.body.id;

      const cur = await request(server).get(`/api/v1/notes/${sharedId}`).set(authorPlayer);
      await request(server)
        .patch(`/api/v1/notes/${sharedId}`)
        .set(authorPlayer)
        .send({ body: 'shared-v2', expectedUpdatedAt: cur.body.updatedAt });

      // The DM CAN see a dm_shared note, so its history lists for them (200)...
      const dmList = await request(server).get(`/api/v1/revisions/note/${sharedId}`).set(dm);
      expect(dmList.status).toBe(200);
      expect(dmList.body[0].snapshot.body).toBe('shared-v1');

      // ...but restoring a note's prose is an edit, so it remains author-only (403 for the DM).
      const revisionId = dmList.body[0].id;
      const dmRestore = await request(server).post(`/api/v1/revisions/note/${sharedId}/${revisionId}/restore`).set(dm);
      expect(dmRestore.status).toBe(403);
    });
  });
});

/**
 * Issue #813 — revision history must attribute versions to their real author, not the
 * replacing editor. Covers human→human, AI→human, human→AI, restore linkage, and
 * legacy-row honesty ("Replaced by …" when authorship is unknowable).
 */
describe('revision version authorship (e2e) — #813', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  const alice = { 'x-dev-role': 'dm', 'x-dev-user': 'alice' };
  const bob = { 'x-dev-role': 'dm', 'x-dev-user': 'bob' };

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(alice).send({ name: 'Authorship Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('human→human: Alice\'s version stays attributed to Alice when Bob overwrites it', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(alice)
      .send({ title: 'The Crossing', body: 'Alice wrote this' });
    expect(created.status).toBe(201);
    const questId = created.body.id;

    const ok = await request(server)
      .patch(`/api/v1/quests/${questId}`)
      .set(bob)
      .send({ body: 'Bob replaced it' });
    expect(ok.status).toBe(200);

    const revs = await request(server).get(`/api/v1/revisions/quest/${questId}`).set(alice);
    expect(revs.status).toBe(200);
    expect(revs.body).toHaveLength(1);
    const version = revs.body[0];
    expect(version.snapshot.body).toBe('Alice wrote this');
    expect(version.authorUserId).toBe('dev:alice');
    expect(version.authorName).toBe('alice');
    expect(version.authorSource).toBe('human');
    expect(version.authorshipKnown).toBe(true);
    expect(version.replacedByUserId).toBe('dev:bob');
    expect(version.replacedByName).toBe('bob');
    expect(version.replacedAt).toBeTruthy();
    // Replacer must not be presented as the version author.
    expect(version.authorUserId).not.toBe('dev:bob');
  });

  it('AI→human and human→AI preserve authorSource provenance on each version', async () => {
    const server = ctx.app.getHttpServer();
    // Drive RevisionsService directly with an AI seat principal — HTTP headers cannot
    // synthesize proposalAttribution, and a second HTTP patch would double-commit tips.
    const { RevisionsService } = await import('../src/modules/revisions/revisions.service');
    const revisions = ctx.app.get(RevisionsService);

    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(alice)
      .send({ name: 'Oracle', body: 'human draft' });
    const npcId = created.body.id;

    const aiUser = {
      id: `ai-dm-seat:${campaignId}`,
      name: 'AI Dungeon Master',
      serverRole: 'user' as const,
      devRole: 'dm' as const,
      tokenContext: {
        tokenId: 0,
        name: `ai-dm-seat:${campaignId}`,
        scope: 'dm' as const,
        writeScope: 'direct' as const,
        campaignId,
        adminEnabled: false,
      },
      proposalAttribution: {
        proposer: 'AI Dungeon Master (driver)',
        proposerUserId: `ai-dm:${campaignId}`,
        proposerToken: null,
      },
    };

    // human→AI: Alice's tip closed by AI, AI tip opened.
    await revisions.commitProseVersion({
      entityType: 'npc',
      entityId: npcId,
      campaignId,
      priorProse: 'human draft',
      nextProse: 'ai rewrite',
      user: aiUser,
    });

    // AI→human: AI tip closed by Bob.
    await revisions.commitProseVersion({
      entityType: 'npc',
      entityId: npcId,
      campaignId,
      priorProse: 'ai rewrite',
      nextProse: 'human polish',
      user: { id: 'dev:bob', name: 'bob', serverRole: 'user', devRole: 'dm' },
    });

    const listed = await revisions.listForEntity('npc', npcId);
    const aiVersion = listed.find((r) => r.snapshot.body === 'ai rewrite');
    const humanVersion = listed.find((r) => r.snapshot.body === 'human draft');
    expect(aiVersion).toBeDefined();
    expect(aiVersion!.authorSource).toBe('ai');
    expect(aiVersion!.authorUserId).toBe(`ai-dm:${campaignId}`);
    expect(aiVersion!.replacedBySource).toBe('human');
    expect(aiVersion!.replacedByUserId).toBe('dev:bob');

    expect(humanVersion).toBeDefined();
    expect(humanVersion!.authorSource).toBe('human');
    expect(humanVersion!.authorUserId).toBe('dev:alice');
    expect(humanVersion!.replacedBySource).toBe('ai');
  });

  it('restore creates a new tip linked to the source revision and attributes it to the restorer', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/locations`)
      .set(alice)
      .send({ name: 'Lantern Road', body: 'original' });
    const locationId = created.body.id;

    await request(server).patch(`/api/v1/locations/${locationId}`).set(bob).send({ body: 'edited' });
    const before = await request(server).get(`/api/v1/revisions/location/${locationId}`).set(alice);
    const sourceId = before.body[0].id;

    const restored = await request(server)
      .post(`/api/v1/revisions/location/${locationId}/${sourceId}/restore`)
      .set(bob);
    expect(restored.status).toBe(201);

    // Live tip is omitted from list; the closed pre-restore content should link when we
    // inspect via listForCampaign / DB. The restore itself closed Bob's "edited" tip —
    // and the NEW tip (restored prose) is live. After another edit we can see the restored tip.
    await request(server).patch(`/api/v1/locations/${locationId}`).set(alice).send({ body: 'after-restore' });
    const after = await request(server).get(`/api/v1/revisions/location/${locationId}`).set(alice);
    const restoredVersion = after.body.find((r: { snapshot: { body?: string } }) => r.snapshot.body === 'original');
    expect(restoredVersion).toBeDefined();
    // The restored tip was authored by Bob (the restorer), linked to the source.
    expect(restoredVersion.authorUserId).toBe('dev:bob');
    expect(restoredVersion.restoredFromRevisionId).toBe(sourceId);
    expect(restoredVersion.authorshipKnown).toBe(true);
  });

  it('legacy rows with unknown authorship expose authorshipKnown=false (honest "Replaced by" shape)', async () => {
    const server = ctx.app.getHttpServer();
    const { DB } = await import('../src/db/db.module');
    const db = ctx.app.get(DB);
    const { entityRevisions } = await import('../src/db/schema');

    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/factions`)
      .set(alice)
      .send({ name: 'Legacy Guild', body: 'current' });
    const factionId = created.body.id;

    // Insert a pre-#813-shaped legacy closed version directly.
    await db.insert(entityRevisions).values({
      campaignId,
      entityType: 'faction',
      entityId: factionId,
      snapshot: JSON.stringify({ body: 'ancient prose' }),
      authorUserId: '',
      authorName: '',
      authorSource: 'human',
      authorSourceDetail: '',
      createdAt: '',
      replacedByUserId: 'dev:bob',
      replacedByName: 'bob',
      replacedBySource: 'human',
      replacedBySourceDetail: '',
      replacedAt: '2024-01-01T00:00:00.000Z',
      restoredFromRevisionId: null,
      authorshipKnown: false,
    });

    const revs = await request(server).get(`/api/v1/revisions/faction/${factionId}`).set(alice);
    expect(revs.status).toBe(200);
    const legacy = revs.body.find((r: { snapshot: { body?: string } }) => r.snapshot.body === 'ancient prose');
    expect(legacy).toBeDefined();
    expect(legacy.authorshipKnown).toBe(false);
    expect(legacy.authorUserId).toBe('');
    expect(legacy.authorName).toBe('');
    expect(legacy.replacedByName).toBe('bob');
    expect(legacy.replacedAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('export/import preserves version authorship metadata with remapped ids', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(alice)
      .send({ title: 'Export Quest', body: 'v-export-a' });
    const questId = created.body.id;
    await request(server).patch(`/api/v1/quests/${questId}`).set(bob).send({ body: 'v-export-b' });

    const exported = await request(server).get(`/api/v1/campaigns/${campaignId}/export?format=json`).set(alice);
    expect(exported.status).toBe(200);
    expect(Array.isArray(exported.body.revisions)).toBe(true);
    const exportedRev = exported.body.revisions.find(
      (r: { entityType: string; snapshot: { body?: string } }) =>
        r.entityType === 'quest' && r.snapshot?.body === 'v-export-a',
    );
    expect(exportedRev).toBeDefined();
    expect(exportedRev.authorUserId).toBe('dev:alice');
    expect(exportedRev.replacedByUserId).toBe('dev:bob');
    expect(exportedRev.authorshipKnown).toBe(true);

    const imported = await request(server).post('/api/v1/campaigns/import').set(alice).send(exported.body);
    expect(imported.status).toBe(201);
    const newCampaignId = imported.body.id;
    expect(newCampaignId).toBeTruthy();
    expect(newCampaignId).not.toBe(campaignId);

    const quests = await request(server).get(`/api/v1/campaigns/${newCampaignId}/quests`).set(alice);
    const importedQuest = quests.body.find((q: { title: string }) => q.title === 'Export Quest');
    expect(importedQuest).toBeDefined();

    const revs = await request(server).get(`/api/v1/revisions/quest/${importedQuest.id}`).set(alice);
    expect(revs.status).toBe(200);
    const roundTripped = revs.body.find((r: { snapshot: { body?: string } }) => r.snapshot.body === 'v-export-a');
    expect(roundTripped).toBeDefined();
    expect(roundTripped.authorUserId).toBe('dev:alice');
    expect(roundTripped.replacedByUserId).toBe('dev:bob');
    expect(roundTripped.authorshipKnown).toBe(true);
    expect(roundTripped.entityId).toBe(importedQuest.id);
    expect(roundTripped.entityId).not.toBe(questId);
  });
});
