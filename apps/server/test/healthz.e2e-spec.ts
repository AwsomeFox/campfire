import request from 'supertest';
import type { Database } from 'better-sqlite3';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { APP_VERSION } from '../src/common/build-metadata';
import { DB, type DrizzleDb } from '../src/db/db.module';

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
    expect(res.body).toEqual({ ok: true, version: APP_VERSION });
  });

  it('GET /readyz -> {ok:true, version} with no auth while the DB answers', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: APP_VERSION });
  });

  // Issue #52: /healthz is liveness-only, so with a broken DB the process must
  // still answer 200 there while /readyz flips to 503 — that contrast is the
  // whole point of the readiness probe (the Docker HEALTHCHECK targets /readyz).
  // Closing the better-sqlite3 handle makes every subsequent query throw, which
  // is the same observable failure as a locked/corrupted DB or unmounted volume.
  // Runs LAST: the DB stays broken for the rest of the suite by design.
  it('GET /readyz -> 503 {ok:false} when the DB is broken, while /healthz stays 200', async () => {
    // DrizzleDb is typed as BetterSQLite3Database, but drizzle() actually returns
    // the intersection with { $client } — the runtime value always carries it.
    const db = ctx.app.get<DrizzleDb & { $client: Database }>(DB);
    db.$client.close();

    const ready = await request(ctx.app.getHttpServer()).get('/readyz');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ ok: false, version: APP_VERSION, error: 'database unavailable' });

    const live = await request(ctx.app.getHttpServer()).get('/healthz');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ ok: true, version: APP_VERSION });
  });
});
