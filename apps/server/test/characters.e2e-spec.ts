import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { campaigns, characters, combatants } from '../src/db/schema';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const owner = { 'x-dev-role': 'player', 'x-dev-user': 'owner-1' };
const nonOwner = { 'x-dev-role': 'player', 'x-dev-user': 'other-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

/** Thin PATCH wrapper for the issue #1492 suites so each assertion reads as a one-liner. */
async function dbUpdate(
  server: import('http').Server,
  auth: Record<string, string>,
  charId: number,
  body: Record<string, unknown>,
) {
  return request(server).patch(`/api/v1/characters/${charId}`).set(auth).send(body);
}

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

  // Issue #112 — create() now clamps hpCurrent/ac like every other write path,
  // instead of persisting out-of-range values verbatim.
  it('POST create clamps out-of-range hpCurrent and ac', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Overflow Ogre', hpMax: 10, hpCurrent: 99999, ac: -50 });
    expect(res.status).toBe(201);
    // hpCurrent above hpMax clamps to hpMax; ac below 0 clamps to 0 (AC_MIN).
    expect(res.body.hpCurrent).toBe(10);
    expect(res.body.ac).toBe(0);
  });

  it('POST create clamps negative hpCurrent to 0 and huge ac to AC_MAX', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Underflow Imp', hpMax: 12, hpCurrent: -500, ac: 999 });
    expect(res.status).toBe(201);
    expect(res.body.hpCurrent).toBe(0);
    expect(res.body.ac).toBe(40); // AC_MAX
  });

  // Sheet depth (issue #1): saving throws, skills, actions, spell slots.
  it('new characters default to empty sheet-depth fields', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
    expect(res.status).toBe(200);
    expect(res.body.saveProficiencies).toEqual([]);
    expect(res.body.skills).toEqual({});
    expect(res.body.actions).toEqual([]);
    expect(res.body.spellSlots).toEqual({});
  });

  it('new characters default to status active (issue #115)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('status can be set on create and round-trips through update (issue #115)', async () => {
    const server = ctx.app.getHttpServer();
    // Create with an explicit non-active status.
    const createRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Fallen Knight', status: 'dead' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.status).toBe('dead');
    const id = createRes.body.id as number;

    // PATCH to another status.
    const patchRes = await request(server).patch(`/api/v1/characters/${id}`).set(dm).send({ status: 'retired' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe('retired');

    // Re-read confirms the value persisted.
    const getRes = await request(server).get(`/api/v1/characters/${id}`).set(dm);
    expect(getRes.status).toBe(200);
    expect(getRes.body.status).toBe('retired');

    // Bring it back to active.
    const reviveRes = await request(server).patch(`/api/v1/characters/${id}`).set(dm).send({ status: 'active' });
    expect(reviveRes.status).toBe(200);
    expect(reviveRes.body.status).toBe('active');
  });

  it('PATCH status rejects an unknown lifecycle value (issue #115)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/characters/${characterId}`).set(dm).send({ status: 'zombie' });
    expect(res.status).toBe(400);
  });

  it('PATCH saveProficiencies round-trips', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ saveProficiencies: ['STR', 'CON'] });
    expect(res.status).toBe(200);
    expect(res.body.saveProficiencies).toEqual(['STR', 'CON']);
  });

  it('PATCH saveProficiencies rejects a non-ability key', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ saveProficiencies: ['LUCK'] });
    expect(res.status).toBe(400);
  });

  it('PATCH skills round-trips proficient/expertise ranks', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ skills: { Stealth: 'expertise', Perception: 'proficient' } });
    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual({ Stealth: 'expertise', Perception: 'proficient' });
  });

  it('PATCH skills rejects an unknown rank', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ skills: { Stealth: 'legendary' } });
    expect(res.status).toBe(400);
  });

  it('PATCH actions round-trips and fills field defaults', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({
        actions: [
          { name: 'Longsword', kind: 'melee', toHit: '+5', damage: '1d8+3 slashing', notes: 'versatile 1d10' },
          { name: 'Second Wind' }, // defaults: kind/toHit/damage/notes -> ''
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(2);
    expect(res.body.actions[0]).toEqual({ name: 'Longsword', kind: 'melee', toHit: '+5', damage: '1d8+3 slashing', targetAc: '', notes: 'versatile 1d10' });
    expect(res.body.actions[1]).toEqual({ name: 'Second Wind', kind: '', toHit: '', damage: '', targetAc: '', notes: '' });
  });

  it('PATCH actions rejects a nameless action', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ actions: [{ name: '' }] });
    expect(res.status).toBe(400);
  });

  it('PATCH spellSlots sets maxima and rejects used outside [0, max]', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ spellSlots: { '1': { max: 4, used: 0 }, '2': { max: 2, used: 1 } } });
    expect(res.status).toBe(200);
    expect(res.body.spellSlots).toEqual({ '1': { max: 4, used: 0 }, '2': { max: 2, used: 1 } });
    // Mirrors the dedicated POST :id/spell-slots path and the #1039 invariant: an overspend
    // must FAIL loudly (400), not silently clamp to a different snapshot than requested.
    const overspend = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ spellSlots: { '2': { max: 2, used: 5 } } });
    expect(overspend.status).toBe(400);
    // used < 0 (over-restore) is rejected for the mirror reason.
    const overrestore = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ spellSlots: { '2': { max: 2, used: -1 } } });
    expect(overrestore.status).toBe(400);
  });

  it('PATCH spellSlots rejects a non 1-9 level key', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ spellSlots: { '10': { max: 1, used: 0 } } });
    expect(res.status).toBe(400);
  });

  it('spell-slots spend/restore adjusts used; an OVERSPEND now errors (#1039)', async () => {
    const server = ctx.app.getHttpServer();
    const spend = await request(server)
      .post(`/api/v1/characters/${characterId}/spell-slots`)
      .set(owner)
      .send({ level: 1, delta: 1 });
    expect(spend.status).toBe(201);
    expect(spend.body.spellSlots['1']).toEqual({ max: 4, used: 1 });

    // Over-RESTORE still clamps: it cannot invent a slot, and used=0 is the state a long rest
    // produces anyway, so refusing it would be noise rather than protection.
    const overRestore = await request(server)
      .post(`/api/v1/characters/${characterId}/spell-slots`)
      .set(owner)
      .send({ level: 1, delta: -100 });
    expect(overRestore.status).toBe(201);
    expect(overRestore.body.spellSlots['1']).toEqual({ max: 4, used: 0 });

    // #1039 BEHAVIOUR CHANGE — this used to return 201 with `used` clamped to max. A silent
    // success is indistinguishable, to the caller, from actually having cast the spell, which
    // is the unlimited-casting hole when the caller is the AI DM.
    const overSpend = await request(server)
      .post(`/api/v1/characters/${characterId}/spell-slots`)
      .set(owner)
      .send({ level: 1, delta: 100 });
    expect(overSpend.status).toBe(400);
    expect(overSpend.body.code).toBe('insufficient_slots');
    // The error must be legible enough for a model to self-correct rather than retry blindly.
    expect(overSpend.body).toMatchObject({ level: 1, remaining: 4, max: 4 });

    // The refused spend wrote nothing.
    const after = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
    expect(after.body.spellSlots['1']).toEqual({ max: 4, used: 0 });
  });

  it('spell-slots: spending the LAST slot succeeds, the next one errors (#1039)', async () => {
    const server = ctx.app.getHttpServer();
    // Drain level 1 exactly.
    for (let i = 0; i < 4; i++) {
      const res = await request(server)
        .post(`/api/v1/characters/${characterId}/spell-slots`)
        .set(owner)
        .send({ level: 1, delta: 1 });
      expect(res.status).toBe(201);
    }
    const exhausted = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
    expect(exhausted.body.spellSlots['1']).toEqual({ max: 4, used: 4 });

    const oneTooMany = await request(server)
      .post(`/api/v1/characters/${characterId}/spell-slots`)
      .set(owner)
      .send({ level: 1, delta: 1 });
    expect(oneTooMany.status).toBe(400);
    expect(oneTooMany.body).toMatchObject({ code: 'insufficient_slots', remaining: 0, max: 4 });

    // Restore for the suite's later cases.
    await request(server)
      .post(`/api/v1/characters/${characterId}/spell-slots`)
      .set(owner)
      .send({ level: 1, delta: -4 });
  });

  it('spell-slots at an unconfigured level -> 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/spell-slots`)
      .set(owner)
      .send({ level: 9, delta: 1 });
    expect(res.status).toBe(400);
  });

  it('non-owner, non-dm player gets 403 on spell-slots', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/spell-slots`)
      .set(nonOwner)
      .send({ level: 1, delta: 1 });
    expect(res.status).toBe(403);
  });

  // Issue #422/#1578: the resource system (adjustResource, resourceVocabularyForAdapter) had
  // ZERO callers — no REST route, no MCP tool. These pin the new surface with the SAME
  // authority spell-slots already has (dm or the owning player), not a re-invented gate.
  describe('character resources (#422/#1578)', () => {
    it('lists the campaign rule system\'s standard resource vocabulary, sourced from the adapter', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/characters/${characterId}/resource-vocabulary`).set(owner);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // The default test campaign's rule system is 5e — this is a fact about THAT adapter's
      // declared resources, not a hardcoded assumption the route itself makes.
      const keys = (res.body as Array<{ key: string }>).map((r) => r.key);
      expect(keys).toEqual(expect.arrayContaining(['hitDice', 'rage', 'actionSurge', 'kiPoints']));
    });

    it('a viewer or non-owner player cannot read a character resource vocabulary', async () => {
      const server = ctx.app.getHttpServer();
      const [asViewer, asOtherPlayer] = await Promise.all([
        request(server).get(`/api/v1/characters/${characterId}/resource-vocabulary`).set(viewer),
        request(server).get(`/api/v1/characters/${characterId}/resource-vocabulary`).set(nonOwner),
      ]);
      expect(asViewer.status).toBe(403);
      expect(asOtherPlayer.status).toBe(403);
    });

    it('the owning player spends and restores a resource; an overspend errors rather than clamping', async () => {
      const server = ctx.app.getHttpServer();
      const spend = await request(server)
        .post(`/api/v1/characters/${characterId}/resources`)
        .set(owner)
        .send({ key: 'kiPoints', delta: 1, max: 3, name: 'Ki Points', recharge: 'short-rest' });
      expect(spend.status).toBe(201);
      expect(spend.body.resources.kiPoints).toMatchObject({ max: 3, used: 1, name: 'Ki Points', recharge: 'short-rest' });

      const restore = await request(server)
        .post(`/api/v1/characters/${characterId}/resources`)
        .set(owner)
        .send({ key: 'kiPoints', delta: -1 });
      expect(restore.status).toBe(201);
      expect(restore.body.resources.kiPoints.used).toBe(0);

      // Deliberately an error, never a clamp (#1039's rule, restated for resources) — a silent
      // success here is indistinguishable from an AI narrating a technique it never paid for.
      const overspend = await request(server)
        .post(`/api/v1/characters/${characterId}/resources`)
        .set(owner)
        .send({ key: 'kiPoints', delta: 100 });
      expect(overspend.status).toBe(400);

      // The refused spend wrote nothing.
      const after = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
      expect(after.body.resources.kiPoints.used).toBe(0);
    });

    it('a key outside the adapter vocabulary creates a custom resource rather than being rejected', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/characters/${characterId}/resources`)
        .set(owner)
        .send({ key: 'houseRuleLuckPoints', delta: 1, max: 2, name: 'Luck Points' });
      expect(res.status).toBe(201);
      expect(res.body.resources.houseRuleLuckPoints).toMatchObject({ max: 2, used: 1, name: 'Luck Points' });
    });

    it('non-owner, non-dm player gets 403 adjusting a resource', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/characters/${characterId}/resources`)
        .set(nonOwner)
        .send({ key: 'kiPoints', delta: 1 });
      expect(res.status).toBe(403);
    });

    it('a viewer cannot adjust a resource', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/characters/${characterId}/resources`)
        .set(viewer)
        .send({ key: 'kiPoints', delta: 1 });
      expect(res.status).toBe(403);
    });

    it('the DM may adjust any character\'s resources', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/characters/${characterId}/resources`)
        .set(dm)
        .send({ key: 'kiPoints', delta: 1 });
      expect(res.status).toBe(201);
      expect(res.body.resources.kiPoints.used).toBe(1);
      // Restore for later tests.
      await request(server).post(`/api/v1/characters/${characterId}/resources`).set(dm).send({ key: 'kiPoints', delta: -1 });
    });
  });

  // Issue #59: characters carry a DM-only dmSecret (a secret curse, hidden true
  // identity…) with the same strip-for-non-DM redaction as quests/NPCs/locations.
  it('dmSecret is visible to the DM, redacted for the owner, and denied to a non-owner', async () => {
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
    expect(viewerGet.status).toBe(403);

    // list endpoint too
    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/characters`).set(nonOwner);
    expect(playerList.status).toBe(200);
    for (const c of playerList.body) {
      expect(c.dmSecret).toBeFalsy();
    }
  });

  it('returns full character sheets only to their owner or the DM', async () => {
    const server = ctx.app.getHttpServer();
    const otherRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(nonOwner)
      .send({ name: 'Other Player Sheet', spellSlots: { '1': { max: 2, used: 0 } } });
    expect(otherRes.status).toBe(201);
    const otherId = otherRes.body.id;

    const ownerList = await request(server).get(`/api/v1/campaigns/${campaignId}/characters`).set(owner);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.some((character: { id: number }) => character.id === characterId)).toBe(true);
    expect(ownerList.body.some((character: { id: number }) => character.id === otherId)).toBe(false);

    const ownerRoster = await request(server).get(`/api/v1/campaigns/${campaignId}/characters/roster`).set(owner);
    expect(ownerRoster.status).toBe(200);
    expect(ownerRoster.body.map((character: { id: number }) => character.id)).toEqual(expect.arrayContaining([characterId, otherId]));
    const rosterTeammate = ownerRoster.body.find((character: { id: number }) => character.id === otherId);
    expect(rosterTeammate).toEqual(expect.objectContaining({ id: otherId, name: 'Other Player Sheet' }));
    expect(rosterTeammate).not.toHaveProperty('spellSlots');
    expect(rosterTeammate).not.toHaveProperty('actions');

    const otherList = await request(server).get(`/api/v1/campaigns/${campaignId}/characters`).set(nonOwner);
    expect(otherList.status).toBe(200);
    expect(otherList.body.some((character: { id: number }) => character.id === otherId)).toBe(true);
    expect(otherList.body.some((character: { id: number }) => character.id === characterId)).toBe(false);

    expect((await request(server).get(`/api/v1/characters/${characterId}`).set(nonOwner)).status).toBe(403);
    expect((await request(server).get(`/api/v1/characters/${otherId}`).set(nonOwner)).status).toBe(200);

    const dmList = await request(server).get(`/api/v1/campaigns/${campaignId}/characters`).set(dm);
    expect(dmList.body.map((character: { id: number }) => character.id)).toEqual(expect.arrayContaining([characterId, otherId]));
    expect((await request(server).get(`/api/v1/characters/${otherId}`).set(dm)).status).toBe(200);

    const ownerSummary = await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(owner);
    expect(ownerSummary.body.characters.some((character: { id: number }) => character.id === otherId)).toBe(false);
    expect(ownerSummary.body.party.map((character: { id: number }) => character.id)).toEqual(expect.arrayContaining([characterId, otherId]));
    const teammateRoster = ownerSummary.body.party.find((character: { id: number }) => character.id === otherId);
    expect(teammateRoster).toEqual(expect.objectContaining({ id: otherId, name: 'Other Player Sheet' }));
    expect(teammateRoster).not.toHaveProperty('spellSlots');
    expect(teammateRoster).not.toHaveProperty('actions');
    const otherMentions = await request(server).get(`/api/v1/campaigns/${campaignId}/mentions`).set(nonOwner);
    expect(otherMentions.body.some((target: { type: string; id: number }) => target.type === 'character' && target.id === characterId)).toBe(false);
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

  // Issue #1489: patchXp, levelUp, and patchSpellSlots each returned the raw
  // `toDomain(row)` instead of `redactSecret(toDomain(row), role)`, so the owning
  // player got the DM's dmSecret back verbatim on three of the most frequently-hit
  // write paths in play (spending a spell slot happens constantly mid-session).
  describe('dmSecret redaction on xp/level-up/spell-slots (issue #1489)', () => {
    const secret = 'the amulet is feeding on her — she loses 1 max HP per long rest and does not know';
    let secretCharId: number;

    beforeEach(async () => {
      const server = ctx.app.getHttpServer();
      const createRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Cursed Adventurer', dmSecret: secret, ownerUserId: 'dev:owner-1', level: 1, xp: 0 });
      expect(createRes.status).toBe(201);
      secretCharId = createRes.body.id;

      // The owning player may set their own spell-slot maxima (same PATCH authority
      // as any other sheet field) — needed so /spell-slots has a level to spend from.
      const slotsRes = await request(server)
        .patch(`/api/v1/characters/${secretCharId}`)
        .set(owner)
        .send({ spellSlots: { '1': { max: 4, used: 0 } } });
      expect(slotsRes.status).toBe(200);
    });

    it('PATCH /characters/:id/xp — player sees no dmSecret, dm sees it', async () => {
      const server = ctx.app.getHttpServer();

      const playerRes = await request(server)
        .post(`/api/v1/characters/${secretCharId}/xp`)
        .set(owner)
        .send({ delta: 10 });
      expect(playerRes.status).toBe(201);
      expect(playerRes.body.xp).toBe(10);
      expect(playerRes.body.dmSecret).toBeFalsy();

      const dmRes = await request(server)
        .post(`/api/v1/characters/${secretCharId}/xp`)
        .set(dm)
        .send({ delta: 10 });
      expect(dmRes.status).toBe(201);
      expect(dmRes.body.xp).toBe(20);
      expect(dmRes.body.dmSecret).toBe(secret);
    });

    it('POST /characters/:id/level-up — player sees no dmSecret, dm sees it', async () => {
      const server = ctx.app.getHttpServer();

      const playerRes = await request(server).post(`/api/v1/characters/${secretCharId}/level-up`).set(owner).send({});
      expect(playerRes.status).toBe(201);
      expect(playerRes.body.level).toBe(2);
      expect(playerRes.body.dmSecret).toBeFalsy();

      const dmRes = await request(server).post(`/api/v1/characters/${secretCharId}/level-up`).set(dm).send({});
      expect(dmRes.status).toBe(201);
      expect(dmRes.body.level).toBe(3);
      expect(dmRes.body.dmSecret).toBe(secret);
    });

    it('POST /characters/:id/spell-slots — player sees no dmSecret, dm sees it', async () => {
      const server = ctx.app.getHttpServer();

      const playerRes = await request(server)
        .post(`/api/v1/characters/${secretCharId}/spell-slots`)
        .set(owner)
        .send({ level: 1, delta: 1 });
      expect(playerRes.status).toBe(201);
      expect(playerRes.body.spellSlots['1']).toEqual({ max: 4, used: 1 });
      expect(playerRes.body.dmSecret).toBeFalsy();

      const dmRes = await request(server)
        .post(`/api/v1/characters/${secretCharId}/spell-slots`)
        .set(dm)
        .send({ level: 1, delta: 1 });
      expect(dmRes.status).toBe(201);
      expect(dmRes.body.spellSlots['1']).toEqual({ max: 4, used: 2 });
      expect(dmRes.body.dmSecret).toBe(secret);
    });
  });

  // Issue #48: stats keys are normalized to canonical uppercase on write, so a writer
  // that submits lowercase keys ({ str: 16 }) can't produce a sheet that reads all 10s.
  it('stats keys are normalized to uppercase on create', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Lowercase Paladin', stats: { str: 16, dex: 12, con: 14 } });
    expect(res.status).toBe(201);
    expect(res.body.stats).toEqual({ STR: 16, DEX: 12, CON: 14 });
  });

  it('stats keys are normalized to uppercase on PATCH', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(dm)
      .send({ stats: { str: 8, wis: 18 } });
    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({ STR: 8, WIS: 18 });
  });

  it('an exact-uppercase key wins over a lowercase duplicate', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(dm)
      .send({ stats: { STR: 20, str: 3 } });
    expect(res.status).toBe(200);
    expect(res.body.stats.STR).toBe(20);
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

  // Issue #1643: exhaustion is a LEVEL (5e, 1-6, 6 = death), not opaque free text.
  // `add`/`remove` above only toggle presence and preserve whatever `stacks` an existing
  // instance already has — there was no way to actually MOVE the level. This campaign has
  // no explicit ruleSystem, which resolves to the 5e adapter (ruleSystemAdapter('') falls
  // back to Dnd5eAdapter), so it's a real 5e sheet.
  describe('exhaustion level (issue #1643)', () => {
    it('requires an actual delta or level adjustment', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/characters/${characterId}/conditions/level`)
        .set(owner)
        .send({ name: 'Exhaustion' });
      expect(res.status).toBe(400);
    });

    it('delta increments from nothing, level sets absolutely, and level shows up in conditionInstances', async () => {
      const server = ctx.app.getHttpServer();
      // Starts at 0 (no Exhaustion instance yet) — delta +1 creates it at level 1.
      const first = await request(server)
        .post(`/api/v1/characters/${characterId}/conditions/level`)
        .set(owner)
        .send({ name: 'Exhaustion', delta: 1 });
      expect(first.status).toBe(201);
      expect(first.body.conditions).toContain('Exhaustion');
      const inst1 = first.body.conditionInstances.find((i: { name: string }) => i.name === 'Exhaustion');
      expect(inst1).toMatchObject({ stacks: 1 });

      // Another failed save: delta +1 again -> level 2.
      const second = await request(server)
        .post(`/api/v1/characters/${characterId}/conditions/level`)
        .set(owner)
        .send({ name: 'Exhaustion', delta: 1 });
      expect(second.status).toBe(201);
      expect(second.body.conditionInstances.find((i: { name: string }) => i.name === 'Exhaustion')).toMatchObject({ stacks: 2 });

      // Absolute set (a DM correcting the level directly).
      const setAbs = await request(server)
        .post(`/api/v1/characters/${characterId}/conditions/level`)
        .set(dm)
        .send({ name: 'Exhaustion', level: 4 });
      expect(setAbs.status).toBe(201);
      expect(setAbs.body.conditionInstances.find((i: { name: string }) => i.name === 'Exhaustion')).toMatchObject({ stacks: 4 });

      // A long rest, extended stay, or magical cure: delta -1 -> level 3.
      const decrement = await request(server)
        .post(`/api/v1/characters/${characterId}/conditions/level`)
        .set(dm)
        .send({ name: 'Exhaustion', delta: -1 });
      expect(decrement.status).toBe(201);
      expect(decrement.body.conditionInstances.find((i: { name: string }) => i.name === 'Exhaustion')).toMatchObject({ stacks: 3 });

      // Level 0 removes the condition entirely — no zero-stacks instance lingers.
      const clear = await request(server)
        .post(`/api/v1/characters/${characterId}/conditions/level`)
        .set(dm)
        .send({ name: 'Exhaustion', level: 0 });
      expect(clear.status).toBe(201);
      expect(clear.body.conditions).not.toContain('Exhaustion');
      expect(clear.body.conditionInstances.find((i: { name: string }) => i.name === 'Exhaustion')).toBeUndefined();
    });

    it('respects the 5e cap: level 7 is a 400, not a clamp to 6, and nothing was written', async () => {
      const server = ctx.app.getHttpServer();
      await request(server).post(`/api/v1/characters/${characterId}/conditions/level`).set(dm).send({ name: 'Exhaustion', level: 0 });
      const atCap = await request(server)
        .post(`/api/v1/characters/${characterId}/conditions/level`)
        .set(dm)
        .send({ name: 'Exhaustion', level: 6 });
      expect(atCap.status).toBe(201);
      expect(atCap.body.conditionInstances.find((i: { name: string }) => i.name === 'Exhaustion')).toMatchObject({ stacks: 6 });

      const overCap = await request(server)
        .post(`/api/v1/characters/${characterId}/conditions/level`)
        .set(dm)
        .send({ name: 'Exhaustion', delta: 1 });
      expect(overCap.status).toBe(400);

      // Unchanged — still 6, not silently clamped and not left at some other value.
      const after = await request(server).get(`/api/v1/characters/${characterId}`).set(dm);
      expect(after.body.conditionInstances.find((i: { name: string }) => i.name === 'Exhaustion')).toMatchObject({ stacks: 6 });

      const belowZero = await request(server)
        .post(`/api/v1/characters/${characterId}/conditions/level`)
        .set(dm)
        .send({ name: 'Exhaustion', level: 0, delta: -1 });
      expect(belowZero.status).toBe(400);

      // Clean up for later tests in this file.
      await request(server).post(`/api/v1/characters/${characterId}/conditions/level`).set(dm).send({ name: 'Exhaustion', level: 0 });
    });

    it('rejects adding Exhaustion when structured condition storage is full', async () => {
      const server = ctx.app.getHttpServer();
      const charRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Full Condition Sheet' });
      expect(charRes.status).toBe(201);
      const targetId = charRes.body.id as number;

      const fullInstances = Array.from({ length: 50 }, (_, idx) => ({
        id: `full_${idx}`,
        name: `Condition ${idx}`,
        ruleEntryId: null,
        source: null,
        sourceCombatantId: null,
        durationRounds: null,
        roundsRemaining: null,
        timing: 'none',
        saveTiming: 'none',
        saveDc: null,
        saveAbility: null,
        isConcentration: false,
        stacks: 1,
        notes: '',
        custom: true,
      }));
      const db = ctx.app.get<DrizzleDb>(DB);
      await db
        .update(characters)
        .set({
          conditions: JSON.stringify(fullInstances.map((i) => i.name)),
          conditionInstances: JSON.stringify(fullInstances),
        })
        .where(eq(characters.id, targetId));

      const res = await request(server)
        .post(`/api/v1/characters/${targetId}/conditions/level`)
        .set(dm)
        .send({ name: 'Exhaustion', level: 1 });
      expect(res.status).toBe(400);

      const [after] = await db.select().from(characters).where(eq(characters.id, targetId)).limit(1);
      const afterInstances = JSON.parse(after.conditionInstances ?? '[]') as Array<{ name: string }>;
      expect(afterInstances).toHaveLength(50);
      expect(afterInstances.some((i) => i.name === 'Exhaustion')).toBe(false);
    });

    it('relative level adjustments are not lost when two callers update at once', async () => {
      const server = ctx.app.getHttpServer();
      const charRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Concurrent Exhaustion Target' });
      expect(charRes.status).toBe(201);
      const targetId = charRes.body.id as number;

      const [a, b] = await Promise.all([
        request(server).post(`/api/v1/characters/${targetId}/conditions/level`).set(dm).send({ name: 'Exhaustion', delta: 1 }),
        request(server).post(`/api/v1/characters/${targetId}/conditions/level`).set(dm).send({ name: 'Exhaustion', delta: 1 }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 201]);

      const after = await request(server).get(`/api/v1/characters/${targetId}`).set(dm);
      expect(after.body.conditionInstances.find((i: { name: string }) => i.name === 'Exhaustion')).toMatchObject({ stacks: 2 });
    });

    it('syncs the adjusted level into a linked live combatant', async () => {
      const server = ctx.app.getHttpServer();
      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Live Exhaustion Sync Campaign' });
      expect(campRes.status).toBe(201);
      const liveCampaignId = campRes.body.id as number;
      const charRes = await request(server)
        .post(`/api/v1/campaigns/${liveCampaignId}/characters`)
        .set(dm)
        .send({ name: 'Live Exhaustion Target' });
      expect(charRes.status).toBe(201);
      const liveCharacterId = charRes.body.id as number;
      const encRes = await request(server).post(`/api/v1/campaigns/${liveCampaignId}/encounters`).set(dm).send({ name: 'Live Sync Fight' });
      expect(encRes.status).toBe(201);
      const combatantRes = await request(server)
        .post(`/api/v1/encounters/${encRes.body.id}/combatants`)
        .set(dm)
        .send({ kind: 'character', characterId: liveCharacterId });
      expect(combatantRes.status).toBe(201);

      const adjusted = await request(server)
        .post(`/api/v1/characters/${liveCharacterId}/conditions/level`)
        .set(dm)
        .send({ name: 'Exhaustion', level: 3 });
      expect(adjusted.status).toBe(201);

      const db = ctx.app.get<DrizzleDb>(DB);
      const [combatant] = await db.select().from(combatants).where(eq(combatants.characterId, liveCharacterId)).limit(1);
      const instances = JSON.parse(combatant.conditionInstances ?? '[]') as Array<{ name: string; stacks: number }>;
      expect(instances.find((i) => i.name === 'Exhaustion')).toMatchObject({ stacks: 3 });
    });

    it("a name that isn't this system's leveled track is a 400 (does not silently create a custom leveled condition)", async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/characters/${characterId}/conditions/level`)
        .set(dm)
        .send({ name: 'Poisoned', delta: 1 });
      expect(res.status).toBe(400);
    });
  });

  // Issue #1643's negative case: PF2e has no leveled condition track at all.
  describe('exhaustion level — a system with no track (issue #1643)', () => {
    let pf2eCampaignId: number;
    let pf2eCharacterId: number;

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'PF2e No-Exhaustion Campaign' });
      pf2eCampaignId = campRes.body.id;
      const db = ctx.app.get<DrizzleDb>(DB);
      await db.update(campaigns).set({ ruleSystem: 'pf2e' }).where(eq(campaigns.id, pf2eCampaignId));

      const charRes = await request(server)
        .post(`/api/v1/campaigns/${pf2eCampaignId}/characters`)
        .set(owner)
        .send({ name: 'PF2e Test Character' });
      pf2eCharacterId = charRes.body.id;
    });

    it('every level call 400s — PF2e declares no leveled condition track', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/characters/${pf2eCharacterId}/conditions/level`)
        .set(owner)
        .send({ name: 'Exhaustion', delta: 1 });
      expect(res.status).toBe(400);

      // The bare-name add/remove path still works normally — #1643 only closes the
      // LEVEL gap, it does not touch presence-only conditions on any system.
      const addRes = await request(server)
        .post(`/api/v1/characters/${pf2eCharacterId}/conditions`)
        .set(owner)
        .send({ add: ['Fatigued'] });
      expect(addRes.status).toBe(201);
      expect(addRes.body.conditions).toContain('Fatigued');
    });
  });

  // Issue #129: a player may own more than one character (backup PC, familiar, companion) —
  // the API always allowed it, and now the owner (not just the dm) can delete their own.
  describe('multi-character ownership & owner delete (issue #129)', () => {
    it('a player may create a second owned character', async () => {
      const server = ctx.app.getHttpServer();
      const first = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(owner)
        .send({ name: 'Main PC' });
      expect(first.status).toBe(201);
      expect(first.body.ownerUserId).toBe('dev:owner-1');

      const second = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(owner)
        .send({ name: 'Pip the Familiar' });
      expect(second.status).toBe(201);
      expect(second.body.ownerUserId).toBe('dev:owner-1');
      expect(second.body.id).not.toBe(first.body.id);
    });

    it('an owner may delete their own character', async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(owner)
        .send({ name: 'Backup Barbarian' });
      expect(created.status).toBe(201);
      const backupId = created.body.id;

      const delRes = await request(server).delete(`/api/v1/characters/${backupId}`).set(owner);
      expect(delRes.status).toBe(200);

      const getAfter = await request(server).get(`/api/v1/characters/${backupId}`).set(owner);
      expect(getAfter.status).toBe(404);
    });

    it("a non-owner player cannot delete someone else's character (403)", async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(owner)
        .send({ name: 'Not Yours' });
      expect(created.status).toBe(201);
      const otherId = created.body.id;

      const delRes = await request(server).delete(`/api/v1/characters/${otherId}`).set(nonOwner);
      expect(delRes.status).toBe(403);

      // still there
      const getAfter = await request(server).get(`/api/v1/characters/${otherId}`).set(owner);
      expect(getAfter.status).toBe(200);
    });

    it('the dm may still delete any character', async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(owner)
        .send({ name: 'DM Can Remove Me' });
      expect(created.status).toBe(201);

      const delRes = await request(server).delete(`/api/v1/characters/${created.body.id}`).set(dm);
      expect(delRes.status).toBe(200);
    });
  });

  // Issue #96 + #116: deleting a character is now a reversible SOFT-delete. The character
  // vanishes from GET/list, but any combatant that references it KEEPS the link — the row
  // still exists (just hidden), so nothing dangles and a restore relights the combat sync.
  describe('soft-delete cleanup: character↔combatant (issue #96 / #116)', () => {
    it('deleting a character hides it but keeps the combatant + its link; restore brings it back', async () => {
      const server = ctx.app.getHttpServer();
      const delCampRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Delete Combatant Campaign' });
      const delCampId = delCampRes.body.id;

      const charRes = await request(server)
        .post(`/api/v1/campaigns/${delCampId}/characters`)
        .set(dm)
        .send({ name: 'Doomed Hero', hpMax: 20, hpCurrent: 20 });
      expect(charRes.status).toBe(201);
      const doomedId = charRes.body.id;

      // Encounter create auto-adds every party character as a combatant.
      const encRes = await request(server).post(`/api/v1/campaigns/${delCampId}/encounters`).set(dm).send({ name: 'Ambush' });
      expect(encRes.status).toBe(201);
      const encId = encRes.body.id;
      const combatant = (encRes.body.combatants as Array<{ id: number; characterId: number | null }>).find(
        (c) => c.characterId === doomedId,
      );
      expect(combatant).toBeDefined();

      const delRes = await request(server).delete(`/api/v1/characters/${doomedId}`).set(dm);
      expect(delRes.status).toBe(200);

      // Character hidden from normal reads...
      const charGone = await request(server).get(`/api/v1/characters/${doomedId}`).set(dm);
      expect(charGone.status).toBe(404);

      // ...but the combatant survives with its link intact (reversible — no dangling ref).
      const encAfter = await request(server).get(`/api/v1/encounters/${encId}`).set(dm);
      expect(encAfter.status).toBe(200);
      const combatantAfter = (encAfter.body.combatants as Array<{ id: number; characterId: number | null }>).find(
        (c) => c.id === combatant!.id,
      );
      expect(combatantAfter).toBeDefined();
      expect(combatantAfter!.characterId).toBe(doomedId);

      // Restore relights the character.
      const restoreRes = await request(server).post(`/api/v1/characters/${doomedId}/restore`).set(dm);
      expect(restoreRes.status).toBe(201);
      const charBack = await request(server).get(`/api/v1/characters/${doomedId}`).set(dm);
      expect(charBack.status).toBe(200);
    });
  });

  describe('draft character creation (issue #719)', () => {
    it('minimal name-only create becomes a draft with unset combat numbers', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(owner)
        .send({ name: 'Sketch PC' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('draft');
      expect(res.body.hpMax).toBe(0);
      expect(res.body.hpCurrent).toBe(0);
      expect(res.body.ac).toBeNull();
      expect(res.body.stats).toEqual({});
    });

    it('explicit template payload stays draft until marked active', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(owner)
        .send({
          name: 'Template Hero',
          status: 'draft',
          className: 'Fighter',
          level: 1,
          stats: { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 8 },
          ac: 18,
          hpMax: 12,
          hpCurrent: 12,
        });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('draft');
      expect(res.body.ac).toBe(18);
    });

    it('create persists death state, temp HP, death saves, and resource pools (issue #1492)', async () => {
      // The same five fields update() now writes must also land on CREATE — CharacterCreate
      // spreads them as valid optional keys, and MCP upsert_character's create branch routes
      // here, so a DM/AI creating a character with a starting death state or resource pool must
      // not get a 201 back while the row keeps schema defaults.
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({
          name: 'Pre-Wounded Hero',
          hpMax: 20,
          hpCurrent: 0,
          hpTemp: 5,
          deathState: 'dying',
          deathSaveSuccesses: 1,
          deathSaveFailures: 2,
          resources: { ki: { max: 5, used: 2, name: 'Ki Points', recharge: 'short-rest' } },
        });
      expect(res.status).toBe(201);
      expect(res.body.hpTemp).toBe(5);
      expect(res.body.deathState).toBe('dying');
      expect(res.body.deathSaveSuccesses).toBe(1);
      expect(res.body.deathSaveFailures).toBe(2);
      expect(res.body.resources).toMatchObject({ ki: { max: 5, used: 2, name: 'Ki Points', recharge: 'short-rest' } });
      // An overspend at create is rejected (#1039 contract), not silently clamped/stored.
      const overspend = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Bad Pool', resources: { rage: { max: 3, used: 9 } } });
      expect(overspend.status).toBe(400);
      // A character created dead (deathState: 'dead', no explicit status) derives lifecycle
      // status 'dead' too, so it's excluded from future encounter auto-add — matching the
      // update() and /end derivation. An explicit status still wins.
      const deadCreate = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Already Dead', hpMax: 20, hpCurrent: 0, deathState: 'dead' });
      expect(deadCreate.status).toBe(201);
      expect(deadCreate.body.deathState).toBe('dead');
      expect(deadCreate.body.status).toBe('dead');
      const explicitStatus = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Retired Veteran', deathState: 'dead', status: 'retired' });
      expect(explicitStatus.status).toBe(201);
      expect(explicitStatus.body.status).toBe('retired'); // explicit choice wins
      // An EXPLICIT `status: 'active'` alongside `deathState: 'dead'` is also honored — the
      // derivation only fires when status is omitted, so a caller who deliberately marks a dead
      // PC active keeps active (mirrors update()'s `input.status === undefined` gate).
      const explicitActive = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Active Corpse', deathState: 'dead', status: 'active' });
      expect(explicitActive.status).toBe(201);
      expect(explicitActive.body.deathState).toBe('dead');
      expect(explicitActive.body.status).toBe('active'); // explicit active wins
    });
  });
});

