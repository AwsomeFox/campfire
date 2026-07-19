import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

/**
 * P2 fix pinning tests — campaign.sessionCount is now a true COUNT(*) of this campaign's
 * sessions (recomputed on every create/delete), instead of max(number seen so far),
 * which never decremented on delete and could be inflated far past the real row count
 * by a single high `number`. Duplicate (campaignId, number) is now rejected (409).
 */
describe('sessions (e2e) — sessionCount + duplicate number', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name: 'Session Count Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('sessionCount is a real count, not max(number)', async () => {
    const server = ctx.app.getHttpServer();

    const s1 = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number: 1 });
    expect(s1.status).toBe(201);

    const s2 = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number: 2 });
    expect(s2.status).toBe(201);

    const campRes = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(campRes.body.sessionCount).toBe(2);
  });

  it('deleting a session decrements sessionCount', async () => {
    const server = ctx.app.getHttpServer();

    const s3 = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number: 3 });
    expect(s3.status).toBe(201);

    const beforeDelete = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(beforeDelete.body.sessionCount).toBe(3);

    const delRes = await request(server).delete(`/api/v1/sessions/${s3.body.id}`).set(dm);
    expect(delRes.status).toBe(200);

    const afterDelete = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(afterDelete.body.sessionCount).toBe(2);
  });

  it('a high session number does not inflate sessionCount past the real row count', async () => {
    const server = ctx.app.getHttpServer();

    const highNumber = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number: 999 });
    expect(highNumber.status).toBe(201);

    // 2 surviving sessions (numbers 1, 2) from prior tests + this one (999) = 3 rows,
    // NOT 999 — proving sessionCount tracks COUNT(*), not max(number).
    const campRes = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(campRes.body.sessionCount).toBe(3);

    // cleanup so later tests in this file start from a known state
    const delRes = await request(server).delete(`/api/v1/sessions/${highNumber.body.id}`).set(dm);
    expect(delRes.status).toBe(200);
  });

  it('creating a session with a duplicate number in the same campaign is rejected (409)', async () => {
    const server = ctx.app.getHttpServer();

    const dupRes = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number: 1 });
    expect(dupRes.status).toBe(409);

    // sessionCount unchanged by the rejected create
    const campRes = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(campRes.body.sessionCount).toBe(2);
  });

  it('PATCHing a session number to collide with another session in the same campaign is rejected (409)', async () => {
    const server = ctx.app.getHttpServer();

    const s4 = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number: 4 });
    expect(s4.status).toBe(201);

    const patchRes = await request(server).patch(`/api/v1/sessions/${s4.body.id}`).set(dm).send({ number: 1 });
    expect(patchRes.status).toBe(409);

    // PATCHing a session's number to itself (no-op change) is fine, not a false conflict
    const selfPatch = await request(server).patch(`/api/v1/sessions/${s4.body.id}`).set(dm).send({ number: 4, title: 'Renamed' });
    expect(selfPatch.status).toBe(200);
    expect(selfPatch.body.title).toBe('Renamed');
  });

  it('duplicate numbers are allowed across different campaigns', async () => {
    const server = ctx.app.getHttpServer();
    const otherCampRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Session Campaign' });
    const otherCampaignId = otherCampRes.body.id;

    const res = await request(server).post(`/api/v1/campaigns/${otherCampaignId}/sessions`).set(dm).send({ number: 1 });
    expect(res.status).toBe(201);
  });
});
