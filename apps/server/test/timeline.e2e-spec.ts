import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('timeline / in-world calendar (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Timeline Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('dm creates events (POST=201) -> list ordered by sortIndex, then id', async () => {
    const server = ctx.app.getHttpServer();

    // Create out of narrative order; sortIndex decides the timeline order.
    const third = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .set(dm)
      .send({ title: 'The Sundering', inWorldDate: '1st of Hammer, 1492 DR', sortIndex: 30 });
    expect(third.status).toBe(201);
    expect(third.body.inWorldDate).toBe('1st of Hammer, 1492 DR');

    const first = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .set(dm)
      .send({ title: 'Founding of Neverwinter', inWorldDate: 'Year 87 DR', sortIndex: 10 });
    expect(first.status).toBe(201);

    const second = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .set(dm)
      .send({ title: 'The Spellplague', inWorldDate: '1385 DR', sortIndex: 20 });
    expect(second.status).toBe(201);

    const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/timeline`).set(dm);
    expect(listRes.status).toBe(200);
    const titles = listRes.body.map((e: { title: string }) => e.title);
    expect(titles).toEqual(['Founding of Neverwinter', 'The Spellplague', 'The Sundering']);
    expect(listRes.body.map((e: { id: number }) => e.id)).toEqual([first.body.id, second.body.id, third.body.id]);
  });

  it('get / update / delete a single event', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .set(dm)
      .send({ title: 'A minor skirmish', inWorldDate: '3rd of Flamerule' });
    const id = created.body.id;

    const got = await request(server).get(`/api/v1/timeline/${id}`).set(dm);
    expect(got.status).toBe(200);
    expect(got.body.title).toBe('A minor skirmish');

    const updated = await request(server)
      .patch(`/api/v1/timeline/${id}`)
      .set(dm)
      .send({ title: 'The Battle of Flamerule', era: 'Age of Chains' });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe('The Battle of Flamerule');
    expect(updated.body.era).toBe('Age of Chains');

    const removed = await request(server).delete(`/api/v1/timeline/${id}`).set(dm);
    expect(removed.status).toBe(200);
    const gone = await request(server).get(`/api/v1/timeline/${id}`).set(dm);
    expect(gone.status).toBe(404);
  });

  it('unknown key in create/update body -> 400 (strict DTO), not silently stripped', async () => {
    const server = ctx.app.getHttpServer();
    const bad = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .set(dm)
      .send({ title: 'Typo event', dat: 'not a real field' });
    expect(bad.status).toBe(400);

    const ok = await request(server).post(`/api/v1/campaigns/${campaignId}/timeline`).set(dm).send({ title: 'Clean event' });
    expect(ok.status).toBe(201);

    const badPatch = await request(server).patch(`/api/v1/timeline/${ok.body.id}`).set(dm).send({ titel: 'typo' });
    expect(badPatch.status).toBe(400);
  });

  it('dmSecret is visible to dm but stripped for player and viewer', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .set(dm)
      // #754: omit defaults to DM-only; this case tests dmSecret redaction, so create visible.
      .send({ title: 'Secret pact', dmSecret: 'The duke signed it in blood.', hidden: false });
    const id = created.body.id;
    expect(created.body.dmSecret).toBe('The duke signed it in blood.');

    const dmGet = await request(server).get(`/api/v1/timeline/${id}`).set(dm);
    expect(dmGet.body.dmSecret).toBe('The duke signed it in blood.');

    const playerGet = await request(server).get(`/api/v1/timeline/${id}`).set(player);
    expect(playerGet.status).toBe(200);
    expect(playerGet.body.dmSecret).toBeFalsy();

    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/timeline`).set(player);
    for (const e of playerList.body) expect(e.dmSecret).toBeFalsy();
  });

  it('hidden event is absent for non-DM (list + direct GET 404), reveal makes it appear', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .set(dm)
      .send({ title: 'A prophecy yet to unfold', hidden: true });
    expect(created.status).toBe(201);
    expect(created.body.hidden).toBe(true);
    const id = created.body.id;

    // DM sees it
    const dmList = await request(server).get(`/api/v1/campaigns/${campaignId}/timeline`).set(dm);
    expect(dmList.body.some((e: { id: number }) => e.id === id)).toBe(true);

    // Player & viewer: excluded from list, direct GET 404s (existence not leaked)
    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/timeline`).set(player);
    expect(playerList.body.some((e: { id: number }) => e.id === id)).toBe(false);
    expect((await request(server).get(`/api/v1/timeline/${id}`).set(player)).status).toBe(404);
    expect((await request(server).get(`/api/v1/timeline/${id}`).set(viewer)).status).toBe(404);

    // Reveal -> visible to players
    const reveal = await request(server).patch(`/api/v1/timeline/${id}`).set(dm).send({ hidden: false });
    expect(reveal.status).toBe(200);
    const playerListAfter = await request(server).get(`/api/v1/campaigns/${campaignId}/timeline`).set(player);
    expect(playerListAfter.body.some((e: { id: number }) => e.id === id)).toBe(true);
  });

  it('non-DM cannot create/update/delete events (403)', async () => {
    const server = ctx.app.getHttpServer();
    const playerCreate = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .set(player)
      .send({ title: 'Should fail' });
    expect(playerCreate.status).toBe(403);

    const evt = await request(server).post(`/api/v1/campaigns/${campaignId}/timeline`).set(dm).send({ title: 'Guarded' });
    expect((await request(server).patch(`/api/v1/timeline/${evt.body.id}`).set(player).send({ title: 'x' })).status).toBe(403);
    expect((await request(server).delete(`/api/v1/timeline/${evt.body.id}`).set(viewer)).status).toBe(403);
  });

  it('current in-world date: empty default, DM upserts, members read', async () => {
    const server = ctx.app.getHttpServer();

    // Never-set calendar reads as an empty default (not 404).
    const initial = await request(server).get(`/api/v1/campaigns/${campaignId}/timeline/calendar`).set(player);
    expect(initial.status).toBe(200);
    expect(initial.body.currentDate).toBe('');

    // DM sets it (insert path)
    const set1 = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/timeline/calendar`)
      .set(dm)
      .send({ currentDate: '3rd of Flamerule, 1492 DR', note: 'Months: Hammer, Alturiak, Ches…' });
    expect(set1.status).toBe(200);
    expect(set1.body.currentDate).toBe('3rd of Flamerule, 1492 DR');

    // DM updates it (update path), partial patch leaves note intact
    const set2 = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/timeline/calendar`)
      .set(dm)
      .send({ currentDate: '4th of Flamerule, 1492 DR' });
    expect(set2.status).toBe(200);
    expect(set2.body.currentDate).toBe('4th of Flamerule, 1492 DR');
    expect(set2.body.note).toBe('Months: Hammer, Alturiak, Ches…');

    // Player reads the updated value
    const read = await request(server).get(`/api/v1/campaigns/${campaignId}/timeline/calendar`).set(player);
    expect(read.body.currentDate).toBe('4th of Flamerule, 1492 DR');

    // Player cannot set it
    const forbidden = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/timeline/calendar`)
      .set(player)
      .send({ currentDate: 'nope' });
    expect(forbidden.status).toBe(403);
  });
});