describe('dmControlsProgression flag gates XP/level-up (issue #270)', () => {
  const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
  const owner = { 'x-dev-role': 'player', 'x-dev-user': 'owner-1' };
  let ctx: TestAppContext;
  let server: import('http').Server;
  let campaignId: number;
  let characterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Progression Camp' });
    campaignId = camp.body.id;
    // Flag defaults to false.
    expect(camp.body.dmControlsProgression).toBe(false);
    const char = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(owner)
      .send({ name: 'Aspiring Hero', hpMax: 20, hpCurrent: 20 });
    expect(char.status).toBe(201);
    characterId = char.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('flag OFF (default): the owning player may self-award XP and level up', async () => {
    const xp = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(owner).send({ set: 900 });
    expect(xp.status).toBe(201);
    expect(xp.body.xp).toBe(900);
    const lvl = await request(server).post(`/api/v1/characters/${characterId}/level-up`).set(owner).send({});
    expect(lvl.status).toBe(201);
    expect(lvl.body.level).toBe(2);
  });

  it('flag ON: a non-DM player is 403 on xp, level-up, and the general PATCH; the DM still succeeds', async () => {
    const flip = await request(server)
      .patch(`/api/v1/campaigns/${campaignId}`)
      .set(dm)
      .send({ dmControlsProgression: true });
    expect(flip.status).toBe(200);
    expect(flip.body.dmControlsProgression).toBe(true);

    // Player is now blocked on every progression path.
    const xpDenied = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(owner).send({ set: 5000 });
    expect(xpDenied.status).toBe(403);
    const lvlDenied = await request(server).post(`/api/v1/characters/${characterId}/level-up`).set(owner).send({});
    expect(lvlDenied.status).toBe(403);
    const patchDenied = await request(server).patch(`/api/v1/characters/${characterId}`).set(owner).send({ xp: 5000 });
    expect(patchDenied.status).toBe(403);
    const afterDenied = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
    expect(afterDenied.body.xp).toBe(900);
    expect(afterDenied.body.level).toBe(2);

    // Non-progression edits by the owner still work (HP), proving the gate is scoped.
    const hpOk = await request(server).post(`/api/v1/characters/${characterId}/hp`).set(owner).send({ set: 15 });
    expect(hpOk.status).toBe(201);

    // The DM can still award XP + level up.
    const dmXp = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(dm).send({ set: 5000 });
    expect(dmXp.status).toBe(201);
    expect(dmXp.body.xp).toBe(5000);
    const dmLvl = await request(server).post(`/api/v1/characters/${characterId}/level-up`).set(dm).send({});
    expect(dmLvl.status).toBe(201);
    expect(dmLvl.body.level).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Issue #1492 (Part 1): PATCH /characters/:id accepted deathState, hpTemp,
// deathSaveSuccesses, deathSaveFailures and resources (valid CharacterUpdate keys
// the schema passes and MCP advertises) and then SILENTLY DROPPED them, returning
// 200 with the unchanged values. A DM reviving a dead PC believed the write worked
// while the row kept the old dead/dying state — the PC died instantly on their next
// drop to 0 HP. These fields now persist, with the same clamps every other path uses.
// ---------------------------------------------------------------------------
describe('PATCH /characters/:id persists deathState/hpTemp/death-saves/resources (issue #1492)', () => {
  const dm1492 = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1492' };
  let ctx: TestAppContext;
  let server: import('http').Server;
  let campaignId: number;
  let charId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm1492).send({ name: 'Revive Camp' });
    expect(camp.status).toBe(201);
    campaignId = camp.body.id;
    const char = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm1492)
      .send({ name: 'Fallen Hero', hpMax: 32, hpCurrent: 0 });
    expect(char.status).toBe(201);
    charId = char.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('the death-revival scenario: clearing deathState + death-save failures persists', async () => {
    // Seed the dead state the DM is trying to clear (simulate a PC who died).
    const seeded = await dbUpdate(server, dm1492, charId, { deathState: 'dead', deathSaveFailures: 3, deathSaveSuccesses: 0 });
    expect(seeded.status).toBe(200);
    expect(seeded.body.deathState).toBe('dead');
    expect(seeded.body.deathSaveFailures).toBe(3);

    // The DM revives the PC. Before the fix this returned 200 but kept deathState:'dead'.
    const revived = await dbUpdate(server, dm1492, charId, {
      deathState: 'none',
      deathSaveFailures: 0,
      deathSaveSuccesses: 0,
      hpCurrent: 1,
      status: 'active',
    });
    expect(revived.status).toBe(200);
    expect(revived.body.deathState).toBe('none');
    expect(revived.body.deathSaveFailures).toBe(0);
    expect(revived.body.deathSaveSuccesses).toBe(0);
    expect(revived.body.status).toBe('active');

    // Confirm the row truly persisted (not just the response body) — a GET reads it back.
    const fetched = await request(server).get(`/api/v1/characters/${charId}`).set(dm1492);
    expect(fetched.status).toBe(200);
    expect(fetched.body.deathState).toBe('none');
    expect(fetched.body.deathSaveFailures).toBe(0);
  });

  it('hpTemp persists', async () => {
    const res = await dbUpdate(server, dm1492, charId, { hpTemp: 12 });
    expect(res.status).toBe(200);
    expect(res.body.hpTemp).toBe(12);
    // The schema's `.min(0)` bound rejects a negative temp pool at the DTO boundary (400),
    // never silently storing it — the field used to be dropped entirely; now it's guarded.
    const rejected = await dbUpdate(server, dm1492, charId, { hpTemp: -5 });
    expect(rejected.status).toBe(400);
  });

  it('death-save tallies persist and reject out-of-range values', async () => {
    const res = await dbUpdate(server, dm1492, charId, { deathSaveSuccesses: 2, deathSaveFailures: 1 });
    expect(res.status).toBe(200);
    expect(res.body.deathSaveSuccesses).toBe(2);
    expect(res.body.deathSaveFailures).toBe(1);
    // The schema's [0, 3] bound rejects an out-of-range tally at the DTO boundary (400) rather
    // than coercing it — the field used to be dropped entirely; now it's guarded.
    const rejected = await dbUpdate(server, dm1492, charId, { deathSaveSuccesses: 9, deathSaveFailures: 9 });
    expect(rejected.status).toBe(400);
  });

  it('resources persist on the general PATCH (reject used outside [0, max], merge over existing)', async () => {
    const res = await dbUpdate(server, dm1492, charId, {
      resources: { ki: { max: 5, used: 2, name: 'Ki Points', recharge: 'short-rest' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.resources).toMatchObject({ ki: { max: 5, used: 2, name: 'Ki Points', recharge: 'short-rest' } });
    // Mirrors the dedicated POST :id/resources invariant (#1039: "spending a resource you do
    // not have must fail loudly") and the spellSlots branch below — an overspend/overrestore is
    // REJECTED (400), never silently clamped to a different pool than the caller requested.
    const overspend = await dbUpdate(server, dm1492, charId, {
      resources: { ki: { max: 5, used: 20 } },
    });
    expect(overspend.status).toBe(400);
    // The row is unchanged: the write didn't happen (re-read confirms the prior value).
    const afterOverspend = await request(server).get(`/api/v1/characters/${charId}`).set(dm1492);
    expect(afterOverspend.body.resources.ki.used).toBe(2);
    const overrestore = await dbUpdate(server, dm1492, charId, {
      resources: { ki: { max: 5, used: -1 } },
    });
    expect(overrestore.status).toBe(400);
    // MERGE, not wholesale replace: sending a second pool preserves the first (and its
    // name/recharge metadata). A caller — notably MCP upsert_character, which advertises
    // resources as optional — must not erase pools it didn't mention.
    const merged = await dbUpdate(server, dm1492, charId, {
      resources: { sorcery: { max: 4, used: 1, name: 'Sorcery Points', recharge: 'long-rest' } },
    });
    expect(merged.status).toBe(200);
    expect(merged.body.resources.ki).toMatchObject({ max: 5, used: 2, name: 'Ki Points', recharge: 'short-rest' });
    expect(merged.body.resources.sorcery).toMatchObject({ max: 4, used: 1, name: 'Sorcery Points', recharge: 'long-rest' });
    // PER-POOL field merge: updating only `used` on an existing pool preserves its name/recharge,
    // so a caller adjusting a single field doesn't strip the pool's display config.
    const spendKi = await dbUpdate(server, dm1492, charId, {
      resources: { ki: { max: 5, used: 3 } },
    });
    expect(spendKi.status).toBe(200);
    expect(spendKi.body.resources.ki).toMatchObject({ max: 5, used: 3, name: 'Ki Points', recharge: 'short-rest' });
    // The untouched sorcery pool survives too.
    expect(spendKi.body.resources.sorcery).toMatchObject({ max: 4, used: 1, name: 'Sorcery Points', recharge: 'long-rest' });
  });

  it('death-state transitions synchronize lifecycle status (dead->dead, none+hp>0->active, respects explicit status)', async () => {
    // Mirror patchHp (issue #711) and the encounter /end reconciliation. Each transition below
    // runs WITHOUT sending status, so the auto-flip is what's under test — except case 4, which
    // proves an explicit status wins.
    // 1. deathState: 'dead' (no status sent) on an active PC flips lifecycle status to 'dead'
    //    (excludes from future encounter auto-add, which selects only active PCs).
    const killed = await dbUpdate(server, dm1492, charId, { deathState: 'dead', hpCurrent: 0 });
    expect(killed.status).toBe(200);
    expect(killed.body.deathState).toBe('dead');
    expect(killed.body.status).toBe('dead');
    // 2. deathState: 'none' with positive HP on a previously-dead PC flips status back to active.
    const revived = await dbUpdate(server, dm1492, charId, { deathState: 'none', deathSaveFailures: 0, hpCurrent: 5 });
    expect(revived.status).toBe(200);
    expect(revived.body.deathState).toBe('none');
    expect(revived.body.status).toBe('active');
    expect(revived.body.hpCurrent).toBe(5);
    // 3. deathState: 'none' at 0 HP does NOT revive the lifecycle status — a 0-HP character is
    //    not alive (matches /end's `revived = !dead && hpCurrent > 0`). Seed dead again first.
    await dbUpdate(server, dm1492, charId, { deathState: 'dead', hpCurrent: 0 });
    const clearedAtZero = await dbUpdate(server, dm1492, charId, { deathState: 'none', deathSaveFailures: 0 });
    expect(clearedAtZero.status).toBe(200);
    expect(clearedAtZero.body.deathState).toBe('none');
    expect(clearedAtZero.body.status).toBe('dead'); // unchanged — not a revive
    // 4. An explicit status is never overwritten by the auto-flip: reviving to 'retired' lands
    //    as 'retired', not 'active'.
    await dbUpdate(server, dm1492, charId, { deathState: 'dead', hpCurrent: 0 });
    const retired = await dbUpdate(server, dm1492, charId, { deathState: 'none', status: 'retired', hpCurrent: 5 });
    expect(retired.status).toBe(200);
    expect(retired.body.deathState).toBe('none');
    expect(retired.body.status).toBe('retired'); // explicit choice wins
  });
});

// ---------------------------------------------------------------------------
// Issue #1492 (Part 2): the schema's hard level cap of 20 conflicted with rule
// systems whose adapter legitimately allows past 20 (Open Legend / an OSR
// retroclone report `maxLevel: Infinity`). A legal level-up past 20 wrote 21 to
// the row, then every subsequent "Edit sheet" save PATCHed `level: 21` and 400'd
// against the schema bound — bricking the sheet. The schema cap now matches the
// most permissive adapter, and create()/update() enforce the per-system
// `adapter.maxLevel` server-side so a direct PATCH can't bypass it.
// ---------------------------------------------------------------------------
describe('character level cap matches the rule-system adapter (issue #1492)', () => {
  const capDm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1492-level' };
  let ctx: TestAppContext;
  let server: import('http').Server;
  let db: DrizzleDb;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    db = ctx.app.get<DrizzleDb>(DB);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a level-up past 20 in an uncapped system leaves the sheet editable (the Scenario-B regression)', async () => {
    const camp = await request(server).post('/api/v1/campaigns').set(capDm).send({ name: 'OSR Edit Camp' });
    expect(camp.status).toBe(201);
    // 'basic-fantasy' resolves to the OSR adapter (maxLevel: Infinity).
    await db.update(campaigns).set({ ruleSystem: 'basic-fantasy' }).where(eq(campaigns.id, camp.body.id)).run();

    const char = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/characters`)
      .set(capDm)
      .send({ name: 'Old School Delver', hpMax: 16, hpCurrent: 16 });
    expect(char.status).toBe(201);

    // Advance past 20 in the uncapped system.
    const at20 = await dbUpdate(server, capDm, char.body.id, { level: 20 });
    expect(at20.status).toBe(200);
    const leveled = await request(server).post(`/api/v1/characters/${char.body.id}/level-up`).set(capDm).send({});
    expect(leveled.status).toBe(201);
    expect(leveled.body.level).toBe(21);

    // The brick: before the fix, an "Edit sheet" save carrying level:21 400'd against the schema
    // bound. Now it succeeds — the sheet stays editable.
    const reEdit = await dbUpdate(server, capDm, char.body.id, { level: 21, notes: 'back from the dead' });
    expect(reEdit.status).toBe(200);
    expect(reEdit.body.level).toBe(21);
    expect(reEdit.body.notes).toBe('back from the dead');
  });

  it('a 5e campaign still rejects a level above 20 on PATCH (the cap moved to the service, not removed)', async () => {
    const camp = await request(server).post('/api/v1/campaigns').set(capDm).send({ name: '5e Cap Edit Camp' });
    expect(camp.status).toBe(201);
    expect(camp.body.ruleSystem).toBe(''); // default → 5e adapter → maxLevel 20

    const char = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/characters`)
      .set(capDm)
      .send({ name: 'Five E Hero', hpMax: 20, hpCurrent: 20 });
    expect(char.status).toBe(201);

    // A level above the 5e adapter cap is rejected server-side (400), even though the schema
    // bound now permits it for uncapped systems.
    const denied = await dbUpdate(server, capDm, char.body.id, { level: 21 });
    expect(denied.status).toBe(400);
    // The character's level is unchanged (the write didn't happen).
    const fetched = await request(server).get(`/api/v1/characters/${char.body.id}`).set(capDm);
    expect(fetched.body.level).toBe(1);
  });

  it('a level above the adapter cap is rejected on create too (not just levelUp)', async () => {
    const camp = await request(server).post('/api/v1/campaigns').set(capDm).send({ name: '5e Create Cap Camp' });
    expect(camp.status).toBe(201);
    // Default rule system is 5e (maxLevel 20).
    const denied = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/characters`)
      .set(capDm)
      .send({ name: 'Too High', level: 25, hpMax: 10, hpCurrent: 10 });
    expect(denied.status).toBe(400);
    // A legal 5e level still creates fine.
    const ok = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/characters`)
      .set(capDm)
      .send({ name: 'Just Right', level: 5, hpMax: 10, hpCurrent: 10 });
    expect(ok.status).toBe(201);
    expect(ok.body.level).toBe(5);
  });

  it('a character already over the cap (after a rule-system downgrade) stays editable for unrelated fields', async () => {
    // Start in an uncapped system, level the character past 13th Age's cap of 10.
    const camp = await request(server).post('/api/v1/campaigns').set(capDm).send({ name: 'Downgrade Camp' });
    expect(camp.status).toBe(201);
    await db.update(campaigns).set({ ruleSystem: 'basic-fantasy' }).where(eq(campaigns.id, camp.body.id)).run();

    const char = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/characters`)
      .set(capDm)
      .send({ name: 'High Level', level: 15, hpMax: 40, hpCurrent: 40 });
    expect(char.status).toBe(201);
    expect(char.body.level).toBe(15);

    // Downgrade the campaign to 13th Age (cap 10). The character is now over the new cap.
    await db.update(campaigns).set({ ruleSystem: 'archmage' }).where(eq(campaigns.id, camp.body.id)).run();

    // A sheet edit that resends the current level (level: 15, unchanged) alongside an unrelated
    // field must still succeed — the editor resends level on every save. Only an INCREASE above
    // the cap is rejected.
    const reEdit = await dbUpdate(server, capDm, char.body.id, { level: 15, notes: 'still playing' });
    expect(reEdit.status).toBe(200);
    expect(reEdit.body.level).toBe(15);
    expect(reEdit.body.notes).toBe('still playing');

    // Pushing the over-cap character HIGHER is still rejected.
    const higher = await dbUpdate(server, capDm, char.body.id, { level: 16 });
    expect(higher.status).toBe(400);
  });
});

/**
 * Issue #535: levelUp must consult the campaign's RuleSystemAdapter.maxLevel instead of a
 * hardcoded 5e `20`. A 5e campaign still caps at 20 (regression guard), but a campaign on a
 * no-cap system (an OSR retroclone → Infinity) lets a level-20 character advance to 21 — the
 * exact advance the old hardcoded `>= 20` check wrongly rejected.
 *
 * The campaign's `ruleSystem` is written straight to the DB (the campaigns-service POST/PATCH
 * path validates the slug against an installed rule pack, which is out of scope for this fix);
 * `levelUp` reads it back through the same adapter resolver the live service uses.
 */
describe('levelUp honors the rule-system level cap (issue #535)', () => {
  const capDm = { 'x-dev-role': 'dm', 'x-dev-user': 'cap-dm-1' };
  let ctx: TestAppContext;
  let server: import('http').Server;
  let db: DrizzleDb;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    db = ctx.app.get<DrizzleDb>(DB);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a 5e (default) campaign still rejects level-up at 20', async () => {
    const camp = await request(server).post('/api/v1/campaigns').set(capDm).send({ name: '5e Cap Camp' });
    expect(camp.status).toBe(201);
    expect(camp.body.ruleSystem).toBe(''); // default → 5e adapter → maxLevel 20

    const char = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/characters`)
      .set(capDm)
      .send({ name: 'Five E Hero', hpMax: 20, hpCurrent: 20 });
    expect(char.status).toBe(201);

    // Seed the character to level 20 via the PATCH escape hatch (ruleSystem '' stays 5e).
    const at20 = await request(server).patch(`/api/v1/characters/${char.body.id}`).set(capDm).send({ level: 20 });
    expect(at20.status).toBe(200);
    expect(at20.body.level).toBe(20);

    // levelUp at 20 is rejected: the 5e adapter's cap is 20.
    const denied = await request(server).post(`/api/v1/characters/${char.body.id}/level-up`).set(capDm).send({});
    expect(denied.status).toBe(400);
  });

  it('a no-cap OSR campaign lets a level-20 character advance to 21 (the #535 regression)', async () => {
    const camp = await request(server).post('/api/v1/campaigns').set(capDm).send({ name: 'OSR No-Cap Camp' });
    expect(camp.status).toBe(201);

    // Write a no-cap rule-system slug directly (bypassing the campaigns-service pack validation,
    // which is unrelated to the cap logic under test). 'basic-fantasy' resolves to the OSR
    // adapter, whose maxLevel is Infinity.
    await db.update(campaigns).set({ ruleSystem: 'basic-fantasy' }).where(eq(campaigns.id, camp.body.id)).run();
    const reloaded = await request(server).get(`/api/v1/campaigns/${camp.body.id}`).set(capDm);
    expect(reloaded.body.ruleSystem).toBe('basic-fantasy');

    const char = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/characters`)
      .set(capDm)
      .send({ name: 'Old School Delver', hpMax: 16, hpCurrent: 16 });
    expect(char.status).toBe(201);

    // Seed to level 20; the old hardcoded `>= 20` check would block the next levelUp here.
    const at20 = await request(server).patch(`/api/v1/characters/${char.body.id}`).set(capDm).send({ level: 20 });
    expect(at20.status).toBe(200);
    expect(at20.body.level).toBe(20);

    // The fix: a no-cap system's levelUp succeeds past 20.
    const leveled = await request(server).post(`/api/v1/characters/${char.body.id}/level-up`).set(capDm).send({});
    expect(leveled.status).toBe(201);
    expect(leveled.body.level).toBe(21);

    // Sanity: the character row really persisted 21 (not just the response body).
    const [row] = await db.select({ level: characters.level }).from(characters).where(eq(characters.id, char.body.id)).limit(1);
    expect(row?.level).toBe(21);
  });

  it('a no-cap OSR campaign still stops at the shared schema ceiling (MAX_LEVEL, issue #1492)', async () => {
    const camp = await request(server).post('/api/v1/campaigns').set(capDm).send({ name: 'OSR Schema-Cap Camp' });
    expect(camp.status).toBe(201);
    // 'basic-fantasy' → OSR adapter → maxLevel Infinity. The adapter alone would never stop
    // advancing, but the shared schema's MAX_LEVEL (99) ceiling still applies so a level-99 PC
    // leveled to 100 doesn't write a row the schema then rejects on every subsequent save.
    await db.update(campaigns).set({ ruleSystem: 'basic-fantasy' }).where(eq(campaigns.id, camp.body.id)).run();

    const char = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/characters`)
      .set(capDm)
      .send({ name: 'Max Level Delver', hpMax: 16, hpCurrent: 16 });
    expect(char.status).toBe(201);

    // Seed to the schema ceiling (MAX_LEVEL = 99) via the PATCH path, which the widened schema
    // bound now permits for an uncapped system.
    const atCeiling = await request(server).patch(`/api/v1/characters/${char.body.id}`).set(capDm).send({ level: 99 });
    expect(atCeiling.status).toBe(200);
    expect(atCeiling.body.level).toBe(99);

    // levelUp at the ceiling is rejected: min(Infinity, MAX_LEVEL) = MAX_LEVEL = 99.
    const denied = await request(server).post(`/api/v1/characters/${char.body.id}/level-up`).set(capDm).send({});
    expect(denied.status).toBe(400);

    // A PATCH that resends the current level (99) alongside an unrelated edit still succeeds —
    // the sheet editor resends level on every save and 99 is a legal value.
    const reEdit = await request(server).patch(`/api/v1/characters/${char.body.id}`).set(capDm).send({ level: 99, notes: 'at the ceiling' });
    expect(reEdit.status).toBe(200);
    expect(reEdit.body.level).toBe(99);
    expect(reEdit.body.notes).toBe('at the ceiling');
  });
});

