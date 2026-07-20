import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('npcs (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name: 'NPC Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('dmSecret visible to dm but absent for player and viewer', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Mayor Higgins', dmSecret: 'Is actually a doppelganger' });
    expect(createRes.status).toBe(201);
    const npcId = createRes.body.id;
    expect(createRes.body.dmSecret).toBe('Is actually a doppelganger');

    const dmGet = await request(server).get(`/api/v1/npcs/${npcId}`).set(dm);
    expect(dmGet.body.dmSecret).toBe('Is actually a doppelganger');

    const playerGet = await request(server).get(`/api/v1/npcs/${npcId}`).set(player);
    expect(playerGet.status).toBe(200);
    expect(playerGet.body.dmSecret).toBeFalsy();

    const viewerGet = await request(server).get(`/api/v1/npcs/${npcId}`).set(viewer);
    expect(viewerGet.status).toBe(200);
    expect(viewerGet.body.dmSecret).toBeFalsy();

    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/npcs`).set(player);
    for (const n of playerList.body) {
      expect(n.dmSecret).toBeFalsy();
    }
  });

  it('canon writes are dm only', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(player)
      .send({ name: 'Should fail' });
    expect(res.status).toBe(403);
  });

  // Issue #96: npc.locationId is an FK-shaped field that must resolve to a real location
  // IN THE SAME campaign, or 400 — mirroring quest giverNpcId / member characterId guards.
  describe('FK validation: npc.locationId (issue #96)', () => {
    it('POST npc with a nonexistent locationId -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Ghost-pinned', locationId: 99999 });
      expect(res.status).toBe(400);
    });

    it('POST npc with a cross-campaign locationId -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const otherCamp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other NPC Campaign' });
      const locRes = await request(server)
        .post(`/api/v1/campaigns/${otherCamp.body.id}/locations`)
        .set(dm)
        .send({ name: 'Foreign Keep' });
      expect(locRes.status).toBe(201);

      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Cross-pinned', locationId: locRes.body.id });
      expect(res.status).toBe(400);
    });

    it('POST/PATCH npc with a valid same-campaign locationId -> 201/200', async () => {
      const server = ctx.app.getHttpServer();
      const locRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Home Village' });
      expect(locRes.status).toBe(201);

      const createRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Villager', locationId: locRes.body.id });
      expect(createRes.status).toBe(201);
      expect(createRes.body.locationId).toBe(locRes.body.id);

      const patchBad = await request(server).patch(`/api/v1/npcs/${createRes.body.id}`).set(dm).send({ locationId: 99999 });
      expect(patchBad.status).toBe(400);
    });
  });

  // Issue #96: deleting an NPC must null out any quest that credits it as giver, so the
  // quest never dangles on a deleted giverNpcId.
  describe('delete cleanup: npc giver on quests (issue #96)', () => {
    it('deleting an NPC nulls quests.giverNpcId', async () => {
      const server = ctx.app.getHttpServer();
      const npcRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Quest Giver' });
      expect(npcRes.status).toBe(201);
      const npcId = npcRes.body.id;

      const questRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'Slay the beast', giverNpcId: npcId });
      expect(questRes.status).toBe(201);
      expect(questRes.body.giverNpcId).toBe(npcId);
      const questId = questRes.body.id;

      const delRes = await request(server).delete(`/api/v1/npcs/${npcId}`).set(dm);
      expect(delRes.status).toBe(200);

      const questAfter = await request(server).get(`/api/v1/quests/${questId}`).set(dm);
      expect(questAfter.status).toBe(200);
      expect(questAfter.body.giverNpcId).toBeNull();
    });
  });
});
