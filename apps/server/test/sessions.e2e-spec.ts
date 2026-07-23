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

/**
 * Issue #841 — campaign position must use the highest canonical session number,
 * not the recap COUNT(*). sessionCount stays a true row count; latestSessionNumber
 * tracks MAX(number) among live sessions so gaps/imports/deletes don't mislabel
 * the campaign as "Session 3" when the latest recap is Session 12.
 */
describe('sessions (e2e) — latestSessionNumber vs sessionCount (issue #841)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name: 'Position Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('empty campaign reports 0 count and 0 latest session number', async () => {
    const campRes = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(campRes.status).toBe(200);
    expect(campRes.body.sessionCount).toBe(0);
    expect(campRes.body.latestSessionNumber).toBe(0);
  });

  it('non-contiguous numbering: count is row tally, latest is MAX(number)', async () => {
    const server = ctx.app.getHttpServer();

    for (const number of [1, 7, 12]) {
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number });
      expect(res.status).toBe(201);
    }

    const campRes = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(campRes.body.sessionCount).toBe(3);
    expect(campRes.body.latestSessionNumber).toBe(12);
  });

  it('deleting the highest session drops latestSessionNumber to the next-highest', async () => {
    const server = ctx.app.getHttpServer();

    const list = await request(server).get(`/api/v1/campaigns/${campaignId}/sessions`).set(dm);
    expect(list.status).toBe(200);
    const twelve = list.body.find((s: { number: number }) => s.number === 12);
    expect(twelve).toBeTruthy();

    const del = await request(server).delete(`/api/v1/sessions/${twelve.id}`).set(dm);
    expect(del.status).toBe(200);

    const campRes = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(campRes.body.sessionCount).toBe(2);
    expect(campRes.body.latestSessionNumber).toBe(7);
  });

  it('restoring a deleted high session restores latestSessionNumber', async () => {
    const server = ctx.app.getHttpServer();

    const high = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number: 20 });
    expect(high.status).toBe(201);
    const highId = high.body.id as number;

    expect((await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm)).body.latestSessionNumber).toBe(20);

    expect((await request(server).delete(`/api/v1/sessions/${highId}`).set(dm)).status).toBe(200);
    expect((await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm)).body.latestSessionNumber).toBe(7);

    const restored = await request(server).post(`/api/v1/sessions/${highId}/restore`).set(dm);
    expect(restored.status).toBe(201);
    expect((await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm)).body.latestSessionNumber).toBe(20);
  });

  it('renumbering a session updates latestSessionNumber without changing sessionCount', async () => {
    const server = ctx.app.getHttpServer();

    const list = await request(server).get(`/api/v1/campaigns/${campaignId}/sessions`).set(dm);
    const seven = list.body.find((s: { number: number }) => s.number === 7);
    expect(seven).toBeTruthy();

    const before = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    const countBefore = before.body.sessionCount as number;

    const patch = await request(server).patch(`/api/v1/sessions/${seven.id}`).set(dm).send({ number: 99 });
    expect(patch.status).toBe(200);

    const after = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(after.body.sessionCount).toBe(countBefore);
    expect(after.body.latestSessionNumber).toBe(99);
  });

  it('a future-dated recap still contributes to latestSessionNumber (scheduled upcoming is separate)', async () => {
    const server = ctx.app.getHttpServer();
    // Session recaps with a future playedAt are still numbered recaps — distinct from
    // ScheduledSession rows, which never touch these denormalized fields.
    const farFuture = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({ number: 100, playedAt: '2099-01-01' });
    expect(farFuture.status).toBe(201);

    const campRes = await request(server).get(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(campRes.body.latestSessionNumber).toBe(100);
    expect(campRes.body.sessionCount).toBeGreaterThanOrEqual(3);
  });
});

/**
 * Issue #59: sessions carry a DM-only dmSecret (prep notes on a session record)
 * with the same strip-for-non-DM redaction as quests/NPCs/locations. The recap
 * itself stays fully player-visible.
 */
describe('sessions (e2e) — dmSecret redaction', () => {
  const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
  const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

  let ctx: TestAppContext;
  let campaignId: number;
  let sessionId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Secret Session Campaign' });
    campaignId = res.body.id;

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({ number: 1, title: 'The Setup', recap: 'The party met at the tavern.', dmSecret: 'next session: the barkeep betrays them' });
    expect(createRes.status).toBe(201);
    sessionId = createRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('dmSecret visible to dm on create, get, and list', async () => {
    const server = ctx.app.getHttpServer();

    const dmGet = await request(server).get(`/api/v1/sessions/${sessionId}`).set(dm);
    expect(dmGet.status).toBe(200);
    expect(dmGet.body.dmSecret).toBe('next session: the barkeep betrays them');

    const dmList = await request(server).get(`/api/v1/campaigns/${campaignId}/sessions`).set(dm);
    expect(dmList.status).toBe(200);
    expect(dmList.body[0].dmSecret).toBe('next session: the barkeep betrays them');
  });

  it('dmSecret absent for player and viewer; recap stays visible', async () => {
    const server = ctx.app.getHttpServer();

    const playerGet = await request(server).get(`/api/v1/sessions/${sessionId}`).set(player);
    expect(playerGet.status).toBe(200);
    expect(playerGet.body.recap).toBe('The party met at the tavern.');
    expect(playerGet.body.dmSecret).toBeFalsy();

    const viewerGet = await request(server).get(`/api/v1/sessions/${sessionId}`).set(viewer);
    expect(viewerGet.status).toBe(200);
    expect(viewerGet.body.dmSecret).toBeFalsy();

    // list endpoint too
    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/sessions`).set(player);
    expect(playerList.status).toBe(200);
    for (const s of playerList.body) {
      expect(s.dmSecret).toBeFalsy();
    }

    // campaign summary embeds sessions (and characters) — redacted there too
    const summary = await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(player);
    expect(summary.status).toBe(200);
    for (const s of summary.body.sessions) {
      expect(s.dmSecret).toBeFalsy();
    }
  });

  it('dm can PATCH dmSecret; player cannot PATCH a session at all (403)', async () => {
    const server = ctx.app.getHttpServer();

    const dmPatch = await request(server)
      .patch(`/api/v1/sessions/${sessionId}`)
      .set(dm)
      .send({ dmSecret: 'betrayal postponed to session 3' });
    expect(dmPatch.status).toBe(200);
    expect(dmPatch.body.dmSecret).toBe('betrayal postponed to session 3');

    const playerPatch = await request(server)
      .patch(`/api/v1/sessions/${sessionId}`)
      .set(player)
      .send({ dmSecret: 'players write secrets?' });
    expect(playerPatch.status).toBe(403);
  });
});
