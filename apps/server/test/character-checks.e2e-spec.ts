import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

/**
 * Roll catalog (issue #415) — server-resolved checks. The adapter owns the roll catalog, the
 * server computes the authoritative modifier + dice expression (clients never invent the math),
 * and every skill — proficient AND unproficient — is rollable inline with a transparent
 * breakdown. These e2e tests exercise the two new endpoints end to end.
 */

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const owner = { 'x-dev-role': 'player', 'x-dev-user': 'owner-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('character roll catalog (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let characterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Catalog Campaign' });
    campaignId = camp.body.id;
    // DEX 16 (+3), STR 14 (+2), level 5 (proficiency +3). Proficient in Athletics + DEX save;
    // Acrobatics is deliberately left UNPROFICIENT to prove it still rolls inline.
    const charRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(owner)
      .send({
        name: 'Aldra',
        level: 5,
        hpMax: 30,
        hpCurrent: 30,
        stats: { STR: 14, DEX: 16, CON: 12, INT: 10, WIS: 13, CHA: 8 },
        saveProficiencies: ['DEX'],
        skills: { Athletics: 'proficient' },
      });
    expect(charRes.status).toBe(201);
    characterId = charRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('GET .../checks lists every skill (incl. unproficient), favorites first', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/characters/${characterId}/checks`).set(owner);
    expect(res.status).toBe(200);
    const skills = res.body.filter((c: { category: string }) => c.category === 'skill');
    expect(skills).toHaveLength(18);
    // Acrobatics (unproficient) is present and rollable, not hidden.
    const acro = res.body.find((c: { id: string }) => c.id === 'skill:Acrobatics');
    expect(acro).toBeTruthy();
    expect(acro.modifier).toBe(3); // DEX +3, no proficiency
    expect(acro.favorite).toBe(false);
    // Athletics carries the transparent proficiency breakdown.
    const ath = res.body.find((c: { id: string }) => c.id === 'skill:Athletics');
    expect(ath.modifier).toBe(5); // STR +2 + proficiency +3
    expect(ath.favorite).toBe(true);
    // Favorites sort ahead of non-favorites.
    const firstFavIdx = res.body.findIndex((c: { favorite: boolean }) => c.favorite);
    const firstNonFavIdx = res.body.findIndex((c: { favorite: boolean }) => !c.favorite);
    expect(firstFavIdx).toBeLessThan(firstNonFavIdx);
  });

  it('POST .../checks/roll rolls an UNPROFICIENT skill server-side with the correct modifier + breakdown', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/checks/roll`)
      .set(owner)
      .send({ checkId: 'skill:Acrobatics' });
    expect(res.status).toBe(201);
    expect(res.body.check.id).toBe('skill:Acrobatics');
    expect(res.body.check.modifier).toBe(3);
    expect(res.body.check.breakdownText).toBe('DEX +3 = +3');
    // The persisted roll is a 1d20+3 in the shared dice log, attributed to the roller.
    expect(res.body.roll.expr).toBe('1d20+3');
    expect(res.body.roll.total).toBe(res.body.roll.rolls[0] + 3);
    expect(res.body.roll.label).toContain('Aldra · Acrobatics');
    expect(res.body.roll.rollerUserId).toBe('dev:owner-1');
    // 5e reports no degrees of success.
    expect(res.body.degree).toBeUndefined();
  });

  it('advantage rolls two d20 and keeps the higher (5e supports it)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/checks/roll`)
      .set(owner)
      .send({ checkId: 'save:DEX', mode: 'advantage' });
    expect(res.status).toBe(201);
    expect(res.body.roll.expr).toBe('2d20kh1+6'); // DEX +3 + proficiency +3
    expect(res.body.roll.rolls).toHaveLength(2);
    expect(res.body.roll.kept[0]).toBe(Math.max(res.body.roll.rolls[0], res.body.roll.rolls[1]));
  });

  it('computes success against a DC server-side and appears in the shared feed', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/checks/roll`)
      .set(owner)
      .send({ checkId: 'ability:STR', dc: 1 }); // STR +2 + d20 >= 1 always
    expect(res.status).toBe(201);
    expect(res.body.roll.dc).toBe(1);
    expect(res.body.roll.success).toBe(true);

    // The roll landed in the campaign-shared dice log for every member to see.
    const feed = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls?limit=10`).set(viewer);
    expect(feed.status).toBe(200);
    expect(feed.body.some((r: { id: number }) => r.id === res.body.roll.id)).toBe(true);
  });

  it('viewer (any campaign member) may roll a check — not gated to dm/owner', async () => {
    const server = ctx.app.getHttpServer();
    const ok = await request(server)
      .post(`/api/v1/characters/${characterId}/checks/roll`)
      .set(viewer)
      .send({ checkId: 'skill:Stealth' });
    expect(ok.status).toBe(201);
    expect(ok.body.roll.rollerUserId).toBe('dev:v-1');
  });

  it('an unknown check id is a 404', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/checks/roll`)
      .set(owner)
      .send({ checkId: 'skill:Nonsense' });
    expect(res.status).toBe(404);
  });
});

/**
 * DM-initiated check requests (issue #415) — the request → player-prompt → consequence loop.
 * The DM asks a target character for a check/save; the targeted player reads it back over a
 * permission-checked REST read and rolls ONCE (reusing the catalog-roll path), which records to
 * the shared dice log and marks the request resolved. Consequence text rides through to the roll.
 */
describe('DM check requests (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let characterId: number;
  let otherCampaignId: number;
  let otherCharacterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Requests Campaign' });
    campaignId = camp.body.id;
    const charRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(owner)
      .send({
        name: 'Aldra',
        level: 5,
        hpMax: 30,
        hpCurrent: 30,
        stats: { STR: 14, DEX: 16, CON: 12, INT: 10, WIS: 13, CHA: 8 },
        saveProficiencies: ['DEX'],
        skills: { Athletics: 'proficient' },
      });
    characterId = charRes.body.id;
    // A separate campaign + character to prove a cross-campaign target is rejected.
    const other = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Campaign' });
    otherCampaignId = other.body.id;
    const otherChar = await request(server)
      .post(`/api/v1/campaigns/${otherCampaignId}/characters`)
      .set(dm)
      .send({ name: 'Outsider', level: 1, hpMax: 8, hpCurrent: 8, stats: { DEX: 12 } });
    otherCharacterId = otherChar.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('DM creates a pending check request with DC + consequence; a player cannot', async () => {
    const server = ctx.app.getHttpServer();
    // A player (even the owner) may not initiate a request — dm only.
    const forbidden = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(owner)
      .send({ characterIds: [characterId], checkId: 'save:DEX' });
    expect(forbidden.status).toBe(403);

    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(dm)
      .send({ characterIds: [characterId], checkId: 'save:DEX', dc: 12, consequence: 'The rope bridge lurches.' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    const req = res.body[0];
    expect(req.characterId).toBe(characterId);
    expect(req.characterName).toBe('Aldra');
    expect(req.checkId).toBe('save:DEX');
    expect(req.checkLabel).toBe('DEX save');
    expect(req.dc).toBe(12);
    expect(req.consequence).toBe('The rope bridge lurches.');
    expect(req.status).toBe('pending');
    expect(req.rollId).toBeNull();
    expect(req.requestedByUserId).toBe('dev:dm-1');
  });

  it('a request naming a character outside the campaign is a 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(dm)
      .send({ characterIds: [otherCharacterId], checkId: 'save:DEX' });
    expect(res.status).toBe(400);
  });

  it('a request naming a check absent from the target catalog is a 404', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(dm)
      .send({ characterIds: [characterId], checkId: 'skill:Nonsense' });
    expect(res.status).toBe(404);
  });

  it('the targeted player sees the pending request; a viewer sees none; the DM sees all', async () => {
    const server = ctx.app.getHttpServer();
    const ownerList = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/check-requests?status=pending`)
      .set(owner);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.length).toBeGreaterThanOrEqual(1);
    expect(ownerList.body.every((r: { characterId: number }) => r.characterId === characterId)).toBe(true);

    const viewerList = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/check-requests?status=pending`)
      .set(viewer);
    expect(viewerList.status).toBe(200);
    expect(viewerList.body).toHaveLength(0);

    const dmList = await request(server).get(`/api/v1/campaigns/${campaignId}/check-requests`).set(dm);
    expect(dmList.status).toBe(200);
    expect(dmList.body.length).toBeGreaterThanOrEqual(1);
  });

  it('the targeted player rolls once — recorded to the dice log, request resolved, consequence returned', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(dm)
      .send({ characterIds: [characterId], checkId: 'save:DEX', dc: 5, consequence: 'You keep your footing.' });
    const requestId = created.body[0].id;

    const rolled = await request(server).post(`/api/v1/check-requests/${requestId}/roll`).set(owner).send({});
    expect(rolled.status).toBe(201);
    expect(rolled.body.request.status).toBe('resolved');
    expect(rolled.body.request.rollId).toBe(rolled.body.result.roll.id);
    expect(rolled.body.request.consequence).toBe('You keep your footing.');
    // DEX +3 + proficiency +3 = +6.
    expect(rolled.body.result.check.id).toBe('save:DEX');
    expect(rolled.body.result.roll.expr).toBe('1d20+6');
    expect(rolled.body.result.roll.dc).toBe(5);
    expect(rolled.body.result.roll.label).toContain('Aldra · DEX save');

    // It landed in the campaign-shared dice feed for every member.
    const feed = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls?limit=10`).set(viewer);
    expect(feed.body.some((r: { id: number }) => r.id === rolled.body.result.roll.id)).toBe(true);

    // Rolling the same request again is rejected (roll once).
    const again = await request(server).post(`/api/v1/check-requests/${requestId}/roll`).set(owner).send({});
    expect(again.status).toBe(400);
  });

  it('a non-owner non-DM member cannot answer a request', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(dm)
      .send({ characterIds: [characterId], checkId: 'skill:Athletics' });
    const requestId = created.body[0].id;
    const res = await request(server).post(`/api/v1/check-requests/${requestId}/roll`).set(viewer).send({});
    expect(res.status).toBe(403);
  });
});
