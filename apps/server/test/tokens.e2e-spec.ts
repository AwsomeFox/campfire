import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

describe('api tokens (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let otherAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let otherCampaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'token-dm', password: 'dm-password-1' });

    await dmAgent.post('/api/v1/users').send({ username: 'token-other', password: 'other-password-1', serverRole: 'user' });
    otherAgent = request.agent(server);
    await otherAgent.post('/api/v1/auth/login').send({ username: 'token-other', password: 'other-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Token Campaign' });
    campaignId = campRes.body.id;

    const otherCampRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Other Campaign' });
    otherCampaignId = otherCampRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('create -> raw token works as Bearer on /me and campaign routes', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await dmAgent.post('/api/v1/tokens').send({ name: 'my-dm-token', scope: 'dm' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.token).toMatch(/^cf_pat_[0-9a-f]{48}$/);
    expect(createRes.body.apiToken.tokenPrefix).toBe(createRes.body.token.slice(0, 11));
    const rawToken = createRes.body.token;

    const meRes = await request(server).get('/api/v1/me').set('Authorization', `Bearer ${rawToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.username).toBe('token-dm');

    const questRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set('Authorization', `Bearer ${rawToken}`)
      .send({ title: 'Token-created quest' });
    expect(questRes.status).toBe(201);
    expect(questRes.body.title).toBe('Token-created quest');

    // audit actor recorded as token:<name>
    const auditRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/audit`);
    const questCreateEntry = auditRes.body.find((a: { action: string }) => a.action === 'quest.create');
    expect(questCreateEntry.actor).toBe('token:my-dm-token');

    // listing tokens shows it
    const listRes = await dmAgent.get('/api/v1/tokens');
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((t: { name: string }) => t.name === 'my-dm-token')).toBe(true);
  });

  it('scope viewer token cannot create quest (403) even for dm owner', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await dmAgent.post('/api/v1/tokens').send({ name: 'viewer-scoped', scope: 'viewer' });
    expect(createRes.status).toBe(201);
    const rawToken = createRes.body.token;

    const questRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set('Authorization', `Bearer ${rawToken}`)
      .send({ title: 'Should fail' });
    expect(questRes.status).toBe(403);

    // but reading is fine (viewer can read)
    const getRes = await request(server).get(`/api/v1/campaigns/${campaignId}`).set('Authorization', `Bearer ${rawToken}`);
    expect(getRes.status).toBe(200);
  });

  it('campaign-bound token 403 on other campaign', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await dmAgent.post('/api/v1/tokens').send({ name: 'bound-token', scope: 'dm', campaignId });
    expect(createRes.status).toBe(201);
    const rawToken = createRes.body.token;

    const okRes = await request(server).get(`/api/v1/campaigns/${campaignId}`).set('Authorization', `Bearer ${rawToken}`);
    expect(okRes.status).toBe(200);

    const forbiddenRes = await request(server).get(`/api/v1/campaigns/${otherCampaignId}`).set('Authorization', `Bearer ${rawToken}`);
    expect(forbiddenRes.status).toBe(403);
  });

  it('delete revokes -> 401', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await dmAgent.post('/api/v1/tokens').send({ name: 'to-be-revoked', scope: 'dm' });
    const rawToken = createRes.body.token;
    const tokenId = createRes.body.apiToken.id;

    const preRes = await request(server).get('/api/v1/me').set('Authorization', `Bearer ${rawToken}`);
    expect(preRes.status).toBe(200);

    const delRes = await dmAgent.delete(`/api/v1/tokens/${tokenId}`);
    expect(delRes.status).toBe(204);

    const postRes = await request(server).get('/api/v1/me').set('Authorization', `Bearer ${rawToken}`);
    expect(postRes.status).toBe(401);
  });

  it('own tokens only: user cannot delete another user\'s token', async () => {
    const createRes = await dmAgent.post('/api/v1/tokens').send({ name: 'dm-owned', scope: 'dm' });
    const tokenId = createRes.body.apiToken.id;

    const delRes = await otherAgent.delete(`/api/v1/tokens/${tokenId}`);
    expect(delRes.status).toBe(404);
  });
});
