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
  /**
   * True once the underlying response stream ended — i.e. Node emitted 'end'
   * (clean completion) or 'close' (socket torn down). This fires for EITHER
   * endpoint: the server completing the Observable (the issue #527 revocation
   * teardown) OR the local client calling close() (req.destroy). A test that
   * wants to assert the SERVER initiated the close must pair `ended` with a
   * no-more-frames check (wait a beat, assert events.length is unchanged) and
   * must NOT have called close() itself — otherwise this flag only proves the
   * stream is no longer delivering frames, not who closed it.
   */
  ended: boolean;
  waitFor: (pred: (event: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  /**
   * Resolves when the response stream ends (see `ended`), rejecting after
   * timeoutMs if frames keep flowing. Same caveat as `ended`: this resolves for
   * either endpoint, so the revocation test pairs it with a no-more-frames
   * assertion to prove the SERVER closed the stream rather than the client.
   */
  waitForClose: (timeoutMs?: number) => Promise<void>;
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
        const closeWaiters: Array<() => void> = [];
        let buffer = '';
        let ended = false;
        res.setEncoding('utf8');
        const fireCloseWaiters = () => {
          if (ended) return;
          ended = true;
          for (const fn of closeWaiters) fn();
        };
        // The server completes the Observable (issue #527 revocation) -> Node's response
        // stream emits 'end' (clean completion) or 'close' (underlying socket torn down).
        // Either signals the stream is no longer delivering frames.
        res.on('end', fireCloseWaiters);
        res.on('close', fireCloseWaiters);
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
          get ended() {
            return ended;
          },
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
          waitForClose: (timeoutMs = 5000) =>
            new Promise((resolveWait, rejectWait) => {
              if (ended) {
                resolveWait();
                return;
              }
              const timer = setTimeout(
                () => rejectWait(new Error(`stream did not close within ${timeoutMs}ms`)),
                timeoutMs,
              );
              closeWaiters.push(() => {
                clearTimeout(timer);
                resolveWait();
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

/**
 * Issue #527 regression: revoking a member must tear down that member's open SSE stream
 * (and ONLY that member's). Membership used to be checked once at stream open, so a removed
 * player kept receiving live event ticks until they themselves disconnected. Now
 * MembersService.remove() emits a `membership.revoked` campaign event and the controller's
 * takeUntil completes the affected subscriber's stream; a bystander on the same campaign is
 * unaffected, and the revoked user reconnecting gets a 403.
 *
 * Uses real cookie sessions (not dev-auth) because revocation flows through a real
 * campaign_members row: MembersService.remove emits userId = String(campaignMembers.userId),
 * which only matches a real user's RequestUser.id (integer string), never a synthetic
 * dev:<name> id. So this suite mirrors the real-auth block above.
 */
describe('campaign events SSE revocation teardown (e2e, real auth) — issue #527', () => {
  let ctx: TestAppContext;
  let port: number;
  let campaignId: number;
  let dmCookie: string;
  let revokeeCookie: string;
  let bystanderCookie: string;
  let revokeeMemberId: number;
  const open: SseConnection[] = [];
  /** Cross-test handles to the two streams opened in the baseline test (the revoke test reuses them). */
  const suiteConns: SseConnection[] = [];

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    // DM (admin) sets up the table.
    const dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'dm-527', password: 'dm-password-527' });
    dmCookie = (await dmAgent.post('/api/v1/auth/login').send({ username: 'dm-527', password: 'dm-password-527' }).then((r) => r.headers['set-cookie'][0].split(';')[0]));

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Revocation Campaign' });
    expect(campRes.status).toBe(201);
    campaignId = campRes.body.id;

    // Two real players: the one who gets revoked, and a bystander who must keep flowing.
    const revokeeUser = await dmAgent.post('/api/v1/users').send({ username: 'revokee', password: 'revokee-pass-1', serverRole: 'user' });
    expect(revokeeUser.status).toBe(201);
    const revokeeId = revokeeUser.body.id as number;

    const bystanderUser = await dmAgent.post('/api/v1/users').send({ username: 'bystander', password: 'bystander-pass-1', serverRole: 'user' });
    expect(bystanderUser.status).toBe(201);
    const bystanderId = bystanderUser.body.id as number;

    const addRevokee = await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: revokeeId, role: 'player' });
    expect(addRevokee.status).toBe(201);
    revokeeMemberId = addRevokee.body.id;

    const addBystander = await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: bystanderId, role: 'player' });
    expect(addBystander.status).toBe(201);

    revokeeCookie = (await request(server).post('/api/v1/auth/login').send({ username: 'revokee', password: 'revokee-pass-1' }).then((r) => r.headers['set-cookie'][0].split(';')[0]));
    bystanderCookie = (await request(server).post('/api/v1/auth/login').send({ username: 'bystander', password: 'bystander-pass-1' }).then((r) => r.headers['set-cookie'][0].split(';')[0]));

    port = await listen(server);
  });

  afterAll(async () => {
    for (const conn of open) conn.close();
    await closeTestApp(ctx);
  });

  it('opens a stream for both members and delivers a baseline event to each', async () => {
    const server = ctx.app.getHttpServer();
    const revokeeConn = await connectSse(port, `/api/v1/campaigns/${campaignId}/events`, { cookie: revokeeCookie });
    open.push(revokeeConn);
    const bystanderConn = await connectSse(port, `/api/v1/campaigns/${campaignId}/events`, { cookie: bystanderCookie });
    open.push(bystanderConn);
    expect(revokeeConn.status).toBe(200);
    expect(bystanderConn.status).toBe(200);

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set('Cookie', dmCookie)
      .send({ name: 'Baseline Fight' });
    expect(createRes.status).toBe(201);

    // Both members receive the normal encounter.updated tick — confirms the revocation
    // teardown does NOT break ordinary event delivery before any revoke happens.
    const r = await revokeeConn.waitFor((e) => e.type === 'encounter.updated' && e.encounterId === createRes.body.id);
    const b = await bystanderConn.waitFor((e) => e.type === 'encounter.updated' && e.encounterId === createRes.body.id);
    expect(r.campaignId).toBe(campaignId);
    expect(b.campaignId).toBe(campaignId);

    // Stash the connections onto the suite scope for the next test (both still open).
    (revokeeConn as SseConnection & { tag?: string }).tag = 'revokee';
    (bystanderConn as SseConnection & { tag?: string }).tag = 'bystander';
    suiteConns.push(revokeeConn, bystanderConn);
  });

  it('revoking the member closes ONLY their stream, delivers no further frames, and a reconnect 403s; the bystander keeps flowing', async () => {
    const server = ctx.app.getHttpServer();
    const revokeeConn = suiteConns.find((c) => (c as SseConnection & { tag?: string }).tag === 'revokee')!;
    const bystanderConn = suiteConns.find((c) => (c as SseConnection & { tag?: string }).tag === 'bystander')!;
    const framesBeforeRevoke = revokeeConn.events.length;

    // DM removes the revokee. MembersService.remove emits membership.revoked synchronously
    // after the DB delete; the SSE controller's takeUntil completes the stream.
    const removeRes = await request(server)
      .delete(`/api/v1/campaigns/${campaignId}/members/${revokeeMemberId}`)
      .set('Cookie', dmCookie);
    expect(removeRes.status).toBe(204);

    // The affected stream must close. waitForClose rejects if it stays open.
    await revokeeConn.waitForClose(5000);
    expect(revokeeConn.ended).toBe(true);

    // Race-condition boundary: no `data:` frame may slip through after the revoke.
    // Give a beat for any in-flight emission to land; events count must be unchanged.
    await sleep(300);
    expect(revokeeConn.events.length).toBe(framesBeforeRevoke);
    // And critically: no membership.revoked frame was forwarded to the client (it is an
    // internal control signal, filtered out of the data path).
    expect(revokeeConn.events.some((e) => typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === 'membership.revoked')).toBe(false);

    // A reconnect by the now-revoked user gets 403 (requireMember fails) — the drop is
    // permanent until they are re-added.
    const reconnect = await connectSse(port, `/api/v1/campaigns/${campaignId}/events`, { cookie: revokeeCookie });
    open.push(reconnect);
    expect(reconnect.status).toBe(403);

    // The bystander's stream is unaffected: still open, and it keeps receiving the next
    // encounter event (a DM revoking player A must not disconnect player B).
    expect(bystanderConn.ended).toBe(false);
    const nextEncounter = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set('Cookie', dmCookie)
      .send({ name: 'After Revoke Fight' });
    expect(nextEncounter.status).toBe(201);
    const stillFlowing = await bystanderConn.waitFor(
      (e) => e.type === 'encounter.updated' && e.encounterId === nextEncounter.body.id,
      5000,
    );
    expect(stillFlowing.campaignId).toBe(campaignId);
  });
});
