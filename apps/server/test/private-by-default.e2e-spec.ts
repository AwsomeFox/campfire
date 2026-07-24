/**
 * Issue #754 — private-by-default prep.
 *
 * Quick-create / API omits must not auto-reveal NPCs, factions, quests,
 * timeline events, or Preparing encounters. Multi-client checks: player list,
 * get-by-id, search, and SSE create events stay clean until an explicit reveal.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-754' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-754' };

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve((server.address() as AddressInfo).port);
      return;
    }
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

interface SseConnection {
  status: number;
  events: Array<Record<string, unknown>>;
  close: () => void;
}

function connectSse(port: number, path: string, headers: Record<string, string>): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: { accept: 'text/event-stream', ...headers } },
      (res) => {
        const events: Array<Record<string, unknown>> = [];
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
            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              if (parsed && typeof parsed === 'object') events.push(parsed);
            } catch {
              /* ignore keepalive/non-JSON */
            }
          }
        });
        resolve({
          status: res.statusCode ?? 0,
          events,
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('private-by-default prep (issue #754)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let port: number;
  const open: SseConnection[] = [];

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Private-by-default Campaign' });
    campaignId = res.body.id;
    port = await listen(server);
  });

  afterAll(async () => {
    for (const c of open) c.close();
    await closeTestApp(ctx);
  });

  async function assertPlayerCannotSee(
    kind: 'npc' | 'faction' | 'quest' | 'timeline' | 'encounter',
    id: number,
    listPath: string,
    searchNeedle: string,
  ) {
    const server = ctx.app.getHttpServer();
    const list = await request(server).get(listPath).set(player);
    expect(list.status).toBe(200);
    const rows: Array<{ id: number }> = Array.isArray(list.body) ? list.body : [];
    expect(rows.some((r) => r.id === id)).toBe(false);

    const getPath =
      kind === 'timeline'
        ? `/api/v1/timeline/${id}`
        : kind === 'encounter'
          ? `/api/v1/encounters/${id}`
          : kind === 'quest'
            ? `/api/v1/quests/${id}`
            : kind === 'faction'
              ? `/api/v1/factions/${id}`
              : `/api/v1/npcs/${id}`;
    const got = await request(server).get(getPath).set(player);
    expect(got.status).toBe(404);

    const search = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/search`)
      .query({ q: searchNeedle })
      .set(player);
    expect(search.status).toBe(200);
    const hits = (search.body.results ?? search.body) as Array<{ type?: string; id?: number }>;
    const typed = Array.isArray(hits) ? hits : [];
    expect(typed.some((r) => r.type === kind && r.id === id)).toBe(false);
  }

  it('NPC create without hidden is DM-only; player list/get/search stay clean until reveal', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: '754-private NPC' });
    expect(created.status).toBe(201);
    expect(created.body.hidden).toBe(true);
    const id = created.body.id as number;

    await assertPlayerCannotSee('npc', id, `/api/v1/campaigns/${campaignId}/npcs`, '754-private NPC');

    const reveal = await request(server).patch(`/api/v1/npcs/${id}`).set(dm).send({ hidden: false });
    expect(reveal.status).toBe(200);
    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/npcs`).set(player);
    expect(playerList.body.some((n: { id: number }) => n.id === id)).toBe(true);
  });

  it('faction / quest / timeline / encounter creates omit → DM-only', async () => {
    const server = ctx.app.getHttpServer();

    const faction = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/factions`)
      .set(dm)
      .send({ name: '754-private Faction' });
    expect(faction.status).toBe(201);
    expect(faction.body.hidden).toBe(true);
    await assertPlayerCannotSee('faction', faction.body.id, `/api/v1/campaigns/${campaignId}/factions`, '754-private Faction');

    const quest = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: '754-private Quest' });
    expect(quest.status).toBe(201);
    expect(quest.body.hidden).toBe(true);
    await assertPlayerCannotSee('quest', quest.body.id, `/api/v1/campaigns/${campaignId}/quests`, '754-private Quest');

    const event = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .set(dm)
      .send({ title: '754-private Timeline' });
    expect(event.status).toBe(201);
    expect(event.body.hidden).toBe(true);
    await assertPlayerCannotSee('timeline', event.body.id, `/api/v1/campaigns/${campaignId}/timeline`, '754-private Timeline');

    const encounter = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: '754-private Encounter' });
    expect(encounter.status).toBe(201);
    expect(encounter.body.hidden).toBe(true);
    expect(encounter.body.status).toBe('preparing');
    await assertPlayerCannotSee('encounter', encounter.body.id, `/api/v1/campaigns/${campaignId}/encounters`, '754-private Encounter');
  });

  it('explicit hidden:false is an intentional public create', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: '754-public NPC', hidden: false });
    expect(created.status).toBe(201);
    expect(created.body.hidden).toBe(false);
    const playerGet = await request(server).get(`/api/v1/npcs/${created.body.id}`).set(player);
    expect(playerGet.status).toBe(200);
  });

  it('private encounter create does not emit encounter.updated SSE (no event leak)', async () => {
    const conn = await connectSse(port, `/api/v1/campaigns/${campaignId}/events`, player);
    open.push(conn);
    expect(conn.status).toBe(200);

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: '754-sse-silent' });
    expect(created.status).toBe(201);
    expect(created.body.hidden).toBe(true);

    await new Promise((r) => setTimeout(r, 500));
    const leaked = conn.events.some(
      (e) => e.type === 'encounter.updated' && e.encounterId === created.body.id,
    );
    expect(leaked).toBe(false);
    conn.close();
  });

  it('public encounter create still emits encounter.updated SSE', async () => {
    const conn = await connectSse(port, `/api/v1/campaigns/${campaignId}/events`, player);
    open.push(conn);
    expect(conn.status).toBe(200);

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: '754-sse-public', hidden: false });
    expect(created.status).toBe(201);
    expect(created.body.hidden).toBe(false);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (conn.events.some((e) => e.type === 'encounter.updated' && e.encounterId === created.body.id)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(conn.events.some((e) => e.type === 'encounter.updated' && e.encounterId === created.body.id)).toBe(true);
    conn.close();
  });
});
