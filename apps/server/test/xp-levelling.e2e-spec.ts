import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const owner = { 'x-dev-role': 'player', 'x-dev-user': 'owner-1' };
const nonOwner = { 'x-dev-role': 'player', 'x-dev-user': 'other-1' };

// Issue #14: XP tracking + guided level-up.
describe('xp & levelling (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let characterId: number; // owned by owner-1
  let secondCharacterId: number; // DM-managed

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campaignRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'XP Campaign' });
    campaignId = campaignRes.body.id;

    const charRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(owner)
      .send({ name: 'Grindy McLevels', hpMax: 12, hpCurrent: 12 });
    expect(charRes.status).toBe(201);
    characterId = charRes.body.id;

    const char2Res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Sidekick', hpMax: 8, hpCurrent: 8 });
    expect(char2Res.status).toBe(201);
    secondCharacterId = char2Res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('new characters start with xp 0', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
    expect(res.status).toBe(200);
    expect(res.body.xp).toBe(0);
    expect(res.body.level).toBe(1);
  });

  it('xp delta accrues', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(owner).send({ delta: 250 });
    expect(res.status).toBe(201);
    expect(res.body.xp).toBe(250);
  });

  it('xp set is absolute', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(dm).send({ set: 300 });
    expect(res.status).toBe(201);
    expect(res.body.xp).toBe(300);
  });

  it('xp clamps at 0 (never negative)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(owner).send({ delta: -9999 });
    expect(res.status).toBe(201);
    expect(res.body.xp).toBe(0);
  });

  it('non-owner, non-dm player gets 403 on xp patch', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(nonOwner).send({ delta: 100 });
    expect(res.status).toBe(403);
  });

  it('negative xp set -> 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(owner).send({ set: -5 });
    expect(res.status).toBe(400);
  });

  // ---------- party award ----------

  it('dm awards party-wide xp to every character', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/characters/xp`).set(dm).send({ amount: 300 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    const byId = new Map<number, { xp: number }>(res.body.map((c: { id: number; xp: number }) => [c.id, c]));
    expect(byId.get(characterId)!.xp).toBe(300); // was clamped to 0 above
    expect(byId.get(secondCharacterId)!.xp).toBe(300);
  });

  it('dm awards xp to a characterIds subset only', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/xp`)
      .set(dm)
      .send({ amount: 600, characterIds: [characterId] });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(characterId);
    expect(res.body[0].xp).toBe(900); // 300 + 600 — enough for level 2 (5e threshold: 300) and 3 (900)

    const other = await request(server).get(`/api/v1/characters/${secondCharacterId}`).set(dm);
    expect(other.body.xp).toBe(300); // untouched
  });

  it('player (even a character owner) gets 403 on party award', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/characters/xp`).set(owner).send({ amount: 100 });
    expect(res.status).toBe(403);
  });

  it('party award with a foreign characterId -> 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/xp`)
      .set(dm)
      .send({ amount: 100, characterIds: [999999] });
    expect(res.status).toBe(400);
  });

  it('party award amount must be positive', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/characters/xp`).set(dm).send({ amount: 0 });
    expect(res.status).toBe(400);
  });

  // ---------- guided level-up ----------

  it('level-up bumps level and grows hp (gained hp added to current)', async () => {
    const server = ctx.app.getHttpServer();
    // Take some damage first so we can verify the delta-based heal (12 -> 5).
    const dmg = await request(server).post(`/api/v1/characters/${characterId}/hp`).set(owner).send({ set: 5 });
    expect(dmg.body.hpCurrent).toBe(5);

    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/level-up`)
      .set(owner)
      .send({ hpMax: 19 });
    expect(res.status).toBe(201);
    expect(res.body.level).toBe(2);
    expect(res.body.hpMax).toBe(19);
    expect(res.body.hpCurrent).toBe(12); // 5 + (19 - 12) gained — damage taken is kept
  });

  it('level-up without hpMax just bumps the level', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/level-up`).set(dm).send({});
    expect(res.status).toBe(201);
    expect(res.body.level).toBe(3);
    expect(res.body.hpMax).toBe(19);
    expect(res.body.hpCurrent).toBe(12);
  });

  it('non-owner, non-dm player gets 403 on level-up', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/level-up`).set(nonOwner).send({});
    expect(res.status).toBe(403);
  });

  it('level-up at 20 -> 400', async () => {
    const server = ctx.app.getHttpServer();
    const patch = await request(server).patch(`/api/v1/characters/${secondCharacterId}`).set(dm).send({ level: 20 });
    expect(patch.status).toBe(200);
    const res = await request(server).post(`/api/v1/characters/${secondCharacterId}/level-up`).set(dm).send({});
    expect(res.status).toBe(400);
  });

  it('unknown key in level-up body -> 400 (strict DTO)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/level-up`)
      .set(dm)
      .send({ hp: 30 }); // real field is hpMax
    expect(res.status).toBe(400);
  });

  it('xp is patchable via PATCH /characters/:id too (escape hatch)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/characters/${characterId}`).set(dm).send({ xp: 1234 });
    expect(res.status).toBe(200);
    expect(res.body.xp).toBe(1234);
  });
});