// ---------------------------------------------------------------------------
// Issue #746 — optimistic concurrency for characters. A character sheet is the
// classic blind last-write-wins clobber victim: two tabs (or a player tab + a
// DM tab, or a connected AI over MCP) both load the sheet, one applies a live
// HP/level change or a DM-secret edit, and the other's stale full-snapshot save
// silently restores the old HP max, level, status, or ability scores. PATCH
// /characters/:id now enforces the same `expectedUpdatedAt` CAS invariant as
// quests/npcs/locations/sessions/encounters (#157/#532) — a stale save 409s
// with STALE_WRITE instead of clobbering the fresher edit.
// ---------------------------------------------------------------------------
describe('characters — optimistic concurrency (issue #746, e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let characterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'CAS Character Campaign' })).body.id;
    const char = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(owner)
      .send({ name: 'Stale Sheet', hpMax: 20, hpCurrent: 20, ac: 15 });
    expect(char.status).toBe(201);
    characterId = char.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('omitting expectedUpdatedAt is unchanged back-compat (unconditional write)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/characters/${characterId}`).set(owner).send({ name: 'Fresh Sheet' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Fresh Sheet');
  });

  it('a stale expectedUpdatedAt PATCH 409s with STALE_WRITE and does NOT mutate the row', async () => {
    const server = ctx.app.getHttpServer();
    const before = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
    expect(before.body.name).toBe('Fresh Sheet');

    const conflict = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ name: 'CLOBBER', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('STALE_WRITE');

    // The row is untouched — no clobber.
    const after = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
    expect(after.body.name).toBe('Fresh Sheet');
    expect(after.body.updatedAt).toBe(before.body.updatedAt);
  });

  it('a matching expectedUpdatedAt PATCH succeeds', async () => {
    const server = ctx.app.getHttpServer();
    const current = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);

    const ok = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ ac: 17, expectedUpdatedAt: current.body.updatedAt });
    expect(ok.status).toBe(200);
    expect(ok.body.ac).toBe(17);
    expect(ok.body.updatedAt).not.toBe(current.body.updatedAt); // bumped
  });

  // The headline regression from the issue: two tabs both load the sheet, both save.
  // Tab A applies a live HP change (the common mid-session case); Tab B (still holding
  // the pre-A updatedAt) then PATCHes its stale full snapshot — which used to silently
  // restore the old HP. The CAS guard must now 409 Tab B and leave Tab A's HP intact.
  it('two concurrent updates: the second (stale) one gets 409 and the first edit survives', async () => {
    const server = ctx.app.getHttpServer();

    // Both tabs load the same version.
    const tabA = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
    const tabB = await request(server).get(`/api/v1/characters/${characterId}`).set(dm);
    expect(tabA.body.updatedAt).toBe(tabB.body.updatedAt);
    const loadedAt = tabA.body.updatedAt;
    const loadedHp = tabA.body.hpCurrent;

    // Tab A applies a live HP change first — succeeds and bumps updatedAt. (This is the
    // mid-session heal/damage path: a real second writer, not just a field echo.)
    const firstSave = await request(server).post(`/api/v1/characters/${characterId}/hp`).set(dm).send({ set: 4 });
    expect(firstSave.status).toBe(201);
    expect(firstSave.body.hpCurrent).toBe(4);
    expect(firstSave.body.updatedAt).not.toBe(loadedAt); // bumped

    // Tab B (still holding the pre-A updatedAt) PATCHes its stale full snapshot — must
    // 409, NOT silently restore the old hpCurrent.
    const staleSave = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(dm)
      .send({ hpCurrent: loadedHp, expectedUpdatedAt: loadedAt });
    expect(staleSave.status).toBe(409);
    expect(staleSave.body.code).toBe('STALE_WRITE');

    // Tab A's HP edit survived — the stale save did not clobber it.
    const after = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
    expect(after.body.hpCurrent).toBe(4);
  });

  // A proposal-applied update never carries expectedUpdatedAt (the DM applies a queued
  // edit later, so any guard would be stale-by-design) — the CAS guard must be a no-op
  // when the field is omitted, so the proposal path stays unaffected.
  it('the proposal path (no expectedUpdatedAt) is unaffected', async () => {
    const server = ctx.app.getHttpServer();
    const proposal = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .query('proposed=true')
      .send({ name: 'Proposed Rename' });
    expect(proposal.status).toBe(202);
    expect(proposal.body.proposal).toBeDefined();
    // The live row is unchanged until the DM approves.
    const live = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
    expect(live.body.name).not.toBe('Proposed Rename');
  });
});

