import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };

// Minimal valid 1x1 PNG — same fixture as attachments.e2e-spec.ts / campaigns.e2e-spec.ts.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

/**
 * Issue #16 — campaign archive: paused/completed used to be cosmetic; now they
 * mean READ-ONLY. Every write (dm-gated, player-gated, and member-level —
 * notes, inbox, proposals, dice rolls, attachments, members) 403s while the
 * campaign is archived; reads (incl. dm-only ones: audit, export, inbox list,
 * proposal list) keep working; and the only allowed campaign PATCH while
 * archived is flipping `status` itself. DELETE stays allowed so a dead
 * campaign can be removed without resurrecting it first.
 */
describe('campaign archive read-only enforcement (e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;
  let questId: number;
  let npcId: number;
  let noteId: number;
  let attachmentId: number;
  let proposalId: number;
  let scheduleId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();

    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'The Finished Saga' });
    expect(campRes.status).toBe(201);
    campaignId = campRes.body.id;

    const questRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Last Quest', hidden: false });
    expect(questRes.status).toBe(201);
    questId = questRes.body.id;

    const npcRes = await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Old Friend', hidden: false });
    expect(npcRes.status).toBe(201);
    npcId = npcRes.body.id;

    const noteRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(dm)
      .send({ body: 'A note from the good old days', visibility: 'party_shared' });
    expect(noteRes.status).toBe(201);
    noteId = noteRes.body.id;

    const uploadRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: 'memory.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
    attachmentId = uploadRes.body.id;
    // Images are DM-only by default (issue #97); reveal it so the player-visible
    // "reads still work while archived" assertion below exercises a shared handout.
    const revealRes = await request(server).post(`/api/v1/attachments/${attachmentId}/reveal`).set(dm);
    expect(revealRes.status).toBe(201);

    // A pending proposal from before the archive — must NOT be approvable while archived.
    const proposalRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
      .set(player)
      .send({ title: 'Proposed While Active' });
    expect(proposalRes.status).toBe(202);
    proposalId = proposalRes.body.proposal.id;

    // A scheduled game night created while active — used to assert the archive
    // gate covers the RSVP upsert (issue #1480 Category 3).
    const scheduleRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-01-01T18:00:00Z', durationMinutes: 180 });
    expect(scheduleRes.status).toBe(201);
    scheduleId = scheduleRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('DM archives the campaign (PATCH status=completed)', async () => {
    const res = await request(server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ status: 'completed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  });

  describe('while completed: reads still work', () => {
    it('GET campaign / summary / quests / notes', async () => {
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm)).status).toBe(200);
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(dm)).status).toBe(200);
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}/quests`).set(player)).status).toBe(200);
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}/notes`).set(player)).status).toBe(200);
      expect((await request(server).get(`/api/v1/quests/${questId}`).set(player)).status).toBe(200);
    });

    it('dm-only reads: audit log, export, inbox list, proposal list', async () => {
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm)).status).toBe(200);
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}/export?format=json`).set(dm)).status).toBe(200);
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}/inbox`).set(dm)).status).toBe(200);
      expect((await request(server).get(`/api/v1/campaigns/${campaignId}/proposals`).set(dm)).status).toBe(200);
    });

    it('attachment bytes still stream', async () => {
      const res = await request(server).get(`/api/v1/attachments/${attachmentId}/file`).set(player);
      expect(res.status).toBe(200);
    });
  });

  describe('while completed: writes are 403 read-only', () => {
    it('dm entity writes: quest create/update/delete, npc, encounter, character, member add', async () => {
      const create = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Too Late' });
      expect(create.status).toBe(403);
      expect(create.body.message).toContain('read-only');

      expect((await request(server).patch(`/api/v1/quests/${questId}`).set(dm).send({ title: 'Renamed' })).status).toBe(403);
      expect((await request(server).delete(`/api/v1/quests/${questId}`).set(dm)).status).toBe(403);
      expect((await request(server).post(`/api/v1/quests/${questId}/status`).set(dm).send({ status: 'completed' })).status).toBe(403);
      expect((await request(server).patch(`/api/v1/npcs/${npcId}`).set(dm).send({ name: 'Renamed Friend' })).status).toBe(403);
      expect((await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Too Late Fight' })).status).toBe(403);
      expect((await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Too Late Hero' })).status).toBe(403);
      expect((await request(server).post(`/api/v1/campaigns/${campaignId}/members`).set(dm).send({ userId: 999, role: 'player' })).status).toBe(403);
    });

    it('member-level writes: notes, inbox, note edit/delete, dice roll', async () => {
      expect((await request(server).post(`/api/v1/campaigns/${campaignId}/notes`).set(player).send({ body: 'Too late note' })).status).toBe(403);
      expect((await request(server).post(`/api/v1/campaigns/${campaignId}/inbox`).set(player).send({ authorName: 'p', body: 'Hello?' })).status).toBe(403);
      expect((await request(server).patch(`/api/v1/notes/${noteId}`).set(dm).send({ body: 'Edited' })).status).toBe(403);
      expect((await request(server).delete(`/api/v1/notes/${noteId}`).set(dm)).status).toBe(403);
      expect((await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(player).send({ expr: '1d20+3' })).status).toBe(403);
    });

    it('proposal submission and resolution are blocked', async () => {
      const propose = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
        .set(player)
        .send({ title: 'Proposed Too Late' });
      expect(propose.status).toBe(403);

      const approve = await request(server).post(`/api/v1/proposals/${proposalId}/approve`).set(dm).send({});
      expect(approve.status).toBe(403);
      const reject = await request(server).post(`/api/v1/proposals/${proposalId}/reject`).set(dm).send({});
      expect(reject.status).toBe(403);
    });

    it('member-level writes that used to skip the archive gate: RSVP, proposal withdraw/revise (issue #1480)', async () => {
      // RSVP upsert — any member; the archive gate now applies.
      const rsvp = await request(server).put(`/api/v1/schedule/${scheduleId}/rsvp`).set(player).send({ status: 'yes' });
      expect(rsvp.status).toBe(403);
      expect(rsvp.body.message).toContain('read-only');

      // Proposal withdraw — the player IS the proposer, but the archive gate still
      // refuses the edit on a frozen campaign.
      const withdraw = await request(server).post(`/api/v1/proposals/${proposalId}/withdraw`).set(player);
      expect(withdraw.status).toBe(403);
      expect(withdraw.body.message).toContain('read-only');

      // Proposal revise — same gate, fires before payload validation.
      const revise = await request(server)
        .patch(`/api/v1/proposals/${proposalId}`)
        .set(player)
        .send({ payload: { title: 'Revised While Archived' } });
      expect(revise.status).toBe(403);
      expect(revise.body.message).toContain('read-only');
    });

    it('catch-up mark is EXEMPT from the archive gate — personal read-state (issue #1480)', async () => {
      // The catch-up cursor is the caller's OWN per-user read marker (consumed
      // by GET /catch-up); nobody else can observe it, so the archive read-only
      // gate must NOT fire — otherwise the dashboard banner is un-dismissible on
      // a paused/completed campaign. This dev-auth player has no numeric id, so
      // the request passes the gate and reaches the numeric-user guard (400),
      // NOT a 403 read-only: the archive gate was skipped. The full 201 path
      // for a real authenticated member is covered in catch-up.e2e-spec.ts.
      const mark = await request(server).post(`/api/v1/campaigns/${campaignId}/catch-up/mark`).set(player).send({});
      expect(mark.status).not.toBe(403);
    });

    it('attachment upload and delete are blocked', async () => {
      const upload = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/attachments`)
        .set(dm)
        .field('kind', 'image')
        .attach('file', TINY_PNG, { filename: 'late.png', contentType: 'image/png' });
      expect(upload.status).toBe(403);

      expect((await request(server).delete(`/api/v1/attachments/${attachmentId}`).set(dm)).status).toBe(403);
    });

    it('campaign PATCH is restricted to status-only', async () => {
      const descPatch = await request(server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ description: 'Epilogue' });
      expect(descPatch.status).toBe(403);
      expect(descPatch.body.message).toContain('read-only');

      // mixing status with another field is rejected too — un-archive first
      const mixed = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}`)
        .set(dm)
        .send({ status: 'active', description: 'Sneaky combo' });
      expect(mixed.status).toBe(403);
    });
  });

  it('paused is read-only too (archived <-> archived status flips are allowed)', async () => {
    const toPaused = await request(server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ status: 'paused' });
    expect(toPaused.status).toBe(200);
    expect(toPaused.body.status).toBe('paused');

    const npcCreate = await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Paused NPC' });
    expect(npcCreate.status).toBe(403);
  });

  it('un-archiving (status=active) restores full write access', async () => {
    const unarchive = await request(server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ status: 'active' });
    expect(unarchive.status).toBe(200);
    expect(unarchive.body.status).toBe('active');

    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Sequel Hook' })).status).toBe(201);
    expect((await request(server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ description: 'Back in business' })).status).toBe(200);
    expect((await request(server).post(`/api/v1/proposals/${proposalId}/approve`).set(dm).send({})).status).toBe(201);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(player).send({ expr: '1d20' })).status).toBe(201);
  });

  it('an archived campaign can still be deleted without un-archiving first', async () => {
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Doomed Archived Campaign' });
    const doomedId = campRes.body.id;
    expect((await request(server).patch(`/api/v1/campaigns/${doomedId}`).set(dm).send({ status: 'completed' })).status).toBe(200);

    const del = await request(server).delete(`/api/v1/campaigns/${doomedId}`).set(dm);
    expect(del.status).toBe(200);
    expect((await request(server).get(`/api/v1/campaigns/${doomedId}`).set(dm)).status).toBe(404);
  });

  it('creating a campaign directly as completed lands it archived (writes blocked from birth)', async () => {
    const campRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Born Finished', status: 'completed' });
    expect(campRes.status).toBe(201);
    const id = campRes.body.id;
    expect((await request(server).post(`/api/v1/campaigns/${id}/quests`).set(dm).send({ title: 'Nope' })).status).toBe(403);
  });
});
