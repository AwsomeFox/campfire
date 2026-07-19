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
});
