import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'clear-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'clear-p1' };

/**
 * Issue #1326 review (coordinator) — THE single rule this file enumerates and proves for
 * every write path that can change which character (if any) owns an inventory item:
 *
 *   When an item ceases to be owned by a character, `equipped`, `equipSlot`, and
 *   `equippedAction` are all cleared together — atomically, on every path that can
 *   change ownership.
 *
 * Three separate earlier review rounds on this PR each found a DIFFERENT path clearing
 * only equipped/equipSlot and leaving equippedAction behind (bulk move_inventory_owner,
 * clone/import's party fallback, and InventoryService.update()'s own move branch) — an
 * "unworn but pre-armed" state normal play can never produce, and (because
 * `equippedAction` visibility is keyed to `ownerType === 'character'`) also a state where
 * a previously-private character action silently becomes readable the moment ownership
 * changes. Rather than trust another one-off fix, this suite enumerates every
 * owner-changing path in ONE place and asserts each clears the FULL triple, so a sixth
 * path added later fails HERE instead of shipping a fourth recurrence of the same bug.
 *
 * Enumerated paths:
 *  1. InventoryService.update() — party move
 *  2. InventoryService.update() — character-to-character move
 *  3. Bulk move_inventory_owner (CampaignLibraryService)
 *  4. Bulk move_inventory_owner undo, when a conflict prevents restoring (the state must
 *     stay fully cleared, not half-restored)
 *  5. Campaign clone — party fallback (source character not copied)
 *  6. Campaign import — party fallback (dangling characterId)
 */
