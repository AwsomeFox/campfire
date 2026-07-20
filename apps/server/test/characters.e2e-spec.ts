import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const owner = { 'x-dev-role': 'player', 'x-dev-user': 'owner-1' };
const nonOwner = { 'x-dev-role': 'player', 'x-dev-user': 'other-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

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

  // Strict-validation (task P1 item 3): CharacterUpdateDto is now .strict() at
  // the DTO layer — an unrecognized key 400s instead of the global
  // ZodValidationPipe silently stripping it and 200-ing as a no-op.
  it('unknown key in character PATCH body -> 400, not silently stripped', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(dm)
      .send({ hp: 999 }); // not a real field (real fields: hpCurrent/hpMax, and hp writes go through /hp anyway)
    expect(res.status).toBe(400);
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

  // Issue #59: characters carry a DM-only dmSecret (a secret curse, hidden true
  // identity…) with the same strip-for-non-DM redaction as quests/NPCs/locations.
  it('dmSecret visible to dm but absent for the owning player and viewer', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Cursed Knight', dmSecret: 'secretly a doppelganger', ownerUserId: 'dev:owner-1' });
    expect(createRes.status).toBe(201);
    const secretCharId = createRes.body.id;
    expect(createRes.body.dmSecret).toBe('secretly a doppelganger');

    const dmGet = await request(server).get(`/api/v1/characters/${secretCharId}`).set(dm);
    expect(dmGet.body.dmSecret).toBe('secretly a doppelganger');

    // Even the OWNING player never sees the secret on their own sheet.
    const ownerGet = await request(server).get(`/api/v1/characters/${secretCharId}`).set(owner);
    expect(ownerGet.status).toBe(200);
    expect(ownerGet.body.dmSecret).toBeFalsy();

    const viewerGet = await request(server).get(`/api/v1/characters/${secretCharId}`).set(viewer);
    expect(viewerGet.status).toBe(200);
    expect(viewerGet.body.dmSecret).toBeFalsy();

    // list endpoint too
    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/characters`).set(nonOwner);
    expect(playerList.status).toBe(200);
    for (const c of playerList.body) {
      expect(c.dmSecret).toBeFalsy();
    }
  });

  it('owning player cannot write dmSecret (silently ignored), dm can', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Marked One', dmSecret: 'bears the lich mark', ownerUserId: 'dev:owner-1' });
    const secretCharId = createRes.body.id;

    // Owner PATCH with dmSecret: accepted (they may edit their sheet) but the
    // secret write itself is ignored — same silent-ignore rule as ownerUserId.
    const ownerPatch = await request(server)
      .patch(`/api/v1/characters/${secretCharId}`)
      .set(owner)
      .send({ background: 'Folk hero', dmSecret: 'overwritten by player?' });
    expect(ownerPatch.status).toBe(200);
    expect(ownerPatch.body.background).toBe('Folk hero');
    expect(ownerPatch.body.dmSecret).toBeFalsy(); // still redacted in the response

    const dmGet = await request(server).get(`/api/v1/characters/${secretCharId}`).set(dm);
    expect(dmGet.body.dmSecret).toBe('bears the lich mark'); // unchanged

    // dm PATCH does write it
    const dmPatch = await request(server)
      .patch(`/api/v1/characters/${secretCharId}`)
      .set(dm)
      .send({ dmSecret: 'the mark is fading' });
    expect(dmPatch.status).toBe(200);
    expect(dmPatch.body.dmSecret).toBe('the mark is fading');
  });

  it('player creating their own character cannot seed dmSecret', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(owner)
      .send({ name: 'Sneaky Bard', dmSecret: 'planted by player' });
    expect(createRes.status).toBe(201);

    const dmGet = await request(server).get(`/api/v1/characters/${createRes.body.id}`).set(dm);
    expect(dmGet.body.dmSecret).toBe('');
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
