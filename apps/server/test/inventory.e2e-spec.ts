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

    it('weight round-trips: defaults to 0, creatable, patchable, audited (issue #2157)', async () => {
      const server = ctx.app.getHttpServer();

      // Default when omitted.
      const defaultRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Unweighed trinket' });
      expect(defaultRes.status).toBe(201);
      expect(defaultRes.body.weight).toBe(0);

      // Set at creation — decimal pounds.
      const createRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Chainmail', weight: 55.5 });
      expect(createRes.status).toBe(201);
      expect(createRes.body.weight).toBe(55.5);
      const itemId = createRes.body.id;

      // Survives read paths (get + list).
      const getRes = await request(server).get(`/api/v1/inventory/${itemId}`).set(player);
      expect(getRes.body.weight).toBe(55.5);
      const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/inventory`).set(viewer);
      expect(listRes.body.find((i: { id: number }) => i.id === itemId).weight).toBe(55.5);

      // Patch to a new value.
      const patchRes = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ weight: 10 });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.weight).toBe(10);

      // Rejected out of range.
      const negativeRes = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ weight: -1 });
      expect(negativeRes.status).toBe(400);
      const tooHeavyRes = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ weight: 10_001 });
      expect(tooHeavyRes.status).toBe(400);

      // Audited as a normal field change (issue #2157: `weight` joins the audit field list).
      const auditRes = await request(server).get(`/api/v1/campaigns/${campaignId}/audit?entityType=inventory_item`).set(dm);
      expect(auditRes.status).toBe(200);
      const entry = (auditRes.body as { entityId: number; payload?: { changes?: { field: string }[] } }[]).find(
        (e) => e.entityId === itemId && e.payload?.changes?.some((c) => c.field === 'weight'),
      );
      expect(entry).toBeDefined();
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
      const patchRes = await request(server)
        .patch(`/api/v1/inventory/${itemRes.body.id}`)
        .set(viewer)
        .send({ qtyDelta: -1, idempotencyKey: 'viewer-forbidden-qty' });
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
      const otherPatch = await request(server)
        .patch(`/api/v1/inventory/${itemId}`)
        .set(otherPlayer)
        .send({ qtyDelta: 1, idempotencyKey: 'other-forbidden-qty' });
      expect(otherPatch.status).toBe(403);
      const otherDelete = await request(server).delete(`/api/v1/inventory/${itemId}`).set(otherPlayer);
      expect(otherDelete.status).toBe(403);
      // ...nor add to someone else's character
      const otherCreate = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(otherPlayer)
        .send({ name: 'Planted evidence', ownerType: 'character', characterId: ownCharacterId });
      expect(otherCreate.status).toBe(403);

      // the owner may (atomic delta + notes)
      const ownerPatch = await request(server)
        .patch(`/api/v1/inventory/${itemId}`)
        .set(player)
        .send({ qtyDelta: 1, idempotencyKey: 'owner-qty-notes', notes: 'Well-worn.' });
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

      const patchRes = await request(server)
        .patch(`/api/v1/inventory/${createRes.body.id}`)
        .set(player)
        .send({ qtyDelta: -2, idempotencyKey: 'stash-spend-2' });
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

    // ---- issue #782: atomic qty deltas, CAS absolute set, idempotency ----

    it('qtyDelta requires idempotencyKey; absolute qty requires expectedUpdatedAt (#782)', async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Arrow', qty: 5 });
      expect(created.status).toBe(201);

      const noKey = await request(server).patch(`/api/v1/inventory/${created.body.id}`).set(dm).send({ qtyDelta: 1 });
      expect(noKey.status).toBe(400);
      expect(noKey.body.message).toMatch(/idempotencyKey/i);

      const noCas = await request(server).patch(`/api/v1/inventory/${created.body.id}`).set(dm).send({ qty: 9 });
      expect(noCas.status).toBe(400);
      expect(noCas.body.message).toMatch(/expectedUpdatedAt/i);

      const both = await request(server)
        .patch(`/api/v1/inventory/${created.body.id}`)
        .set(dm)
        .send({ qty: 9, qtyDelta: 1, idempotencyKey: 'both-shapes', expectedUpdatedAt: created.body.updatedAt });
      expect(both.status).toBe(400);
      expect(both.body.message).toMatch(/not both/i);
    });

    it('qtyDelta composes; zero boundary rejects without changing the row (#782)', async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Ration', qty: 2 });
      expect(created.status).toBe(201);
      const id = created.body.id;

      const up = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(player)
        .send({ qtyDelta: 1, idempotencyKey: 'ration-up-1' });
      expect(up.status).toBe(200);
      expect(up.body.qty).toBe(3);

      const down = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(player)
        .send({ qtyDelta: -1, idempotencyKey: 'ration-down-1' });
      expect(down.status).toBe(200);
      expect(down.body.qty).toBe(2);

      const floor = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(player)
        .send({ qtyDelta: -2, idempotencyKey: 'ration-to-zero' });
      expect(floor.status).toBe(200);
      expect(floor.body.qty).toBe(0);

      const over = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(player)
        .send({ qtyDelta: -1, idempotencyKey: 'ration-below-zero' });
      expect(over.status).toBe(400);

      const after = await request(server).get(`/api/v1/inventory/${id}`).set(dm);
      expect(after.body.qty).toBe(0);
    });

    it('idempotent qtyDelta retry returns the committed item without re-applying (#782)', async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Torch bundle', qty: 1 });
      const id = created.body.id;
      const key = 'retry-torch-inc';

      const first = await request(server).patch(`/api/v1/inventory/${id}`).set(dm).send({ qtyDelta: 1, idempotencyKey: key });
      expect(first.status).toBe(200);
      expect(first.body.qty).toBe(2);

      const retry = await request(server).patch(`/api/v1/inventory/${id}`).set(dm).send({ qtyDelta: 1, idempotencyKey: key });
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ id, qty: 2, updatedAt: first.body.updatedAt });

      const misuse = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(dm)
        .send({ qtyDelta: 2, idempotencyKey: key });
      expect(misuse.status).toBe(409);
      expect(misuse.body.code).toBe('IDEMPOTENCY_KEY_REUSE');

      // Same qtyDelta but different accompanying fields must also 409 — fingerprint
      // covers name/notes/move/icon so a "corrected" retry cannot silently drop them.
      const differentFields = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(dm)
        .send({ qtyDelta: 1, idempotencyKey: key, name: 'Torch bundle (lit)', notes: 'smoky' });
      expect(differentFields.status).toBe(409);
      expect(differentFields.body.code).toBe('IDEMPOTENCY_KEY_REUSE');

      const live = await request(server).get(`/api/v1/inventory/${id}`).set(dm);
      expect(live.body.qty).toBe(2);
      expect(live.body.name).toBe('Torch bundle');
    });

    it('issue #1901 rework: qty idempotency fingerprint covers displaceEquipped (review: chatgpt-codex-connector P2)', async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Hired Guard Buckler', ownerType: 'character', characterId: dmCharacterId, qty: 1 });
      const id = created.body.id;
      const key = 'displace-fingerprint-1901';
      const slot = 'idempotency-displace-slot-1901';

      const first = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(dm)
        .send({ qtyDelta: 1, idempotencyKey: key, equipped: true, equipSlot: slot, displaceEquipped: false });
      expect(first.status).toBe(200);
      expect(first.body.qty).toBe(2);

      // Same key, same qtyDelta, same equip/equipSlot — but a FLIPPED displaceEquipped. This
      // payload authorizes something the original one did not (unequipping whatever else
      // occupies the slot), so it must 409 rather than silently replay the first response.
      const flipped = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(dm)
        .send({ qtyDelta: 1, idempotencyKey: key, equipped: true, equipSlot: slot, displaceEquipped: true });
      expect(flipped.status).toBe(409);
      expect(flipped.body.code).toBe('IDEMPOTENCY_KEY_REUSE');

      // The identical request, replayed, is still a clean idempotent no-op.
      const replay = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(dm)
        .send({ qtyDelta: 1, idempotencyKey: key, equipped: true, equipSlot: slot, displaceEquipped: false });
      expect(replay.status).toBe(200);
      expect(replay.body.qty).toBe(2);
    });

    // Issue #1901 review (chatgpt-codex-connector P2 + devin-ai-integration): the SAME rule
    // as displaceEquipped above applies to expectedConflictingItemId — it changes what the
    // write is AUTHORIZED to do (which incumbent it may displace), so reusing an idempotency
    // key while confirming a DIFFERENT incumbent must 409, not silently replay the prior
    // response as if the caller's (different) confirmation had been honored.
    it('issue #1901 review: qty idempotency fingerprint covers expectedConflictingItemId', async () => {
      const server = ctx.app.getHttpServer();
      const slot = 'idempotency-cas-slot-1901';
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Hired Guard Cudgel', ownerType: 'character', characterId: dmCharacterId, qty: 1 });
      const id = created.body.id;
      const incumbentA = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Incumbent A', ownerType: 'character', characterId: dmCharacterId });
      const incumbentB = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Incumbent B', ownerType: 'character', characterId: dmCharacterId });
      await request(server).patch(`/api/v1/inventory/${incumbentA.body.id}`).set(dm).send({ equipped: true, equipSlot: slot });

      const key = 'cas-fingerprint-1901';
      const first = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(dm)
        .send({ qtyDelta: 1, idempotencyKey: key, equipped: true, equipSlot: slot, displaceEquipped: true, expectedConflictingItemId: incumbentA.body.id });
      expect(first.status).toBe(200);
      expect(first.body.qty).toBe(2);

      // Same key, same qty/equip/displaceEquipped — but confirming a DIFFERENT incumbent.
      // This authorizes displacing incumbentB, which the original request never confirmed.
      const flipped = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(dm)
        .send({ qtyDelta: 1, idempotencyKey: key, equipped: true, equipSlot: slot, displaceEquipped: true, expectedConflictingItemId: incumbentB.body.id });
      expect(flipped.status).toBe(409);
      expect(flipped.body.code).toBe('IDEMPOTENCY_KEY_REUSE');

      // The identical request, replayed, is still a clean idempotent no-op.
      const replay = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(dm)
        .send({ qtyDelta: 1, idempotencyKey: key, equipped: true, equipSlot: slot, displaceEquipped: true, expectedConflictingItemId: incumbentA.body.id });
      expect(replay.status).toBe(200);
      expect(replay.body.qty).toBe(2);
    });

    it('prunes expired inventory_qty_idempotency rows on the next qty write (#782)', async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Oil flask', qty: 1 });
      const id = created.body.id as number;
      const key = 'oil-ttl-replay';

      const first = await request(server).patch(`/api/v1/inventory/${id}`).set(dm).send({ qtyDelta: 1, idempotencyKey: key });
      expect(first.status).toBe(200);
      expect(first.body.qty).toBe(2);

      // Age the idempotency row past the TTL window, then touch qty again — prune
      // runs inside the write tx, so the stale key is gone and a "retry" re-applies.
      const { DB } = await import('../src/db/db.module');
      const { inventoryQtyIdempotency } = await import('../src/db/schema');
      const { eq } = await import('drizzle-orm');
      const {
        INVENTORY_QTY_IDEMPOTENCY_TTL_MS,
      } = await import('../src/modules/inventory/inventory.service');
      const db = ctx.app.get(DB);
      const stale = new Date(Date.now() - INVENTORY_QTY_IDEMPOTENCY_TTL_MS - 60_000).toISOString();
      db.update(inventoryQtyIdempotency)
        .set({ createdAt: stale })
        .where(eq(inventoryQtyIdempotency.key, key))
        .run();

      const afterTtl = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(dm)
        .send({ qtyDelta: 1, idempotencyKey: key });
      expect(afterTtl.status).toBe(200);
      expect(afterTtl.body.qty).toBe(3);
    });

    it('absolute qty CAS: stale expectedUpdatedAt returns 409 with current item (#782)', async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Gem', qty: 1 });
      const id = created.body.id;
      const staleUpdatedAt = created.body.updatedAt;

      await new Promise((r) => setTimeout(r, 10));
      const mid = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(player)
        .send({ qtyDelta: 1, idempotencyKey: 'gem-mid-inc' });
      expect(mid.status).toBe(200);
      expect(mid.body.qty).toBe(2);

      const stale = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(dm)
        .send({ qty: 10, expectedUpdatedAt: staleUpdatedAt, idempotencyKey: 'gem-stale-set' });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('INVENTORY_QTY_CONFLICT');
      expect(stale.body.current).toMatchObject({ id, qty: 2 });

      const after = await request(server).get(`/api/v1/inventory/${id}`).set(dm);
      expect(after.body.qty).toBe(2);

      const ok = await request(server)
        .patch(`/api/v1/inventory/${id}`)
        .set(dm)
        .send({ qty: 10, expectedUpdatedAt: after.body.updatedAt, idempotencyKey: 'gem-reapply-set' });
      expect(ok.status).toBe(200);
      expect(ok.body.qty).toBe(10);
    });

    it('move and qtyDelta in one write both apply (#782)', async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Potion', qty: 3 });
      const res = await request(server)
        .patch(`/api/v1/inventory/${created.body.id}`)
        .set(player)
        .send({
          ownerType: 'character',
          characterId: ownCharacterId,
          qtyDelta: -1,
          idempotencyKey: 'move-and-drink',
        });
      expect(res.status).toBe(200);
      expect(res.body.ownerType).toBe('character');
      expect(res.body.characterId).toBe(ownCharacterId);
      expect(res.body.qty).toBe(2);
    });

    // ---- issue #551: soft-delete, restore, and audit snapshot ----

    it('soft-deletes an item to trash and excludes it from live lists (#551)', async () => {
      const server = ctx.app.getHttpServer();

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Glass bauble', qty: 7 });
      expect(created.status).toBe(201);
      const itemId = created.body.id;

      const deleteRes = await request(server).delete(`/api/v1/inventory/${itemId}`).set(player);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.deletedAt).toMatch(/^\d{4}-/);
      expect(deleteRes.body.deletedBy).toMatch(/p-1$/);
      expect(deleteRes.body.name).toBe('Glass bauble');

      const getRes = await request(server).get(`/api/v1/inventory/${itemId}`).set(dm);
      expect(getRes.status).toBe(404);

      const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/inventory`).set(dm);
      expect(listRes.body.some((i: { id: number }) => i.id === itemId)).toBe(false);

      const trashRes = await request(server).get(`/api/v1/campaigns/${campaignId}/inventory/trash`).set(dm);
      expect(trashRes.status).toBe(200);
      expect(trashRes.body.some((i: { id: number }) => i.id === itemId)).toBe(true);
    });

    it('restores a soft-deleted item to its original owner and clears the tombstone (#551)', async () => {
      const server = ctx.app.getHttpServer();

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Lucky coin', ownerType: 'character', characterId: ownCharacterId, qty: 1 });
      expect(created.status).toBe(201);
      const itemId = created.body.id;

      await request(server).delete(`/api/v1/inventory/${itemId}`).set(player);

      const restoreRes = await request(server).post(`/api/v1/inventory/${itemId}/restore`).set(dm);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.deletedAt).toBeNull();
      expect(restoreRes.body.deletedBy).toBeNull();
      expect(restoreRes.body.ownerType).toBe('character');
      expect(restoreRes.body.characterId).toBe(ownCharacterId);

      const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/inventory`).set(dm);
      expect(listRes.body.some((i: { id: number }) => i.id === itemId)).toBe(true);
    });

    it('restore falls back to party stash when the original character is gone (#551)', async () => {
      const server = ctx.app.getHttpServer();

      const tempChar = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Temp PC' });
      expect(tempChar.status).toBe(201);

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Borrowed shield', ownerType: 'character', characterId: tempChar.body.id });
      expect(created.status).toBe(201);
      const itemId = created.body.id;

      const deleteRes = await request(server).delete(`/api/v1/inventory/${itemId}`).set(dm);
      expect(deleteRes.status).toBe(200);

      const charDelete = await request(server).delete(`/api/v1/characters/${tempChar.body.id}`).set(dm);
      expect(charDelete.status).toBe(200);

      const restoreRes = await request(server).post(`/api/v1/inventory/${itemId}/restore`).set(dm);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.ownerType).toBe('party');
      expect(restoreRes.body.characterId).toBeNull();
    });

    it('records an immutable deletion snapshot in the audit log (#551)', async () => {
      const server = ctx.app.getHttpServer();

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Signed contract', qty: 3, notes: 'Do not lose' });
      const itemId = created.body.id;

      await request(server).delete(`/api/v1/inventory/${itemId}`).set(player);

      const auditRes = await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
      const deleteAudit = auditRes.body.find((e: { action: string; entityId: number }) => e.action === 'item.delete' && e.entityId === itemId);
      expect(deleteAudit).toBeDefined();
      const detail = JSON.parse(deleteAudit.detail);
      expect(detail.snapshot).toMatchObject({ name: 'Signed contract', qty: 3, notes: 'Do not lose' });
    });

    it('only dm, the deleting player, or the owning player may restore a character-owned item (#551)', async () => {
      const server = ctx.app.getHttpServer();

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Private journal', ownerType: 'character', characterId: ownCharacterId });
      const itemId = created.body.id;

      await request(server).delete(`/api/v1/inventory/${itemId}`).set(player);

      // another player cannot restore
      const otherRestore = await request(server).post(`/api/v1/inventory/${itemId}/restore`).set(otherPlayer);
      expect(otherRestore.status).toBe(403);

      // the owner may restore
      const ownerRestore = await request(server).post(`/api/v1/inventory/${itemId}/restore`).set(player);
      expect(ownerRestore.status).toBe(200);
    });

    it('idempotent restore: repeated restores still return the restored item (#551)', async () => {
      const server = ctx.app.getHttpServer();

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Pebble', qty: 1 });
      const itemId = created.body.id;

      await request(server).delete(`/api/v1/inventory/${itemId}`).set(dm);

      const first = await request(server).post(`/api/v1/inventory/${itemId}/restore`).set(dm);
      expect(first.status).toBe(200);

      const second = await request(server).post(`/api/v1/inventory/${itemId}/restore`).set(dm);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(itemId);
      expect(second.body.deletedAt).toBeNull();
      expect(second.body.deletedBy).toBeNull();
    });
  });

  describe('equip/unequip (issue #1326)', () => {
    it('round-trips: equip requires a slot, unequip clears it, state persists on GET', async () => {
      const server = ctx.app.getHttpServer();

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Longsword', ownerType: 'character', characterId: ownCharacterId });
      expect(created.body.equipped).toBe(false);
      expect(created.body.equipSlot).toBeNull();
      const itemId = created.body.id;

      // Equipping without a slot is rejected.
      const noSlot = await request(server).patch(`/api/v1/inventory/${itemId}`).set(player).send({ equipped: true });
      expect(noSlot.status).toBe(400);

      const equipRes = await request(server)
        .patch(`/api/v1/inventory/${itemId}`)
        .set(player)
        .send({ equipped: true, equipSlot: 'main-hand' });
      expect(equipRes.status).toBe(200);
      expect(equipRes.body.equipped).toBe(true);
      expect(equipRes.body.equipSlot).toBe('main-hand');

      const getRes = await request(server).get(`/api/v1/inventory/${itemId}`).set(player);
      expect(getRes.body.equipped).toBe(true);
      expect(getRes.body.equipSlot).toBe('main-hand');

      const unequipRes = await request(server).patch(`/api/v1/inventory/${itemId}`).set(player).send({ equipped: false });
      expect(unequipRes.status).toBe(200);
      expect(unequipRes.body.equipped).toBe(false);
      // Unequipping clears the slot rather than leaving a stale value behind.
      expect(unequipRes.body.equipSlot).toBeNull();
    });

    it('only the dm or the owning player may equip a character\'s item; a party-stash item cannot be equipped', async () => {
      const server = ctx.app.getHttpServer();

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Shield', ownerType: 'character', characterId: ownCharacterId });
      const itemId = created.body.id;

      const otherEquip = await request(server)
        .patch(`/api/v1/inventory/${itemId}`)
        .set(otherPlayer)
        .send({ equipped: true, equipSlot: 'off-hand' });
      expect(otherEquip.status).toBe(403);

      const dmEquip = await request(server)
        .patch(`/api/v1/inventory/${itemId}`)
        .set(dm)
        .send({ equipped: true, equipSlot: 'off-hand' });
      expect(dmEquip.status).toBe(200);
      expect(dmEquip.body.equipped).toBe(true);

      const partyItem = await request(server).post(`/api/v1/campaigns/${campaignId}/inventory`).set(dm).send({ name: 'Rope' });
      const partyEquip = await request(server)
        .patch(`/api/v1/inventory/${partyItem.body.id}`)
        .set(dm)
        .send({ equipped: true, equipSlot: 'worn' });
      expect(partyEquip.status).toBe(400);
    });

    it('rejects a second item equipped into an already-occupied slot on the same character (409)', async () => {
      const server = ctx.app.getHttpServer();

      const sword = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Rapier', ownerType: 'character', characterId: ownCharacterId });
      const dagger = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Dagger', ownerType: 'character', characterId: ownCharacterId });

      const first = await request(server)
        .patch(`/api/v1/inventory/${sword.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: 'main-hand' });
      expect(first.status).toBe(200);

      const conflict = await request(server)
        .patch(`/api/v1/inventory/${dagger.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: 'main-hand' });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('INVENTORY_SLOT_CONFLICT');
      // Issue #1901: the incumbent's id/name + the contested slot ride along so the web
      // one-tap swap can unequip the incumbent and retry without parsing the message string.
      expect(conflict.body.conflictingItemId).toBe(sword.body.id);
      expect(conflict.body.conflictingItemName).toBe('Rapier');
      expect(conflict.body.equipSlot).toBe('main-hand');

      // Unequipping the incumbent frees the slot for the second item.
      const freed = await request(server).patch(`/api/v1/inventory/${sword.body.id}`).set(player).send({ equipped: false });
      expect(freed.status).toBe(200);
      const retry = await request(server)
        .patch(`/api/v1/inventory/${dagger.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: 'main-hand' });
      expect(retry.status).toBe(200);
    });

    it('issue #1901 rework: displaceEquipped resolves a slot conflict atomically — one request, no half-applied state', async () => {
      const server = ctx.app.getHttpServer();

      // Unique slot string (see the "review fix" test above): this describe block shares
      // ownCharacterId across earlier tests in this file and never unequips between them,
      // so a common name like 'main-hand' would collide with THEIR leftover equipped item
      // (the prior 409-conflict test above leaves 'main-hand' occupied) rather than
      // exercising a clean slot conflict for THIS test.
      const slot = 'atomic-swap-slot-1901';
      const sword = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Rapier', ownerType: 'character', characterId: ownCharacterId });
      const dagger = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Dagger', ownerType: 'character', characterId: ownCharacterId });

      const first = await request(server)
        .patch(`/api/v1/inventory/${sword.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: slot });
      expect(first.status).toBe(200);

      // Without displaceEquipped, still a plain 409 (existing behavior unchanged).
      const stillConflicts = await request(server)
        .patch(`/api/v1/inventory/${dagger.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: slot });
      expect(stillConflicts.status).toBe(409);

      // ONE request, with displaceEquipped: true, atomically unequips the incumbent and
      // equips the new item — no separate unequip PATCH, no window where neither item
      // (or, on a client retry bug, both items) is equipped.
      const swap = await request(server)
        .patch(`/api/v1/inventory/${dagger.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: slot, displaceEquipped: true });
      expect(swap.status).toBe(200);
      expect(swap.body.equipped).toBe(true);
      expect(swap.body.equipSlot).toBe(slot);

      const incumbentAfter = await request(server).get(`/api/v1/inventory/${sword.body.id}`).set(player);
      expect(incumbentAfter.body.equipped).toBe(false);
      expect(incumbentAfter.body.equipSlot).toBeNull();

      // Exactly one item holds the slot afterward.
      const list = await request(server).get(`/api/v1/campaigns/${campaignId}/inventory`).set(player);
      const inSlot = (list.body as Array<{ id: number; equipped: boolean; equipSlot: string | null }>).filter(
        (it) => (it.id === sword.body.id || it.id === dagger.body.id) && it.equipped && it.equipSlot === slot,
      );
      expect(inSlot).toHaveLength(1);
      expect(inSlot[0].id).toBe(dagger.body.id);
    });

    it('issue #1901 rework: displaceEquipped is a no-op flag when there is no conflict', async () => {
      const server = ctx.app.getHttpServer();

      // Unique slot string — see the note in the atomic-swap test above.
      const slot = 'no-conflict-slot-1901';
      const item = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Buckler', ownerType: 'character', characterId: ownCharacterId });

      const res = await request(server)
        .patch(`/api/v1/inventory/${item.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: slot, displaceEquipped: true });
      expect(res.status).toBe(200);
      expect(res.body.equipped).toBe(true);
      expect(res.body.equipSlot).toBe(slot);
    });

    // Issue #1901 review (chatgpt-codex-connector P2): the web one-tap swap shows "Replace
    // <incumbent>" naming the item from an earlier 409, then re-sends the same slot with
    // displaceEquipped: true. If a DIFFERENT client unequips that named incumbent and equips a
    // third item into the same slot before the swap lands, the swap must reject — not silently
    // displace the third item under a confirmation that named someone else.
    it('issue #1901 review (chatgpt-codex-connector P2): expectedConflictingItemId rejects a swap once the confirmed incumbent no longer holds the slot', async () => {
      const server = ctx.app.getHttpServer();

      const slot = 'cas-swap-slot-1901';
      const swordA = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Sword A', ownerType: 'character', characterId: ownCharacterId });
      const swordB = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Sword B', ownerType: 'character', characterId: ownCharacterId });
      const swordC = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Sword C', ownerType: 'character', characterId: ownCharacterId });

      // Sword A holds the slot; confirm the 409 names it as the incumbent.
      await request(server).patch(`/api/v1/inventory/${swordA.body.id}`).set(player).send({ equipped: true, equipSlot: slot });
      const conflict = await request(server)
        .patch(`/api/v1/inventory/${swordB.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: slot });
      expect(conflict.status).toBe(409);
      expect(conflict.body.conflictingItemId).toBe(swordA.body.id);

      // Another client races ahead: unequips Sword A, equips Sword C into the same slot.
      await request(server).patch(`/api/v1/inventory/${swordA.body.id}`).set(player).send({ equipped: false });
      await request(server)
        .patch(`/api/v1/inventory/${swordC.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: slot });

      // The stale confirmation (still naming Sword A) must be rejected with a FRESH 409
      // naming Sword C — not silently displace Sword C under a confirmation for Sword A.
      const staleSwap = await request(server)
        .patch(`/api/v1/inventory/${swordB.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: slot, displaceEquipped: true, expectedConflictingItemId: swordA.body.id });
      expect(staleSwap.status).toBe(409);
      expect(staleSwap.body.conflictingItemId).toBe(swordC.body.id);

      const cUntouched = await request(server).get(`/api/v1/inventory/${swordC.body.id}`).set(player);
      expect(cUntouched.body.equipped).toBe(true);
      expect(cUntouched.body.equipSlot).toBe(slot);

      // Re-confirming against the FRESH incumbent succeeds and displaces Sword C, not A.
      const freshSwap = await request(server)
        .patch(`/api/v1/inventory/${swordB.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: slot, displaceEquipped: true, expectedConflictingItemId: swordC.body.id });
      expect(freshSwap.status).toBe(200);
      const cAfter = await request(server).get(`/api/v1/inventory/${swordC.body.id}`).set(player);
      expect(cAfter.body.equipped).toBe(false);
    });

    it('moving an equipped character item to the party stash auto-unequips it', async () => {
      const server = ctx.app.getHttpServer();

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Cloak', ownerType: 'character', characterId: ownCharacterId });
      await request(server)
        .patch(`/api/v1/inventory/${created.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: 'worn', equippedAction: { name: 'Cloak Flourish', kind: 'feature', toHit: '', damage: '', notes: '' } });

      const moved = await request(server)
        .patch(`/api/v1/inventory/${created.body.id}`)
        .set(player)
        .send({ ownerType: 'party', characterId: null });
      expect(moved.status).toBe(200);
      expect(moved.body.equipped).toBe(false);
      expect(moved.body.equipSlot).toBeNull();
      // Coordinator review: the granted action does not silently survive the move to
      // the (unredacted) party stash either — it would otherwise become visible to
      // every campaign member the moment ownership changes.
      expect(moved.body.equippedAction).toBeNull();
    });

    it('moving an equipped item to a DIFFERENT character auto-unequips it rather than arming the recipient or 409ing on their slots (review fix)', async () => {
      const server = ctx.app.getHttpServer();

      // Unique slot strings throughout: this describe block shares ownCharacterId/
      // dmCharacterId (and never unequips) across earlier tests in this file, so
      // reusing a common name like 'main-hand' here would collide with THEIR leftover
      // equipped items rather than exercising the scenario this test targets.
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Handed-down sword', ownerType: 'character', characterId: ownCharacterId });
      const sourceEquip = await request(server)
        .patch(`/api/v1/inventory/${created.body.id}`)
        .set(player)
        .send({
          equipped: true,
          equipSlot: 'review-move-slot',
          equippedAction: { name: 'Handed-down Slash', kind: 'melee', toHit: '+5', damage: '1d8+3', notes: '' },
        });
      expect(sourceEquip.status).toBe(200);

      // The recipient (dmCharacterId) already has something equipped in the same slot
      // string — a plain move (no equip requested) must NOT be rejected as a slot
      // conflict, because the caller never asked to equip anything for the recipient.
      const recipientIncumbent = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Recipient shield', ownerType: 'character', characterId: dmCharacterId });
      const recipientEquip = await request(server)
        .patch(`/api/v1/inventory/${recipientIncumbent.body.id}`)
        .set(dm)
        .send({ equipped: true, equipSlot: 'review-move-slot' });
      expect(recipientEquip.status).toBe(200);

      const moved = await request(server)
        .patch(`/api/v1/inventory/${created.body.id}`)
        .set(dm)
        .send({ ownerType: 'character', characterId: dmCharacterId });
      expect(moved.status).toBe(200);
      // Not silently armed on the new owner...
      expect(moved.body.equipped).toBe(false);
      expect(moved.body.equipSlot).toBeNull();
      // ...and its granted action does not silently follow it either (coordinator
      // review): a new owner never chose this attack, so it must not carry over.
      expect(moved.body.equippedAction).toBeNull();

      // ...and the recipient's own equipped item is untouched.
      const recipientCheck = await request(server).get(`/api/v1/inventory/${recipientIncumbent.body.id}`).set(dm);
      expect(recipientCheck.body.equipped).toBe(true);
      expect(recipientCheck.body.equipSlot).toBe('review-move-slot');
    });

    it('a move + explicit equip in the SAME request is honored against the new owner\'s slots', async () => {
      const server = ctx.app.getHttpServer();

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Gifted dagger', ownerType: 'character', characterId: ownCharacterId });

      const moveAndEquip = await request(server)
        .patch(`/api/v1/inventory/${created.body.id}`)
        .set(dm)
        .send({ ownerType: 'character', characterId: dmCharacterId, equipped: true, equipSlot: 'review-move-and-equip-slot' });
      expect(moveAndEquip.status).toBe(200);
      expect(moveAndEquip.body.characterId).toBe(dmCharacterId);
      expect(moveAndEquip.body.equipped).toBe(true);
      expect(moveAndEquip.body.equipSlot).toBe('review-move-and-equip-slot');
    });

    it('reusing an idempotencyKey with the same qtyDelta but a different equip payload is rejected, not silently replayed (review fix)', async () => {
      const server = ctx.app.getHttpServer();

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Charged wand', ownerType: 'character', characterId: ownCharacterId, qty: 3 });

      const first = await request(server)
        .patch(`/api/v1/inventory/${created.body.id}`)
        .set(player)
        .send({ qtyDelta: -1, idempotencyKey: 'wand-use-and-equip', equipped: true, equipSlot: 'review-idempotency-slot' });
      expect(first.status).toBe(200);
      expect(first.body.equipped).toBe(true);

      // Same key, same qtyDelta, but a DIFFERENT equip instruction — must 409, not replay.
      const reused = await request(server)
        .patch(`/api/v1/inventory/${created.body.id}`)
        .set(player)
        .send({ qtyDelta: -1, idempotencyKey: 'wand-use-and-equip', equipped: false });
      expect(reused.status).toBe(409);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSE');

      // The original equip from the first call is still intact — the reuse attempt
      // neither replayed silently nor mutated the item.
      const getRes = await request(server).get(`/api/v1/inventory/${created.body.id}`).set(player);
      expect(getRes.body.equipped).toBe(true);
      expect(getRes.body.qty).toBe(2);
    });

    it('a qty-only idempotency retry spanning the #1326 upgrade still replays rather than 409ing (review fix)', async () => {
      const server = ctx.app.getHttpServer();

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Pre-upgrade potion', qty: 5 });
      const id = created.body.id as number;
      const key = 'pre-upgrade-qty-retry';

      // Simulate a row persisted by the PRE-#1326 binary: its qtyFingerprint never
      // had the equip keys at all (they didn't exist yet), and its stored response
      // carries no equip fields either.
      const { DB } = await import('../src/db/db.module');
      const { inventoryQtyIdempotency } = await import('../src/db/schema');
      const db = ctx.app.get(DB);
      const preUpgradeResponse = { ...created.body, qty: 4 };
      const legacyFingerprint = 'delta:-1|{"name":null,"notes":null,"iconSlug":null,"ownerType":null,"characterId":null}';
      db.insert(inventoryQtyIdempotency)
        .values({
          key,
          itemId: id,
          userId: 'dev:dm-1',
          fingerprint: legacyFingerprint,
          responseJson: JSON.stringify(preUpgradeResponse),
          createdAt: new Date().toISOString(),
        })
        .run();

      // The identical qty-only request, retried on the now-upgraded binary, must
      // replay the pre-upgrade response — not 409 IDEMPOTENCY_KEY_REUSE just because
      // the fingerprint format grew new (unused-here) equip fields.
      const retry = await request(server).patch(`/api/v1/inventory/${id}`).set(dm).send({ qtyDelta: -1, idempotencyKey: key });
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(preUpgradeResponse);
    });

    it('trashing an equipped item clears its equip state, so restoring it never resurrects a slot conflict (review fix)', async () => {
      const server = ctx.app.getHttpServer();

      const original = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Old shield', ownerType: 'character', characterId: ownCharacterId });
      const originalEquip = await request(server)
        .patch(`/api/v1/inventory/${original.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: 'review-trash-restore-slot' });
      expect(originalEquip.status).toBe(200);

      const deleteRes = await request(server).delete(`/api/v1/inventory/${original.body.id}`).set(player);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.equipped).toBe(false);
      expect(deleteRes.body.equipSlot).toBeNull();

      // A replacement now claims the same slot while the original sits in the trash.
      const replacement = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'New shield', ownerType: 'character', characterId: ownCharacterId });
      const equipReplacement = await request(server)
        .patch(`/api/v1/inventory/${replacement.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: 'review-trash-restore-slot' });
      expect(equipReplacement.status).toBe(200);

      // Restoring the original does NOT resurrect a two-items-one-slot conflict — it
      // comes back unequipped, because remove() already cleared its equip state.
      const restoreRes = await request(server).post(`/api/v1/inventory/${original.body.id}/restore`).set(player);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.equipped).toBe(false);
      expect(restoreRes.body.equipSlot).toBeNull();

      // The replacement remains equipped in that slot, undisturbed.
      const replacementCheck = await request(server).get(`/api/v1/inventory/${replacement.body.id}`).set(player);
      expect(replacementCheck.body.equipped).toBe(true);
      expect(replacementCheck.body.equipSlot).toBe('review-trash-restore-slot');
    });

    it('redacts equippedAction from a non-owner, non-dm read on the SERIALISED payload — not just the type (review fix)', async () => {
      const server = ctx.app.getHttpServer();

      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Secret Blade', ownerType: 'character', characterId: ownCharacterId });
      const grantedAction = { name: 'Hidden Strike', kind: 'melee', toHit: '+9', damage: '3d6+9 necrotic', notes: 'A distinctive telltale phrase.' };
      const equipRes = await request(server)
        .patch(`/api/v1/inventory/${created.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: 'review-redaction-slot', equippedAction: grantedAction });
      expect(equipRes.status).toBe(200);
      expect(equipRes.body.equippedAction).toMatchObject(grantedAction);

      // The DM sees the full action — both via GET and the campaign list.
      const dmGet = await request(server).get(`/api/v1/inventory/${created.body.id}`).set(dm);
      expect(dmGet.body.equippedAction).toMatchObject(grantedAction);
      const dmList = await request(server).get(`/api/v1/campaigns/${campaignId}/inventory`).set(dm);
      expect(dmList.body.find((i: { id: number }) => i.id === created.body.id).equippedAction).toMatchObject(grantedAction);

      // The owning player sees it too.
      const ownerGet = await request(server).get(`/api/v1/inventory/${created.body.id}`).set(player);
      expect(ownerGet.body.equippedAction).toMatchObject(grantedAction);

      // A DIFFERENT player gets equippedAction: null — assert on the raw response TEXT
      // (the serialised payload a TypeScript `Omit` could still leak at runtime), not
      // merely the parsed field, per the review's explicit ask.
      const otherGet = await request(server).get(`/api/v1/inventory/${created.body.id}`).set(otherPlayer);
      expect(otherGet.status).toBe(200);
      expect(otherGet.body.equippedAction).toBeNull();
      expect(otherGet.text).not.toContain('Hidden Strike');
      expect(otherGet.text).not.toContain('A distinctive telltale phrase');

      const otherList = await request(server).get(`/api/v1/campaigns/${campaignId}/inventory`).set(otherPlayer);
      expect(otherList.status).toBe(200);
      expect(otherList.body.find((i: { id: number }) => i.id === created.body.id).equippedAction).toBeNull();
      expect(otherList.text).not.toContain('Hidden Strike');
      expect(otherList.text).not.toContain('A distinctive telltale phrase');

      // A viewer (not even a player) also gets it redacted.
      const viewerGet = await request(server).get(`/api/v1/inventory/${created.body.id}`).set(viewer);
      expect(viewerGet.body.equippedAction).toBeNull();
      expect(viewerGet.text).not.toContain('Hidden Strike');

      // Non-secret fields (name/qty/equipped/equipSlot) remain visible to everyone —
      // only equippedAction carries the sheet-action secrecy precedent.
      expect(otherGet.body.name).toBe('Secret Blade');
      expect(otherGet.body.equipped).toBe(true);
      expect(otherGet.body.equipSlot).toBe('review-redaction-slot');
    });

    it('trashing and restoring a character item preserves equippedAction while clearing equipped/equipSlot (review fix)', async () => {
      const server = ctx.app.getHttpServer();

      const grantedAction = { name: 'Trashed Strike', kind: 'melee', toHit: '+7', damage: '2d6+5', notes: '' };
      const original = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Keepsake blade', ownerType: 'character', characterId: ownCharacterId });
      await request(server)
        .patch(`/api/v1/inventory/${original.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: 'review-trash-preserve-slot', equippedAction: grantedAction });

      const deleteRes = await request(server).delete(`/api/v1/inventory/${original.body.id}`).set(player);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.equipped).toBe(false);
      expect(deleteRes.body.equipSlot).toBeNull();
      expect(deleteRes.body.equippedAction).toMatchObject(grantedAction);

      const restoreRes = await request(server).post(`/api/v1/inventory/${original.body.id}/restore`).set(player);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.equipped).toBe(false);
      expect(restoreRes.body.equipSlot).toBeNull();
      expect(restoreRes.body.equippedAction).toMatchObject(grantedAction);
    });

    it('restoring a trashed item to the party stash clears equippedAction (review fix)', async () => {
      const server = ctx.app.getHttpServer();

      const tempChar = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Temp departee' });
      expect(tempChar.status).toBe(201);

      const grantedAction = { name: 'Lost Strike', kind: 'melee', toHit: '+7', damage: '2d6+5', notes: '' };
      const original = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(dm)
        .send({ name: 'Departing blade', ownerType: 'character', characterId: tempChar.body.id });
      await request(server)
        .patch(`/api/v1/inventory/${original.body.id}`)
        .set(dm)
        .send({ equipped: true, equipSlot: 'review-restore-party-slot', equippedAction: grantedAction });

      await request(server).delete(`/api/v1/inventory/${original.body.id}`).set(dm);
      await request(server).delete(`/api/v1/characters/${tempChar.body.id}`).set(dm);

      const restoreRes = await request(server).post(`/api/v1/inventory/${original.body.id}/restore`).set(dm);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.ownerType).toBe('party');
      expect(restoreRes.body.equipped).toBe(false);
      expect(restoreRes.body.equipSlot).toBeNull();
      expect(restoreRes.body.equippedAction).toBeNull();
    });

    it('reject patching equippedAction onto a party-stash item (review fix)', async () => {
      const server = ctx.app.getHttpServer();

      const partyItem = await request(server).post(`/api/v1/campaigns/${campaignId}/inventory`).set(dm).send({ name: 'Stash scroll' });
      const action = { name: 'Stash Strike', kind: 'melee', toHit: '+5', damage: '1d8', notes: '' };
      const patchRes = await request(server)
        .patch(`/api/v1/inventory/${partyItem.body.id}`)
        .set(dm)
        .send({ equippedAction: action });
      expect(patchRes.status).toBe(400);
      expect(patchRes.body.message).toContain('Only character-owned items may carry an equipped action');
    });

    it('moving an item to the party stash with equippedAction: null succeeds (review fix)', async () => {
      const server = ctx.app.getHttpServer();

      const action = { name: 'Departing Strike', kind: 'melee', toHit: '+6', damage: '1d10+2', notes: '' };
      const original = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/inventory`)
        .set(player)
        .send({ name: 'Departing blade', ownerType: 'character', characterId: ownCharacterId });
      await request(server)
        .patch(`/api/v1/inventory/${original.body.id}`)
        .set(player)
        .send({ equipped: true, equipSlot: 'departing-slot', equippedAction: action });

      const moveRes = await request(server)
        .patch(`/api/v1/inventory/${original.body.id}`)
        .set(player)
        .send({ ownerType: 'party', characterId: null, equippedAction: null });
      expect(moveRes.status).toBe(200);
      expect(moveRes.body.ownerType).toBe('party');
      expect(moveRes.body.equipped).toBe(false);
      expect(moveRes.body.equipSlot).toBeNull();
      expect(moveRes.body.equippedAction).toBeNull();
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
      const base = (await request(server).get(`/api/v1/campaigns/${campaignId}/treasury`).set(dm)).body;
      const res = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}/treasury`)
        .set(dm)
        .send({ set: { pp: 5, gp: 42 }, expectedUpdatedAt: base.updatedAt });
      expect(res.status).toBe(200);
      expect(res.body.pp).toBe(5);
      expect(res.body.gp).toBe(42);
      expect(res.body.sp).toBe(20); // untouched from the previous test

      // negative absolute value fails schema validation
      const negRes = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}/treasury`)
        .set(dm)
        .send({ set: { gp: -1 }, expectedUpdatedAt: res.body.updatedAt });
      expect(negRes.status).toBe(400);
    });

    it('an absolute { set } without expectedUpdatedAt is rejected (issue #582 — CAS required)', async () => {
      // A stale form sending an absolute set without the CAS token could still
      // clobber a concurrent spend — the exact data-loss this PR closes. The
      // server now enforces the acceptance criterion "require expectedUpdatedAt
      // for absolute reconciliation". Use { delta } for add/spend (atomic, no
      // CAS needed) or supply expectedUpdatedAt to reconcile.
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}/treasury`)
        .set(dm)
        .send({ set: { gp: 1 } });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/expectedUpdatedAt/i);
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
      const base = (await request(server).get(`/api/v1/campaigns/${campaignId}/treasury`).set(dm)).body;
      const res = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}/treasury`)
        .set(dm)
        .send({ set: { sp: 9 }, expectedUpdatedAt: base.updatedAt });
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

      // gp 0 -> 50 (delta), then gp 50 -> 50/pp 0 -> 1 (set with CAS), then gp 50 -> 40 (spend).
      await request(server).patch(`/api/v1/campaigns/${camp}/treasury`).set(player).send({ delta: { gp: 50 } });
      const beforeSet = (await request(server).get(`/api/v1/campaigns/${camp}/treasury`).set(dm)).body;
      await request(server).patch(`/api/v1/campaigns/${camp}/treasury`).set(dm).send({ set: { pp: 1 }, expectedUpdatedAt: beforeSet.updatedAt });
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
