import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const owner = { 'x-dev-role': 'player', 'x-dev-user': 'owner-1' };
const nonOwner = { 'x-dev-role': 'player', 'x-dev-user': 'other-1' };

describe('characters (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let characterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campaignRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Char Campaign' });
    campaignId = campaignRes.body.id;

    const charRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(owner)
      .send({ name: 'Owlbear Bait', hpMax: 20, hpCurrent: 20 });
    expect(charRes.status).toBe(201);
    characterId = charRes.body.id;
    // dev-auth (DEV_AUTH=1 header path) synthesizes user id `dev:<name>` — see SessionAuthGuard.
    expect(charRes.body.ownerUserId).toBe('dev:owner-1');
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('hp delta reduces hp', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/hp`).set(owner).send({ delta: -8 });
    expect(res.status).toBe(201);
    expect(res.body.hpCurrent).toBe(12);
  });

  it('hp clamps at 0 (never negative)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/hp`).set(owner).send({ delta: -100 });
    expect(res.status).toBe(201);
    expect(res.body.hpCurrent).toBe(0);
  });

  it('hp clamps at hpMax', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/hp`).set(owner).send({ set: 999 });
    expect(res.status).toBe(201);
    expect(res.body.hpCurrent).toBe(20);
  });

  it('non-owner, non-dm player gets 403 on hp patch', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/hp`).set(nonOwner).send({ delta: -1 });
    expect(res.status).toBe(403);
  });

  it('non-owner gets 403 on PATCH character', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(nonOwner)
      .send({ name: 'Hijacked' });
    expect(res.status).toBe(403);
  });

  it('dm may patch any character', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/hp`).set(dm).send({ set: 5 });
    expect(res.status).toBe(201);
    expect(res.body.hpCurrent).toBe(5);
  });

  // P2 fix pinning tests — CharactersService.update() now clamps hpCurrent to
  // [0, finalHpMax] like patchHp already did, instead of writing verbatim.
  it('PATCH hpMax below standing hpCurrent clamps hpCurrent down', async () => {
    const server = ctx.app.getHttpServer();
    // Reset to a known standing state: hpMax=20, hpCurrent=20.
    const setupRes = await request(server).patch(`/api/v1/characters/${characterId}`).set(dm).send({ hpMax: 20, hpCurrent: 20 });
    expect(setupRes.status).toBe(200);
    expect(setupRes.body.hpCurrent).toBe(20);

    const res = await request(server).patch(`/api/v1/characters/${characterId}`).set(dm).send({ hpMax: 10 });
    expect(res.status).toBe(200);
    expect(res.body.hpMax).toBe(10);
    expect(res.body.hpCurrent).toBe(10);
  });

  it('PATCH hpCurrent above hpMax is clamped to hpMax', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/characters/${characterId}`).set(dm).send({ hpCurrent: 999 });
    expect(res.status).toBe(200);
    // hpMax is 10 from the previous test.
    expect(res.body.hpCurrent).toBe(10);
  });

  it('PATCH hpCurrent negative is clamped to 0', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/characters/${characterId}`).set(dm).send({ hpCurrent: -50 });
    expect(res.status).toBe(200);
    expect(res.body.hpCurrent).toBe(0);
  });

  it('conditions add/remove', async () => {
    const server = ctx.app.getHttpServer();
    const addRes = await request(server)
      .post(`/api/v1/characters/${characterId}/conditions`)
      .set(owner)
      .send({ add: ['poisoned', 'prone'] });
    expect(addRes.status).toBe(201);
    expect(addRes.body.conditions.sort()).toEqual(['poisoned', 'prone']);

    const removeRes = await request(server)
      .post(`/api/v1/characters/${characterId}/conditions`)
      .set(owner)
      .send({ remove: ['prone'] });
    expect(removeRes.status).toBe(201);
    expect(removeRes.body.conditions).toEqual(['poisoned']);
  });
});
