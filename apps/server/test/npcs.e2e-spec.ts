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
});
