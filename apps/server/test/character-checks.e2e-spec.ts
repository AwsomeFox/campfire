import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { AuditService } from '../src/modules/audit/audit.service';
import { CampaignEventsService } from '../src/modules/events/campaign-events.service';

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

  it('GET .../checks is limited to the owning player or dm', async () => {
    const server = ctx.app.getHttpServer();
    const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'other-player' };
    const [asViewer, asOtherPlayer, asDm] = await Promise.all([
      request(server).get(`/api/v1/characters/${characterId}/checks`).set(viewer),
      request(server).get(`/api/v1/characters/${characterId}/checks`).set(otherPlayer),
      request(server).get(`/api/v1/characters/${characterId}/checks`).set(dm),
    ]);
    expect(asViewer.status).toBe(403);
    expect(asOtherPlayer.status).toBe(403);
    expect(asDm.status).toBe(200);
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

  // Issue #1479: this endpoint used to be gated only by `requireMember(..., { write:
  // true })`, which asserts the CAMPAIGN accepts writes, not that the CALLER has write
  // authority over THIS character — any campaign member (including a read-only viewer)
  // could roll as any character and inject arbitrary `consequence` text into the shared,
  // persisted dice log under that character's name. dm-or-owner is now required, same as
  // every other character write.
  it('a viewer may not roll a check for a character — 403, nothing persisted to the dice log (#1479)', async () => {
    const server = ctx.app.getHttpServer();
    const before = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls?limit=50`).set(dm);
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/checks/roll`)
      .set(viewer)
      .send({ checkId: 'skill:Stealth' });
    expect(res.status).toBe(403);
    const after = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls?limit=50`).set(dm);
    expect(after.body.map((r: { id: number }) => r.id)).toEqual(before.body.map((r: { id: number }) => r.id));
  });

  it('a player who does not own the character may not roll a check for it — 403, nothing persisted (#1479)', async () => {
    const server = ctx.app.getHttpServer();
    const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'other-player' };
    const before = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls?limit=50`).set(dm);
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/checks/roll`)
      .set(otherPlayer)
      .send({ checkId: 'skill:Stealth' });
    expect(res.status).toBe(403);
    const after = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls?limit=50`).set(dm);
    expect(after.body.map((r: { id: number }) => r.id)).toEqual(before.body.map((r: { id: number }) => r.id));
  });

  it('the owning player may still roll their own character — 201 regression guard (#1479)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/checks/roll`)
      .set(owner)
      .send({ checkId: 'skill:Stealth' });
    expect(res.status).toBe(201);
    expect(res.body.roll.rollerUserId).toBe('dev:owner-1');
  });

  it('the dm may roll a check for any character, including one they do not own — 201 (#1479)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/checks/roll`)
      .set(dm)
      .send({ checkId: 'skill:Stealth' });
    expect(res.status).toBe(201);
    expect(res.body.roll.rollerUserId).toBe('dev:dm-1');
  });

  it('consequence text is attributed to the acting user, not silently under the character name (#1479)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/checks/roll`)
      .set(dm)
      .send({ checkId: 'skill:Stealth', consequence: 'A guard turns toward the noise.' });
    expect(res.status).toBe(201);
    // The label still carries the character's name (public, transparent breakdown) and
    // the consequence text rides along on it (issue #415's documented contract)...
    expect(res.body.roll.label).toContain('Aldra · Stealth');
    expect(res.body.roll.label).toContain('A guard turns toward the noise.');
    // ...but the PERSISTED ROW records the real acting user distinctly from the
    // character, so the table can always tell who actually supplied that text — it is
    // never silently attributed to the character itself.
    expect(res.body.roll.rollerUserId).toBe('dev:dm-1');
    expect(res.body.roll.rollerName).toBe('dm-1');
    expect(res.body.roll.rollerName).not.toBe('Aldra');
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

  // Issue #1636: `POST /check-requests/:id/roll` was gated only by
  // `requireMember(..., { write: true })`, which asserts the CAMPAIGN is writable, not
  // that the CALLER has write authority — it returns a viewer's role unchanged.
  // Downstream, `assertCanWrite` is dm-or-owner, and `character.ownerUserId` is
  // untouched by a role change, so a member demoted from player to viewer who still
  // owns the targeted character could roll — and thereby consume and resolve — a
  // DM's pending check request. Dev-auth's role header IS the effective role for a
  // given request (no DB membership row backs it), so sending the SAME dev-user with
  // a different `x-dev-role` on the second request faithfully simulates "demoted mid-
  // session, same identity" without needing a real membership PATCH.
  it('the owning character\'s player demoted to viewer mid-session loses roll authority on the very next request, and the request stays pending (#1636)', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(dm)
      .send({ characterIds: [characterId], checkId: 'save:DEX', dc: 10 });
    expect(created.status).toBe(201);
    const requestId = created.body[0].id;

    // Same identity (owner-1) as the character's owner, but now presenting as viewer —
    // the demotion.
    const demotedOwner = { 'x-dev-role': 'viewer', 'x-dev-user': 'owner-1' };
    const res = await request(server).post(`/api/v1/check-requests/${requestId}/roll`).set(demotedOwner).send({});
    expect(res.status).toBe(403);

    // State assertion (the point of the issue): the request must still be pending, and
    // no roll was recorded against it — a 403 with a completed roll+resolve underneath
    // it would be the bug this test pins.
    const list = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/check-requests?status=pending`)
      .set(dm);
    expect(list.status).toBe(200);
    const pinned = list.body.find((r: { id: number }) => r.id === requestId);
    expect(pinned).toBeTruthy();
    expect(pinned.status).toBe('pending');
    expect(pinned.rollId).toBeNull();

    // Still owned by the (still-player, in a real deployment) 'owner-1' identity: the
    // ORIGINAL role (player) can still answer it, proving the 403 above was really the
    // role floor and not some unrelated breakage.
    const rolled = await request(server).post(`/api/v1/check-requests/${requestId}/roll`).set(owner).send({});
    expect(rolled.status).toBe(201);
    expect(rolled.body.request.status).toBe('resolved');
  });
});

/**
 * Group checks (issue #1943): `requestChecks` mints one `groupId` per call and stamps it on
 * every row the call creates, so a "whole party" submit is recoverable as one group. Single-
 * target behavior is the same code path (a size-1 group) — these tests pin both directions.
 */
describe('Group check requests (issue #1943, e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let charA: number;
  let charB: number;
  let charC: number;
  const playerA = { 'x-dev-role': 'player', 'x-dev-user': 'group-owner-a' };
  const playerB = { 'x-dev-role': 'player', 'x-dev-user': 'group-owner-b' };

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Group Checks Campaign' });
    campaignId = camp.body.id;

    // Three characters owned by two different players, so list-scoping across a group can be
    // exercised with more than one non-DM owner in the same submit.
    const a = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Party A', ownerUserId: 'dev:group-owner-a', level: 3, hpMax: 20, hpCurrent: 20, stats: { DEX: 14 } });
    charA = a.body.id;
    const b = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Party B', ownerUserId: 'dev:group-owner-b', level: 3, hpMax: 20, hpCurrent: 20, stats: { DEX: 12 } });
    charB = b.body.id;
    const c = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Party C', ownerUserId: 'dev:group-owner-a', level: 3, hpMax: 20, hpCurrent: 20, stats: { DEX: 10 } });
    charC = c.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('one submit targeting several characters creates that many pending rows sharing one non-null groupId', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(dm)
      .send({ characterIds: [charA, charB, charC], checkId: 'save:DEX', dc: 12 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(3);

    const groupIds = new Set(res.body.map((r: { groupId: string | null }) => r.groupId));
    expect(groupIds.size).toBe(1);
    const [groupId] = [...groupIds];
    expect(groupId).toEqual(expect.any(String));
    expect(groupId).not.toBeNull();
  });

  it('distinct submits (even targeting the exact same characters) get distinct groupIds', async () => {
    const server = ctx.app.getHttpServer();
    const first = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(dm)
      .send({ characterIds: [charA, charB], checkId: 'save:DEX' });
    const second = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(dm)
      .send({ characterIds: [charA, charB], checkId: 'save:DEX' });

    expect(first.body[0].groupId).toEqual(expect.any(String));
    expect(second.body[0].groupId).toEqual(expect.any(String));
    expect(first.body[0].groupId).not.toBe(second.body[0].groupId);
  });

  it('a single-target submit is the same code path — still one row with a non-null groupId, otherwise unchanged', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(dm)
      .send({ characterIds: [charA], checkId: 'save:DEX', dc: 8, consequence: 'Solo save.' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].characterId).toBe(charA);
    expect(res.body[0].dc).toBe(8);
    expect(res.body[0].consequence).toBe('Solo save.');
    expect(res.body[0].groupId).toEqual(expect.any(String));
  });

  it('a group send targeting two different players\' characters: each player sees only their own row, never the other\'s (list-scoping, extended for #1943)', async () => {
    const server = ctx.app.getHttpServer();
    const sent = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(dm)
      .send({ characterIds: [charA, charB], checkId: 'save:DEX', dc: 10 });
    expect(sent.status).toBe(201);
    const groupId = sent.body[0].groupId;

    const aList = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/check-requests?status=pending`)
      .set(playerA);
    expect(aList.status).toBe(200);
    const aGroupRows = aList.body.filter((r: { groupId: string | null }) => r.groupId === groupId);
    expect(aGroupRows).toHaveLength(1);
    expect(aGroupRows[0].characterId).toBe(charA);

    const bList = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/check-requests?status=pending`)
      .set(playerB);
    expect(bList.status).toBe(200);
    const bGroupRows = bList.body.filter((r: { groupId: string | null }) => r.groupId === groupId);
    expect(bGroupRows).toHaveLength(1);
    expect(bGroupRows[0].characterId).toBe(charB);

    // Neither player's list ever contains the OTHER's row from this same group.
    expect(aList.body.some((r: { characterId: number }) => r.characterId === charB)).toBe(false);
    expect(bList.body.some((r: { characterId: number }) => r.characterId === charA)).toBe(false);

    // The DM sees both rows of the group.
    const dmList = await request(server).get(`/api/v1/campaigns/${campaignId}/check-requests`).set(dm);
    const dmGroupRows = dmList.body.filter((r: { groupId: string | null }) => r.groupId === groupId);
    expect(dmGroupRows).toHaveLength(2);
  });

  // Issue #1943 review: the group-check board refetches this list on every SSE invalidation for
  // the life of the campaign — an unbounded page would grow without end. `?limit`/`?offset`
  // bound it (shared pagination convention); omitted, behavior is exactly as before (unbounded).
  it('optional ?limit bounds the page; omitted still returns every visible row (back-compat)', async () => {
    const server = ctx.app.getHttpServer();
    // Three more sends on top of everything already created by earlier tests in this block —
    // guarantees there are strictly more than 2 rows visible to the DM at this point.
    for (let i = 0; i < 3; i++) {
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/check-requests`)
        .set(dm)
        .send({ characterIds: [charA], checkId: 'save:DEX' });
    }

    const unbounded = await request(server).get(`/api/v1/campaigns/${campaignId}/check-requests`).set(dm);
    expect(unbounded.status).toBe(200);
    expect(unbounded.body.length).toBeGreaterThan(2);

    const bounded = await request(server).get(`/api/v1/campaigns/${campaignId}/check-requests?limit=2`).set(dm);
    expect(bounded.status).toBe(200);
    expect(bounded.body).toHaveLength(2);
    // Newest-first ordering is preserved under the limit — the bounded page is exactly the
    // first 2 rows of the unbounded page, not an arbitrary 2.
    expect(bounded.body.map((r: { id: number }) => r.id)).toEqual(unbounded.body.slice(0, 2).map((r: { id: number }) => r.id));
  });

  // Issue #1943 review finding #7: requestChecks used to validate-then-insert inside one loop,
  // so a LATER target's 404 threw after EARLIER targets' rows were already committed — a DM
  // whose group send failed would see an error and reasonably believe nothing happened, while
  // part of the party already had a live prompt under the same groupId. A rejected group must
  // leave zero rows behind, for ANY of its targets, not just the one that failed validation.
  it('a group send with a later invalid target leaves ZERO rows for the whole group — atomicity (#1943 review)', async () => {
    const server = ctx.app.getHttpServer();
    const before = await request(server).get(`/api/v1/campaigns/${campaignId}/check-requests`).set(dm);
    expect(before.status).toBe(200);
    const idsBefore = new Set(before.body.map((r: { id: number }) => r.id));

    // charA and charB are valid, EARLIER targets that a validate-then-insert loop would already
    // have committed by the time it reaches the third, nonexistent target id.
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/check-requests`)
      .set(dm)
      .send({ characterIds: [charA, charB, 9_999_999], checkId: 'save:DEX' });
    expect(res.status).toBe(404);

    const after = await request(server).get(`/api/v1/campaigns/${campaignId}/check-requests`).set(dm);
    expect(after.status).toBe(200);
    const newRows = after.body.filter((r: { id: number }) => !idsBefore.has(r.id));
    // The dramatic assertion: NO new rows at all from this rejected send — not even for charA
    // or charB, which a validate-then-insert loop would have already committed.
    expect(newRows).toHaveLength(0);
    expect(newRows.some((r: { characterId: number }) => r.characterId === charA)).toBe(false);
    expect(newRows.some((r: { characterId: number }) => r.characterId === charB)).toBe(false);
  });

  // Issue #1943 review, round 6: the atomicity fix above wrapped the check-request inserts in
  // a transaction, and the per-row audit write went inside it as a consequence — folding it
  // onto AuditService#logInTx's ALL-OR-NOTHING guarantee. That bought nothing for the atomicity
  // this transaction actually needs (which is only between the check-request rows themselves),
  // and added a new failure mode: an audit-subsystem hiccup would now roll back a DM's entire
  // valid send. requestChecks moved the audit write to a post-commit, best-effort
  // `auditBestEffort` call (matching `AuditService#log`'s documented "an audit-subsystem outage
  // must not undo a user's work" guarantee) — this is the honest behavioural test for that: a
  // forced audit failure must NOT cost the DM their check requests, or the SSE ticks that tell
  // players to look.
  it('a failed audit write does not cost the DM their check requests or the SSE events that notify players (#1943 review, round 6)', async () => {
    const server = ctx.app.getHttpServer();
    const audit = ctx.app.get(AuditService);
    const events = ctx.app.get(CampaignEventsService);

    // In-process subscription to the SAME Subject the real SSE endpoint streams from (the
    // pattern already used elsewhere in this test family, e.g. encounters.e2e-spec.ts) — a
    // direct, non-contrived observation of whether the notification actually fired.
    const broadcasts: Array<{ type: string; requestId?: number; characterId?: number }> = [];
    const subscription = events.streamFor(campaignId).subscribe((event) => broadcasts.push(event));

    // Mocks BOTH audit write paths, not just the one this fix actually uses — a mutation back
    // to the pre-fix `logInTx` call would never touch `.log()` at all (they're two independent
    // methods; see AuditService's doc comments), so a test that only fails `.log()` would pass
    // against the old code for the wrong reason (the old code's audit write would simply
    // "succeed" against an unmocked `logInTx`). Failing both makes this test discriminate on
    // the actual guarantee — "does an audit failure survive" — regardless of which method the
    // implementation happens to call.
    const spy = jest.spyOn(audit, 'log').mockRejectedValue(new Error('audit table is unavailable'));
    const spyInTx = jest.spyOn(audit, 'logInTx').mockImplementation(() => {
      throw new Error('audit table is unavailable');
    });
    try {
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/check-requests`)
        .set(dm)
        .send({ characterIds: [charA, charB], checkId: 'save:DEX' });

      // Not a 500, and not a partial result either — the requests genuinely committed even
      // though every one of their audit rows failed to write.
      expect(res.status).toBe(201);
      expect(res.body).toHaveLength(2);
      const createdIds = new Set(res.body.map((r: { id: number }) => r.id));

      // The rows are really persisted (not silently rolled back by the audit failure) —
      // read them back from a completely separate request.
      const list = await request(server).get(`/api/v1/campaigns/${campaignId}/check-requests`).set(dm);
      expect(list.status).toBe(200);
      const persisted = list.body.filter((r: { id: number }) => createdIds.has(r.id));
      expect(persisted).toHaveLength(2);
      expect(persisted.some((r: { characterId: number }) => r.characterId === charA)).toBe(true);
      expect(persisted.some((r: { characterId: number }) => r.characterId === charB)).toBe(true);

      // Both SSE ticks landed too — the audit failure suppressed neither this row's own
      // notification nor a LATER row's (which a naive shared try/catch around the whole loop
      // could have done).
      const ticks = broadcasts.filter((e) => e.type === 'check.requested' && createdIds.has(e.requestId as number));
      expect(ticks).toHaveLength(2);

      // The audit call really was attempted (and really did fail) for both rows, via the
      // post-commit `log()` path this fix uses — not `logInTx`, which would prove this test is
      // exercising the OLD (transactional, all-or-nothing) shape instead.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spyInTx).not.toHaveBeenCalled();
      for (const call of spy.mock.calls) {
        expect(call[0]).toMatchObject({ action: 'check.request' });
      }
    } finally {
      spy.mockRestore();
      spyInTx.mockRestore();
      subscription.unsubscribe();
    }
  });
});
