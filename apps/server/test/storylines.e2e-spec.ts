import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('storylines (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Storyline Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('create arc -> add beats -> branch between them -> set statuses -> list embeds the graph', async () => {
    const server = ctx.app.getHttpServer();

    const arcRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/arcs`)
      .set(dm)
      .send({ title: 'The Dragon Awakens', summary: 'Central arc.' });
    expect(arcRes.status).toBe(201);
    const arcId = arcRes.body.id;
    expect(arcRes.body.status).toBe('planned');
    expect(arcRes.body.campaignId).toBe(campaignId);

    const beat1Res = await request(server)
      .post(`/api/v1/arcs/${arcId}/beats`)
      .set(dm)
      .send({ title: 'The village burns' });
    expect(beat1Res.status).toBe(201);
    const beat1 = beat1Res.body.id;
    expect(beat1Res.body.arcId).toBe(arcId);
    expect(beat1Res.body.status).toBe('planned');

    const beat2Res = await request(server)
      .post(`/api/v1/arcs/${arcId}/beats`)
      .set(dm)
      .send({ title: 'Confront the dragon', status: 'planned' });
    expect(beat2Res.status).toBe(201);
    const beat2 = beat2Res.body.id;
    // Appended after beat1 by default.
    expect(beat2Res.body.sortOrder).toBeGreaterThan(beat1Res.body.sortOrder);

    // Branch from beat1 -> beat2 with a trigger label.
    const branchRes = await request(server)
      .post(`/api/v1/beats/${beat1}/branches`)
      .set(dm)
      .send({ label: 'if the party investigates the smoke', toBeatId: beat2 });
    expect(branchRes.status).toBe(201);
    const branchId = branchRes.body.id;
    expect(branchRes.body.toBeatId).toBe(beat2);
    expect(branchRes.body.beatId).toBe(beat1);

    // Open-ended branch with no destination yet.
    const branch2Res = await request(server)
      .post(`/api/v1/beats/${beat1}/branches`)
      .set(dm)
      .send({ label: 'if they flee' });
    expect(branch2Res.status).toBe(201);
    expect(branch2Res.body.toBeatId).toBeNull();

    const statusRes = await request(server)
      .post(`/api/v1/beats/${beat1}/status`)
      .set(dm)
      .send({ status: 'active' });
    expect(statusRes.status).toBe(201);
    expect(statusRes.body.status).toBe('active');

    const arcStatusRes = await request(server)
      .post(`/api/v1/arcs/${arcId}/status`)
      .set(dm)
      .send({ status: 'active' });
    expect(arcStatusRes.status).toBe(201);
    expect(arcStatusRes.body.status).toBe('active');

    // List embeds beats (ordered) each with their branches (ordered).
    const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/arcs`).set(dm);
    expect(listRes.status).toBe(200);
    const arc = listRes.body.find((a: { id: number }) => a.id === arcId);
    expect(arc.beats).toHaveLength(2);
    expect(arc.beats[0].id).toBe(beat1);
    expect(arc.beats[0].status).toBe('active');
    expect(arc.beats[0].branches).toHaveLength(2);
    expect(arc.beats[0].branches[0].id).toBe(branchId);
    expect(arc.beats[1].id).toBe(beat2);

    // Remove a branch.
    const rmBranch = await request(server).delete(`/api/v1/beats/${beat1}/branches/${branchId}`).set(dm);
    expect(rmBranch.status).toBe(200);
    const beatAfter = await request(server).get(`/api/v1/beats/${beat1}`).set(dm);
    expect(beatAfter.body.branches).toHaveLength(1);
  });

  it('rejects a branch whose toBeatId is not a beat in the campaign (400)', async () => {
    const server = ctx.app.getHttpServer();
    const arcRes = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Arc B' });
    const beatRes = await request(server).post(`/api/v1/arcs/${arcRes.body.id}/beats`).set(dm).send({ title: 'Beat B' });
    const bad = await request(server)
      .post(`/api/v1/beats/${beatRes.body.id}/branches`)
      .set(dm)
      .send({ label: 'nowhere', toBeatId: 999999 });
    expect(bad.status).toBe(400);
  });

  it('is DM-only: players and viewers get 403 on reads and writes', async () => {
    const server = ctx.app.getHttpServer();
    const arcRes = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Secret Arc' });
    const arcId = arcRes.body.id;

    // Player cannot create an arc.
    const pCreate = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(player).send({ title: 'Nope' });
    expect(pCreate.status).toBe(403);

    // Player/viewer cannot read the arc list (DM-only planning surface).
    expect((await request(server).get(`/api/v1/campaigns/${campaignId}/arcs`).set(player)).status).toBe(403);
    expect((await request(server).get(`/api/v1/campaigns/${campaignId}/arcs`).set(viewer)).status).toBe(403);
    expect((await request(server).get(`/api/v1/arcs/${arcId}`).set(player)).status).toBe(403);

    // Player cannot add a beat.
    const pBeat = await request(server).post(`/api/v1/arcs/${arcId}/beats`).set(player).send({ title: 'Nope' });
    expect(pBeat.status).toBe(403);
  });

  it('rejects unknown keys (strict DTO -> 400)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/arcs`)
      .set(dm)
      .send({ title: 'Arc', bogusKey: true });
    expect(res.status).toBe(400);
  });

  it('deleting an arc cascades to its beats and branches', async () => {
    const server = ctx.app.getHttpServer();
    const arcRes = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Doomed Arc' });
    const arcId = arcRes.body.id;
    const beatRes = await request(server).post(`/api/v1/arcs/${arcId}/beats`).set(dm).send({ title: 'Doomed Beat' });
    const beatId = beatRes.body.id;
    await request(server).post(`/api/v1/beats/${beatId}/branches`).set(dm).send({ label: 'x' });

    const del = await request(server).delete(`/api/v1/arcs/${arcId}`).set(dm);
    expect(del.status).toBe(200);

    expect((await request(server).get(`/api/v1/arcs/${arcId}`).set(dm)).status).toBe(404);
    expect((await request(server).get(`/api/v1/beats/${beatId}`).set(dm)).status).toBe(404);
  });

  // Issue #264: a beat links to the play record it corresponds to (session/quest/encounter),
  // the links validate same-campaign membership, and they round-trip on read.
  it('links a beat to session/quest/encounter, rejects cross-campaign refs, and round-trips', async () => {
    const server = ctx.app.getHttpServer();

    // Play records to link to, all in THIS campaign.
    const session = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number: 42 });
    const quest = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Expose the Duke' });
    const encounter = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Throne Room Betrayal' });
    const sessionId = session.body.id;
    const questId = quest.body.id;
    const encounterId = encounter.body.id;

    const arcRes = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Betrayal Arc' });
    const arcId = arcRes.body.id;

    // Create a beat carrying all three links at once — they persist on the create response.
    const beatRes = await request(server)
      .post(`/api/v1/arcs/${arcId}/beats`)
      .set(dm)
      .send({ title: 'The duke betrays the party', sessionId, questId, encounterId });
    expect(beatRes.status).toBe(201);
    const beatId = beatRes.body.id;
    expect(beatRes.body.sessionId).toBe(sessionId);
    expect(beatRes.body.questId).toBe(questId);
    expect(beatRes.body.encounterId).toBe(encounterId);

    // Round-trips on a direct read.
    const getRes = await request(server).get(`/api/v1/beats/${beatId}`).set(dm);
    expect(getRes.body).toMatchObject({ sessionId, questId, encounterId });

    // And on the arc list read that embeds beats.
    const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/arcs`).set(dm);
    const listedArc = listRes.body.find((a: { id: number }) => a.id === arcId);
    const listedBeat = listedArc.beats.find((b: { id: number }) => b.id === beatId);
    expect(listedBeat).toMatchObject({ sessionId, questId, encounterId });

    // An update can clear a link (null) and change another; omitted links stay put.
    const patchRes = await request(server)
      .patch(`/api/v1/beats/${beatId}`)
      .set(dm)
      .send({ questId: null });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.questId).toBeNull();
    expect(patchRes.body.sessionId).toBe(sessionId); // untouched
    expect(patchRes.body.encounterId).toBe(encounterId); // untouched

    // Cross-campaign refs are rejected. A second campaign owns its own play records.
    const other = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Campaign' });
    const otherId = other.body.id;
    const otherSession = await request(server).post(`/api/v1/campaigns/${otherId}/sessions`).set(dm).send({ number: 1 });
    const otherQuest = await request(server).post(`/api/v1/campaigns/${otherId}/quests`).set(dm).send({ title: 'Elsewhere' });
    const otherEncounter = await request(server).post(`/api/v1/campaigns/${otherId}/encounters`).set(dm).send({ name: 'Elsewhere Fight' });

    // On create.
    const badSession = await request(server)
      .post(`/api/v1/arcs/${arcId}/beats`)
      .set(dm)
      .send({ title: 'Bad session link', sessionId: otherSession.body.id });
    expect(badSession.status).toBe(400);

    // On update, for each of the three link kinds.
    expect((await request(server).patch(`/api/v1/beats/${beatId}`).set(dm).send({ questId: otherQuest.body.id })).status).toBe(400);
    expect((await request(server).patch(`/api/v1/beats/${beatId}`).set(dm).send({ encounterId: otherEncounter.body.id })).status).toBe(400);
    expect((await request(server).patch(`/api/v1/beats/${beatId}`).set(dm).send({ sessionId: otherSession.body.id })).status).toBe(400);

    // A rejected update leaves the beat's existing links intact.
    const afterReject = await request(server).get(`/api/v1/beats/${beatId}`).set(dm);
    expect(afterReject.body).toMatchObject({ sessionId, questId: null, encounterId });

    // A nonexistent ref is likewise rejected.
    expect((await request(server).patch(`/api/v1/beats/${beatId}`).set(dm).send({ sessionId: 999999 })).status).toBe(400);
  });
});
