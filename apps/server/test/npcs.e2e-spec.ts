import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('npcs (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name: 'NPC Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('dmSecret visible to dm but absent for player and viewer', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Mayor Higgins', dmSecret: 'Is actually a doppelganger' });
    expect(createRes.status).toBe(201);
    const npcId = createRes.body.id;
    expect(createRes.body.dmSecret).toBe('Is actually a doppelganger');

    const dmGet = await request(server).get(`/api/v1/npcs/${npcId}`).set(dm);
    expect(dmGet.body.dmSecret).toBe('Is actually a doppelganger');

    const playerGet = await request(server).get(`/api/v1/npcs/${npcId}`).set(player);
    expect(playerGet.status).toBe(200);
    expect(playerGet.body.dmSecret).toBeFalsy();

    const viewerGet = await request(server).get(`/api/v1/npcs/${npcId}`).set(viewer);
    expect(viewerGet.status).toBe(200);
    expect(viewerGet.body.dmSecret).toBeFalsy();

    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/npcs`).set(player);
    for (const n of playerList.body) {
      expect(n.dmSecret).toBeFalsy();
    }
  });

  // Strict request DTOs (issue #131): NpcCreate/NpcUpdate are .strict() at the DTO
  // layer, so a plausible-but-wrong field name (`description` — the real column is
  // `body`) 400s with a message naming the offending key instead of the global pipe
  // silently stripping it and 201/202-ing as an emptier-than-intended write.
  it('unknown field in npc create/update body -> 400 naming the field, not silently stripped', async () => {
    const server = ctx.app.getHttpServer();

    // Direct create with a misnamed field -> 400 (was: 201 with `description` dropped).
    const badCreate = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Barkeep', description: 'a plausible-but-wrong field', role: 'Tavern owner' });
    expect(badCreate.status).toBe(400);
    expect(JSON.stringify(badCreate.body)).toMatch(/description|[Uu]nrecognized/);

    // The exact scenario from the issue: the proposal path (?proposed=true) is where
    // the silent drop was worst — it now 400s before a lossy proposal is ever stored.
    const badProposed = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs?proposed=true`)
      .set(player)
      .send({ name: 'Barkeep', description: 'a plausible-but-wrong field', role: 'Tavern owner' });
    expect(badProposed.status).toBe(400);
    expect(JSON.stringify(badProposed.body)).toMatch(/description|[Uu]nrecognized/);

    // A valid payload (correct `body` field) still succeeds and persists in full.
    const okCreate = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Barkeep', body: 'The friendly owner of the Prancing Pony', role: 'Tavern owner' });
    expect(okCreate.status).toBe(201);
    expect(okCreate.body.body).toBe('The friendly owner of the Prancing Pony');
    expect(okCreate.body.role).toBe('Tavern owner');

    // A misnamed field on update (PATCH) is likewise rejected.
    const badUpdate = await request(server)
      .patch(`/api/v1/npcs/${okCreate.body.id}`)
      .set(dm)
      .send({ discription: 'still a typo' });
    expect(badUpdate.status).toBe(400);
  });

  // Bundled entity icon (issue #302): iconSlug is an optional, opaque string that
  // round-trips through create + update and defaults to '' when unset. The web app
  // validates the slug against its bundled game-icons.net catalog; the server just
  // stores it, so #305/#307 can reuse the exact same field on other entities.
  it('npc iconSlug round-trips through create/update and defaults to empty', async () => {
    const server = ctx.app.getHttpServer();

    // Defaults to '' when omitted.
    const noIcon = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Iconless Ivan' });
    expect(noIcon.status).toBe(201);
    expect(noIcon.body.iconSlug).toBe('');

    // Set on create and read back verbatim.
    const withIcon = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Sir Broadsword', iconSlug: 'broadsword' });
    expect(withIcon.status).toBe(201);
    expect(withIcon.body.iconSlug).toBe('broadsword');
    const npcId = withIcon.body.id;

    // GET reflects the stored slug.
    const got = await request(server).get(`/api/v1/npcs/${npcId}`).set(dm);
    expect(got.body.iconSlug).toBe('broadsword');

    // PATCH updates it, and can clear it back to ''.
    const changed = await request(server)
      .patch(`/api/v1/npcs/${npcId}`)
      .set(dm)
      .send({ iconSlug: 'crossed-swords' });
    expect(changed.status).toBe(200);
    expect(changed.body.iconSlug).toBe('crossed-swords');

    const cleared = await request(server)
      .patch(`/api/v1/npcs/${npcId}`)
      .set(dm)
      .send({ iconSlug: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.iconSlug).toBe('');
  });

  // Entity-level secrecy (issue #42): a hidden NPC is excluded WHOLESALE from
  // non-DM reads, and the DM reveals it by patching hidden=false.
  it('hidden npc is absent for player/viewer, visible to dm, and reveal makes it appear', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'The Hidden Villain', hidden: true });
    expect(createRes.status).toBe(201);
    expect(createRes.body.hidden).toBe(true);
    const npcId = createRes.body.id;

    // DM sees it
    const dmGet = await request(server).get(`/api/v1/npcs/${npcId}`).set(dm);
    expect(dmGet.status).toBe(200);
    const dmList = await request(server).get(`/api/v1/campaigns/${campaignId}/npcs`).set(dm);
    expect(dmList.body.some((n: { id: number }) => n.id === npcId)).toBe(true);

    // Player & viewer: absent from the list and 404 on direct GET
    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/npcs`).set(player);
    expect(playerList.body.some((n: { id: number }) => n.id === npcId)).toBe(false);
    const viewerList = await request(server).get(`/api/v1/campaigns/${campaignId}/npcs`).set(viewer);
    expect(viewerList.body.some((n: { id: number }) => n.id === npcId)).toBe(false);
    expect((await request(server).get(`/api/v1/npcs/${npcId}`).set(player)).status).toBe(404);
    expect((await request(server).get(`/api/v1/npcs/${npcId}`).set(viewer)).status).toBe(404);

    // Excluded from campaign summary
    const playerSummary = await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(player);
    expect(playerSummary.body.npcs.some((n: { id: number }) => n.id === npcId)).toBe(false);

    // DM reveals -> visible to player
    const reveal = await request(server).patch(`/api/v1/npcs/${npcId}`).set(dm).send({ hidden: false });
    expect(reveal.status).toBe(200);
    expect(reveal.body.hidden).toBe(false);
    const playerGetAfter = await request(server).get(`/api/v1/npcs/${npcId}`).set(player);
    expect(playerGetAfter.status).toBe(200);
  });

  it('canon writes are dm only', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(player)
      .send({ name: 'Should fail' });
    expect(res.status).toBe(403);
  });

  // Issue #96: npc.locationId is an FK-shaped field that must resolve to a real location
  // IN THE SAME campaign, or 400 — mirroring quest giverNpcId / member characterId guards.
  describe('FK validation: npc.locationId (issue #96)', () => {
    it('POST npc with a nonexistent locationId -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Ghost-pinned', locationId: 99999 });
      expect(res.status).toBe(400);
    });

    it('POST npc with a cross-campaign locationId -> 400', async () => {
      const server = ctx.app.getHttpServer();
      const otherCamp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other NPC Campaign' });
      const locRes = await request(server)
        .post(`/api/v1/campaigns/${otherCamp.body.id}/locations`)
        .set(dm)
        .send({ name: 'Foreign Keep' });
      expect(locRes.status).toBe(201);

      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Cross-pinned', locationId: locRes.body.id });
      expect(res.status).toBe(400);
    });

    it('POST/PATCH npc with a valid same-campaign locationId -> 201/200', async () => {
      const server = ctx.app.getHttpServer();
      const locRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Home Village' });
      expect(locRes.status).toBe(201);

      const createRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Villager', locationId: locRes.body.id });
      expect(createRes.status).toBe(201);
      expect(createRes.body.locationId).toBe(locRes.body.id);

      const patchBad = await request(server).patch(`/api/v1/npcs/${createRes.body.id}`).set(dm).send({ locationId: 99999 });
      expect(patchBad.status).toBe(400);
    });
  });

  // Issue #96 + #116: deleting an NPC is now a reversible SOFT-delete. The NPC vanishes
  // from GET/list, but a quest that credits it as giver KEEPS the link — the NPC row still
  // exists (just hidden), so nothing dangles and a restore relights the giver line.
  describe('soft-delete cleanup: npc giver on quests (issue #96 / #116)', () => {
    it('deleting an NPC hides it but preserves quests.giverNpcId; restore brings it back', async () => {
      const server = ctx.app.getHttpServer();
      const npcRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Quest Giver' });
      expect(npcRes.status).toBe(201);
      const npcId = npcRes.body.id;

      const questRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'Slay the beast', giverNpcId: npcId });
      expect(questRes.status).toBe(201);
      expect(questRes.body.giverNpcId).toBe(npcId);
      const questId = questRes.body.id;

      const delRes = await request(server).delete(`/api/v1/npcs/${npcId}`).set(dm);
      expect(delRes.status).toBe(200);

      // NPC hidden from normal reads...
      const npcGone = await request(server).get(`/api/v1/npcs/${npcId}`).set(dm);
      expect(npcGone.status).toBe(404);

      // ...but the quest's giver link survives (reversible — restorable, no dangling ref).
      const questAfter = await request(server).get(`/api/v1/quests/${questId}`).set(dm);
      expect(questAfter.status).toBe(200);
      expect(questAfter.body.giverNpcId).toBe(npcId);

      const restoreRes = await request(server).post(`/api/v1/npcs/${npcId}/restore`).set(dm);
      expect(restoreRes.status).toBe(201);
      const npcBack = await request(server).get(`/api/v1/npcs/${npcId}`).set(dm);
      expect(npcBack.status).toBe(200);
    });
  });
});
