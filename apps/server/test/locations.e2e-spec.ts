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

  // Location nesting (issue #99): region→city→dungeon→room via a self-referencing parentId.
  // Mirrors the quest parent tree incl. the same-campaign check and cycle guard (#95).
  describe('nesting: parentId hierarchy (issue #99)', () => {
    it('nests a location under a parent (POST returns 201 with parentId)', async () => {
      const server = ctx.app.getHttpServer();

      const region = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Sword Coast', kind: 'region' });
      expect(region.status).toBe(201);
      expect(region.body.parentId).toBeNull();

      const city = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Waterdeep', kind: 'city', parentId: region.body.id });
      expect(city.status).toBe(201);
      expect(city.body.parentId).toBe(region.body.id);

      // Grandchild — three-level chain region→city→district.
      const district = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Dockside', kind: 'district', parentId: city.body.id });
      expect(district.status).toBe(201);
      expect(district.body.parentId).toBe(city.body.id);

      // Re-parenting via PATCH is allowed and persists.
      const moved = await request(server)
        .patch(`/api/v1/locations/${district.body.id}`)
        .set(dm)
        .send({ parentId: region.body.id });
      expect(moved.status).toBe(200);
      expect(moved.body.parentId).toBe(region.body.id);
    });

    it('rejects a parentId that does not exist in this campaign (400)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Orphan', parentId: 999999 });
      expect(res.status).toBe(400);
    });

    it('rejects a parentId belonging to another campaign (400)', async () => {
      const server = ctx.app.getHttpServer();
      const other = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Campaign' });
      const otherLoc = await request(server)
        .post(`/api/v1/campaigns/${other.body.id}/locations`)
        .set(dm)
        .send({ name: 'Foreign Keep' });
      expect(otherLoc.status).toBe(201);

      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Cross-campaign child', parentId: otherLoc.body.id });
      expect(res.status).toBe(400);
    });

    it('rejects a location becoming its own parent (400)', async () => {
      const server = ctx.app.getHttpServer();
      const loc = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Self Ref' });
      const res = await request(server).patch(`/api/v1/locations/${loc.body.id}`).set(dm).send({ parentId: loc.body.id });
      expect(res.status).toBe(400);
    });

    it('rejects a parentId that would create a cycle (400)', async () => {
      const server = ctx.app.getHttpServer();
      const grand = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Grandparent Cave' });
      const parent = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Parent Cave', parentId: grand.body.id });
      const child = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Child Cave', parentId: parent.body.id });

      // Making the grandparent a child of its own grandchild closes a loop → 400.
      const res = await request(server).patch(`/api/v1/locations/${grand.body.id}`).set(dm).send({ parentId: child.body.id });
      expect(res.status).toBe(400);

      // The tree is untouched — grandparent is still a root.
      const grandAfter = await request(server).get(`/api/v1/locations/${grand.body.id}`).set(dm);
      expect(grandAfter.body.parentId).toBeNull();
    });

    it('deleting a parent promotes its children to top level (parentId null)', async () => {
      const server = ctx.app.getHttpServer();
      const parent = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Collapsing Tower' });
      const child = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Tower Cellar', parentId: parent.body.id });
      expect(child.body.parentId).toBe(parent.body.id);

      const del = await request(server).delete(`/api/v1/locations/${parent.body.id}`).set(dm);
      expect(del.status).toBe(200);

      const childAfter = await request(server).get(`/api/v1/locations/${child.body.id}`).set(dm);
      expect(childAfter.status).toBe(200);
      expect(childAfter.body.parentId).toBeNull();
    });

    it('redaction is preserved on nested locations (unexplored child hidden, dmSecret stripped)', async () => {
      const server = ctx.app.getHttpServer();
      const parent = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Explored Region', status: 'explored' });
      // Unexplored child with a DM secret, nested under an explored parent.
      const child = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Hidden Vault', parentId: parent.body.id, dmSecret: 'the treasure is fake' });
      expect(child.body.parentId).toBe(parent.body.id);

      // DM sees the child and its secret.
      const dmGet = await request(server).get(`/api/v1/locations/${child.body.id}`).set(dm);
      expect(dmGet.body.dmSecret).toBe('the treasure is fake');

      // Player: unexplored child is hidden wholesale (404 + absent from list).
      expect((await request(server).get(`/api/v1/locations/${child.body.id}`).set(player)).status).toBe(404);
      const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/locations`).set(player);
      expect(playerList.body.some((l: { id: number }) => l.id === child.body.id)).toBe(false);

      // Reveal it, then the dmSecret must still be stripped for the player.
      await request(server).post(`/api/v1/locations/${child.body.id}/discover`).set(dm).send({ status: 'explored' });
      const playerGet = await request(server).get(`/api/v1/locations/${child.body.id}`).set(player);
      expect(playerGet.status).toBe(200);
      expect(playerGet.body.parentId).toBe(parent.body.id);
      expect(playerGet.body.dmSecret).toBe('');
    });
  });
});
