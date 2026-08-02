import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createAiEvalHarness, dm, player, type AiEvalHarness } from './ai-eval-harness';
import type { CampaignEvent } from '@campfire/schema';
import { AiDmStreamService } from '../src/modules/ai-driver/ai-driver-stream.service';

/**
 * Issue #825 — AI encounter activity must carry server-derived encounter identity
 * so an open fight never claims a tool that hit another encounter, and hidden
 * prep ids stay role-safe on the shared narration SSE.
 */

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve((server.address() as AddressInfo).port);
      return;
    }
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

function collectSseToolEvents(
  port: number,
  campaignId: number,
  headers: Record<string, string>,
): Promise<{
  close: () => void;
  waitForTool: (name: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
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
        const events: Record<string, unknown>[] = [];
        const waiters: Array<{ name: string; settle: (e: Record<string, unknown>) => void }> = [];
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
            if (typeof parsed !== 'object' || parsed === null) continue;
            const event = parsed as Record<string, unknown>;
            if (event.type !== 'tool') continue;
            events.push(event);
            for (let i = waiters.length - 1; i >= 0; i -= 1) {
              if (waiters[i].name === event.name) {
                const [waiter] = waiters.splice(i, 1);
                waiter.settle(event);
              }
            }
          }
        });
        resolve({
          close: () => req.destroy(),
          waitForTool: (name, timeoutMs = 5000) =>
            new Promise((resolveWait, rejectWait) => {
              const existing = events.find((e) => e.name === name);
              if (existing) {
                resolveWait(existing);
                return;
              }
              const timer = setTimeout(() => rejectWait(new Error(`timeout waiting for tool ${name}`)), timeoutMs);
              waiters.push({
                name,
                settle: (e) => {
                  clearTimeout(timer);
                  resolveWait(e);
                },
              });
            }),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('ai-dm encounter activity identity (#825)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'encounter-activity-model' });
    await h.enableExperimental();
  });

  afterAll(async () => {
    await h.close();
  });

  async function createEncounter(
    campaignId: number,
    name: string,
    opts: { hidden?: boolean } = {},
  ): Promise<number> {
    const res = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name, hidden: opts.hidden ?? false });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  it('attaches encounterId from validated args to tool SSE + turn summary (two fights)', async () => {
    const campaignId = await h.createCampaign('Two Fights Identity');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    const encounterA = await createEncounter(campaignId, 'Fight A');
    const encounterB = await createEncounter(campaignId, 'Fight B');

    // Need two combatants + initiative so next_turn can succeed on B.
    for (const [encounterId, name] of [
      [encounterA, 'Goblin A'],
      [encounterB, 'Goblin B'],
    ] as const) {
      const add = await request(h.server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name, hpMax: 7 });
      expect(add.status).toBe(201);
      const second = await request(h.server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: `${name} 2`, hpMax: 7 });
      expect(second.status).toBe(201);
      expect((await request(h.server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm)).status).toBe(
        201,
      );
    }
    expect((await request(h.server).post(`/api/v1/encounters/${encounterB}/start`).set(dm)).status).toBe(201);

    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: CampaignEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    h.script(
      {
        text: 'The other skirmish presses on…',
        toolCalls: [{ id: 't1', name: 'next_turn', arguments: { encounterId: encounterB } }],
      },
      { text: 'Steel rings in Fight B.' },
    );
    const res = await h.sendMessage(campaignId, { input: 'Advance the other fight.' });
    sub.unsubscribe();

    expect(res.status).toBe(201);
    expect(res.body.toolCalls).toEqual([
      { name: 'next_turn', isError: false, proposed: false, encounterId: encounterB },
    ]);

    const toolEv = events.find((e): e is Extract<CampaignEvent, { type: 'tool' }> => e.type === 'tool');
    expect(toolEv).toBeDefined();
    expect(toolEv?.name).toBe('next_turn');
    expect(toolEv?.encounterId).toBe(encounterB);
    expect(toolEv?.encounterHidden).toBe(false);
    // Must not claim Fight A — the open-page bug this issue closes.
    expect(toolEv?.encounterId).not.toBe(encounterA);
  });

  it('strips hidden encounter ids from player SSE while DMs still receive them', async () => {
    const campaignId = await h.createCampaign('Hidden Prep Identity');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    const hiddenId = await createEncounter(campaignId, 'Secret Ambush', { hidden: true });

    const port = await listen(h.server as http.Server);
    const dmConn = await collectSseToolEvents(port, campaignId, dm);
    const playerConn = await collectSseToolEvents(port, campaignId, player);
    try {
      h.script(
        {
          text: 'Prepping the ambush…',
          toolCalls: [
            {
              id: 'c1',
              name: 'add_combatant',
              arguments: {
                encounterId: hiddenId,
                kind: 'monster',
                name: 'Ogre',
                hpMax: 30,
              },
            },
          ],
        },
        { text: 'The ambush is ready.' },
      );

      const dmWait = dmConn.waitForTool('add_combatant');
      const playerWait = playerConn.waitForTool('add_combatant');
      const res = await h.sendMessage(campaignId, { input: 'Add an ogre to the prep fight.' });
      expect(res.status).toBe(201);
      expect(res.body.toolCalls[0]).toMatchObject({
        name: 'add_combatant',
        isError: false,
        encounterId: hiddenId,
      });

      const dmTool = await dmWait;
      const playerTool = await playerWait;

      expect(dmTool.encounterId).toBe(hiddenId);
      expect(dmTool).not.toHaveProperty('encounterHidden');
      expect(playerTool.name).toBe('add_combatant');
      expect(playerTool).not.toHaveProperty('encounterId');
      expect(playerTool).not.toHaveProperty('encounterHidden');
    } finally {
      dmConn.close();
      playerConn.close();
    }
  });

  it('keeps encounterId on failed encounter tools when the row is valid', async () => {
    const campaignId = await h.createCampaign('Failed Tool Identity');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    const encounterId = await createEncounter(campaignId, 'Not Started');

    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: CampaignEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    // next_turn on a preparing encounter errors — identity must still attach.
    // Single scripted step only: tool_error stops the loop without consuming a follow-up.
    h.script({
      text: 'Advancing…',
      toolCalls: [{ id: 'bad', name: 'next_turn', arguments: { encounterId } }],
    });
    const res = await h.sendMessage(campaignId, { input: 'Next turn.' });
    sub.unsubscribe();

    expect(res.status).toBe(201);
    expect(res.body.toolCalls).toEqual([
      { name: 'next_turn', isError: true, proposed: false, encounterId },
    ]);
    const toolEv = events.find((e): e is Extract<CampaignEvent, { type: 'tool' }> => e.type === 'tool');
    expect(toolEv?.isError).toBe(true);
    expect(toolEv?.encounterId).toBe(encounterId);
  });

  it('labels the mutated fight when prep runs against a different encounter than a live one', async () => {
    const campaignId = await h.createCampaign('Visible Prep Identity');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    const liveId = await createEncounter(campaignId, 'Live Fight');
    const prepId = await createEncounter(campaignId, 'Visible Prep');

    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: CampaignEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    h.script(
      {
        text: 'Staging the next wave…',
        toolCalls: [
          {
            id: 'c1',
            name: 'add_combatant',
            arguments: { encounterId: prepId, kind: 'monster', name: 'Reinforcement', hpMax: 12 },
          },
        ],
      },
      { text: 'Reinforcements wait in the wings.' },
    );
    const res = await h.sendMessage(campaignId, { input: 'Prep reinforcements.' });
    sub.unsubscribe();

    expect(res.status).toBe(201);
    expect(res.body.toolCalls).toEqual([
      { name: 'add_combatant', isError: false, proposed: false, encounterId: prepId },
    ]);
    // Identity is the prep fight — not the live one a client might have open.
    expect(res.body.toolCalls[0].encounterId).not.toBe(liveId);

    const toolEv = events.find((e): e is Extract<CampaignEvent, { type: 'tool' }> => e.type === 'tool');
    expect(toolEv?.encounterId).toBe(prepId);
    expect(toolEv?.encounterHidden).toBe(false);
  });
});
