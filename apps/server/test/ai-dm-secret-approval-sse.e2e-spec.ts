import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createAiEvalHarness, dm, player, type AiEvalHarness } from './ai-eval-harness';

/**
 * Issue #1552 — the `secret-approval` SSE frame leaked DM-hidden entity ids to the whole table.
 *
 * The controller role-projected only `tool` and `transcript` frames. `secret-approval` carries
 * `tool` plus `entityId`, naming the hidden entity a DM had just authorised the AI to read, and
 * went to every member unprojected — while the transcript row for that same event is written
 * `visibility: 'dm'` under a comment saying a player must not merely fail to RENDER a DM-only
 * event they were already handed.
 *
 * These run against the REAL SSE endpoint with two concurrent connections, one DM and one
 * player, because that is the only place the controller's projection is actually exercised.
 * Every other stream spec in this suite subscribes to the Subject in-process with no role at
 * all, which is exactly why this leak had no failing test.
 */

/** A hidden-entity id distinctive enough to search the whole player wire for. */
const HIDDEN_ENTITY_ID = 4242;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve((server.address() as AddressInfo).port);
      return;
    }
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

/**
 * Collect EVERY frame on a subscriber's stream, plus the raw bytes.
 *
 * Deliberately unfiltered, unlike the #825 collector next door which keeps only `tool` frames:
 * the assertion here is about what a player's connection does NOT carry, and a collector that
 * filtered by type could not see a leak in a type it was not looking for. The raw text is kept
 * so the id can be searched across the whole wire rather than only in fields we thought to check.
 */
