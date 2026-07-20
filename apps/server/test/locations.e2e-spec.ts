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

  // Issue #96: deleting a location must null out inbound references so nothing dangles —
  // NPCs pinned here (npcs.locationId) and the campaign's currentLocationId.
  describe('delete cleanup: location pins (issue #96)', () => {
    it('deleting a location nulls NPCs.locationId and campaigns.currentLocationId', async () => {
      const server = ctx.app.getHttpServer();
      const locRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Doomed Tavern' });
      expect(locRes.status).toBe(201);
      const locId = locRes.body.id;

      const npcRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Barkeep', locationId: locId });
      expect(npcRes.status).toBe(201);
      expect(npcRes.body.locationId).toBe(locId);
      const npcId = npcRes.body.id;

      // Make it the campaign's current location too, so we exercise both inbound refs.
      const discoverRes = await request(server).post(`/api/v1/locations/${locId}/discover`).set(dm).send({ status: 'current' });
      expect(discoverRes.status).toBe(201);
      const campBefore = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
      expect(campBefore.body.currentLocationId).toBe(locId);

      const delRes = await request(server).delete(`/api/v1/locations/${locId}`).set(dm);
      expect(delRes.status).toBe(200);

      const npcAfter = await request(server).get(`/api/v1/npcs/${npcId}`).set(dm);
      expect(npcAfter.status).toBe(200);
      expect(npcAfter.body.locationId).toBeNull();

      const campAfter = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
      expect(campAfter.body.currentLocationId).toBeNull();
    });
  });
});
