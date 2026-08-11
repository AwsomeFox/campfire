import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import {
  EncounterPresenceService,
  setEncounterPresenceTtlForTests,
} from '../src/modules/encounters/encounter-presence.service';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const player2 = { 'x-dev-role': 'player', 'x-dev-user': 'p-2' };

/**
 * Co-DM presence (issue #2209, #816 slice 1): ephemeral authenticated presence on the
 * encounter SSE stream. This is the data-foundation slice — the registry, the REST
 * declare/leave/read surface, and the `encounter.presence` campaign event.
 *
 * Covers the acceptance criteria:
 *  - join/leave/expire lifecycle (declare, delete, heartbeat-timeout reap),
 *  - role filtering (hidden-encounter presence reaches DMs only; non-DMs 404 and never
 *    receive the frame),
 *  - presence events flow through the campaign SSE stream,
 *  - campaign isolation (a presence frame for one campaign is not delivered on another's).
 */

type PresenceMember = { userId: string; activity: string };

interface SseConnection {
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

const membersOf = (e: Record<string, unknown>): PresenceMember[] =>
  Array.isArray(e.members) ? (e.members as PresenceMember[]) : [];

/** Predicate matching the next presence frame for an encounter whose members satisfy `cond`. */
const presenceWith =
  (encounterId: number, cond: (members: PresenceMember[]) => boolean) =>
  (e: Record<string, unknown>): boolean =>
    e.type === 'encounter.presence' && e.encounterId === encounterId && cond(membersOf(e));

const anyPresence = (encounterId: number) => presenceWith(encounterId, () => true);
const count = (n: number) => (m: PresenceMember[]) => m.length === n;

describe('encounter presence (issue #2209, #816 slice 1)', () => {
  let ctx: TestAppContext;
  let port: number;
  let campaignId: number;
  let otherCampaignId: number;
  const open: SseConnection[] = [];

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer() as http.Server;
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Presence Campaign' });
    campaignId = campRes.body.id;
    const otherRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Campaign' });
    otherCampaignId = otherRes.body.id;
    port = await listen(server);
  });

  afterAll(async () => {
    setEncounterPresenceTtlForTests(45_000);
    for (const conn of open) conn.close();
    await closeTestApp(ctx);
  });

  async function openStream(cid: number, headers: Record<string, string>): Promise<SseConnection> {
    const conn = await connectSse(port, `/api/v1/campaigns/${cid}/events`, headers);
    open.push(conn);
    return conn;
  }

