/**
 * Body-less POSTs against DTO-bearing endpoints (issue #580).
 *
 * `apps/server` resolves express 5, whose body-parser is 2.x. Unlike 1.x, it assigns
 * `req.body = undefined` for a request with no payload instead of coercing it to `{}`
 * (body-parser 2's `read.js`). Every DTO here is a zod OBJECT schema, and zod rejects
 * `undefined` against an object — so an endpoint whose body is entirely optional 400s
 * with a bare "Validation failed" the instant a client posts nothing.
 *
 * That is not hypothetical: `api.post(url)` sends neither body nor content-type when
 * there is no payload (apps/web/src/lib/api.ts), which is how the Reopen button calls
 * /reopen whenever there are no HP-sync conflicts to send, and how Playwright's
 * `request.post(url)` calls /next-turn.
 *
 * This was invisible for as long as it was, because test/test-app.ts used to build the
 * app with Nest's DEFAULT body parser — the hoisted 1.x — while main.ts runs
 * `bodyParser: false` plus its own express 5 parser. The harness now mirrors main.ts, so
 * these assertions are meaningful; before that change they passed no matter what.
 */
import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

describe('body-less POSTs to endpoints with an optional body (e2e, issue #580)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  const server = () => ctx.app.getHttpServer();

  beforeAll(async () => {
    ctx = await createTestApp();
    const camp = await request(server()).post('/api/v1/campaigns').set(dm).send({ name: 'Bodyless' });
    campaignId = camp.body.id;
    const char = await request(server())
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Hero', stats: { DEX: 14 }, hpCurrent: 20, hpMax: 20 });
    expect(char.status).toBe(201);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  /** A running encounter with the party plus one monster. */
  async function runningEncounter(): Promise<number> {
    const enc = await request(server())
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: `Fight ${Date.now()}-${Math.random()}`, hidden: false });
    expect(enc.status).toBe(201);
    const id = enc.body.id as number;
    const gob = await request(server())
      .post(`/api/v1/encounters/${id}/combatants`)
      .set(dm)
      .send({ name: 'Goblin', kind: 'monster', hpMax: 12 });
    expect(gob.status).toBe(201);
    // No body — /roll-initiative takes none, and must keep working.
    expect((await request(server()).post(`/api/v1/encounters/${id}/roll-initiative`).set(dm)).status).toBe(201);
    expect((await request(server()).post(`/api/v1/encounters/${id}/start`).set(dm)).status).toBe(201);
    return id;
  }

  it('POST /next-turn with no body advances the turn (issue #580 regression)', async () => {
    const id = await runningEncounter();
    // `.set(dm)` with no `.send()` at all: no request body, no Content-Type — exactly
    // what Playwright's request.post(url) and a bare fetch() emit.
    const res = await request(server()).post(`/api/v1/encounters/${id}/next-turn`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('running');
    await request(server()).post(`/api/v1/encounters/${id}/end`).set(dm);
  });

  it('POST /reopen with no body reopens the encounter', async () => {
    // The Reopen button sends no body when there is nothing to resync — the common case.
    const id = await runningEncounter();
    expect((await request(server()).post(`/api/v1/encounters/${id}/end`).set(dm)).status).toBe(201);

    const res = await request(server()).post(`/api/v1/encounters/${id}/reopen`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('running');
    await request(server()).post(`/api/v1/encounters/${id}/end`).set(dm);
  });

  it('a body-less POST to an endpoint with REQUIRED fields still fails validation', async () => {
    // The normalization must not become a way to skip validation: turning `undefined`
    // into `{}` only changes WHICH error you get (missing fields, rather than a whole
    // invalid body), never whether the request is rejected.
    const res = await request(server()).post('/api/v1/campaigns').set(dm);
    expect(res.status).toBe(400);
  });
});
