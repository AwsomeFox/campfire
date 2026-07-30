import fs from 'node:fs';
import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { CAMPAIGN_SEARCH_FTS_AVAILABLE } from '../src/db/db.module';

/**
 * Issue #1481 — search was unreachable on mobile, silently truncated at 50, and
 * returned different results depending on whether the install had the FTS5
 * extension. These suites cover the three acceptance criteria that need a real
 * database + HTTP stack: the server-meta mode signal, honest truncation
 * reporting, and FTS5-vs-fallback result-set parity on the same data.
 */
const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

type Result = { type: string; id: number; title: string; matchedField: string };

describe('campaign search mode, truncation, and parity (issue #1481)', () => {
  describe('server-meta exposes the active search mode on /me', () => {
    it('reports fts5 normally and fallback when the FTS5 flag is overridden false', async () => {
      const fts = await createTestApp();
      try {
        const meFts = (await request(fts.app.getHttpServer()).get('/api/v1/me').set(dm)).body;
        expect(meFts.instance.searchMode).toBe('fts5');
      } finally {
        await closeTestApp(fts);
      }

      const fallback = await createTestApp({
        overrides: [{ token: CAMPAIGN_SEARCH_FTS_AVAILABLE, useValue: false }],
      });
      try {
        const meFallback = (await request(fallback.app.getHttpServer()).get('/api/v1/me').set(dm)).body;
        expect(meFallback.instance.searchMode).toBe('fallback');
      } finally {
        await closeTestApp(fallback);
      }
    });
  });

  describe('truncation is reported, not silently capped at the limit', () => {
    let ctx: TestAppContext;
    let campaignId: number;

    beforeAll(async () => {
      ctx = await createTestApp();
      const server = ctx.app.getHttpServer();
      campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Truncation Camp' })).body.id;
      // 55 NPCs that all match "goblin" — strictly more than the 50-result default.
      for (let i = 1; i <= 55; i++) {
        await request(server)
          .post(`/api/v1/campaigns/${campaignId}/npcs`)
          .set(dm)
          .send({ name: `Goblin Scout ${i}`, body: 'A goblin.' });
      }
      // A uniquely-named entity for the negative (non-truncated) case.
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Snuffle Ogre', body: 'A distinct creature.' });
    });

    afterAll(() => closeTestApp(ctx));

    it('returns total + truncated=true and caps results at the limit', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/v1/campaigns/${campaignId}/search?q=${encodeURIComponent('goblin')}`)
        .set(dm);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(55);
      expect(res.body.truncated).toBe(true);
      expect(res.body.results).toHaveLength(50);
      expect(res.body.results.every((r: Result) => r.type === 'npc')).toBe(true);
    });

    it('does not flag truncation when matches fit within the limit', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/v1/campaigns/${campaignId}/search?q=${encodeURIComponent('snuffle')}`)
        .set(dm);
      expect(res.status).toBe(200);
      expect(res.body.truncated).toBe(false);
      expect(res.body.total).toBe(res.body.results.length);
      expect(res.body.results.length).toBe(1);
    });
  });

  describe('FTS5 and the full-scan fallback return the same set for a representative corpus', () => {
    // Chosen so every query is a token PREFIX (the FTS5 `"token"*` shape): "ex"
    // is deliberately a non-prefix substring of "Vexley", so it must match on
    // NEITHER backend now that the fallback is prefix-token aligned. The date
    // queries exercise the scheduled-session fallback, which has to mirror the
    // FTS5 aux column's space-separated date tokens (issue #1481).
    const queries = ['vex', 'fox', 'ex', 'vexley', 'saturday', '2031-09-20', '19:30'];
    let ftsResults: Record<string, Result[]>;
    let fallbackResults: Record<string, Result[]>;

    async function seedCorpus(server: ReturnType<TestAppContext['app']['getHttpServer']>, campaignId: number): Promise<void> {
      for (const name of ['Vexley', 'Vexor', 'Vex Hand', 'Foxglove', 'Roxy']) {
        await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name, body: 'A person.' });
      }
      await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Find the Vex Ledger' });
      await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'Fox Hunt' });
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/schedule`)
        .set(dm)
        .send({ title: 'Saturday game', scheduledAt: '2031-09-20T19:30:00.000Z' });
    }

    async function runQueries(server: ReturnType<TestAppContext['app']['getHttpServer']>, campaignId: number): Promise<Record<string, Result[]>> {
      const out: Record<string, Result[]> = {};
      for (const query of queries) {
        const res = await request(server)
          .get(`/api/v1/campaigns/${campaignId}/search?q=${encodeURIComponent(query)}`)
          .set(dm);
        expect(res.status).toBe(200);
        out[query] = res.body.results as Result[];
      }
      return out;
    }

    beforeAll(async () => {
      const fts = await createTestApp();
      const dataDir = fts.dataDir;
      const ftsServer = fts.app.getHttpServer();
      const campaignId = (await request(ftsServer).post('/api/v1/campaigns').set(dm).send({ name: 'Parity Camp' })).body.id;
      await seedCorpus(ftsServer, campaignId);
      ftsResults = await runQueries(ftsServer, campaignId);
      // Release the SQLite handle but keep the data dir, then reopen the SAME
      // database with the FTS5 flag forced false so the identical data is searched
      // through the full-scan fallback path.
      await fts.app.close();

      const fallback = await createTestApp({
        dataDir,
        overrides: [{ token: CAMPAIGN_SEARCH_FTS_AVAILABLE, useValue: false }],
      });
      try {
        fallbackResults = await runQueries(fallback.app.getHttpServer(), campaignId);
      } finally {
        await fallback.app.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it('returns the same result set (type:id) for every query in the corpus', () => {
      for (const query of queries) {
        const ftsSet = ftsResults[query].map((r) => `${r.type}:${r.id}`).sort();
        const fallbackSet = fallbackResults[query].map((r) => `${r.type}:${r.id}`).sort();
        expect(fallbackSet).toEqual(ftsSet);
      }
    });

    it('matches a non-prefix substring ("ex") on NEITHER backend', () => {
      expect(ftsResults.ex).toEqual([]);
      expect(fallbackResults.ex).toEqual([]);
    });

    it('agrees on the matched field for every shared hit', () => {
      for (const query of queries) {
        const ftsFields = ftsResults[query].map((r) => `${r.type}:${r.id}:${r.matchedField}`).sort();
        const fallbackFields = fallbackResults[query].map((r) => `${r.type}:${r.id}:${r.matchedField}`).sort();
        expect(fallbackFields).toEqual(ftsFields);
      }
    });
  });
});
