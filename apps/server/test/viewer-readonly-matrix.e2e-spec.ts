import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #1480 — a cross-module matrix that pins a VIEWER's read-only boundary
 * across every mutating surface, so the `requireMember(..., { write: true })` →
 * `requireMemberOnWritableCampaign` rename cannot silently regress either way:
 *
 *  - UNDER-block (the original bug class): a viewer reaches a genuine mutation
 *    it must not — content writes (dm/player-gated) and member-level OUTBOUND
 *    writes (comments, DM-inbox, shared notes) that reach other seats. The
 *    outbound half is enforced by the interactive-seat gate (#597), which the
 *    renamed member-writable gate now feeds; this spec asserts that wiring
 *    survives the rename.
 *
 *  - OVER-block (the rename's failure mode): the legitimate any-member PERSONAL
 *    writes — setting your own RSVP, keeping a private note, submitting a
 *    proposal for DM review — must keep working for a viewer, or "read-only"
 *    has become "cannot use the table at all".
 *
 * Companion specs: `safety-controls.e2e-spec.ts` deep-dives the #597 interactive
 * capability with real sessions; `campaign-archive.e2e-spec.ts` covers the same
 * routes' archived-campaign (read-only) behaviour, including the four Category 3
 * gates this issue added. This spec is the active-campaign baseline for a viewer.
 */
describe('viewer seat read-only matrix across mutating routes (issue #1480, e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;
  let sessionId: number;
  let scheduleId: number;

  const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'vrm-dm' };
  const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'vrm-viewer' };

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();

    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Viewer Matrix Table' });
    expect(camp.status).toBe(201);
    campaignId = camp.body.id;

    const sess = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ title: 'Matrix Session' });
    expect(sess.status).toBe(201);
    sessionId = sess.body.id;

    const schedule = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-01-01T18:00:00Z', durationMinutes: 180 });
    expect(schedule.status).toBe(201);
    scheduleId = schedule.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('a viewer cannot mutate campaign content or reach other seats', () => {
    it('refuses dm-gated content writes (quests, npcs, locations, encounters, sessions, schedule)', async () => {
      expect((await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(viewer).send({ title: 'Nope' })).status).toBe(403);
      expect((await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(viewer).send({ name: 'Nope' })).status).toBe(403);
      expect((await request(server).post(`/api/v1/campaigns/${campaignId}/locations`).set(viewer).send({ name: 'Nope' })).status).toBe(403);
      expect((await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(viewer).send({ name: 'Nope' })).status).toBe(403);
      expect((await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(viewer).send({ title: 'Nope' })).status).toBe(403);
      expect(
        (await request(server).post(`/api/v1/campaigns/${campaignId}/schedule`).set(viewer).send({ scheduledAt: '2099-02-02T18:00:00Z' })).status,
      ).toBe(403);
    });

    it('refuses player-gated content writes (character create)', async () => {
      expect((await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(viewer).send({ name: 'Nope' })).status).toBe(403);
    });

    it('refuses member-level OUTBOUND writes that reach other seats (comments, DM-inbox, shared notes)', async () => {
      // Comments reach everyone who can see the thread — interactive seat required (#597).
      const comment = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(viewer)
        .send({ entityType: 'session', entityId: sessionId, body: 'viewer comment' });
      expect(comment.status).toBe(403);

      // DM-inbox fans out notifications to every DM — interactive seat required.
      const inbox = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inbox`)
        .set(viewer)
        .send({ authorName: 'viewer', body: 'viewer inbox item' });
      expect(inbox.status).toBe(403);

      // An outbound note visibility reaches other members — interactive seat required.
      const shared = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .set(viewer)
        .send({ body: 'viewer broadcast', visibility: 'party_shared' });
      expect(shared.status).toBe(403);
    });
  });

  describe('a viewer may still take personal, non-broadcast actions (no over-block)', () => {
    it('allows setting your own RSVP on an active campaign', async () => {
      const rsvp = await request(server).put(`/api/v1/schedule/${scheduleId}/rsvp`).set(viewer).send({ status: 'yes' });
      expect(rsvp.status).toBe(200);
    });

    it('allows keeping a private note (reaches nobody — the point of the seat)', async () => {
      const note = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .set(viewer)
        .send({ body: 'my own private note', visibility: 'private' });
      expect(note.status).toBe(201);
      expect(note.body.visibility).toBe('private');
    });

    it('allows submitting a proposal for DM review (?proposed=true is any-member)', async () => {
      const proposal = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`)
        .set(viewer)
        .send({ title: 'Viewer-suggested quest' });
      expect(proposal.status).toBe(202);
      expect(proposal.body.proposal).toBeDefined();
    });
  });
});