describe('inventory equip-state ownership-change clearing (issue #1326 review, enumerated)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let sourceCharId: number;
  let recipientCharId: number;

  const grantedAction = { name: 'Enumerated Slash', kind: 'melee', toHit: '+5', damage: '1d8+3 slashing', notes: '' };

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Clearing Enumeration' });
    campaignId = campRes.body.id;
    const src = await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Enum Source' });
    sourceCharId = src.body.id;
    const rec = await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Enum Recipient' });
    recipientCharId = rec.body.id;
  });
  afterAll(async () => closeTestApp(ctx));

  async function equippedItem(server: ReturnType<TestAppContext['app']['getHttpServer']>, name: string, characterId: number, slot: string) {
    const created = await request(server).post(`/api/v1/campaigns/${campaignId}/inventory`).set(dm).send({ name, ownerType: 'character', characterId });
    const equipRes = await request(server)
      .patch(`/api/v1/inventory/${created.body.id}`)
      .set(dm)
      .send({ equipped: true, equipSlot: slot, equippedAction: grantedAction });
    expect(equipRes.status).toBe(200);
    expect(equipRes.body.equipped).toBe(true);
    expect(equipRes.body.equippedAction).toMatchObject(grantedAction);
    return created.body.id as number;
  }

  function expectFullyCleared(item: { equipped: boolean; equipSlot: string | null; equippedAction: unknown }) {
    expect(item.equipped).toBe(false);
    expect(item.equipSlot).toBeNull();
    expect(item.equippedAction).toBeNull();
  }

  it('1. InventoryService.update() — moving an equipped item to the party stash clears the full triple', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await equippedItem(server, 'Path1 Item', sourceCharId, 'path1-slot');
    const moved = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ ownerType: 'party', characterId: null });
    expect(moved.status).toBe(200);
    expectFullyCleared(moved.body);
  });

  it('2. InventoryService.update() — moving an equipped item to a DIFFERENT character clears the full triple', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await equippedItem(server, 'Path2 Item', sourceCharId, 'path2-slot');
    const moved = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ ownerType: 'character', characterId: recipientCharId });
    expect(moved.status).toBe(200);
    expectFullyCleared(moved.body);
  });

  it('3. Bulk move_inventory_owner (CampaignLibraryService) clears the full triple', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await equippedItem(server, 'Path3 Item', sourceCharId, 'path3-slot');
    const bulk = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/library/bulk`)
      .set(dm)
      .send({ operation: 'move_inventory_owner', ownerType: 'party', targets: [{ entityType: 'inventory_item', entityId: itemId }] });
    expect(bulk.status).toBe(201);
    const after = await request(server).get(`/api/v1/inventory/${itemId}`).set(dm);
    expectFullyCleared(after.body);
  });

  it('4. Bulk move_inventory_owner undo — when a slot conflict blocks restoration, the item stays fully cleared (never half-restored)', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await equippedItem(server, 'Path4 Item', sourceCharId, 'path4-slot');
    const bulk = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/library/bulk`)
      .set(dm)
      .send({ operation: 'move_inventory_owner', ownerType: 'party', targets: [{ entityType: 'inventory_item', entityId: itemId }] });
    expect(bulk.status).toBe(201);

    // Something else now claims the vacated slot on the source character.
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/inventory`)
      .set(dm)
      .send({ name: 'Path4 Interloper', ownerType: 'character', characterId: sourceCharId })
      .then((res) => request(server).patch(`/api/v1/inventory/${res.body.id}`).set(dm).send({ equipped: true, equipSlot: 'path4-slot' }));

    const undone = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${bulk.body.operationId}/undo`).set(dm);
    expect(undone.status).toBe(409);
    const after = await request(server).get(`/api/v1/inventory/${itemId}`).set(dm);
    expectFullyCleared(after.body);
  });

  it('5. Campaign clone — an item whose character was trashed (party fallback) clears the full triple', async () => {
    const server = ctx.app.getHttpServer();
    const doomed = await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Path5 Doomed' });
    await equippedItem(server, 'Path5 Item', doomed.body.id, 'path5-slot');
    const del = await request(server).delete(`/api/v1/characters/${doomed.body.id}`).set(dm);
    expect(del.status).toBe(200);

    const cloneRes = await request(server).post(`/api/v1/campaigns/${campaignId}/clone`).set(dm).send({ name: 'Path5 Clone' });
    expect(cloneRes.status).toBe(201);
    const inv = await request(server).get(`/api/v1/campaigns/${cloneRes.body.id}/inventory`).set(dm);
    const cloned = inv.body.find((i: { name: string }) => i.name === 'Path5 Item');
    expect(cloned).toBeDefined();
    expect(cloned.ownerType).toBe('party');
    expectFullyCleared(cloned);
  });

  it('6. Campaign import — a dangling characterId (party fallback) clears the full triple', async () => {
    const server = ctx.app.getHttpServer();
    const doc = {
      campaign: {
        name: 'Path6 Import',
        ruleSystem: '',
        dmControlsProgression: false,
        dmControlsTurns: false,
        requireDmTurnConfirmation: false,
        publicRecapSharingEnabled: true,
        catalogPrivacy: 'private',
        aiExternalContentPolicy: 'blocked',
        narrationLanguage: 'en',
        status: 'active',
      },
      inventory: [
        {
          id: 9101,
          ownerType: 'character',
          characterId: 99999, // no matching entry in `characters` — dangling
          name: 'Path6 Item',
          qty: 1,
          equipped: true,
          equipSlot: 'path6-slot',
          equippedAction: grantedAction,
        },
      ],
    };
    const res = await request(server).post('/api/v1/campaigns/import').set(dm).send(doc);
    expect(res.status).toBe(201);
    const inv = await request(server).get(`/api/v1/campaigns/${res.body.id}/inventory`).set(dm);
    const imported = inv.body.find((i: { name: string }) => i.name === 'Path6 Item');
    expect(imported).toBeDefined();
    expect(imported.ownerType).toBe('party');
    expectFullyCleared(imported);
  });

  it('sanity: the same PATCH-based equip round trip works and a non-owner move-away is redaction-safe (equippedAction never leaks after a move)', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await equippedItem(server, 'Sanity Item', sourceCharId, 'sanity-slot');
    const moved = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ ownerType: 'party', characterId: null });
    expect(moved.status).toBe(200);
    // Any campaign member (including a non-owner) reading the now-party item sees no
    // trace of the formerly-private granted action — confirmed on the raw response TEXT,
    // not just the parsed field.
    const otherRead = await request(server).get(`/api/v1/inventory/${itemId}`).set(player);
    expect(otherRead.status).toBe(200);
    expect(otherRead.body.equippedAction).toBeNull();
    expect(otherRead.text).not.toContain('Enumerated Slash');
  });
});
