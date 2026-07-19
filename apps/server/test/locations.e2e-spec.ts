import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

describe('locations (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Location Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('discover promotes new location to current and demotes previous', async () => {
    const server = ctx.app.getHttpServer();

    const locA = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/locations`)
      .set(dm)
      .send({ name: 'Village of Barovia' });
    const locAId = locA.body.id;

    const locB = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/locations`)
      .set(dm)
      .send({ name: 'Castle Ravenloft' });
    const locBId = locB.body.id;

    const discoverA = await request(server).post(`/api/v1/locations/${locAId}/discover`).set(dm).send({ status: 'current' });
    expect(discoverA.status).toBe(201);
    expect(discoverA.body.status).toBe('current');

    const campaignAfterA = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(campaignAfterA.body.currentLocationId).toBe(locAId);

    const discoverB = await request(server).post(`/api/v1/locations/${locBId}/discover`).set(dm).send({ status: 'current' });
    expect(discoverB.status).toBe(201);
    expect(discoverB.body.status).toBe('current');

    const locAAfter = await request(server).get(`/api/v1/locations/${locAId}`).set(dm);
    expect(locAAfter.body.status).toBe('explored');

    const campaignAfterB = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(campaignAfterB.body.currentLocationId).toBe(locBId);

    const summary = await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(dm);
    expect(summary.body.currentLocation.id).toBe(locBId);
  });
});
