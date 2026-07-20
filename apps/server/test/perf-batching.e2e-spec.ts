import request from 'supertest';
import type Database from 'better-sqlite3';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB_HOLDER } from '../src/db/db.module';
import type { DbHolder } from '../src/db/db.module';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

/**
 * Issue #72 — the hot paths (summary objective-embed, encounter party auto-add,
 * roll-initiative, campaign delete) were N+1 / row-at-a-time. These tests prove
 * (a) behavior is unchanged and (b) each path issues a CONSTANT number of the
 * relevant statements regardless of how many rows it touches — the direct
 * signature of "no N+1".
 *
 * The query-count probe wraps the live better-sqlite3 handle's `prepare` and
 * records each statement's SQL every time it's executed (run/get/all/iterate),
 * so we can count how many times a given table was hit during one HTTP call.
 * drizzle builds+prepares each dynamic query per execution, so this reliably
 * counts real executions.
 */
type QueryProbe = {
  executed: string[];
  reset: () => void;
  restore: () => void;
  count: (needle: string) => number;
};

function instrument(raw: Database.Database): QueryProbe {
  const executed: string[] = [];
  const origPrepare = raw.prepare.bind(raw);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (raw as any).prepare = (source: string) => {
    const stmt = origPrepare(source);
    for (const method of ['run', 'get', 'all', 'iterate'] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orig = (stmt as any)[method];
      if (typeof orig === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (stmt as any)[method] = function patched(...args: unknown[]) {
          executed.push(source);
          return orig.apply(stmt, args);
        };
      }
    }
    return stmt;
  };
  return {
    executed,
    reset: () => {
      executed.length = 0;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    restore: () => {
      (raw as any).prepare = origPrepare;
    },
    count: (needle: string) => executed.filter((s) => s.toLowerCase().includes(needle.toLowerCase())).length,
  };
}

describe('issue #72 — batched hot paths (e2e)', () => {
  let ctx: TestAppContext;
  let probe: QueryProbe;

  beforeAll(async () => {
    ctx = await createTestApp();
    const holder = ctx.app.get<DbHolder>(DB_HOLDER);
    probe = instrument(holder.raw);
  });

  afterAll(async () => {
    probe.restore();
    await closeTestApp(ctx);
  });

  async function newCampaign(name: string): Promise<number> {
    const res = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name });
    return res.body.id;
  }

  describe('summary objective embedding', () => {
    it('embeds each quest\'s objectives in order, and never runs a per-quest query (single IN)', async () => {
      const server = ctx.app.getHttpServer();
      const campaignId = await newCampaign('Summary Batch');

      // Five quests, each with three objectives added in a known order.
      const questIds: number[] = [];
      for (let q = 0; q < 5; q++) {
        const questRes = await request(server)
          .post(`/api/v1/campaigns/${campaignId}/quests`)
          .set(dm)
          .send({ title: `Quest ${q}` });
        const questId = questRes.body.id;
        questIds.push(questId);
        for (let o = 0; o < 3; o++) {
          await request(server).post(`/api/v1/quests/${questId}/objectives`).set(dm).send({ text: `Q${q} obj ${o}` });
        }
      }

      probe.reset();
      const res = await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(dm);
      expect(res.status).toBe(200);

      // Behavior: every quest carries its three objectives, in insertion (sortOrder) order.
      expect(res.body.quests).toHaveLength(5);
      for (let q = 0; q < 5; q++) {
        const quest = res.body.quests.find((x: { id: number }) => x.id === questIds[q]);
        expect(quest.objectives).toHaveLength(3);
        expect(quest.objectives.map((o: { text: string }) => o.text)).toEqual([`Q${q} obj 0`, `Q${q} obj 1`, `Q${q} obj 2`]);
      }

      // N+1 signature: the objective embed must be a SINGLE quest_objectives query for
      // the whole summary, not one per quest (which would be 5 here).
      expect(probe.count('quest_objectives')).toBe(1);
    });

    it('summary with zero quests runs no quest_objectives query at all', async () => {
      const server = ctx.app.getHttpServer();
      const campaignId = await newCampaign('Empty Summary');

      probe.reset();
      const res = await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(dm);
      expect(res.status).toBe(200);
      expect(res.body.quests).toHaveLength(0);
      expect(probe.count('quest_objectives')).toBe(0);
    });
  });

  describe('encounter party auto-add', () => {
    it('adds every party member as a combatant using a single INSERT', async () => {
      const server = ctx.app.getHttpServer();
      const campaignId = await newCampaign('Party Batch');

      // Four party members with distinct DEX so we can verify per-row initMod is preserved.
      const dexByName: Record<string, number> = { Ara: 16, Bex: 10, Cyr: 8, Dor: 14 };
      for (const [name, DEX] of Object.entries(dexByName)) {
        const r = await request(server)
          .post(`/api/v1/campaigns/${campaignId}/characters`)
          .set(dm)
          .send({ name, stats: { DEX }, hpCurrent: 12, hpMax: 12 });
        expect(r.status).toBe(201);
      }

      probe.reset();
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Ambush' });
      expect(res.status).toBe(201);

      // Behavior: all four auto-added, sortOrder sequential, DEX-derived initMod correct.
      const combatants = res.body.combatants as Array<{ name: string; initMod: number; sortOrder: number; kind: string }>;
      expect(combatants).toHaveLength(4);
      for (const c of combatants) {
        expect(c.kind).toBe('character');
        expect(c.initMod).toBe(Math.floor((dexByName[c.name] - 10) / 2));
      }
      expect([...combatants].map((c) => c.sortOrder).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);

      // N+1 signature: exactly one INSERT into combatants for the whole party (was 4).
      const combatantInserts = probe.executed.filter(
        (s) => /insert\s+into/i.test(s) && /combatants/i.test(s),
      ).length;
      expect(combatantInserts).toBe(1);
    });

    it('an empty party issues no combatant INSERT and yields an empty encounter', async () => {
      const server = ctx.app.getHttpServer();
      const campaignId = await newCampaign('No Party');

      probe.reset();
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Solo' });
      expect(res.status).toBe(201);
      expect(res.body.combatants).toHaveLength(0);
      const combatantInserts = probe.executed.filter((s) => /insert\s+into/i.test(s) && /combatants/i.test(s)).length;
      expect(combatantInserts).toBe(0);
    });
  });

  describe('roll-initiative', () => {
    it('fills only null initiatives, in a single UPDATE', async () => {
      const server = ctx.app.getHttpServer();
      const campaignId = await newCampaign('Init Batch');
      for (const name of ['P1', 'P2', 'P3', 'P4']) {
        await request(server)
          .post(`/api/v1/campaigns/${campaignId}/characters`)
          .set(dm)
          .send({ name, stats: { DEX: 12 }, hpCurrent: 10, hpMax: 10 });
      }
      const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Fight' });
      const encounterId = encRes.body.id;

      // Pin one combatant's initiative so we can prove roll-initiative leaves it untouched.
      const pinned = encRes.body.combatants[0];
      await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${pinned.id}`).set(dm).send({ initiative: 42 });

      probe.reset();
      const rollRes = await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
      expect(rollRes.status).toBe(201);

      // Behavior: everyone now has an initiative; the pinned one is preserved.
      for (const c of rollRes.body.combatants as Array<{ id: number; initiative: number | null }>) {
        expect(c.initiative).not.toBeNull();
      }
      const pinnedAfter = (rollRes.body.combatants as Array<{ id: number; initiative: number }>).find((c) => c.id === pinned.id);
      expect(pinnedAfter?.initiative).toBe(42);

      // N+1 signature: the three remaining null initiatives are filled by ONE UPDATE (was 3).
      const combatantUpdates = probe.executed.filter((s) => /update\s+.*combatants/i.test(s)).length;
      expect(combatantUpdates).toBe(1);
    });

    it('a fully-rolled encounter issues no UPDATE on re-roll', async () => {
      const server = ctx.app.getHttpServer();
      const campaignId = await newCampaign('Init Noop');
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Solo', stats: { DEX: 12 }, hpCurrent: 10, hpMax: 10 });
      const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Fight' });
      const encounterId = encRes.body.id;
      await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm); // fill it once

      probe.reset();
      const again = await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
      expect(again.status).toBe(201);
      const combatantUpdates = probe.executed.filter((s) => /update\s+.*combatants/i.test(s)).length;
      expect(combatantUpdates).toBe(0);
    });
  });

  describe('campaign delete cascade', () => {
    it('deletes quests+objectives and encounters+combatants with one child DELETE each', async () => {
      const server = ctx.app.getHttpServer();
      const campaignId = await newCampaign('Delete Batch');

      // Three quests (each with objectives) and two encounters (each with combatants).
      for (let q = 0; q < 3; q++) {
        const questRes = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: `Q${q}` });
        await request(server).post(`/api/v1/quests/${questRes.body.id}/objectives`).set(dm).send({ text: 'obj' });
      }
      await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'PC', hpCurrent: 10, hpMax: 10 });
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'E1' });
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'E2' });

      probe.reset();
      const delRes = await request(server).delete(`/api/v1/campaigns/${campaignId}`).set(dm);
      expect(delRes.status).toBe(200);

      // One DELETE for quest_objectives (was one per quest) and one for combatants
      // (was one per encounter).
      const objectiveDeletes = probe.executed.filter((s) => /delete\s+from.*quest_objectives/i.test(s)).length;
      const combatantDeletes = probe.executed.filter((s) => /delete\s+from.*combatants/i.test(s)).length;
      expect(objectiveDeletes).toBe(1);
      expect(combatantDeletes).toBe(1);

      // And the campaign is gone.
      const getRes = await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(dm);
      expect(getRes.status).toBe(404);
    });
  });
});