  async function createEncounter(hidden: boolean, name: string): Promise<number> {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name, hidden });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  function presenceService(): EncounterPresenceService {
    return ctx.app.get(EncounterPresenceService);
  }

  describe('lifecycle: join / leave / expire', () => {
    it('declare returns a snapshot containing the declarer and broadcasts join over SSE', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(false, 'Visible Fight');
      const conn = await openStream(campaignId, player);

      const declare = await request(server)
        .post(`/api/v1/encounters/${encounterId}/presence`)
        .set(dm)
        .send({ activity: 'viewing' });
      expect(declare.status).toBe(201);
      expect(declare.body).toEqual({
        campaignId,
        encounterId,
        members: [{ userId: 'dev:dm-1', activity: 'viewing' }],
      });

      const event = await conn.waitFor(anyPresence(encounterId));
      expect(event.members).toEqual([{ userId: 'dev:dm-1', activity: 'viewing' }]);
      conn.close();
    });

    it('GET reads the current snapshot', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(false, 'Read Fight');
      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(player).send({ activity: 'viewing' });
      const get = await request(server).get(`/api/v1/encounters/${encounterId}/presence`).set(dm);
      expect(get.status).toBe(200);
      expect(get.body.encounterId).toBe(encounterId);
      expect(get.body.members).toContainEqual({ userId: 'dev:p-1', activity: 'viewing' });
    });

    it('a same-activity heartbeat refreshes the lease without re-broadcasting', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(false, 'Heartbeat Fight');
      const conn = await openStream(campaignId, player);

      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'viewing' });
      await conn.waitFor(anyPresence(encounterId));
      const afterJoin = conn.events.filter((e) => anyPresence(encounterId)(e as Record<string, unknown>)).length;

      // Same activity = heartbeat only: no new frame on the wire.
      const again = await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'viewing' });
      expect(again.status).toBe(201);
      expect(again.body.members).toEqual([{ userId: 'dev:dm-1', activity: 'viewing' }]);
      await sleep(150);
      const afterHeartbeat = conn.events.filter((e) => anyPresence(encounterId)(e as Record<string, unknown>)).length;
      expect(afterHeartbeat).toBe(afterJoin);
      conn.close();
    });

    it('an activity change broadcasts the updated snapshot', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(false, 'Edit Fight');
      const conn = await openStream(campaignId, player);

      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'viewing' });
      await conn.waitFor(presenceWith(encounterId, count(1)));

      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'editing' });
      const event = await conn.waitFor(
        presenceWith(encounterId, (m) => m.some((x) => x.activity === 'editing')),
      );
      expect(event.members).toEqual([{ userId: 'dev:dm-1', activity: 'editing' }]);
      conn.close();
    });

    it('leave removes the caller and broadcasts the updated snapshot', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(false, 'Leave Fight');
      const conn = await openStream(campaignId, player);

      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'viewing' });
      await conn.waitFor(anyPresence(encounterId));

      const leave = await request(server).delete(`/api/v1/encounters/${encounterId}/presence`).set(dm);
      expect(leave.status).toBe(200);
      expect(leave.body).toEqual({ campaignId, encounterId, members: [] });

      const event = await conn.waitFor(presenceWith(encounterId, count(0)));
      expect(event.members).toEqual([]);
      conn.close();
    });

    it('heartbeat-expire reaps a stale entry and broadcasts the leave', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(false, 'Expire Fight');
      const conn = await openStream(campaignId, player);

      // Shrink TTL so the entry goes stale almost immediately, then restore it.
      setEncounterPresenceTtlForTests(50);
      try {
        await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'viewing' });
        await conn.waitFor(anyPresence(encounterId));
        await sleep(120);
        // Expiry is lazy: the reaped leave is emitted on the next sweep, triggered here.
        presenceService().expireNow();

        const event = await conn.waitFor(presenceWith(encounterId, count(0)));
        expect(event.members).toEqual([]);

        const get = await request(server).get(`/api/v1/encounters/${encounterId}/presence`).set(dm);
        expect(get.body.members).toEqual([]);
      } finally {
        setEncounterPresenceTtlForTests(45_000);
      }
      conn.close();
    });

    it('reconnect restores presence (re-declare after leave re-broadcasts)', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(false, 'Reconnect Fight');
      const conn = await openStream(campaignId, player);

      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'viewing' });
      await conn.waitFor(anyPresence(encounterId));
      await request(server).delete(`/api/v1/encounters/${encounterId}/presence`).set(dm);
      await conn.waitFor(presenceWith(encounterId, count(0)));

      // Re-declare after a "reconnect": presence is restored and the join re-broadcasts.
      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'viewing' });
      const restored = await conn.waitFor(presenceWith(encounterId, count(1)));
      expect(restored.members).toEqual([{ userId: 'dev:dm-1', activity: 'viewing' }]);
      conn.close();
    });
  });

  describe('role filtering & secrecy (hidden encounters)', () => {
    it('a non-DM GET on a hidden encounter 404s (no existence leak)', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(true, 'Hidden Prep');
      const get = await request(server).get(`/api/v1/encounters/${encounterId}/presence`).set(player);
      expect(get.status).toBe(404);
    });

    it('a non-DM cannot declare presence on a hidden encounter (404)', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(true, 'Hidden Prep Two');
      const declare = await request(server)
        .post(`/api/v1/encounters/${encounterId}/presence`)
        .set(player)
        .send({ activity: 'viewing' });
      expect(declare.status).toBe(404);
    });

    it('a DM can declare presence on a hidden encounter and read it back', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(true, 'Hidden Prep Three');
      const declare = await request(server)
        .post(`/api/v1/encounters/${encounterId}/presence`)
        .set(dm)
        .send({ activity: 'editing' });
      expect(declare.status).toBe(201);
      expect(declare.body.members).toEqual([{ userId: 'dev:dm-1', activity: 'editing' }]);
    });

    it('hidden-encounter presence is NOT delivered to a non-DM SSE stream', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(true, 'Hidden Prep Four');
      const playerConn = await openStream(campaignId, player);

      // The DM declares presence on the hidden encounter...
      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'viewing' });
      await sleep(250);
      // ...and the player's stream must not have learned about it.
      const leaked = playerConn.events.filter((e) => anyPresence(encounterId)(e as Record<string, unknown>));
      expect(leaked).toEqual([]);
      playerConn.close();
    });

    it('hidden-encounter presence IS delivered to a DM SSE stream', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(true, 'Hidden Prep Five');
      const dmConn = await openStream(campaignId, dm);

      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'editing' });
      const event = await dmConn.waitFor(anyPresence(encounterId));
      expect(event.members).toEqual([{ userId: 'dev:dm-1', activity: 'editing' }]);
      dmConn.close();
    });

    it('visible-encounter presence IS delivered to a non-DM SSE stream', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(false, 'Shared Fight');
      const playerConn = await openStream(campaignId, player);

      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'viewing' });
      const event = await playerConn.waitFor(anyPresence(encounterId));
      expect(event.members).toEqual([{ userId: 'dev:dm-1', activity: 'viewing' }]);
      playerConn.close();
    });
  });

  describe('campaign isolation', () => {
    it('a presence frame for one campaign is not delivered on another campaign stream', async () => {
      const server = ctx.app.getHttpServer();
      // Encounter lives in the main campaign; the listener subscribes to the OTHER campaign.
      const encounterId = await createEncounter(false, 'Isolated Fight');
      const otherEncounterRes = await request(server)
        .post(`/api/v1/campaigns/${otherCampaignId}/encounters`)
        .set(dm)
        .send({ name: 'Other Fight', hidden: false });
      const otherEncounterId = otherEncounterRes.body.id as number;
      const otherConn = await openStream(otherCampaignId, player);

      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'viewing' });
      // A real event on the OTHER campaign's encounter proves the listener is wired...
      await request(server).post(`/api/v1/encounters/${otherEncounterId}/presence`).set(dm).send({ activity: 'viewing' });
      await otherConn.waitFor(anyPresence(otherEncounterId));
      await sleep(250);
      // ...while the first campaign's presence must never cross over.
      const crossed = otherConn.events.filter((e) => anyPresence(encounterId)(e as Record<string, unknown>));
      expect(crossed).toEqual([]);
      otherConn.close();
    });
  });

  describe('multiple participants', () => {
    it('tracks distinct users and broadcasts the full snapshot on each change', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(false, 'Co-DM Fight');
      const conn = await openStream(campaignId, player2);

      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(dm).send({ activity: 'viewing' });
      await conn.waitFor(presenceWith(encounterId, count(1)));

      await request(server).post(`/api/v1/encounters/${encounterId}/presence`).set(player).send({ activity: 'editing' });
      const two = await conn.waitFor(presenceWith(encounterId, count(2)));
      // Server sorts members by userId for stable output.
      expect(two.members).toEqual([
        { userId: 'dev:dm-1', activity: 'viewing' },
        { userId: 'dev:p-1', activity: 'editing' },
      ]);

      await request(server).delete(`/api/v1/encounters/${encounterId}/presence`).set(player);
      const one = await conn.waitFor(presenceWith(encounterId, count(1)));
      expect(one.members).toEqual([{ userId: 'dev:dm-1', activity: 'viewing' }]);
      conn.close();
    });
  });

  describe('authorization & validation', () => {
    it('a hidden encounter reads 404 to a non-DM (no existence leak)', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(true, 'Gated Prep');
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/presence`)
        .set(player)
        .send({ activity: 'viewing' });
      expect(res.status).toBe(404);
    });

    it('rejects an invalid activity body with 400', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(false, 'Validation Fight');
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/presence`)
        .set(dm)
        .send({ activity: 'spectating' });
      expect(res.status).toBe(400);
    });

    it('rejects an unknown key in the declare body with 400 (strict)', async () => {
      const server = ctx.app.getHttpServer();
      const encounterId = await createEncounter(false, 'Strict Fight');
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/presence`)
        .set(dm)
        .send({ activity: 'viewing', intent: 'resolving' });
      expect(res.status).toBe(400);
    });
  });
});
