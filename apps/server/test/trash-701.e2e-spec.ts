import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { combatants, encounterEvents, storyBranches } from '../src/db/schema';
import * as time from '../src/common/time';

// Covers soft-delete/restore for factions, story arcs/beats, and encounters (issue #701).
const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'trash-701-dm' };

describe('trash consistency — factions, storylines, encounters (e2e, issue #701)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Trash 701 Campaign' });
    campaignId = camp.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('faction soft-delete round-trips through trash + restore; NPC factionId survives', async () => {
    const server = ctx.app.getHttpServer();
    const factionRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/factions`)
      .set(dm)
      .send({ name: 'Trash Faction' });
    const factionId = factionRes.body.id;

    const npcRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Member', factionId });
    expect(npcRes.body.factionId).toBe(factionId);

    expect((await request(server).delete(`/api/v1/factions/${factionId}`).set(dm)).status).toBe(200);
    expect((await request(server).get(`/api/v1/factions/${factionId}`).set(dm)).status).toBe(404);

    const trash = await request(server).get(`/api/v1/campaigns/${campaignId}/trash`).set(dm);
    expect(trash.body.some((t: { type: string; id: number }) => t.type === 'faction' && t.id === factionId)).toBe(true);

    const npcAfter = await request(server).get(`/api/v1/npcs/${npcRes.body.id}`).set(dm);
    expect(npcAfter.body.factionId).toBe(factionId);

    expect((await request(server).post(`/api/v1/factions/${factionId}/restore`).set(dm)).status).toBe(201);
    expect((await request(server).get(`/api/v1/factions/${factionId}`).set(dm)).status).toBe(200);
    expect(
      (await request(server).get(`/api/v1/campaigns/${campaignId}/trash`).set(dm)).body.some(
        (t: { type: string; id: number }) => t.type === 'faction' && t.id === factionId,
      ),
    ).toBe(false);
  });

  it('arc delete cascades beats into trash; restore arc restores beats + branches', async () => {
    const server = ctx.app.getHttpServer();
    const db = ctx.app.get<DrizzleDb>(DB);

    const arcRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/arcs`)
      .set(dm)
      .send({ title: 'Trash Arc' });
    const arcId = arcRes.body.id;
    const beat1 = await request(server).post(`/api/v1/arcs/${arcId}/beats`).set(dm).send({ title: 'Beat A' });
    const beat2 = await request(server).post(`/api/v1/arcs/${arcId}/beats`).set(dm).send({ title: 'Beat B' });
    await request(server)
      .post(`/api/v1/beats/${beat1.body.id}/branches`)
      .set(dm)
      .send({ label: 'Go to B', toBeatId: beat2.body.id });

    expect((await request(server).delete(`/api/v1/arcs/${arcId}`).set(dm)).status).toBe(200);
    expect((await request(server).get(`/api/v1/arcs/${arcId}`).set(dm)).status).toBe(404);

    const trash = await request(server).get(`/api/v1/campaigns/${campaignId}/trash`).set(dm);
    expect(trash.body.some((t: { type: string; id: number }) => t.type === 'story_arc' && t.id === arcId)).toBe(true);
    expect(trash.body.some((t: { type: string; id: number }) => t.type === 'story_beat')).toBe(false);

    const branchesBefore = await db.select().from(storyBranches).where(eq(storyBranches.beatId, beat1.body.id));
    expect(branchesBefore.length).toBe(1);

    expect((await request(server).post(`/api/v1/arcs/${arcId}/restore`).set(dm)).status).toBe(201);
    const restored = await request(server).get(`/api/v1/arcs/${arcId}`).set(dm);
    expect(restored.status).toBe(200);
    expect(restored.body.beats).toHaveLength(2);
    expect(restored.body.beats[0].branches).toHaveLength(1);
  });

  it('beat restore is refused while parent arc is trashed (409)', async () => {
    const server = ctx.app.getHttpServer();
    const arcRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/arcs`)
      .set(dm)
      .send({ title: 'Conflict Arc' });
    const arcId = arcRes.body.id;
    const beat = await request(server).post(`/api/v1/arcs/${arcId}/beats`).set(dm).send({ title: 'Lonely beat' });

    await request(server).delete(`/api/v1/arcs/${arcId}`).set(dm);
    const restoreBeat = await request(server).post(`/api/v1/beats/${beat.body.id}/restore`).set(dm);
    expect(restoreBeat.status).toBe(409);
  });

  it('does not restore a beat independently deleted in the same millisecond as its arc', async () => {
    const server = ctx.app.getHttpServer();
    const arcRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/arcs`)
      .set(dm)
      .send({ title: 'Independent-delete Arc' });
    const arcId = arcRes.body.id;
    const independent = await request(server).post(`/api/v1/arcs/${arcId}/beats`).set(dm).send({ title: 'Keep trashed' });
    const cascaded = await request(server).post(`/api/v1/arcs/${arcId}/beats`).set(dm).send({ title: 'Restore with arc' });

    const nowIso = jest.spyOn(time, 'nowIso').mockReturnValue('2026-07-29T16:32:08.000Z');
    try {
      expect((await request(server).delete(`/api/v1/beats/${independent.body.id}`).set(dm)).status).toBe(200);
      expect((await request(server).delete(`/api/v1/arcs/${arcId}`).set(dm)).status).toBe(200);
      expect((await request(server).post(`/api/v1/arcs/${arcId}/restore`).set(dm)).status).toBe(201);
    } finally {
      nowIso.mockRestore();
    }

    const restored = await request(server).get(`/api/v1/arcs/${arcId}`).set(dm);
    expect(restored.status).toBe(200);
    expect(restored.body.beats).toHaveLength(1);
    expect(restored.body.beats[0].id).toBe(cascaded.body.id);
    expect((await request(server).post(`/api/v1/beats/${independent.body.id}/restore`).set(dm)).status).toBe(201);
  });

  it('encounter soft-delete preserves combatants, events, and revisions; restore round-trips', async () => {
    const server = ctx.app.getHttpServer();
    const db = ctx.app.get<DrizzleDb>(DB);

    const encRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Trash Encounter' });
    const encId = encRes.body.id;
    const add = await request(server)
      .post(`/api/v1/encounters/${encId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Goblin', hpMax: 7 });
    expect(add.status).toBe(201);
    await request(server).post(`/api/v1/encounters/${encId}/roll-initiative`).set(dm);
    await request(server).post(`/api/v1/encounters/${encId}/start`).set(dm);

    const combatantsBefore = await db.select().from(combatants).where(eq(combatants.encounterId, encId));
    const eventsBefore = await db.select().from(encounterEvents).where(eq(encounterEvents.encounterId, encId));
    expect(combatantsBefore.length).toBeGreaterThan(0);
    expect(eventsBefore.length).toBeGreaterThan(0);

    expect((await request(server).delete(`/api/v1/encounters/${encId}`).set(dm)).status).toBe(200);
    expect((await request(server).get(`/api/v1/encounters/${encId}`).set(dm)).status).toBe(404);

    const combatantsAfter = await db.select().from(combatants).where(eq(combatants.encounterId, encId));
    const eventsAfter = await db.select().from(encounterEvents).where(eq(encounterEvents.encounterId, encId));
    expect(combatantsAfter).toHaveLength(combatantsBefore.length);
    expect(eventsAfter).toHaveLength(eventsBefore.length);

    expect((await request(server).post(`/api/v1/encounters/${encId}/restore`).set(dm)).status).toBe(201);
    const back = await request(server).get(`/api/v1/encounters/${encId}`).set(dm);
    expect(back.status).toBe(200);
    expect(back.body.combatants.length).toBe(combatantsBefore.length);
  });

  it('permanent campaign purge hard-deletes trashed child rows', async () => {
    const server = ctx.app.getHttpServer();
    const purgeCamp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Purge Trash Camp' });
    const cid = purgeCamp.body.id;
    const faction = await request(server).post(`/api/v1/campaigns/${cid}/factions`).set(dm).send({ name: 'Gone' });
    await request(server).delete(`/api/v1/factions/${faction.body.id}`).set(dm);

    await request(server).delete(`/api/v1/campaigns/${cid}`).set(dm);
    const purge = await request(server).delete(`/api/v1/campaigns/${cid}/purge`).set(dm).send({ confirm: 'PURGE' });
    expect(purge.status).toBe(200);
    expect((await request(server).get(`/api/v1/factions/${faction.body.id}`).set(dm)).status).toBe(404);
  });
});
