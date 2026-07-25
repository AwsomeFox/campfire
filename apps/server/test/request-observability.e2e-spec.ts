import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #684 — correlation ids propagate through REST envelopes, audit rows,
 * MCP tool errors, structured logs, and the server-admin audit search surface.
 */
describe('request observability (e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<typeof request>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = request(ctx.app.getHttpServer());
    const campRes = await server.post('/api/v1/campaigns').set('x-dev-role', 'dm').send({ name: 'Observability Campaign' });
    expect(campRes.status).toBe(201);
    campaignId = campRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('stamps audit rows with the inbound X-Request-Id on a mutating REST call', async () => {
    const correlationId = 'audit-corr-rest-684';
    const title = `Obs ${Date.now()}`;
    const create = await server
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set('x-dev-role', 'dm')
      .set('X-Request-Id', correlationId)
      .send({ title, status: 'active' });
    expect(create.status).toBe(201);
    expect(create.headers['x-request-id']).toBe(correlationId);

    const audit = await server
      .get(`/api/v1/campaigns/${campaignId}/audit?requestId=${correlationId}`)
      .set('x-dev-role', 'dm');
    expect(audit.status).toBe(200);
    expect(audit.body.length).toBeGreaterThan(0);
    expect(audit.body.every((row: { requestId: string | null }) => row.requestId === correlationId)).toBe(true);
  });

  it('server-admin audit search pivots on requestId across campaigns', async () => {
    const correlationId = 'admin-search-684';
    await server
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set('x-dev-role', 'dm')
      .set('X-Request-Id', correlationId)
      .send({ title: `Admin search ${Date.now()}`, status: 'active' });

    const rows = await server
      .get(`/api/v1/admin/audit?requestId=${correlationId}`)
      .set('x-dev-role', 'dm');
    expect(rows.status).toBe(200);
    expect(rows.body.some((row: { requestId: string | null }) => row.requestId === correlationId)).toBe(true);
  });

  it('concurrent requests keep distinct correlation ids when callers supply them', async () => {
    const ids = ['parallel-a-684', 'parallel-b-684', 'parallel-c-684'];
    const responses = await Promise.all(
      ids.map((id) =>
        server
          .get(`/api/v1/campaigns/${campaignId}`)
          .set('x-dev-role', 'dm')
          .set('X-Request-Id', id),
      ),
    );
    for (let i = 0; i < ids.length; i++) {
      expect(responses[i]!.headers['x-request-id']).toBe(ids[i]);
    }
  });

  it('retries with the same inbound header preserve the correlation id end-to-end', async () => {
    const correlationId = 'retry-corr-684';
    const first = await server
      .get('/api/v1/campaigns/999999999')
      .set('x-dev-role', 'dm')
      .set('X-Request-Id', correlationId);
    const second = await server
      .get('/api/v1/campaigns/999999999')
      .set('x-dev-role', 'dm')
      .set('X-Request-Id', correlationId);
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(first.headers['x-request-id']).toBe(correlationId);
    expect(second.headers['x-request-id']).toBe(correlationId);
    expect(first.body.requestId).toBe(correlationId);
    expect(second.body.requestId).toBe(correlationId);
  });
});
