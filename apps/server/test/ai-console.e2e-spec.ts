import request from 'supertest';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Admin AI console (issue #315) — opt-in/kill switch, budgets & caps, usage
 * dashboard, model allowlist, provider health. All routes are @ServerRoles('admin').
 *
 * Covers: the kill switch pauses all AI (turns 403), a server-wide token cap is
 * enforced, usage aggregates across seats, the allowlist editor drives #310, and
 * every route is admin-gated (a non-admin user gets 403).
 */
const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'aic-dm' };

describe('ai-console (e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Console Campaign' });
    campaignId = campRes.body.id;
    // Opt the server in and configure + enable a seat with a generous budget.
    await request(server).post('/api/v1/settings/ai/kill').set(dm).send({ enabled: true });
    await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(dm)
      .send({ enabled: true, model: 'connected-agent', tokenBudget: 100_000 });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('overview reflects the kill switch, caps, allowlist, and usage', async () => {
    const res = await request(server).get('/api/v1/settings/ai').set(dm);
    expect(res.status).toBe(200);
    expect(res.body.killSwitchEnabled).toBe(true);
    expect(res.body.serverTokenCap).toBe(0); // unlimited by default
    expect(Array.isArray(res.body.allowedModels)).toBe(true);
    expect(res.body.usage.seatCount).toBeGreaterThanOrEqual(1);
    const row = res.body.usage.byCampaign.find((r: { campaignId: number }) => r.campaignId === campaignId);
    expect(row).toBeDefined();
    expect(row.campaignName).toBe('Console Campaign');
    expect(row.enabled).toBe(true);
    expect(row.tokenBudget).toBe(100_000);
  });

  it('usage aggregates tokens across seats after a turn', async () => {
    const turn = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'The party opens the door.', kind: 'narrate' });
    expect(turn.status).toBe(201);
    const spent = turn.body.tokensUsed;
    expect(spent).toBeGreaterThan(0);

    const usage = await request(server).get('/api/v1/settings/ai/usage').set(dm);
    expect(usage.status).toBe(200);
    expect(usage.body.totalTokensUsed).toBeGreaterThanOrEqual(spent);
    expect(usage.body.totalTurns).toBeGreaterThanOrEqual(1);
    // by-model rollup carries the seat's model label.
    const model = usage.body.byModel.find((m: { model: string }) => m.model === 'connected-agent');
    expect(model).toBeDefined();
    expect(model.tokensUsed).toBeGreaterThanOrEqual(spent);
  });

  it('the kill switch pauses all AI immediately (turn 403 while off)', async () => {
    const off = await request(server).post('/api/v1/settings/ai/kill').set(dm).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.killSwitchEnabled).toBe(false);

    const turn = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'Should be blocked.' });
    expect(turn.status).toBe(403);

    // Re-enable for later cases.
    await request(server).post('/api/v1/settings/ai/kill').set(dm).send({ enabled: true });
  });

  it('a server-wide hard token cap is enforced across campaigns', async () => {
    // Reset the seat, then cap the whole server at 1 token so the next turn exhausts it.
    await request(server).post(`/api/v1/campaigns/${campaignId}/ai-dm/reset`).set(dm).send({});
    const caps = await request(server).put('/api/v1/settings/ai/caps').set(dm).send({ serverTokenCap: 1 });
    expect(caps.status).toBe(200);
    expect(caps.body.serverTokenCap).toBe(1);

    // First turn runs (aggregate 0 < 1) and pushes usage to/over the cap.
    const first = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'First and last.' });
    expect(first.status).toBe(201);

    // Second turn is refused with a clear server-cap reason.
    const second = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'Over the ceiling.' });
    expect(second.status).toBe(403);
    expect(second.text).toContain('Server-wide AI token cap');

    // Lift the cap again.
    await request(server).put('/api/v1/settings/ai/caps').set(dm).send({ serverTokenCap: 0 });
  });

  it('caps can set a per-campaign budget', async () => {
    const res = await request(server)
      .put('/api/v1/settings/ai/caps')
      .set(dm)
      .send({ campaigns: [{ campaignId, tokenBudget: 55_000 }] });
    expect(res.status).toBe(200);
    const row = res.body.usage.byCampaign.find((r: { campaignId: number }) => r.campaignId === campaignId);
    expect(row.tokenBudget).toBe(55_000);
  });

  it('caps rejects unknown campaign ids with 400 (#537)', async () => {
    const res = await request(server)
      .put('/api/v1/settings/ai/caps')
      .set(dm)
      .send({ campaigns: [{ campaignId: 999999, tokenBudget: 10_000 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/999999/);
  });

  it('the model allowlist editor drives the #310 provider allowlist', async () => {
    // Setting an allowlist requires a server-default provider first.
    const noProvider = await request(server)
      .put('/api/v1/settings/ai/allowlist')
      .set(dm)
      .send({ allowedModels: ['gpt-4o-mini'] });
    expect(noProvider.status).toBe(400);

    // Configure a server-default provider (mock — no network), then set the allowlist.
    const prov = await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType: 'mock', model: 'mock-1' });
    expect(prov.status).toBe(200);

    const set = await request(server)
      .put('/api/v1/settings/ai/allowlist')
      .set(dm)
      .send({ allowedModels: ['gpt-4o-mini', 'claude-3-5-haiku'] });
    expect(set.status).toBe(200);
    expect(set.body.allowedModels).toEqual(['gpt-4o-mini', 'claude-3-5-haiku']);

    // It is visible on the #310 server-provider view.
    const view = await request(server).get('/api/v1/settings/ai-provider').set(dm);
    expect(view.body.allowedModels).toEqual(['gpt-4o-mini', 'claude-3-5-haiku']);
  });

  it('provider health "test all" probes the server default', async () => {
    const res = await request(server).post('/api/v1/settings/ai/health').set(dm);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const serverEntry = res.body.find((e: { scope: string }) => e.scope === 'server');
    expect(serverEntry).toBeDefined();
    expect(serverEntry.ok).toBe(true); // the mock provider always succeeds without a network call
  });
});

describe('ai-console admin gating (e2e, real auth)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let userAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'aic-admin', password: 'admin-password-1' });

    await adminAgent.post('/api/v1/users').send({ username: 'aic-user', password: 'user-password-1', serverRole: 'user' });
    userAgent = request.agent(server);
    await userAgent.post('/api/v1/auth/login').send({ username: 'aic-user', password: 'user-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a non-admin user is 403 on every AI-console route', async () => {
    expect((await userAgent.get('/api/v1/settings/ai')).status).toBe(403);
    expect((await userAgent.get('/api/v1/settings/ai/usage')).status).toBe(403);
    expect((await userAgent.put('/api/v1/settings/ai/caps').send({ serverTokenCap: 10 })).status).toBe(403);
    expect((await userAgent.post('/api/v1/settings/ai/kill').send({ enabled: false })).status).toBe(403);
    expect((await userAgent.put('/api/v1/settings/ai/allowlist').send({ allowedModels: [] })).status).toBe(403);
    expect((await userAgent.post('/api/v1/settings/ai/health')).status).toBe(403);
  });

  it('the admin can reach the console', async () => {
    const res = await adminAgent.get('/api/v1/settings/ai');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('killSwitchEnabled');
  });
});
