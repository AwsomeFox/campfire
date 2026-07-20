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
});
