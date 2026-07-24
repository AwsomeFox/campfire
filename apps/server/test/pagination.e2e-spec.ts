import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'player-1' };

/**
 * Issue #71: real pagination on the high-volume list endpoints (sessions, notes,
 * audit), plus the sessions list-shape change (recapExcerpt instead of the full
 * recap body). Pagination is opt-in: omitting limit/offset preserves the prior
 * "return everything" behaviour so existing callers are unaffected.
 */
describe('list pagination (e2e, issue #71)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Pagination Campaign' });
    campaignId = res.body.id;

    // Seed 5 sessions with distinct recaps.
    for (let n = 1; n <= 5; n++) {
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/sessions`)
        .set(dm)
        .send({ number: n, title: `Session ${n}`, recap: `Recap body number ${n}. `.repeat(30) });
      expect(created.status).toBe(201);
    }
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // ---------- sessions ----------

  describe('sessions list', () => {
    it('list-shape omits the full recap and carries a recapExcerpt (issue #71)', async () => {
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/sessions`).set(dm);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(5);
      for (const s of res.body as Array<Record<string, unknown>>) {
        expect(s).not.toHaveProperty('recap'); // full body dropped from the list shape
        expect(typeof s.recapExcerpt).toBe('string');
        expect((s.recapExcerpt as string).length).toBeLessThanOrEqual(200); // excerpt is short
      }
    });

    it('the full recap is still available via GET /sessions/:id', async () => {
      const list = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/sessions`).set(dm);
      const first = (list.body as Array<{ id: number }>)[0];
      const full = await request(ctx.app.getHttpServer()).get(`/api/v1/sessions/${first.id}`).set(dm);
      expect(full.status).toBe(200);
      expect(typeof full.body.recap).toBe('string');
      expect(full.body.recap.length).toBeGreaterThan(200); // the whole body, not an excerpt
    });

    it('?limit honours the cap and stays newest-first', async () => {
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/sessions?limit=2`).set(dm);
      expect(res.status).toBe(200);
      const numbers = (res.body as Array<{ number: number }>).map((s) => s.number);
      expect(numbers).toEqual([5, 4]); // newest (highest number) first
    });

    it('?offset pages through the ordered result without overlap', async () => {
      const page1 = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/sessions?limit=2&offset=0`).set(dm);
      const page2 = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/sessions?limit=2&offset=2`).set(dm);
      expect((page1.body as Array<{ number: number }>).map((s) => s.number)).toEqual([5, 4]);
      expect((page2.body as Array<{ number: number }>).map((s) => s.number)).toEqual([3, 2]);
    });

    it('?offset without limit returns the remaining rows', async () => {
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/sessions?offset=3`).set(dm);
      expect((res.body as Array<{ number: number }>).map((s) => s.number)).toEqual([2, 1]);
    });

    it('no limit/offset returns every session (opt-in — backward compatible)', async () => {
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/sessions`).set(dm);
      expect(res.body).toHaveLength(5);
    });

    it.each([
      ['limit=abc', 'limit=abc'],
      ['limit=0', 'limit=0'],
      ['limit=-1', 'limit=-1'],
      ['offset=-1', 'offset=-1'],
    ])('rejects invalid %s with 400', async (_label, qs) => {
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/sessions?${qs}`).set(dm);
      expect(res.status).toBe(400);
    });

    it('an over-max limit is clamped (not an error) and returns all rows', async () => {
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/sessions?limit=99999`).set(dm);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(5);
    });
  });

  // ---------- campaign summary ----------

  it('campaign summary embeds list-shape sessions (recapExcerpt, no full recap)', async () => {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/summary`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body.sessions.length).toBe(5);
    for (const s of res.body.sessions as Array<Record<string, unknown>>) {
      expect(s).not.toHaveProperty('recap');
      expect(typeof s.recapExcerpt).toBe('string');
    }
  });

  // ---------- notes ----------

  describe('notes list', () => {
    let noteCampaign: number;

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Notes Paging' });
      noteCampaign = res.body.id;
      for (let i = 0; i < 6; i++) {
        const created = await request(server)
          .post(`/api/v1/campaigns/${noteCampaign}/notes`)
          .set(dm)
          .send({ body: `party note ${i}`, visibility: 'party_shared' });
        expect(created.status).toBe(201);
      }
    });

    it('?limit/?cursor page over the notes list', async () => {
      const server = ctx.app.getHttpServer();
      const page1 = await request(server).get(`/api/v1/campaigns/${noteCampaign}/notes?limit=4`).set(dm);
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(4);
      expect(page1.body.hasMore).toBe(true);
      const page2 = await request(server)
        .get(`/api/v1/campaigns/${noteCampaign}/notes?limit=4&cursor=${page1.body.nextCursor}`)
        .set(dm);
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(2);
      const ids1 = new Set((page1.body.items as Array<{ id: number }>).map((n) => n.id));
      const overlap = (page2.body.items as Array<{ id: number }>).filter((n) => ids1.has(n.id));
      expect(overlap).toHaveLength(0); // no row appears on both pages
    });

    it('no paging params returns a NoteListPage under the default limit', async () => {
      // Default contract is a page object (not a bare array). With only 6 notes the
      // default limit still returns every visible row on the first page.
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${noteCampaign}/notes`).set(dm);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        items: expect.any(Array),
        total: 6,
        hasMore: false,
        nextCursor: null,
      });
      expect(res.body.items).toHaveLength(6);
    });

    it('paging still respects note visibility (a private note stays hidden from a non-author)', async () => {
      const server = ctx.app.getHttpServer();
      // Author (dm) creates a private note; a player must not see it, even when paging.
      await request(server)
        .post(`/api/v1/campaigns/${noteCampaign}/notes`)
        .set(dm)
        .send({ body: 'dm private', visibility: 'private' });

      const playerAll = await request(server).get(`/api/v1/campaigns/${noteCampaign}/notes?limit=50`).set(player);
      expect(playerAll.status).toBe(200);
      // Player sees the 6 party_shared notes but NOT the dm's private one.
      expect(playerAll.body.items).toHaveLength(6);
      for (const n of playerAll.body.items as Array<{ body: string }>) {
        expect(n.body).not.toBe('dm private');
      }
    });

    it('rejects an invalid limit with 400', async () => {
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${noteCampaign}/notes?limit=nope`).set(dm);
      expect(res.status).toBe(400);
    });
  });

  // ---------- audit ----------

  describe('audit list', () => {
    it('?limit honours the cap and stays newest-first', async () => {
      const server = ctx.app.getHttpServer();
      const all = await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
      expect(all.status).toBe(200);
      const totalIds = (all.body as Array<{ id: number }>).map((r) => r.id);
      expect(totalIds.length).toBeGreaterThan(3);

      const limited = await request(server).get(`/api/v1/campaigns/${campaignId}/audit?limit=3`).set(dm);
      expect(limited.status).toBe(200);
      const limitedIds = (limited.body as Array<{ id: number }>).map((r) => r.id);
      expect(limitedIds).toHaveLength(3);
      expect(limitedIds).toEqual(totalIds.slice(0, 3)); // same newest-first order
    });

    it('?offset reaches older history the cap-100 would otherwise hide', async () => {
      const server = ctx.app.getHttpServer();
      const all = await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
      const totalIds = (all.body as Array<{ id: number }>).map((r) => r.id);

      const paged = await request(server).get(`/api/v1/campaigns/${campaignId}/audit?limit=2&offset=2`).set(dm);
      const pagedIds = (paged.body as Array<{ id: number }>).map((r) => r.id);
      expect(pagedIds).toEqual(totalIds.slice(2, 4));
    });

    it('rejects an invalid offset with 400', async () => {
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/audit?offset=abc`).set(dm);
      expect(res.status).toBe(400);
    });
  });
});
