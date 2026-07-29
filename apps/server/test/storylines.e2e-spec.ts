import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { StorylinesService } from '../src/modules/storylines/storylines.service';

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

  it('updates a branch label and retargets it to a beat created later (#1313)', async () => {
    const server = ctx.app.getHttpServer();
    const arcRes = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Arc C' });
    const arcId = arcRes.body.id;
    const beat1Res = await request(server).post(`/api/v1/arcs/${arcId}/beats`).set(dm).send({ title: 'Beat C1' });
    const beat1 = beat1Res.body.id;

    // Create a branch with no target yet (open branch).
    const openBranch = await request(server)
      .post(`/api/v1/beats/${beat1}/branches`)
      .set(dm)
      .send({ label: 'If the party flees' });
    expect(openBranch.status).toBe(201);
    expect(openBranch.body.toBeatId).toBeNull();
    const branchId = openBranch.body.id;

    // Later, create the destination beat.
    const beat2Res = await request(server).post(`/api/v1/arcs/${arcId}/beats`).set(dm).send({ title: 'Beat C2' });
    const beat2 = beat2Res.body.id;

    // Retarget the existing branch to the new beat and relabel.
    const updated = await request(server)
      .patch(`/api/v1/beats/${beat1}/branches/${branchId}`)
      .set(dm)
      .send({ label: 'If the party flees into the woods', toBeatId: beat2 });
    expect(updated.status).toBe(200);
    expect(updated.body.id).toBe(branchId);
    expect(updated.body.label).toBe('If the party flees into the woods');
    expect(updated.body.toBeatId).toBe(beat2);

    // Clear the target back to an open branch.
    const cleared = await request(server)
      .patch(`/api/v1/beats/${beat1}/branches/${branchId}`)
      .set(dm)
      .send({ toBeatId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.toBeatId).toBeNull();
    // Label is preserved when only toBeatId is patched.
    expect(cleared.body.label).toBe('If the party flees into the woods');

    // Rejects retargeting to a beat in a different campaign.
    const otherCampaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other campaign' });
    const otherArc = await request(server).post(`/api/v1/campaigns/${otherCampaign.body.id}/arcs`).set(dm).send({ title: 'Other arc' });
    const otherBeat = await request(server).post(`/api/v1/arcs/${otherArc.body.id}/beats`).set(dm).send({ title: 'Other beat' });
    const crossCampaign = await request(server)
      .patch(`/api/v1/beats/${beat1}/branches/${branchId}`)
      .set(dm)
      .send({ toBeatId: otherBeat.body.id });
    expect(crossCampaign.status).toBe(400);

    // Player cannot update a branch (DM-only).
    const pUpdate = await request(server)
      .patch(`/api/v1/beats/${beat1}/branches/${branchId}`)
      .set(player)
      .send({ label: 'hacked' });
    expect(pUpdate.status).toBe(403);
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

  it('restoring an arc leaves beats trashed before the arc deletion in the trash', async () => {
    const server = ctx.app.getHttpServer();
    const arc = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Selective restore' });
    const firstBeat = await request(server).post(`/api/v1/arcs/${arc.body.id}/beats`).set(dm).send({ title: 'Discarded idea' });
    const cascadeBeat = await request(server).post(`/api/v1/arcs/${arc.body.id}/beats`).set(dm).send({ title: 'Keep with arc' });

    expect((await request(server).delete(`/api/v1/beats/${firstBeat.body.id}`).set(dm)).status).toBe(200);
    expect((await request(server).delete(`/api/v1/arcs/${arc.body.id}`).set(dm)).status).toBe(200);

    const restored = await request(server).post(`/api/v1/arcs/${arc.body.id}/restore`).set(dm);
    expect(restored.status).toBe(201);
    expect(restored.body.beats.map((beat: { id: number }) => beat.id)).toEqual([cascadeBeat.body.id]);
    expect((await request(server).get(`/api/v1/beats/${firstBeat.body.id}`).set(dm)).status).toBe(404);
  });

  it('uses the current cascade marker when an arc is restored and trashed again during restore', async () => {
    const server = ctx.app.getHttpServer();
    const arc = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Racing restore' });
    const beat = await request(server).post(`/api/v1/arcs/${arc.body.id}/beats`).set(dm).send({ title: 'Restore with arc' });
    expect((await request(server).delete(`/api/v1/arcs/${arc.body.id}`).set(dm)).status).toBe(200);

    const storylines = ctx.app.get(StorylinesService) as unknown as {
      getArcRowOrThrow(id: number, includeDeleted?: boolean): Promise<unknown>;
    };
    const getArcRowOrThrow = storylines.getArcRowOrThrow.bind(storylines);
    let interleaved = false;
    const lookup = jest.spyOn(storylines, 'getArcRowOrThrow').mockImplementation(async (id, includeDeleted) => {
      const row = await getArcRowOrThrow(id, includeDeleted);
      if (!interleaved && id === arc.body.id && includeDeleted === true) {
        interleaved = true;
        expect((await request(server).post(`/api/v1/arcs/${arc.body.id}/restore`).set(dm)).status).toBe(201);
        expect((await request(server).delete(`/api/v1/arcs/${arc.body.id}`).set(dm)).status).toBe(200);
      }
      return row;
    });
    try {
      const restored = await request(server).post(`/api/v1/arcs/${arc.body.id}/restore`).set(dm);
      expect(restored.status).toBe(201);
      expect(restored.body.beats.map((item: { id: number }) => item.id)).toEqual([beat.body.id]);
    } finally {
      lookup.mockRestore();
    }
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

// Issue #856 / #881: arc summary and beat body authoring with optimistic concurrency.
describe('storylines prose authoring (#856)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (
      await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Prose Authoring Campaign' })
    ).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('creates an arc with markdown summary and a beat with markdown body', async () => {
    const server = ctx.app.getHttpServer();
    const arc = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/arcs`)
      .set(dm)
      .send({ title: 'Prose Arc', summary: '**Bold** arc overview' });
    expect(arc.status).toBe(201);
    expect(arc.body.summary).toBe('**Bold** arc overview');

    const beat = await request(server)
      .post(`/api/v1/arcs/${arc.body.id}/beats`)
      .set(dm)
      .send({ title: 'Prose Beat', body: '- first clue\n- second clue' });
    expect(beat.status).toBe(201);
    expect(beat.body.body).toBe('- first clue\n- second clue');
  });

  it('patches arc summary and beat body', async () => {
    const server = ctx.app.getHttpServer();
    const arc = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Patch Arc' });
    const beat = await request(server).post(`/api/v1/arcs/${arc.body.id}/beats`).set(dm).send({ title: 'Patch Beat' });

    const arcPatch = await request(server)
      .patch(`/api/v1/arcs/${arc.body.id}`)
      .set(dm)
      .send({ summary: 'Updated **summary**' });
    expect(arcPatch.status).toBe(200);
    expect(arcPatch.body.summary).toBe('Updated **summary**');

    const beatPatch = await request(server)
      .patch(`/api/v1/beats/${beat.body.id}`)
      .set(dm)
      .send({ body: 'Updated beat prose' });
    expect(beatPatch.status).toBe(200);
    expect(beatPatch.body.body).toBe('Updated beat prose');
  });
});

// Issue #881: optimistic concurrency for story arcs AND beats.
describe('storylines optimistic concurrency (#881)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (
      await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'SL OC Campaign' })
    ).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('arc: omitting expectedUpdatedAt is back-compat', async () => {
    const server = ctx.app.getHttpServer();
    const arc = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Original Arc' });
    const res = await request(server).patch(`/api/v1/arcs/${arc.body.id}`).set(dm).send({ title: 'Back compat' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Back compat');
  });

  it('arc: stale expectedUpdatedAt 409s with STALE_WRITE and does NOT mutate', async () => {
    const server = ctx.app.getHttpServer();
    const arc = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/arcs`)
      .set(dm)
      .send({ title: 'Stale Arc', summary: 'v1' });
    const before = await request(server).get(`/api/v1/arcs/${arc.body.id}`).set(dm);
    const conflict = await request(server)
      .patch(`/api/v1/arcs/${arc.body.id}`)
      .set(dm)
      .send({ summary: 'CLOBBER', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('STALE_WRITE');
    const after = await request(server).get(`/api/v1/arcs/${arc.body.id}`).set(dm);
    expect(after.body.summary).toBe('v1');
    expect(after.body.updatedAt).toBe(before.body.updatedAt);
  });

  it('arc: matching expectedUpdatedAt succeeds', async () => {
    const server = ctx.app.getHttpServer();
    const arc = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Match Arc' });
    const current = await request(server).get(`/api/v1/arcs/${arc.body.id}`).set(dm);
    const ok = await request(server)
      .patch(`/api/v1/arcs/${arc.body.id}`)
      .set(dm)
      .send({ title: 'Arc v2', expectedUpdatedAt: current.body.updatedAt });
    expect(ok.status).toBe(200);
    expect(ok.body.title).toBe('Arc v2');
  });

  it('arc: two concurrent updates — second (stale) 409s, first survives', async () => {
    const server = ctx.app.getHttpServer();
    const arc = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Concurrent Arc' });
    const loaded = await request(server).get(`/api/v1/arcs/${arc.body.id}`).set(dm);
    const loadedAt = loaded.body.updatedAt;

    const firstSave = await request(server)
      .patch(`/api/v1/arcs/${arc.body.id}`)
      .set(dm)
      .send({ summary: 'Tab A summary', expectedUpdatedAt: loadedAt });
    expect(firstSave.status).toBe(200);

    const staleSave = await request(server)
      .patch(`/api/v1/arcs/${arc.body.id}`)
      .set(dm)
      .send({ title: 'Tab B Wins', expectedUpdatedAt: loadedAt });
    expect(staleSave.status).toBe(409);
    expect(staleSave.body.code).toBe('STALE_WRITE');

    const after = await request(server).get(`/api/v1/arcs/${arc.body.id}`).set(dm);
    expect(after.body.title).toBe('Concurrent Arc');
    expect(after.body.summary).toBe('Tab A summary');
  });

  it('beat: stale expectedUpdatedAt 409s with STALE_WRITE and does NOT mutate body', async () => {
    const server = ctx.app.getHttpServer();
    const arc = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Beat Arc B' });
    const beat = await request(server)
      .post(`/api/v1/arcs/${arc.body.id}/beats`)
      .set(dm)
      .send({ title: 'Stale Beat', body: 'v1' });
    const before = await request(server).get(`/api/v1/beats/${beat.body.id}`).set(dm);
    const conflict = await request(server)
      .patch(`/api/v1/beats/${beat.body.id}`)
      .set(dm)
      .send({ body: 'CLOBBER', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('STALE_WRITE');
    const after = await request(server).get(`/api/v1/beats/${beat.body.id}`).set(dm);
    expect(after.body.body).toBe('v1');
    expect(after.body.updatedAt).toBe(before.body.updatedAt);
  });

  it('beat: two concurrent body updates — second (stale) 409s, first survives', async () => {
    const server = ctx.app.getHttpServer();
    const arc = await request(server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Beat Arc D' });
    const beat = await request(server).post(`/api/v1/arcs/${arc.body.id}/beats`).set(dm).send({ title: 'Concurrent Beat' });
    const loaded = await request(server).get(`/api/v1/beats/${beat.body.id}`).set(dm);
    const loadedAt = loaded.body.updatedAt;

    const firstSave = await request(server)
      .patch(`/api/v1/beats/${beat.body.id}`)
      .set(dm)
      .send({ body: 'Tab A body', expectedUpdatedAt: loadedAt });
    expect(firstSave.status).toBe(200);

    const staleSave = await request(server)
      .patch(`/api/v1/beats/${beat.body.id}`)
      .set(dm)
      .send({ title: 'Tab B Wins', expectedUpdatedAt: loadedAt });
    expect(staleSave.status).toBe(409);
    expect(staleSave.body.code).toBe('STALE_WRITE');

    const after = await request(server).get(`/api/v1/beats/${beat.body.id}`).set(dm);
    expect(after.body.title).toBe('Concurrent Beat');
    expect(after.body.body).toBe('Tab A body');
  });
});
