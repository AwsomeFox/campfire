import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { campaigns, characters } from '../src/db/schema';

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
    expect(res.body.actions[0]).toEqual({ name: 'Longsword', kind: 'melee', toHit: '+5', damage: '1d8+3 slashing', notes: 'versatile 1d10' });
    expect(res.body.actions[1]).toEqual({ name: 'Second Wind', kind: '', toHit: '', damage: '', notes: '' });
  });

  it('PATCH actions rejects a nameless action', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ actions: [{ name: '' }] });
    expect(res.status).toBe(400);
  });

  it('PATCH spellSlots sets maxima and clamps used to max', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ spellSlots: { '1': { max: 4, used: 0 }, '2': { max: 2, used: 5 } } });
    expect(res.status).toBe(200);
    // used=5 > max=2 is clamped down, mirroring the hpCurrent/hpMax clamp.
    expect(res.body.spellSlots).toEqual({ '1': { max: 4, used: 0 }, '2': { max: 2, used: 2 } });
  });

  it('PATCH spellSlots rejects a non 1-9 level key', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/characters/${characterId}`)
      .set(owner)
      .send({ spellSlots: { '10': { max: 1, used: 0 } } });
    expect(res.status).toBe(400);
  });

  it('spell-slots spend/restore adjusts used and clamps to [0, max]', async () => {
    const server = ctx.app.getHttpServer();
    const spend = await request(server)
      .post(`/api/v1/characters/${characterId}/spell-slots`)
      .set(owner)
      .send({ level: 1, delta: 1 });
    expect(spend.status).toBe(201);
    expect(spend.body.spellSlots['1']).toEqual({ max: 4, used: 1 });

    const overRestore = await request(server)
      .post(`/api/v1/characters/${characterId}/spell-slots`)
      .set(owner)
      .send({ level: 1, delta: -100 });
    expect(overRestore.status).toBe(201);
    expect(overRestore.body.spellSlots['1']).toEqual({ max: 4, used: 0 });

    const overSpend = await request(server)
      .post(`/api/v1/characters/${characterId}/spell-slots`)
      .set(owner)
      .send({ level: 1, delta: 100 });
    expect(overSpend.status).toBe(201);
    expect(overSpend.body.spellSlots['1']).toEqual({ max: 4, used: 4 });
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
});
