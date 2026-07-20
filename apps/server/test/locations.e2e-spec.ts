import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

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

  // Entity-level secrecy (issue #42): reconciled with `status` rather than a separate
  // `hidden` flag — an `unexplored` location is the DM's un-revealed prep, dropped
  // wholesale from non-DM reads. Discovering it (→ explored|current) is the reveal.
  it('unexplored location is hidden from player/viewer; discovering reveals it', async () => {
    const server = ctx.app.getHttpServer();

    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/locations`)
      .set(dm)
      .send({ name: 'Secret Dungeon' }); // defaults to status 'unexplored'
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('unexplored');
    const locId = created.body.id;

    // DM sees it; player/viewer do not
    const dmList = await request(server).get(`/api/v1/campaigns/${campaignId}/locations`).set(dm);
    expect(dmList.body.some((l: { id: number }) => l.id === locId)).toBe(true);

    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/locations`).set(player);
    expect(playerList.body.some((l: { id: number }) => l.id === locId)).toBe(false);
    const viewerList = await request(server).get(`/api/v1/campaigns/${campaignId}/locations`).set(viewer);
    expect(viewerList.body.some((l: { id: number }) => l.id === locId)).toBe(false);

    // direct GET 404s for non-DM
    expect((await request(server).get(`/api/v1/locations/${locId}`).set(player)).status).toBe(404);

    // excluded from the player summary
    const playerSummary = await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(player);
    expect(playerSummary.body.locations.some((l: { id: number }) => l.id === locId)).toBe(false);

    // DM discovers it -> now visible to players
    const discover = await request(server).post(`/api/v1/locations/${locId}/discover`).set(dm).send({ status: 'explored' });
    expect(discover.status).toBe(201);
    const playerGetAfter = await request(server).get(`/api/v1/locations/${locId}`).set(player);
    expect(playerGetAfter.status).toBe(200);
    const playerListAfter = await request(server).get(`/api/v1/campaigns/${campaignId}/locations`).set(player);
    expect(playerListAfter.body.some((l: { id: number }) => l.id === locId)).toBe(true);
  });
});
