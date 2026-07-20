import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };

/**
 * SSE endpoint (issue #4): GET /api/v1/campaigns/:id/events streams thin
 * CampaignEvent change signals emitted from the encounter write paths.
 *
 * supertest buffers the whole response, which never ends for a live SSE stream,
 * so the streaming assertions use a raw http client against the listening test
 * server instead (auth/permission failures still respond with ordinary JSON
 * errors and are asserted via the same raw client's status code).
 */

interface SseConnection {
  status: number;
  contentType: string | undefined;
  /** All JSON-parsed `data:` payloads seen so far (includes keepalive pings). */
  events: unknown[];
  waitFor: (pred: (event: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => void;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve((server.address() as AddressInfo).port);
      return;
    }
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

function connectSse(port: number, path: string, headers: Record<string, string> = {}): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: { accept: 'text/event-stream', ...headers } },
      (res) => {
        const events: unknown[] = [];
        const waiters: Array<{ pred: (event: Record<string, unknown>) => boolean; settle: (event: Record<string, unknown>) => void }> = [];
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice('data:'.length).trimStart())
              .join('\n');
            if (!data) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            events.push(parsed);
            if (typeof parsed === 'object' && parsed !== null) {
              const event = parsed as Record<string, unknown>;
              for (let i = waiters.length - 1; i >= 0; i -= 1) {
                if (waiters[i].pred(event)) {
                  const [waiter] = waiters.splice(i, 1);
                  waiter.settle(event);
                }
              }
            }
          }
        });
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers['content-type'],
          events,
          waitFor: (pred, timeoutMs = 4000) =>
            new Promise((resolveWait, rejectWait) => {
              const existing = events.find(
                (e): e is Record<string, unknown> => typeof e === 'object' && e !== null && pred(e as Record<string, unknown>),
              );
              if (existing) {
                resolveWait(existing);
                return;
              }
              const timer = setTimeout(() => rejectWait(new Error(`timed out after ${timeoutMs}ms waiting for SSE event`)), timeoutMs);
              waiters.push({
                pred,
                settle: (event) => {
                  clearTimeout(timer);
                  resolveWait(event);
                },
              });
            }),
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('campaign events SSE (e2e, dev auth)', () => {
  let ctx: TestAppContext;
  let port: number;
  let campaignId: number;
  let otherCampaignId: number;
  const open: SseConnection[] = [];

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer() as http.Server;

    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'SSE Campaign' });
    campaignId = campRes.body.id;
    const otherRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Campaign' });
    otherCampaignId = otherRes.body.id;

    port = await listen(server);
  });

  afterAll(async () => {
    for (const conn of open) conn.close();
    await closeTestApp(ctx);
  });

  async function openStream(cid: number, headers: Record<string, string>): Promise<SseConnection> {
    const conn = await connectSse(port, `/api/v1/campaigns/${cid}/events`, headers);
    open.push(conn);
    return conn;
  }

  it('opens a text/event-stream for a campaign member', async () => {
    const conn = await openStream(campaignId, player);
    expect(conn.status).toBe(200);
    expect(conn.contentType).toContain('text/event-stream');
    conn.close();
  });

  it('delivers encounter.updated to a connected member across the write paths', async () => {
    const server = ctx.app.getHttpServer();
    const conn = await openStream(campaignId, player);

    const createRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Ambush' });
    expect(createRes.status).toBe(201);
    const encounterId = createRes.body.id;

    const created = await conn.waitFor((e) => e.type === 'encounter.updated' && e.encounterId === encounterId);
    expect(created.campaignId).toBe(campaignId);
    expect(typeof created.at).toBe('string');

    // Combatant add -> another update event.
    const addRes = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Goblin', hpMax: 7 });
    expect(addRes.status).toBe(201);
    await conn.waitFor((e) => e.type === 'encounter.updated' && e.encounterId === encounterId && conn.events.indexOf(e) > conn.events.indexOf(created));

    // Full flow: roll initiative -> start -> combatant HP patch -> next turn -> end,
    // each write pushing a fresh signal to the open stream.
    let seen = conn.events.length;
    const expectNextUpdate = async () => {
      await conn.waitFor((e) => e.type === 'encounter.updated' && e.encounterId === encounterId && conn.events.indexOf(e) >= seen);
      seen = conn.events.length;
    };

    expect((await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm)).status).toBe(201);
    await expectNextUpdate();

    expect((await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm)).status).toBe(201);
    await expectNextUpdate();

    const combatantId = addRes.body.id;
    expect((await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`).set(dm).send({ hpDelta: -3 })).status).toBe(200);
    await expectNextUpdate();

    expect((await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm)).status).toBe(201);
    await expectNextUpdate();

    expect((await request(server).post(`/api/v1/encounters/${encounterId}/end`).set(dm)).status).toBe(201);
    await expectNextUpdate();

    conn.close();
  });

  it('emits encounter.deleted when an encounter is removed', async () => {
    const server = ctx.app.getHttpServer();
    const conn = await openStream(campaignId, player);

    const createRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Doomed' });
    const encounterId = createRes.body.id;

    expect((await request(server).delete(`/api/v1/encounters/${encounterId}`).set(dm)).status).toBe(200);
    const deleted = await conn.waitFor((e) => e.type === 'encounter.deleted' && e.encounterId === encounterId);
    expect(deleted.campaignId).toBe(campaignId);
    conn.close();
  });

  it('scopes events to their campaign — a stream on another campaign stays silent', async () => {
    const server = ctx.app.getHttpServer();
    const conn = await openStream(otherCampaignId, dm);

    const createRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Elsewhere' });
    expect(createRes.status).toBe(201);

    await sleep(400);
    const campaignEvents = conn.events.filter(
      (e) => typeof e === 'object' && e !== null && (e as Record<string, unknown>).type !== 'ping',
    );
    expect(campaignEvents).toHaveLength(0);
    conn.close();
  });
});

describe('campaign events SSE (e2e, real auth)', () => {
  let ctx: TestAppContext;
  let port: number;
  let campaignId: number;
  let adminCookie: string;
  let outsiderCookie: string;
  const open: SseConnection[] = [];

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer() as http.Server;

    const adminAgent = request.agent(server);
    const setupRes = await adminAgent.post('/api/v1/auth/setup').send({ username: 'admin', password: 'admin-password-1' });
    expect(setupRes.status).toBe(201);
    adminCookie = (setupRes.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

    // A regular (non-admin) user with no campaign membership.
    const userRes = await adminAgent.post('/api/v1/users').send({ username: 'outsider', password: 'outsider-password-1' });
    expect(userRes.status).toBe(201);
    const loginRes = await request(server).post('/api/v1/auth/login').send({ username: 'outsider', password: 'outsider-password-1' });
    expect(loginRes.status).toBe(201);
    outsiderCookie = (loginRes.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

    const campRes = await adminAgent.post('/api/v1/campaigns').send({ name: 'Cookie Campaign' });
    campaignId = campRes.body.id;

    port = await listen(server);
  });

  afterAll(async () => {
    for (const conn of open) conn.close();
    await closeTestApp(ctx);
  });

  it('rejects an unauthenticated stream with 401', async () => {
    const conn = await connectSse(port, `/api/v1/campaigns/${campaignId}/events`);
    open.push(conn);
    expect(conn.status).toBe(401);
    conn.close();
  });

  it('rejects a non-member with 403', async () => {
    const conn = await connectSse(port, `/api/v1/campaigns/${campaignId}/events`, { cookie: outsiderCookie });
    open.push(conn);
    expect(conn.status).toBe(403);
    conn.close();
  });

  it('streams events to a cookie-authenticated member', async () => {
    const server = ctx.app.getHttpServer();
    const conn = await connectSse(port, `/api/v1/campaigns/${campaignId}/events`, { cookie: adminCookie });
    open.push(conn);
    expect(conn.status).toBe(200);

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set('Cookie', adminCookie)
      .send({ name: 'Cookie Fight' });
    expect(createRes.status).toBe(201);

    const event = await conn.waitFor((e) => e.type === 'encounter.updated' && e.encounterId === createRes.body.id);
    expect(event.campaignId).toBe(campaignId);
    conn.close();
  });
});