const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'other-player-2' };

describe('POST /characters/:id/rest — individual character rest', () => {
  let ctx: TestAppContext;
  let restCampaignId: number;
  let restCharId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();

    const campRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: `Rest Test Campaign ${Date.now()}` });
    restCampaignId = campRes.body.id;

    await request(server)
      .post(`/api/v1/campaigns/${restCampaignId}/members`)
      .set(dm)
      .send({ userId: 'dev:other-player-2', role: 'player' });

    const charRes = await request(server)
      .post(`/api/v1/campaigns/${restCampaignId}/characters`)
      .set(owner)
      .send({
        name: 'Resting Hero',
        className: 'Fighter',
        level: 3,
        hpMax: 30,
        hpCurrent: 10,
        spMax: 15,
        spCurrent: 5,
        rpMax: 3,
        rpCurrent: 1,
        deathState: 'stable',
      });
    restCharId = charRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('rejects a non-owner non-DM campaign player with 403', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${restCharId}/rest`)
      .set(otherPlayer)
      .send({ type: 'stamina' });
    expect(res.status).toBe(403);
  });

  it('stamina rest consumes 1 RP and restores SP to max', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${restCharId}/rest`)
      .set(owner)
      .send({ type: 'stamina' });
    expect(res.status).toBe(201);
    expect(res.body.rpCurrent).toBe(0);
    expect(res.body.spCurrent).toBe(15);
  });

  it('stamina rest with 0 RP returns 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${restCharId}/rest`)
      .set(owner)
      .send({ type: 'stamina' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('requires at least 1 Resolve Point');
  });

  it('night rest heals max(1, level) HP, resets deathState, and restores SP/RP to max', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${restCharId}/rest`)
      .set(owner)
      .send({ type: 'night' });
    expect(res.status).toBe(201);
    expect(res.body.hpCurrent).toBe(13); // 10 + level(3) = 13
    expect(res.body.spCurrent).toBe(15);
    expect(res.body.rpCurrent).toBe(3);
    expect(res.body.deathState).toBe('none');
  });
});