function collectSse(
  port: number,
  campaignId: number,
  headers: Record<string, string>,
): Promise<{
  close: () => void;
  frames: Record<string, unknown>[];
  raw: () => string;
  waitFor: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  settle: (ms?: number) => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1/campaigns/${campaignId}/events`,
        headers: { accept: 'text/event-stream', ...headers },
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`SSE open failed: ${res.statusCode}`));
          res.resume();
          return;
        }
        let buffer = '';
        let rawAll = '';
        const frames: Record<string, unknown>[] = [];
        const waiters: Array<{ type: string; settle: (e: Record<string, unknown>) => void }> = [];
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          rawAll += chunk;
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
            if (typeof parsed !== 'object' || parsed === null) continue;
            const frame = parsed as Record<string, unknown>;
            frames.push(frame);
            for (let i = waiters.length - 1; i >= 0; i -= 1) {
              if (waiters[i].type === frame.type) {
                const [waiter] = waiters.splice(i, 1);
                waiter.settle(frame);
              }
            }
          }
        });
        resolve({
          close: () => req.destroy(),
          frames,
          raw: () => rawAll,
          settle: (ms = 400) => new Promise((r) => setTimeout(r, ms)),
          waitFor: (type, timeoutMs = 5000) =>
            new Promise((resolveWait, rejectWait) => {
              const existing = frames.find((f) => f.type === type);
              if (existing) {
                resolveWait(existing);
                return;
              }
              const timer = setTimeout(() => rejectWait(new Error(`timeout waiting for ${type}`)), timeoutMs);
              waiters.push({ type, settle: (f) => { clearTimeout(timer); resolveWait(f); } });
            }),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('ai-dm secret-approval SSE role projection (#1552)', () => {
  let h: AiEvalHarness;
  let port: number;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'secret-approval-model' });
    await h.enableExperimental();
    port = await listen(h.server as http.Server);
  });
  afterAll(async () => {
    await h.close();
  });

  async function grant(campaignId: number, tool: string, entityId: number) {
    return request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'grant', tool, entityId });
  }

  it("a player's stream carries no DM-hidden entity id for an approved secret read", async () => {
    const campaignId = await h.createCampaign('Secret SSE Leak');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const playerStream = await collectSse(port, campaignId, player);
    const dmStream = await collectSse(port, campaignId, dm);
    try {
      const res = await grant(campaignId, 'get_npc', HIDDEN_ENTITY_ID);
      expect(res.status).toBe(201);

      // The DM's frame is the synchronisation point: once it has landed, the broadcast has
      // fanned out to every open connection, so a player frame that was going to arrive has.
      await dmStream.waitFor('secret-approval');
      await playerStream.settle();

      // No frame of this type at all — the decision is to WITHHOLD, not to strip. A stripped
      // frame would still tell the table that the DM authorised a hidden read, i.e. that there
      // is something to know, at a table where the DM may be working not to signal that.
      expect(playerStream.frames.filter((f) => f.type === 'secret-approval')).toHaveLength(0);

      // And the id appears nowhere on the player's wire in any form — searched across the raw
      // bytes rather than only the fields this test thought to check.
      expect(playerStream.raw()).not.toContain(String(HIDDEN_ENTITY_ID));
      expect(playerStream.raw()).not.toContain('secret-approval');
      // The DM-only transcript row for the same event must not arrive either (#572); the two
      // are one event and had to stop disagreeing about who may see it.
      expect(playerStream.frames.some((f) => f.type === 'transcript')).toBe(false);
    } finally {
      playerStream.close();
      dmStream.close();
    }
  });

  it("the DM's own stream still receives the full frame", async () => {
    // As load-bearing as the leak test: projecting everyone's frames into uselessness would
    // pass the assertion above while silently breaking the feature #557 exists to provide.
    const campaignId = await h.createCampaign('Secret SSE DM');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const dmStream = await collectSse(port, campaignId, dm);
    try {
      expect((await grant(campaignId, 'get_npc', HIDDEN_ENTITY_ID)).status).toBe(201);

      const frame = await dmStream.waitFor('secret-approval');
      expect(frame.action).toBe('granted');
      expect(frame.tool).toBe('get_npc');
      expect(frame.entityId).toBe(HIDDEN_ENTITY_ID);
      expect(frame.campaignId).toBe(campaignId);
    } finally {
      dmStream.close();
    }
  });

  it('a revoke is withheld from players and delivered to the DM, same as a grant', async () => {
    // Revoke names the same hidden entity as the grant it withdraws, and is emitted from a
    // different method — the leak existed on both paths, so the fix has to cover both.
    const campaignId = await h.createCampaign('Secret SSE Revoke');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    await grant(campaignId, 'get_npc', HIDDEN_ENTITY_ID);

    const playerStream = await collectSse(port, campaignId, player);
    const dmStream = await collectSse(port, campaignId, dm);
    try {
      const res = await request(h.server)
        .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
        .set(dm)
        .send({ action: 'revoke', tool: 'get_npc', entityId: HIDDEN_ENTITY_ID });
      expect(res.status).toBe(201);

      const frame = await dmStream.waitFor('secret-approval');
      expect(frame.action).toBe('revoked');
      expect(frame.entityId).toBe(HIDDEN_ENTITY_ID);

      await playerStream.settle();
      expect(playerStream.raw()).not.toContain(String(HIDDEN_ENTITY_ID));
    } finally {
      playerStream.close();
      dmStream.close();
    }
  });

  it('table-wide signals still reach a player — the fix does not mute the shared stream', async () => {
    // The failure mode opposite to the leak. Narration and lifecycle frames are the table's
    // shared experience; a projection that dropped them would "pass" a leak test.
    const campaignId = await h.createCampaign('Secret SSE Not Muted');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const playerStream = await collectSse(port, campaignId, player);
    try {
      const res = await request(h.server)
        .post(`/api/v1/campaigns/${campaignId}/ai-dm/pause`)
        .set(dm)
        .send({ paused: true });
      expect(res.status).toBe(201);

      const state = await playerStream.waitFor('state');
      expect(state.campaignId).toBe(campaignId);
      expect(typeof state.state).toBe('string');
    } finally {
      playerStream.close();
    }
  });
});
