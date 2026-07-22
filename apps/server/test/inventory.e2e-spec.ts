import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'p-2' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('inventory & treasury (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let ownCharacterId: number; // owned by player p-1
  let dmCharacterId: number; // DM-managed (no owner)

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Loot Campaign' });
    campaignId = res.body.id;

    // player p-1 creates their own character -> ownerUserId = p-1's user id
    const ownChar = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(player)
      .send({ name: 'Sariel' });
    ownCharacterId = ownChar.body.id;

    const dmChar = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Hired Guard' });
    dmCharacterId = dmChar.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('items', () => {
    it('create party item (defaults) -> list -> get', async () => {
      const server = ctx.app.getHttpServer();

      const createRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Rope (50 ft)' });
      expect(createRes.status).toBe(201);
      expect(createRes.body.ownerType).toBe('party');
      expect(createRes.body.characterId).toBeNull();
      expect(createRes.body.qty).toBe(1);
      expect(createRes.body.notes).toBe('');
      expect(createRes.body.iconSlug).toBe(''); // issue #307 — no override by default

      const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/inventory`).set(viewer);
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((i: { id: number }) => i.id === createRes.body.id)).toBe(true);

      const getRes = await request(server).get(`/api/v1/inventory/${createRes.body.id}`).set(player);
      expect(getRes.status).toBe(200);
      expect(getRes.body.name).toBe('Rope (50 ft)');
    });

    it('icon override round-trips: create with iconSlug -> list/get -> patch -> clear (issue #307)', async () => {
      const server = ctx.app.getHttpServer();

      // Create carries an explicit icon slug.
      const createRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Flaming Longsword', iconSlug: 'sword-brandish' });
      expect(createRes.status).toBe(201);
      expect(createRes.body.iconSlug).toBe('sword-brandish');
      const itemId = createRes.body.id;

      // Survives read paths (get + list).
      const getRes = await request(server).get(`/api/v1/inventory/${itemId}`).set(player);
      expect(getRes.body.iconSlug).toBe('sword-brandish');
      const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/inventory`).set(viewer);
      expect(listRes.body.find((i: { id: number }) => i.id === itemId).iconSlug).toBe('sword-brandish');

      // Patch to a different slug.
      const patchRes = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ iconSlug: 'flanged-mace' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.iconSlug).toBe('flanged-mace');

      // Clearing the override ('') reverts to the auto default on the client.
      const clearRes = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ iconSlug: '' });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.iconSlug).toBe('');
    });

    it('viewer cannot create/update/delete items', async () => {
      const server = ctx.app.getHttpServer();

      const createRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(viewer)
        .send({ name: 'Should fail' });
      expect(createRes.status).toBe(403);

      const itemRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Torch', qty: 5 });
      const patchRes = await request(server).patch(`/api/v1/inventory/${itemRes.body.id}`).set(viewer).send({ qty: 4 });
      expect(patchRes.status).toBe(403);
      const deleteRes = await request(server).delete(`/api/v1/inventory/${itemRes.body.id}`).set(viewer);
      expect(deleteRes.status).toBe(403);
    });

    it('owner consistency: character owner requires a valid same-campaign characterId; party forbids one', async () => {
      const server = ctx.app.getHttpServer();

      // ownerType=character without characterId -> 400
      const noChar = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Bad', ownerType: 'character' });
      expect(noChar.status).toBe(400);

      // nonexistent characterId -> 400
      const badChar = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Bad', ownerType: 'character', characterId: 999999 });
      expect(badChar.status).toBe(400);

      // cross-campaign characterId -> 400
      const otherCampRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Loot Campaign' });
      const otherCharRes = await request(server)
        .post(`/api/v1/campaigns/${otherCampRes.body.id}/characters`)
        .set(dm)
        .send({ name: 'Foreign PC' });
      const crossChar = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Bad', ownerType: 'character', characterId: otherCharRes.body.id });
      expect(crossChar.status).toBe(400);

      // ownerType=party with characterId -> 400
      const partyWithChar = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Bad', ownerType: 'party', characterId: ownCharacterId });
      expect(partyWithChar.status).toBe(400);
    });

    it('unknown key in item create/update body -> 400, not silently stripped', async () => {
      const server = ctx.app.getHttpServer();

      const createRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Strict Item', quanttiy: 3 });
      expect(createRes.status).toBe(400);

      const okCreate = await request(server).post(`/api/v1/campaigns/${campaignId}/inventory`).set(dm).send({ name: 'Strict Item' });
      expect(okCreate.status).toBe(201);
      const patchRes = await request(server).patch(`/api/v1/inventory/${okCreate.body.id}`).set(dm).send({ nmae: 'Typo' });
      expect(patchRes.status).toBe(400);
    });

    it('character items: dm or the owning player may write; other players 403', async () => {
      const server = ctx.app.getHttpServer();

      // p-1 adds an item to their own character
      const createRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Longsword', ownerType: 'character', characterId: ownCharacterId });
      expect(createRes.status).toBe(201);
      const itemId = createRes.body.id;

      // another player may not touch it
      const otherPatch = await request(server).patch(`/api/v1/inventory/${itemId}`).set(otherPlayer).send({ qty: 2 });
      expect(otherPatch.status).toBe(403);
      const otherDelete = await request(server).delete(`/api/v1/inventory/${itemId}`).set(otherPlayer);
      expect(otherDelete.status).toBe(403);
      // ...nor add to someone else's character
      const otherCreate = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(otherPlayer)
        .send({ name: 'Planted evidence', ownerType: 'character', characterId: ownCharacterId });
      expect(otherCreate.status).toBe(403);

      // the owner may
      const ownerPatch = await request(server).patch(`/api/v1/inventory/${itemId}`).set(player).send({ qty: 2, notes: 'Well-worn.' });
      expect(ownerPatch.status).toBe(200);
      expect(ownerPatch.body.qty).toBe(2);
      expect(ownerPatch.body.notes).toBe('Well-worn.');

      // dm may too
      const dmPatch = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ name: 'Longsword +1' });
      expect(dmPatch.status).toBe(200);
      expect(dmPatch.body.name).toBe('Longsword +1');

      // a DM-managed character (no owner) is dm-only
      const dmCharItem = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Nope', ownerType: 'character', characterId: dmCharacterId });
      expect(dmCharItem.status).toBe(403);
      const dmCharItemByDm = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Guard spear', ownerType: 'character', characterId: dmCharacterId });
      expect(dmCharItemByDm.status).toBe(201);
    });

    it('moving an item between party and character owners', async () => {
      const server = ctx.app.getHttpServer();

      // party -> own character (player may claim from the stash)
      const stashRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Healing potion', qty: 3 });
      const moveRes = await request(server)
        .patch(`/api/v1/inventory/${stashRes.body.id}`)
        .set(player)
        .send({ ownerType: 'character', characterId: ownCharacterId });
      expect(moveRes.status).toBe(200);
      expect(moveRes.body.ownerType).toBe('character');
      expect(moveRes.body.characterId).toBe(ownCharacterId);

      // character -> party (characterId cleared automatically)
      const backRes = await request(server).patch(`/api/v1/inventory/${stashRes.body.id}`).set(player).send({ ownerType: 'party' });
      expect(backRes.status).toBe(200);
      expect(backRes.body.ownerType).toBe('party');
      expect(backRes.body.characterId).toBeNull();

      // party -> someone ELSE's character as a non-dm -> 403 (destination check)
      const toOther = await request(server)
        .patch(`/api/v1/inventory/${stashRes.body.id}`)
        .set(otherPlayer)
        .send({ ownerType: 'character', characterId: ownCharacterId });
      expect(toOther.status).toBe(403);

      // moving to a nonexistent character -> 400
      const toNowhere = await request(server)
        .patch(`/api/v1/inventory/${stashRes.body.id}`)
        .set(dm)
        .send({ ownerType: 'character', characterId: 999999 });
      expect(toNowhere.status).toBe(400);
    });

    it('any player may manage the party stash; delete works', async () => {
      const server = ctx.app.getHttpServer();

      const createRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(otherPlayer)
        .send({ name: 'Iron rations', qty: 10, notes: 'Found in the mine.' });
      expect(createRes.status).toBe(201);

      const patchRes = await request(server).patch(`/api/v1/inventory/${createRes.body.id}`).set(player).send({ qty: 8 });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.qty).toBe(8);

      const deleteRes = await request(server).delete(`/api/v1/inventory/${createRes.body.id}`).set(otherPlayer);
      expect(deleteRes.status).toBe(200);
      const getRes = await request(server).get(`/api/v1/inventory/${createRes.body.id}`).set(dm);
      expect(getRes.status).toBe(404);
    });

    it('items are scoped to their campaign', async () => {
      const server = ctx.app.getHttpServer();
      const otherCampRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Scoped Campaign' });
      const otherId = otherCampRes.body.id;
      await request(server).post(`/api/v1/campaigns/${otherId}/inventory`).set(dm).send({ name: 'Elsewhere item' });

      const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/inventory`).set(dm);
      expect(listRes.body.some((i: { name: string }) => i.name === 'Elsewhere item')).toBe(false);
    });
  });

  describe('treasury', () => {
    it('GET returns a zeroed treasury before any writes', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/campaigns/${campaignId}/treasury`).set(viewer);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ campaignId, cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 });
    });

    it('delta adds and spends; going negative is a 400 and leaves totals unchanged', async () => {
      const server = ctx.app.getHttpServer();

      const addRes = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}/treasury`)
        .set(dm)
        .send({ delta: { gp: 150, sp: 20 } });
      expect(addRes.status).toBe(200);
      expect(addRes.body.gp).toBe(150);
      expect(addRes.body.sp).toBe(20);
      expect(addRes.body.cp).toBe(0);

      const spendRes = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}/treasury`)
        .set(player)
        .send({ delta: { gp: -50 } });
      expect(spendRes.status).toBe(200);
      expect(spendRes.body.gp).toBe(100);

      const overspendRes = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}/treasury`)
        .set(player)
        .send({ delta: { gp: -101 } });
      expect(overspendRes.status).toBe(400);

      const getRes = await request(server).get(`/api/v1/campaigns/${campaignId}/treasury`).set(player);
      expect(getRes.body.gp).toBe(100);
      expect(getRes.body.sp).toBe(20);
    });

    it('sequential deltas compose without losing an update (atomic patch, issue #272)', async () => {
      const server = ctx.app.getHttpServer();
      const otherCampRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Coin Purse' });
      const camp = otherCampRes.body.id;

      // A run of add/spend deltas — each must read the latest committed balance and apply
      // onto it (read+compute+write happen in one transaction), so the final total is the
      // exact running sum rather than a clobbered read-modify-write.
      const deltas = [{ gp: 100 }, { gp: 25, sp: 10 }, { gp: -40 }, { sp: -3 }];
      for (const delta of deltas) {
        const res = await request(server).patch(`/api/v1/campaigns/${camp}/treasury`).set(dm).send({ delta });
        expect(res.status).toBe(200);
      }
      const getRes = await request(server).get(`/api/v1/campaigns/${camp}/treasury`).set(dm);
      expect(getRes.body.gp).toBe(85); // 100 + 25 - 40
      expect(getRes.body.sp).toBe(7); // 10 - 3
    });

    it('set is absolute and only touches the given denominations', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}/treasury`)
        .set(dm)
        .send({ set: { pp: 5, gp: 42 } });
      expect(res.status).toBe(200);
      expect(res.body.pp).toBe(5);
      expect(res.body.gp).toBe(42);
      expect(res.body.sp).toBe(20); // untouched from the previous test

      // negative absolute value fails schema validation
      const negRes = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}/treasury`)
        .set(dm)
        .send({ set: { gp: -1 } });
      expect(negRes.status).toBe(400);
    });

    it('viewer may read but not write the treasury', async () => {
      const server = ctx.app.getHttpServer();
      const readRes = await request(server).get(`/api/v1/campaigns/${campaignId}/treasury`).set(viewer);
      expect(readRes.status).toBe(200);
      const writeRes = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}/treasury`)
        .set(viewer)
        .send({ delta: { gp: 1 } });
      expect(writeRes.status).toBe(403);
    });

    it('treasuries are per-campaign', async () => {
      const server = ctx.app.getHttpServer();
      const otherCampRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Poor Campaign' });
      const res = await request(server).get(`/api/v1/campaigns/${otherCampRes.body.id}/treasury`).set(dm);
      expect(res.status).toBe(200);
      expect(res.body.gp).toBe(0);
    });

    // ---- issue #582: concurrency, CAS, and per-denomination audit ----

    it('CAS: a stale expectedUpdatedAt returns 409 with the current server values (issue #582)', async () => {
      const server = ctx.app.getHttpServer();
      const camp = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'CAS Camp' })).body.id;

      // Baseline reconciliation with a fresh CAS token — must succeed.
      const base = await request(server)
        .patch(`/api/v1/campaigns/${camp}/treasury`)
        .set(dm)
        .send({ set: { gp: 100, pp: 2 }, expectedUpdatedAt: (await request(server).get(`/api/v1/campaigns/${camp}/treasury`).set(dm)).body.updatedAt });
      expect(base.status).toBe(200);
      expect(base.body.gp).toBe(100);
      const staleUpdatedAt = base.body.updatedAt;

      // Another player spends some gold in between, advancing updatedAt. updatedAt is
      // millisecond-resolution, so a write landing in the same ms as the baseline wouldn't
      // move the CAS token — wait briefly before the spend to guarantee a fresh ms, so the
      // stale-token assertion below is deterministic. (This mirrors real at-the-table usage
      // where the gap between a player's load and save spans many ms.)
      await new Promise((r) => setTimeout(r, 10));
      const mid = await request(server).patch(`/api/v1/campaigns/${camp}/treasury`).set(player).send({ delta: { gp: -30 } });
      expect(mid.status).toBe(200);
      expect(mid.body.gp).toBe(70);
      expect(mid.body.updatedAt).not.toBe(staleUpdatedAt);

      // Now the DM's STALE set (snapshotted before the spend) arrives with the old
      // expectedUpdatedAt. Without the CAS guard it would write gp=100 and silently
      // restore the 30gp the player just spent — the exact data-loss bug in #582.
      const stale = await request(server)
        .patch(`/api/v1/campaigns/${camp}/treasury`)
        .set(dm)
        .send({ set: { gp: 100 }, expectedUpdatedAt: staleUpdatedAt });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('TREASURY_CONFLICT');
      // The 409 carries the live values so the client can merge.
      expect(stale.body.current).toMatchObject({ gp: 70, pp: 2 });
      expect(stale.body.current.updatedAt).toBe(mid.body.updatedAt);

      // The stale write was rejected — the row is unchanged.
      const after = await request(server).get(`/api/v1/campaigns/${camp}/treasury`).set(dm);
      expect(after.body.gp).toBe(70);
      expect(after.body.pp).toBe(2);

      // A fresh set with the up-to-date token succeeds (the merge/reapply path).
      const reapplied = await request(server)
        .patch(`/api/v1/campaigns/${camp}/treasury`)
        .set(dm)
        .send({ set: { gp: 100 }, expectedUpdatedAt: after.body.updatedAt });
      expect(reapplied.status).toBe(200);
      expect(reapplied.body.gp).toBe(100);
    });

    it('CAS: a set without expectedUpdatedAt still applies (back-compat for pre-CAS callers)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}/treasury`)
        .set(dm)
        .send({ set: { sp: 9 } });
      expect(res.status).toBe(200);
      expect(res.body.sp).toBe(9);
    });

    it('an empty patch (no denominations) returns 400 rather than a no-op write', async () => {
      const server = ctx.app.getHttpServer();
      const deltaEmpty = await request(server).patch(`/api/v1/campaigns/${campaignId}/treasury`).set(dm).send({ delta: {} });
      expect(deltaEmpty.status).toBe(400);
      const setEmpty = await request(server).patch(`/api/v1/campaigns/${campaignId}/treasury`).set(dm).send({ set: {} });
      expect(setEmpty.status).toBe(400);
    });

    it('audits per-denomination before/after and the actor on every treasury write (issue #582)', async () => {
      const server = ctx.app.getHttpServer();
      const camp = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Audit Camp' })).body.id;

      // gp 0 -> 50 (delta), then gp 50 -> 50/pp 0 -> 1 (set), then gp 50 -> 40 (spend).
      await request(server).patch(`/api/v1/campaigns/${camp}/treasury`).set(player).send({ delta: { gp: 50 } });
      await request(server).patch(`/api/v1/campaigns/${camp}/treasury`).set(dm).send({ set: { pp: 1 } });
      await request(server).patch(`/api/v1/campaigns/${camp}/treasury`).set(player).send({ delta: { gp: -10, sp: 5 } });

      const auditRes = await request(server).get(`/api/v1/campaigns/${camp}/audit`).set(dm);
      expect(auditRes.status).toBe(200);
      const treasuryAudits = auditRes.body.filter((e: { action: string }) => e.action === 'treasury.update');
      expect(treasuryAudits).toHaveLength(3);

      // Each row carries a structured per-denomination detail with before/after + actor.
      for (const row of treasuryAudits) {
        const detail = JSON.parse(row.detail);
        expect(detail.actor).toBeDefined();
        expect(detail.actor.id).toEqual(expect.any(String));
        expect(detail.actor.role).toEqual(expect.any(String));
        expect(Array.isArray(detail.changes)).toBe(true);
        for (const c of detail.changes) {
          expect(['cp', 'sp', 'ep', 'gp', 'pp']).toContain(c.coin);
          expect(typeof c.before).toBe('number');
          expect(typeof c.after).toBe('number');
        }
      }

      // The third write (a multi-coin delta) records both coins it touched.
      const third = JSON.parse(treasuryAudits[0].detail); // newest-first
      expect(third.kind).toBe('delta');
      const coins = third.changes.map((c: { coin: string }) => c.coin).sort();
      expect(coins).toEqual(['gp', 'sp']);
      const gpChange = third.changes.find((c: { coin: string }) => c.coin === 'gp');
      expect(gpChange).toEqual({ coin: 'gp', before: 50, delta: -10, after: 40 });
      const spChange = third.changes.find((c: { coin: string }) => c.coin === 'sp');
      expect(spChange).toEqual({ coin: 'sp', before: 0, delta: 5, after: 5 });

      // The set write records setTo rather than delta.
      const second = JSON.parse(treasuryAudits[1].detail);
      expect(second.kind).toBe('set');
      expect(second.changes[0]).toEqual({ coin: 'pp', before: 0, setTo: 1, after: 1 });
    });
  });
});
