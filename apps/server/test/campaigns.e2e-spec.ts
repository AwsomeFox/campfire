import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

describe('campaigns (e2e)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('CRUD roundtrip', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'The Sunless Citadel', description: 'A classic.' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe('The Sunless Citadel');
    expect(createRes.body.sessionCount).toBe(0);
    const id = createRes.body.id;

    const listRes = await request(server).get('/api/v1/campaigns').set(dm);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((c: { id: number }) => c.id === id)).toBe(true);

    const getRes = await request(server).get(`/api/v1/campaigns/${id}`).set(dm);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(id);

    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${id}`)
      .set(dm)
      .send({ description: 'Updated description' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.description).toBe('Updated description');

    const deleteRes = await request(server).delete(`/api/v1/campaigns/${id}`).set(dm);
    expect(deleteRes.status).toBe(200);

    const getAfterDelete = await request(server).get(`/api/v1/campaigns/${id}`).set(dm);
    expect(getAfterDelete.status).toBe(404);
  });

  it('ruleSystem defaults to empty string and passes through create + PATCH', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Rule System Test' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.ruleSystem).toBe('');
    const id = createRes.body.id;

    const createWithRuleSystem = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Rule System Test 2', ruleSystem: 'dnd5e-srd' });
    expect(createWithRuleSystem.status).toBe(201);
    expect(createWithRuleSystem.body.ruleSystem).toBe('dnd5e-srd');

    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${id}`)
      .set(dm)
      .send({ ruleSystem: 'dnd5e-srd' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.ruleSystem).toBe('dnd5e-srd');

    const getRes = await request(server).get(`/api/v1/campaigns/${id}`).set(dm);
    expect(getRes.body.ruleSystem).toBe('dnd5e-srd');
  });

  it('GET /campaigns/:id/summary returns aggregate shape', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Summary Test' });
    const id = createRes.body.id;

    const summaryRes = await request(server).get(`/api/v1/campaigns/${id}/summary`).set(dm);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.campaign.id).toBe(id);
    expect(summaryRes.body.currentLocation).toBeNull();
    expect(Array.isArray(summaryRes.body.quests)).toBe(true);
    expect(Array.isArray(summaryRes.body.npcs)).toBe(true);
    expect(Array.isArray(summaryRes.body.locations)).toBe(true);
    expect(Array.isArray(summaryRes.body.characters)).toBe(true);
    expect(Array.isArray(summaryRes.body.sessions)).toBe(true);
    expect(summaryRes.body.openInboxCount).toBe(0);
  });

  it('POST /campaigns is open to any authenticated user (dev-auth headers count), not just dm', async () => {
    // Under the membership model, campaign creation itself is unrestricted for any
    // authenticated caller — the creator is auto-inserted as that campaign's 'dm'.
    // The old "dm role required" behavior is superseded by per-campaign membership.
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set({ 'x-dev-role': 'player', 'x-dev-user': 'p1' })
      .send({ name: 'Player-created campaign' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Player-created campaign');
  });

  it('POST /campaigns 400s on invalid body (zod validation)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({});
    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
  });
});
