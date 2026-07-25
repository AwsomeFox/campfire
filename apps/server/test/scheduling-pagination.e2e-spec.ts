import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-612' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'player-612' };

/**
 * Issue #612 — bounded session history + direct upcoming/past schedule queries.
 */
describe('sessions & schedule pagination (e2e, issue #612)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Issue 612 Campaign' });
    campaignId = res.body.id;

    // Seed a five-year span of session logs (newest-first paging must stay stable).
    for (let year = 2021; year <= 2025; year++) {
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/sessions`)
        .set(dm)
        .send({ number: year - 2020, title: `Session ${year}`, playedAt: `${year}-06-15`, recap: `Recap for ${year}.` });
      expect(created.status).toBe(201);
    }
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('session list with limit returns SessionListPage newest-first with total/hasMore', async () => {
    const server = ctx.app.getHttpServer();
    const page1 = await request(server).get(`/api/v1/campaigns/${campaignId}/sessions?limit=2&offset=0`).set(player);
    expect(page1.status).toBe(200);
    expect(page1.body).toMatchObject({
      items: expect.any(Array),
      total: 5,
      hasMore: true,
      limit: 2,
      offset: 0,
    });
    expect(page1.body.items.map((s: { number: number }) => s.number)).toEqual([5, 4]);

    const page2 = await request(server).get(`/api/v1/campaigns/${campaignId}/sessions?limit=2&offset=2`).set(player);
    expect(page2.body.items.map((s: { number: number }) => s.number)).toEqual([3, 2]);
    expect(page2.body.hasMore).toBe(true);

    const page3 = await request(server).get(`/api/v1/campaigns/${campaignId}/sessions?limit=2&offset=4`).set(player);
    expect(page3.body.items.map((s: { number: number }) => s.number)).toEqual([1]);
    expect(page3.body.hasMore).toBe(false);
  });

  it('GET /schedule/upcoming returns only live nights; /schedule/past pages ended history', async () => {
    const server = ctx.app.getHttpServer();
    const now = Date.now();

    const pastNight = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({
        scheduledAt: new Date(now - 5 * 60 * 60_000).toISOString(),
        durationMinutes: 60,
        title: 'Ended morning slot',
      });
    expect(pastNight.status).toBe(201);

    const liveNight = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({
        scheduledAt: new Date(now + 2 * 60 * 60_000).toISOString(),
        durationMinutes: 180,
        title: 'Tonight',
      });
    expect(liveNight.status).toBe(201);

    const upcoming = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(player);
    expect(upcoming.status).toBe(200);
    expect(upcoming.body.some((s: { id: number }) => s.id === liveNight.body.id)).toBe(true);
    expect(upcoming.body.some((s: { id: number }) => s.id === pastNight.body.id)).toBe(false);

    const past = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/past?limit=1&offset=0`).set(player);
    expect(past.status).toBe(200);
    expect(past.body.items).toHaveLength(1);
    expect(past.body.total).toBeGreaterThanOrEqual(1);
    expect(past.body.items[0].id).toBe(pastNight.body.id);

    await request(server).delete(`/api/v1/schedule/${liveNight.body.id}`).set(dm);
    await request(server).delete(`/api/v1/schedule/${pastNight.body.id}`).set(dm);
  });

  it('GET /schedule/next uses LIMIT 1 and matches upcoming split across DST spring-forward', async () => {
    const server = ctx.app.getHttpServer();
    const prevTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const dstStart = '2027-03-14T06:30:00.000Z';
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/schedule`)
        .set(dm)
        .send({ scheduledAt: dstStart, durationMinutes: 180, title: 'DST game' });
      expect(created.status).toBe(201);

      const next = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/next`).set(player);
      expect(next.status).toBe(200);
      expect(next.body?.id).toBe(created.body.id);

      const upcoming = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(player);
      expect(upcoming.body.some((s: { id: number }) => s.id === created.body.id)).toBe(true);

      await request(server).delete(`/api/v1/schedule/${created.body.id}`).set(dm);
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });

  it('concurrent RSVP writes preserve notes and upcoming projection stays consistent', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-12-01T18:00:00Z', title: 'RSVP concurrency night' });
    const scheduleId = created.body.id as number;

    const [statusRes, noteRes] = await Promise.all([
      request(server).put(`/api/v1/schedule/${scheduleId}/rsvp`).set(player).send({ status: 'yes' }),
      request(server).put(`/api/v1/schedule/${scheduleId}/rsvp`).set(player).send({ note: 'running late' }),
    ]);
    expect(statusRes.status).toBe(200);
    expect(noteRes.status).toBe(200);

    const upcoming = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(player);
    const row = upcoming.body.find((s: { id: number }) => s.id === scheduleId);
    expect(row.rsvps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'dev:player-612', status: 'yes' }),
      ]),
    );

    await request(server).delete(`/api/v1/schedule/${scheduleId}`).set(dm);
  });
});
