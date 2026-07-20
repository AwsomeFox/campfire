import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('quests (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Quest Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('create -> add objective -> player toggles done -> dm sets status completed', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Slay the Kobolds', dmSecret: 'The kobolds are secretly allied with the dragon.' });
    expect(createRes.status).toBe(201);
    const questId = createRes.body.id;
    expect(createRes.body.status).toBe('available');

    const objRes = await request(server)
      .post(`/api/v1/quests/${questId}/objectives`)
      .set(dm)
      .send({ text: 'Find the kobold lair' });
    expect(objRes.status).toBe(201);
    const objectiveId = objRes.body.id;
    expect(objRes.body.done).toBe(false);

    const toggleRes = await request(server)
      .patch(`/api/v1/quests/${questId}/objectives/${objectiveId}`)
      .set(player)
      .send({ done: true });
    expect(toggleRes.status).toBe(200);
    expect(toggleRes.body.done).toBe(true);

    // player may NOT change objective text
    const textRes = await request(server)
      .patch(`/api/v1/quests/${questId}/objectives/${objectiveId}`)
      .set(player)
      .send({ text: 'Nope' });
    expect(textRes.status).toBe(403);

    const statusRes = await request(server)
      .post(`/api/v1/quests/${questId}/status`)
      .set(dm)
      .send({ status: 'completed' });
    expect(statusRes.status).toBe(201);
    expect(statusRes.body.status).toBe('completed');

    // player cannot set status
    const statusForbidden = await request(server)
      .post(`/api/v1/quests/${questId}/status`)
      .set(player)
      .send({ status: 'active' });
    expect(statusForbidden.status).toBe(403);
  });

  // Strict-validation (task P1 item 3): QuestCreateDto/QuestUpdateDto are now
  // .strict() at the DTO layer — an unrecognized key 400s instead of the global
  // ZodValidationPipe silently stripping it and 200/201-ing as a no-op/partial-create.
  it('unknown key in quest create/update body -> 400, not silently stripped', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Strict Quest', reard: 'typo, not reward' });
    expect(createRes.status).toBe(400);

    const okCreate = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Strict Quest' });
    expect(okCreate.status).toBe(201);

    const patchRes = await request(server)
      .patch(`/api/v1/quests/${okCreate.body.id}`)
      .set(dm)
      .send({ titel: 'Typo Field' });
    expect(patchRes.status).toBe(400);
  });

  it('dmSecret visible to dm but absent for player and viewer', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Secret Quest', dmSecret: 'top secret plot twist' });
    const questId = createRes.body.id;
    expect(createRes.body.dmSecret).toBe('top secret plot twist');

    const dmGet = await request(server).get(`/api/v1/quests/${questId}`).set(dm);
    expect(dmGet.body.dmSecret).toBe('top secret plot twist');

    const playerGet = await request(server).get(`/api/v1/quests/${questId}`).set(player);
    expect(playerGet.status).toBe(200);
    expect(playerGet.body.dmSecret).toBeFalsy();

    const viewerGet = await request(server).get(`/api/v1/quests/${questId}`).set(viewer);
    expect(viewerGet.status).toBe(200);
    expect(viewerGet.body.dmSecret).toBeFalsy();

    // list endpoint too
    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/quests`).set(player);
    expect(playerList.status).toBe(200);
    for (const q of playerList.body) {
      expect(q.dmSecret).toBeFalsy();
    }
  });

  it('viewer cannot create quest (403) but can post inbox', async () => {
    const server = ctx.app.getHttpServer();

    const questRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(viewer)
      .send({ title: 'Should fail' });
    expect(questRes.status).toBe(403);

    const inboxRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/inbox`)
      .set(viewer)
      .send({ body: 'I found a secret door!' });
    expect(inboxRes.status).toBe(201);
  });

  it('GET /campaigns/:id/quests embeds objectives per quest', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Quest with objectives' });
    const questId = createRes.body.id;

    await request(server).post(`/api/v1/quests/${questId}/objectives`).set(dm).send({ text: 'Objective A' });
    await request(server).post(`/api/v1/quests/${questId}/objectives`).set(dm).send({ text: 'Objective B' });

    const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/quests`).set(dm);
    expect(listRes.status).toBe(200);
    const found = listRes.body.find((q: { id: number }) => q.id === questId);
    expect(found).toBeDefined();
    expect(Array.isArray(found.objectives)).toBe(true);
    expect(found.objectives).toHaveLength(2);
    expect(found.objectives.map((o: { text: string }) => o.text).sort()).toEqual(['Objective A', 'Objective B']);

    // status filter still works alongside the embed
    const filteredRes = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/quests`)
      .query({ status: 'available' })
      .set(dm);
    expect(filteredRes.status).toBe(200);
    expect(filteredRes.body.every((q: { status: string }) => q.status === 'available')).toBe(true);
    expect(filteredRes.body.find((q: { id: number }) => q.id === questId).objectives).toHaveLength(2);
  });

  it('deleting a quest promotes its subquests to top level instead of orphaning them', async () => {
    const server = ctx.app.getHttpServer();

    const parentRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Parent quest' });
    const parentId = parentRes.body.id;

    const childRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Child quest', parentId });
    const childId = childRes.body.id;
    expect(childRes.body.parentId).toBe(parentId);

    const otherChildRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Other child quest', parentId });
    const otherChildId = otherChildRes.body.id;

    const deleteRes = await request(server).delete(`/api/v1/quests/${parentId}`).set(dm);
    expect(deleteRes.status).toBe(200);

    const childGet = await request(server).get(`/api/v1/quests/${childId}`).set(dm);
    expect(childGet.status).toBe(200);
    expect(childGet.body.parentId).toBeNull();

    const otherChildGet = await request(server).get(`/api/v1/quests/${otherChildId}`).set(dm);
    expect(otherChildGet.status).toBe(200);
    expect(otherChildGet.body.parentId).toBeNull();

    const parentGet = await request(server).get(`/api/v1/quests/${parentId}`).set(dm);
    expect(parentGet.status).toBe(404);
  });

  it('objective routes 404 when questId doesn\'t own the objective (cross-parent-id pin)', async () => {
    const server = ctx.app.getHttpServer();

    const questARes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Quest A' });
    const questAId = questARes.body.id;
    const questBRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Quest B' });
    const questBId = questBRes.body.id;

    const objRes = await request(server).post(`/api/v1/quests/${questAId}/objectives`).set(dm).send({ text: 'Belongs to A' });
    const objectiveId = objRes.body.id;

    // PATCH through the WRONG quest's route (questB, but objective belongs to questA) -> 404
    const wrongPatch = await request(server)
      .patch(`/api/v1/quests/${questBId}/objectives/${objectiveId}`)
      .set(dm)
      .send({ done: true });
    expect(wrongPatch.status).toBe(404);

    // DELETE through the WRONG quest's route -> 404
    const wrongDelete = await request(server).delete(`/api/v1/quests/${questBId}/objectives/${objectiveId}`).set(dm);
    expect(wrongDelete.status).toBe(404);

    // sanity: correct quest route still works
    const rightPatch = await request(server)
      .patch(`/api/v1/quests/${questAId}/objectives/${objectiveId}`)
      .set(dm)
      .send({ done: true });
    expect(rightPatch.status).toBe(200);
  });

  // P2 fix pinning tests — FK-shaped fields (parentId, giverNpcId) must resolve to a
  // real row IN THE SAME campaign, or 400.
  describe('FK validation: parentId / giverNpcId', () => {
    it('POST with a nonexistent parentId -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'Bad parent', parentId: 999999 });
      expect(res.status).toBe(400);
    });

    it('POST with a cross-campaign parentId -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const otherCampRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Quest Campaign' });
      const otherCampaignId = otherCampRes.body.id;
      const otherQuestRes = await request(server)
        .post(`/api/v1/campaigns/${otherCampaignId}/quests`)
        .set(dm)
        .send({ title: 'Quest in other campaign' });
      const otherQuestId = otherQuestRes.body.id;

      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'Cross-campaign parent', parentId: otherQuestId });
      expect(res.status).toBe(400);
    });

    it('PATCH quest to be its own parent -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const questRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Self parent test' });
      const questId = questRes.body.id;

      const res = await request(server).patch(`/api/v1/quests/${questId}`).set(dm).send({ parentId: questId });
      expect(res.status).toBe(400);
    });

    it('POST with a nonexistent giverNpcId -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'Bad giver npc', giverNpcId: 999999 });
      expect(res.status).toBe(400);
    });

    it('POST with a cross-campaign giverNpcId -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const otherCampRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Npc Campaign' });
      const otherCampaignId = otherCampRes.body.id;
      const npcRes = await request(server)
        .post(`/api/v1/campaigns/${otherCampaignId}/npcs`)
        .set(dm)
        .send({ name: 'NPC in other campaign' });
      const otherNpcId = npcRes.body.id;

      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'Cross-campaign giver', giverNpcId: otherNpcId });
      expect(res.status).toBe(400);
    });

    it('POST/PATCH with a valid same-campaign parentId and giverNpcId -> 200/201', async () => {
      const server = ctx.app.getHttpServer();
      const npcRes = await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Quest Giver' });
      const npcId = npcRes.body.id;
      const parentRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Valid parent quest' });
      const parentId = parentRes.body.id;

      const createRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'Valid child quest', parentId, giverNpcId: npcId });
      expect(createRes.status).toBe(201);
      expect(createRes.body.parentId).toBe(parentId);
      expect(createRes.body.giverNpcId).toBe(npcId);

      const patchRes = await request(server).patch(`/api/v1/quests/${createRes.body.id}`).set(dm).send({ giverNpcId: npcId });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.giverNpcId).toBe(npcId);
    });
  });

  // #95 — parent cycles (a quest cannot be its own ancestor) must be rejected with 400.
  describe('parent cycle rejection (#95)', () => {
    it('PATCH A parent=B when B parent=A -> 400 (direct 2-cycle)', async () => {
      const server = ctx.app.getHttpServer();
      const aRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Cycle A' });
      const aId = aRes.body.id;
      const bRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Cycle B', parentId: aId });
      const bId = bRes.body.id;
      expect(bRes.body.parentId).toBe(aId);

      // A -> B would close the loop A->B->A
      const res = await request(server).patch(`/api/v1/quests/${aId}`).set(dm).send({ parentId: bId });
      expect(res.status).toBe(400);

      // A must be untouched (still a root)
      const aGet = await request(server).get(`/api/v1/quests/${aId}`).set(dm);
      expect(aGet.body.parentId).toBeNull();
    });

    it('PATCH ancestor to descend from its own grandchild -> 400 (deep cycle)', async () => {
      const server = ctx.app.getHttpServer();
      const aRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Deep A' });
      const aId = aRes.body.id;
      const bRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Deep B', parentId: aId });
      const bId = bRes.body.id;
      const cRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Deep C', parentId: bId });
      const cId = cRes.body.id;

      // A -> C would close A->B->C->A
      const res = await request(server).patch(`/api/v1/quests/${aId}`).set(dm).send({ parentId: cId });
      expect(res.status).toBe(400);
    });

    it('reparenting to an unrelated quest still succeeds (no false positive)', async () => {
      const server = ctx.app.getHttpServer();
      const rootRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'New root' });
      const rootId = rootRes.body.id;
      const movableRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Movable' });
      const movableId = movableRes.body.id;

      const res = await request(server).patch(`/api/v1/quests/${movableId}`).set(dm).send({ parentId: rootId });
      expect(res.status).toBe(200);
      expect(res.body.parentId).toBe(rootId);
    });
  });

  // #100 — quest.sortOrder must actually order reads; objectives get max+1 on create and can be reordered.
  describe('ordering (#100)', () => {
    it('quest list is ordered by sortOrder, then id', async () => {
      const server = ctx.app.getHttpServer();
      const orderCampRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Order Campaign' });
      const oc = orderCampRes.body.id;

      // Create in an order that does NOT match desired sortOrder.
      const first = await request(server).post(`/api/v1/campaigns/${oc}/quests`).set(dm).send({ title: 'Third', sortOrder: 30 });
      const second = await request(server).post(`/api/v1/campaigns/${oc}/quests`).set(dm).send({ title: 'First', sortOrder: 10 });
      const third = await request(server).post(`/api/v1/campaigns/${oc}/quests`).set(dm).send({ title: 'Second', sortOrder: 20 });

      const listRes = await request(server).get(`/api/v1/campaigns/${oc}/quests`).set(dm);
      expect(listRes.status).toBe(200);
      const ids = listRes.body.map((q: { id: number }) => q.id);
      expect(ids).toEqual([second.body.id, third.body.id, first.body.id]);
      expect(listRes.body.map((q: { title: string }) => q.title)).toEqual(['First', 'Second', 'Third']);
    });

    it('new objectives are appended (max sortOrder + 1), preserving creation order', async () => {
      const server = ctx.app.getHttpServer();
      const qRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Objective order quest' });
      const qId = qRes.body.id;

      await request(server).post(`/api/v1/quests/${qId}/objectives`).set(dm).send({ text: 'Step 1' });
      await request(server).post(`/api/v1/quests/${qId}/objectives`).set(dm).send({ text: 'Step 2' });
      await request(server).post(`/api/v1/quests/${qId}/objectives`).set(dm).send({ text: 'Step 3' });

      const get = await request(server).get(`/api/v1/quests/${qId}`).set(dm);
      expect(get.body.objectives.map((o: { text: string }) => o.text)).toEqual(['Step 1', 'Step 2', 'Step 3']);
      const sorts = get.body.objectives.map((o: { sortOrder: number }) => o.sortOrder);
      expect(sorts).toEqual([...sorts].sort((a, b) => a - b));
      expect(new Set(sorts).size).toBe(3); // no collisions at 0
    });

    it('reorder endpoint reassigns objective order; honored in reads', async () => {
      const server = ctx.app.getHttpServer();
      const qRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Reorder quest' });
      const qId = qRes.body.id;
      const o1 = (await request(server).post(`/api/v1/quests/${qId}/objectives`).set(dm).send({ text: 'A' })).body.id;
      const o2 = (await request(server).post(`/api/v1/quests/${qId}/objectives`).set(dm).send({ text: 'B' })).body.id;
      const o3 = (await request(server).post(`/api/v1/quests/${qId}/objectives`).set(dm).send({ text: 'C' })).body.id;

      const reorderRes = await request(server)
        .post(`/api/v1/quests/${qId}/objectives/reorder`)
        .set(dm)
        .send({ objectiveIds: [o3, o1, o2] });
      expect(reorderRes.status).toBe(201);
      expect(reorderRes.body.map((o: { text: string }) => o.text)).toEqual(['C', 'A', 'B']);

      // Persisted + reflected on the quest read
      const get = await request(server).get(`/api/v1/quests/${qId}`).set(dm);
      expect(get.body.objectives.map((o: { text: string }) => o.text)).toEqual(['C', 'A', 'B']);
    });

    it('reorder with a non-permutation (missing/foreign id) -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const qRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Bad reorder quest' });
      const qId = qRes.body.id;
      const o1 = (await request(server).post(`/api/v1/quests/${qId}/objectives`).set(dm).send({ text: 'X' })).body.id;
      const o2 = (await request(server).post(`/api/v1/quests/${qId}/objectives`).set(dm).send({ text: 'Y' })).body.id;

      // partial list
      expect((await request(server).post(`/api/v1/quests/${qId}/objectives/reorder`).set(dm).send({ objectiveIds: [o1] })).status).toBe(400);
      // foreign id
      expect(
        (await request(server).post(`/api/v1/quests/${qId}/objectives/reorder`).set(dm).send({ objectiveIds: [o1, o2, 999999] })).status,
      ).toBe(400);
      // duplicate id
      expect(
        (await request(server).post(`/api/v1/quests/${qId}/objectives/reorder`).set(dm).send({ objectiveIds: [o1, o1] })).status,
      ).toBe(400);
    });

    it('player cannot reorder objectives (403)', async () => {
      const server = ctx.app.getHttpServer();
      const qRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Player reorder quest' });
      const qId = qRes.body.id;
      const o1 = (await request(server).post(`/api/v1/quests/${qId}/objectives`).set(dm).send({ text: 'M' })).body.id;
      const o2 = (await request(server).post(`/api/v1/quests/${qId}/objectives`).set(dm).send({ text: 'N' })).body.id;

      const res = await request(server).post(`/api/v1/quests/${qId}/objectives/reorder`).set(player).send({ objectiveIds: [o2, o1] });
      expect(res.status).toBe(403);
    });
  });
});
