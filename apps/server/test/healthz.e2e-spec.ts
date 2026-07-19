import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

describe('healthz (e2e)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('GET /healthz -> {ok:true, version} with no auth', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: expect.any(String) });
  });
});
