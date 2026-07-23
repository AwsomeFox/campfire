import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('factions (e2e) — issue #221', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name: 'Faction Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('CRUD: create/get/list/update/delete a faction', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/factions`)
      .set(dm)
      .send({ name: "Thieves' Guild", kind: 'guild', body: 'A shadowy network', goals: 'Control the docks' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe("Thieves' Guild");
    expect(createRes.body.kind).toBe('guild');
    expect(createRes.body.reputation).toBe(0);
    expect(createRes.body.standing).toBe('neutral');
    const factionId = createRes.body.id;

    const getRes = await request(server).get(`/api/v1/factions/${factionId}`).set(dm);
    expect(getRes.status).toBe(200);
    expect(getRes.body.goals).toBe('Control the docks');
    expect(Array.isArray(getRes.body.members)).toBe(true);

    const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/factions`).set(dm);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((f: { id: number }) => f.id === factionId)).toBe(true);

    const patchRes = await request(server).patch(`/api/v1/factions/${factionId}`).set(dm).send({ kind: 'crime syndicate' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.kind).toBe('crime syndicate');

    const delRes = await request(server).delete(`/api/v1/factions/${factionId}`).set(dm);
    expect(delRes.status).toBe(200);
    expect((await request(server).get(`/api/v1/factions/${factionId}`).set(dm)).status).toBe(404);
  });

  it('dmSecret visible to dm but absent for player and viewer', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/factions`)
      .set(dm)
      // #754: omit defaults to DM-only; this case tests dmSecret redaction, so create visible.
      .send({ name: 'The Cult of the Deep', dmSecret: 'Fronted by the harbormaster', hidden: false });
    expect(createRes.status).toBe(201);
    const factionId = createRes.body.id;

    expect((await request(server).get(`/api/v1/factions/${factionId}`).set(dm)).body.dmSecret).toBe('Fronted by the harbormaster');
    const playerGet = await request(server).get(`/api/v1/factions/${factionId}`).set(player);
    expect(playerGet.status).toBe(200);
    expect(playerGet.body.dmSecret).toBeFalsy();
    const viewerGet = await request(server).get(`/api/v1/factions/${factionId}`).set(viewer);
    expect(viewerGet.body.dmSecret).toBeFalsy();

    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/factions`).set(player);
    for (const f of playerList.body) expect(f.dmSecret).toBeFalsy();
  });

  it('hidden faction is absent for player/viewer, visible to dm, and reveal makes it appear', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/factions`)
      .set(dm)
      .send({ name: 'The Secret Hand', hidden: true });
    expect(createRes.status).toBe(201);
    expect(createRes.body.hidden).toBe(true);
    const factionId = createRes.body.id;

    // DM sees it; player/viewer do not (absent from list + 404 on GET)
    expect((await request(server).get(`/api/v1/factions/${factionId}`).set(dm)).status).toBe(200);
    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/factions`).set(player);
    expect(playerList.body.some((f: { id: number }) => f.id === factionId)).toBe(false);
    expect((await request(server).get(`/api/v1/factions/${factionId}`).set(player)).status).toBe(404);
    expect((await request(server).get(`/api/v1/factions/${factionId}`).set(viewer)).status).toBe(404);

    // Reveal -> visible to player
    const reveal = await request(server).patch(`/api/v1/factions/${factionId}`).set(dm).send({ hidden: false });
    expect(reveal.status).toBe(200);
    expect((await request(server).get(`/api/v1/factions/${factionId}`).set(player)).status).toBe(200);
  });

  it('canon writes are dm only', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/factions`).set(player).send({ name: 'Should fail' });
    expect(res.status).toBe(403);
  });

  it('reputation round-trip: delta bump, absolute set, standing label, clamping', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/factions`)
      .set(dm)
      .send({ name: 'The Harpers', reputation: 10, standing: 'friendly' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.reputation).toBe(10);
    const factionId = createRes.body.id;

    // Delta bump down
    const down = await request(server).patch(`/api/v1/factions/${factionId}/reputation`).set(dm).send({ delta: -30 });
    expect(down.status).toBe(200);
    expect(down.body.reputation).toBe(-20);

    // Set standing label
    const standing = await request(server).patch(`/api/v1/factions/${factionId}/reputation`).set(dm).send({ standing: 'hostile' });
    expect(standing.status).toBe(200);
    expect(standing.body.standing).toBe('hostile');

    // Absolute set
    const absolute = await request(server).patch(`/api/v1/factions/${factionId}/reputation`).set(dm).send({ reputation: 55 });
    expect(absolute.status).toBe(200);
    expect(absolute.body.reputation).toBe(55);

    // Clamp: a large negative delta (55 - 200) floors at -100
    const clamp = await request(server).patch(`/api/v1/factions/${factionId}/reputation`).set(dm).send({ delta: -200 });
    expect(clamp.status).toBe(200);
    expect(clamp.body.reputation).toBe(-100);

    // Empty patch -> 400
    expect((await request(server).patch(`/api/v1/factions/${factionId}/reputation`).set(dm).send({})).status).toBe(400);

    // Non-dm cannot adjust
    expect((await request(server).patch(`/api/v1/factions/${factionId}/reputation`).set(player).send({ delta: 1 })).status).toBe(403);
  });

  it('npc↔faction membership: set factionId, surface members, FK validation, unlink on delete', async () => {
    const server = ctx.app.getHttpServer();

    const factionRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/factions`)
      .set(dm)
      .send({ name: 'The Zhentarim' });
    const factionId = factionRes.body.id;

    const npcRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Manshoon', factionId });
    expect(npcRes.status).toBe(201);
    expect(npcRes.body.factionId).toBe(factionId);

    // The faction detail surfaces the NPC as a member.
    const withMembers = await request(server).get(`/api/v1/factions/${factionId}`).set(dm);
    expect(withMembers.body.members.some((n: { id: number }) => n.id === npcRes.body.id)).toBe(true);

    // FK validation: nonexistent factionId -> 400.
    const bad = await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Ghost', factionId: 999999 });
    expect(bad.status).toBe(400);

    // Cross-campaign factionId -> 400.
    const otherCamp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Faction Campaign' });
    const foreignFaction = await request(server).post(`/api/v1/campaigns/${otherCamp.body.id}/factions`).set(dm).send({ name: 'Foreign Order' });
    const crossBad = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Cross', factionId: foreignFaction.body.id });
    expect(crossBad.status).toBe(400);

    // Deleting the faction unlinks the NPC (factionId nulled), not deletes it.
    const del = await request(server).delete(`/api/v1/factions/${factionId}`).set(dm);
    expect(del.status).toBe(200);
    const npcAfter = await request(server).get(`/api/v1/npcs/${npcRes.body.id}`).set(dm);
    expect(npcAfter.status).toBe(200);
    expect(npcAfter.body.factionId).toBeNull();
  });

  it('a note can pin to entityType "faction" and resolves the faction name', async () => {
    const server = ctx.app.getHttpServer();
    const factionRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/factions`)
      .set(dm)
      .send({ name: 'The Crown' });
    const factionId = factionRes.body.id;

    const noteRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(dm)
      .send({ body: 'They levied a new tax', entityType: 'faction', entityId: factionId });
    expect(noteRes.status).toBe(201);
    expect(noteRes.body.entityType).toBe('faction');
    expect(noteRes.body.entityName).toBe('The Crown');
  });

  it('faction is searchable and appears as an @-mention target', async () => {
    const server = ctx.app.getHttpServer();
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/factions`)
      .set(dm)
      .send({ name: 'The Emerald Enclave', body: 'Druids and rangers guarding the wilds' });

    const search = await request(server).get(`/api/v1/campaigns/${campaignId}/search?q=Emerald`).set(dm);
    expect(search.status).toBe(200);
    expect(search.body.results.some((r: { type: string; title: string }) => r.type === 'faction' && r.title === 'The Emerald Enclave')).toBe(true);

    const mentions = await request(server).get(`/api/v1/campaigns/${campaignId}/mentions`).set(dm);
    expect(mentions.body.some((m: { type: string; name: string }) => m.type === 'faction' && m.name === 'The Emerald Enclave')).toBe(true);
  });
});
