import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { closeTestApp, createTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { auditLog, campaignLibraryBulkOperations, campaignLibraryEntityTaxonomy, campaignLibraryMonsters, campaigns, characters, inventoryItems, locations, npcs, quests } from '../src/db/schema';

describe('campaign library taxonomy (issue #742)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'library-dm' };
  const player = { 'x-dev-role': 'player', 'x-dev-user': 'library-player' };

  beforeAll(async () => {
    ctx = await createTestApp();
    const response = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name: 'Taxonomy' });
    expect(response.status).toBe(201);
    campaignId = response.body.id;
  });
  afterAll(async () => closeTestApp(ctx));

  it('persists aliases, color, description and safely re-roots/de-references deleted tags', async () => {
    const server = ctx.app.getHttpServer();
    const parent = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'People', aliases: ['NPCs'], color: '#123abc', description: 'Characters' });
    expect(parent.status).toBe(201);
    expect(parent.body).toMatchObject({ aliases: ['NPCs'], color: '#123abc', description: 'Characters', parentTagId: null });
    const child = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Villains', parentTagId: parent.body.id });
    expect(child.status).toBe(201);
    const cycle = await request(server).patch(`/api/v1/campaigns/${campaignId}/library/tags/${parent.body.id}`).set(dm).send({ parentTagId: child.body.id });
    expect(cycle.status).toBe(400);
    const db = ctx.app.get<DrizzleDb>(DB);
    await db.insert(campaignLibraryEntityTaxonomy).values({ campaignId, entityType: 'npc', entityId: 999, tagId: parent.body.id, collectionId: null, createdAt: new Date().toISOString() });
    expect((await request(server).delete(`/api/v1/campaigns/${campaignId}/library/tags/${parent.body.id}`).set(dm)).status).toBe(200);
    const tags = await request(server).get(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm);
    expect(tags.body).toEqual([expect.objectContaining({ id: child.body.id, parentTagId: null })]);
    expect(await db.select().from(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.tagId, parent.body.id)))).toEqual([]);
  });

  it('returns 409 for duplicate tag and collection names on create and rename', async () => {
    const server = ctx.app.getHttpServer();
    const tag = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Unique tag' });
    expect(tag.status).toBe(201);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Unique tag' })).status).toBe(409);
    const otherTag = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Other tag' });
    expect((await request(server).patch(`/api/v1/campaigns/${campaignId}/library/tags/${otherTag.body.id}`).set(dm).send({ name: 'Unique tag' })).status).toBe(409);
    const collection = await request(server).post(`/api/v1/campaigns/${campaignId}/library/collections`).set(dm).send({ name: 'Unique collection' });
    expect(collection.status).toBe(201);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/collections`).set(dm).send({ name: 'Unique collection' })).status).toBe(409);
    const otherCollection = await request(server).post(`/api/v1/campaigns/${campaignId}/library/collections`).set(dm).send({ name: 'Other collection' });
    expect((await request(server).patch(`/api/v1/campaigns/${campaignId}/library/collections/${otherCollection.body.id}`).set(dm).send({ name: 'Unique collection' })).status).toBe(409);
  });

  it('enforces campaign scope and DM writes for collection lifecycle', async () => {
    const server = ctx.app.getHttpServer();
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/collections`).set(player).send({ name: 'Secret' })).status).toBe(403);
    const parent = await request(server).post(`/api/v1/campaigns/${campaignId}/library/collections`).set(dm).send({ name: 'Act One' });
    const child = await request(server).post(`/api/v1/campaigns/${campaignId}/library/collections`).set(dm).send({ name: 'Scene', parentCollectionId: parent.body.id });
    const patched = await request(server).patch(`/api/v1/campaigns/${campaignId}/library/collections/${child.body.id}`).set(dm).send({ aliases: ['Intro'], color: '#abcdef', description: 'Opening scene' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ aliases: ['Intro'], color: '#abcdef', description: 'Opening scene' });
    expect((await request(server).delete(`/api/v1/campaigns/${campaignId}/library/collections/${parent.body.id}`).set(dm)).status).toBe(200);
    const collections = await request(server).get(`/api/v1/campaigns/${campaignId}/library/collections`).set(dm);
    expect(collections.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: child.body.id, parentCollectionId: null })]));
    const other = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other taxonomy' });
    expect((await request(server).patch(`/api/v1/campaigns/${other.body.id}/library/collections/${child.body.id}`).set(dm).send({ name: 'Wrong campaign' })).status).toBe(404);
  });

  it('searches a role-safe mixed library with taxonomy facets and filters', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const tag = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Plot hook', aliases: ['lead'] });
    const [visibleQuest] = await db.insert(quests).values({ campaignId, title: 'Find the observatory', body: 'A lead in the hills', status: 'available', hidden: false, createdAt: ts, updatedAt: ts }).returning();
    await db.insert(quests).values({ campaignId, title: 'Secret cult', body: 'DM only', status: 'available', hidden: true, createdAt: ts, updatedAt: ts });
    await db.insert(locations).values({ campaignId, name: 'Uncharted vault', body: 'DM only location', status: 'unexplored', createdAt: ts, updatedAt: ts });
    await db.insert(npcs).values({ campaignId, name: 'Mira', body: 'Knows the observatory', hidden: false, createdAt: ts, updatedAt: ts });
    await db.insert(campaignLibraryEntityTaxonomy).values({ campaignId, entityType: 'quest', entityId: visibleQuest.id, tagId: tag.body.id, collectionId: null, createdAt: ts });
    const playerSearch = await request(server).get(`/api/v1/campaigns/${campaignId}/library/search?q=lead&tagId=${tag.body.id}`).set(player);
    expect(playerSearch.status).toBe(200);
    expect(playerSearch.body).toMatchObject({ total: 1, items: [expect.objectContaining({ entityType: 'quest', entityId: visibleQuest.id })], facets: { tags: [expect.objectContaining({ id: tag.body.id, count: 1 })] } });
    const playerAll = await request(server).get(`/api/v1/campaigns/${campaignId}/library/search`).set(player);
    expect(playerAll.body.items.some((item: { name: string }) => item.name === 'Secret cult')).toBe(false);
    expect(playerAll.body.items.some((item: { name: string }) => item.name === 'Uncharted vault')).toBe(false);
    const dmAll = await request(server).get(`/api/v1/campaigns/${campaignId}/library/search?visibility=hidden`).set(dm);
    expect(dmAll.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Secret cult', visibility: 'hidden' }), expect.objectContaining({ name: 'Uncharted vault', visibility: 'hidden' })]));
    const typed = await request(server).get(`/api/v1/campaigns/${campaignId}/library/search?type=quest`).set(dm);
    expect(typed.status).toBe(200);
    expect(typed.body.items.every((item: { entityType: string }) => item.entityType === 'quest')).toBe(true);
    expect(typed.body.facets.types.map((facet: { id: string }) => facet.id)).toEqual(expect.arrayContaining(['quest', 'npc', 'location']));
    const hidden = await request(server).get(`/api/v1/campaigns/${campaignId}/library/search?visibility=hidden`).set(dm);
    expect(hidden.body.facets.visibility.map((facet: { id: string }) => facet.id)).toEqual(expect.arrayContaining(['hidden', 'public']));
    expect(hidden.body.items.every((item: { visibility: string }) => item.visibility === 'hidden')).toBe(true);
  });

  it('bulk move is atomic, auditable, and undo preserves a later unrelated collection', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [quest] = await db.insert(quests).values({ campaignId, title: 'Bulk target', createdAt: ts, updatedAt: ts }).returning();
    const old = await request(server).post(`/api/v1/campaigns/${campaignId}/library/collections`).set(dm).send({ name: 'Old' });
    const destination = await request(server).post(`/api/v1/campaigns/${campaignId}/library/collections`).set(dm).send({ name: 'Destination' });
    const later = await request(server).post(`/api/v1/campaigns/${campaignId}/library/collections`).set(dm).send({ name: 'Later' });
    await db.insert(campaignLibraryEntityTaxonomy).values({ campaignId, entityType: 'quest', entityId: quest.id, tagId: null, collectionId: old.body.id, createdAt: ts });
    const bulk = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'move_collection', taxonomyId: destination.body.id, targets: [{ entityType: 'quest', entityId: quest.id }] });
    expect(bulk.status).toBe(201);
    // Added after the operation: undo must not delete this collaborator's change.
    await db.insert(campaignLibraryEntityTaxonomy).values({ campaignId, entityType: 'quest', entityId: quest.id, tagId: null, collectionId: later.body.id, createdAt: ts });
    const undo = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${bulk.body.operationId}/undo`).set(dm);
    expect(undo.status).toBe(201);
    const rows = await db.select().from(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityId, quest.id)));
    expect(rows.map((row) => row.collectionId)).toEqual(expect.arrayContaining([old.body.id, later.body.id]));
    expect(rows.map((row) => row.collectionId)).not.toContain(destination.body.id);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${bulk.body.operationId}/undo`).set(dm)).body).toMatchObject({ alreadyUndone: true });
  });

  it('bulk rejects a bad mixed selection without changing earlier targets and returns 404 for no journal', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [quest] = await db.insert(quests).values({ campaignId, title: 'Rollback target', createdAt: ts, updatedAt: ts }).returning();
    const tag = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Rollback tag' });
    const failure = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'add_tag', taxonomyId: tag.body.id, targets: [{ entityType: 'quest', entityId: quest.id }, { entityType: 'npc', entityId: 987654321 }] });
    expect(failure.status).toBe(404);
    expect(await db.select().from(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityId, quest.id), eq(campaignLibraryEntityTaxonomy.tagId, tag.body.id)))).toEqual([]);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/999999/undo`).set(dm)).status).toBe(404);
  });

  it('accepts exactly 500 unique targets, rejects 501, writes one audit row, and is DM-only', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const rows = await db.insert(quests).values(Array.from({ length: 501 }, (_, n) => ({ campaignId, title: `Boundary ${n}`, createdAt: ts, updatedAt: ts }))).returning({ id: quests.id });
    const tag = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Boundary' });
    const targets = rows.slice(0, 500).map((row) => ({ entityType: 'quest', entityId: row.id }));
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(player).send({ operation: 'add_tag', taxonomyId: tag.body.id, targets })).status).toBe(403);
    const applied = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'add_tag', taxonomyId: tag.body.id, targets });
    expect(applied.status).toBe(201);
    expect(applied.body.applied).toBe(500);
    const auditRows = await db.select().from(auditLog).where(and(eq(auditLog.campaignId, campaignId), eq(auditLog.entityId, applied.body.operationId), eq(auditLog.action, 'campaign_library.bulk')));
    expect(auditRows).toHaveLength(1);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'add_tag', taxonomyId: tag.body.id, targets: [...targets, { entityType: 'quest', entityId: rows[500].id }] })).status).toBe(400);
  });

  it('rejects cross-campaign target and taxonomy identifiers', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const other = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other bulk campaign' });
    const [otherQuest] = await db.insert(quests).values({ campaignId: other.body.id, title: 'Foreign', createdAt: ts, updatedAt: ts }).returning();
    const foreignTag = await request(server).post(`/api/v1/campaigns/${other.body.id}/library/tags`).set(dm).send({ name: 'Foreign tag' });
    const [ownQuest] = await db.insert(quests).values({ campaignId, title: 'Own', createdAt: ts, updatedAt: ts }).returning();
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'add_tag', taxonomyId: foreignTag.body.id, targets: [{ entityType: 'quest', entityId: ownQuest.id }] })).status).toBe(404);
    const localTag = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Local tag' });
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'add_tag', taxonomyId: localTag.body.id, targets: [{ entityType: 'quest', entityId: otherQuest.id }] })).status).toBe(404);
  });

  it('adapts visibility, status, archive and inventory-owner writes and rejects unsupported mixed types before writes', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [quest] = await db.insert(quests).values({ campaignId, title: 'Adapter quest', status: 'available', hidden: false, createdAt: ts, updatedAt: ts }).returning();
    const [item] = await db.insert(inventoryItems).values({ campaignId, name: 'Adapter item', ownerType: 'party', createdAt: ts, updatedAt: ts }).returning();
    const target = [{ entityType: 'quest', entityId: quest.id }];
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'set_visibility', visibility: 'hidden', targets: target })).status).toBe(201);
    expect((await db.select().from(quests).where(eq(quests.id, quest.id))).at(0)?.hidden).toBe(true);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'set_status', status: 'completed', targets: target })).status).toBe(201);
    expect((await db.select().from(quests).where(eq(quests.id, quest.id))).at(0)?.status).toBe('completed');
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'archive', targets: target })).status).toBe(201);
    expect((await db.select().from(quests).where(eq(quests.id, quest.id))).at(0)?.deletedAt).not.toBeNull();
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'move_inventory_owner', ownerType: 'party', targets: [{ entityType: 'inventory_item', entityId: item.id }] })).status).toBe(201);
    expect((await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id))).at(0)?.ownerType).toBe('party');
    const bad = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'set_visibility', visibility: 'hidden', targets: [{ entityType: 'quest', entityId: quest.id }, { entityType: 'inventory_item', entityId: item.id }] });
    expect(bad.status).toBe(400);
  });

  it('bulk move_inventory_owner auto-unequips a worn item rather than arming the new owner or leaving an invalid party-equipped row (issue #1326 review)', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [source] = await db.insert(characters).values({ campaignId, name: 'Bulk source', createdAt: ts, updatedAt: ts }).returning();
    const [recipient] = await db.insert(characters).values({ campaignId, name: 'Bulk recipient', createdAt: ts, updatedAt: ts }).returning();
    const [equippedItem] = await db
      .insert(inventoryItems)
      .values({
        campaignId,
        name: 'Bulk-moved sword',
        ownerType: 'character',
        characterId: source.id,
        equipped: true,
        equipSlot: 'main-hand',
        equippedAction: JSON.stringify({ name: 'Slash', kind: 'melee', toHit: '+5', damage: '1d8+3', notes: '' }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    // Bulk move to a DIFFERENT character never silently arms them with the action.
    const movedToChar = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/library/bulk`)
      .set(dm)
      .send({ operation: 'move_inventory_owner', ownerType: 'character', characterId: recipient.id, targets: [{ entityType: 'inventory_item', entityId: equippedItem.id }] });
    expect(movedToChar.status).toBe(201);
    const afterCharMove = (await db.select().from(inventoryItems).where(eq(inventoryItems.id, equippedItem.id))).at(0)!;
    expect(afterCharMove.characterId).toBe(recipient.id);
    expect(afterCharMove.equipped).toBe(false);
    expect(afterCharMove.equipSlot).toBeNull();

    // Bulk move to the party stash never leaves an invalid equipped=true party row.
    await db.update(inventoryItems).set({ equipped: true, equipSlot: 'main-hand' }).where(eq(inventoryItems.id, equippedItem.id));
    const movedToParty = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/library/bulk`)
      .set(dm)
      .send({ operation: 'move_inventory_owner', ownerType: 'party', targets: [{ entityType: 'inventory_item', entityId: equippedItem.id }] });
    expect(movedToParty.status).toBe(201);
    const afterPartyMove = (await db.select().from(inventoryItems).where(eq(inventoryItems.id, equippedItem.id))).at(0)!;
    expect(afterPartyMove.ownerType).toBe('party');
    expect(afterPartyMove.equipped).toBe(false);
    expect(afterPartyMove.equipSlot).toBeNull();
  });

  it('bulk move_inventory_owner to the same owner leaves equip state intact (issue #1326 review)', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [owner] = await db.insert(characters).values({ campaignId, name: 'No-op owner', createdAt: ts, updatedAt: ts }).returning();
    const [item] = await db
      .insert(inventoryItems)
      .values({
        campaignId,
        name: 'No-op sword',
        ownerType: 'character',
        characterId: owner.id,
        equipped: true,
        equipSlot: 'main-hand',
        equippedAction: JSON.stringify({ name: 'Slash', kind: 'melee', toHit: '+5', damage: '1d8+3', notes: '' }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    const noOp = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/library/bulk`)
      .set(dm)
      .send({ operation: 'move_inventory_owner', ownerType: 'character', characterId: owner.id, targets: [{ entityType: 'inventory_item', entityId: item.id }] });
    expect(noOp.status).toBe(201);
    const afterNoOp = (await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id))).at(0)!;
    expect(afterNoOp.ownerType).toBe('character');
    expect(afterNoOp.characterId).toBe(owner.id);
    expect(afterNoOp.equipped).toBe(true);
    expect(afterNoOp.equipSlot).toBe('main-hand');
    expect(afterNoOp.equippedAction).not.toBeNull();
  });

  it('bulk archive clears equip state so a later bulk restore cannot resurrect a slot conflict (issue #1326 review)', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [character] = await db.insert(characters).values({ campaignId, name: 'Archive owner', createdAt: ts, updatedAt: ts }).returning();
    const [original] = await db
      .insert(inventoryItems)
      .values({ campaignId, name: 'Archived shield', ownerType: 'character', characterId: character.id, equipped: true, equipSlot: 'off-hand', createdAt: ts, updatedAt: ts })
      .returning();

    const archived = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/library/bulk`)
      .set(dm)
      .send({ operation: 'archive', targets: [{ entityType: 'inventory_item', entityId: original.id }] });
    expect(archived.status).toBe(201);
    const afterArchive = (await db.select().from(inventoryItems).where(eq(inventoryItems.id, original.id))).at(0)!;
    expect(afterArchive.deletedAt).not.toBeNull();
    expect(afterArchive.equipped).toBe(false);
    expect(afterArchive.equipSlot).toBeNull();

    // A replacement claims the freed slot while the original is archived.
    const [replacement] = await db
      .insert(inventoryItems)
      .values({ campaignId, name: 'Replacement shield', ownerType: 'character', characterId: character.id, equipped: true, equipSlot: 'off-hand', createdAt: ts, updatedAt: ts })
      .returning();

    const restored = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/library/bulk`)
      .set(dm)
      .send({ operation: 'restore', targets: [{ entityType: 'inventory_item', entityId: original.id }] });
    expect(restored.status).toBe(201);
    const afterRestore = (await db.select().from(inventoryItems).where(eq(inventoryItems.id, original.id))).at(0)!;
    expect(afterRestore.deletedAt).toBeNull();
    // Restored unequipped — no two-items-one-slot conflict resurrected.
    expect(afterRestore.equipped).toBe(false);
    const replacementCheck = (await db.select().from(inventoryItems).where(eq(inventoryItems.id, replacement.id))).at(0)!;
    expect(replacementCheck.equipped).toBe(true);
    expect(replacementCheck.equipSlot).toBe('off-hand');
  });

  // Issue #1326 review (Codex): the enumeration of bulk operations that must preserve
  // equip state round-trips is: move, archive, restore, UNDO, clone, import. These
  // three tests close the "undo" gap in that set.
  it('undoing a bulk move_inventory_owner restores the pre-move equip state when the slot is still free', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [source] = await db.insert(characters).values({ campaignId, name: 'Undo-move source', createdAt: ts, updatedAt: ts }).returning();
    const [recipient] = await db.insert(characters).values({ campaignId, name: 'Undo-move recipient', createdAt: ts, updatedAt: ts }).returning();
    const [item] = await db
      .insert(inventoryItems)
      .values({
        campaignId,
        name: 'Undo-move blade',
        ownerType: 'character',
        characterId: source.id,
        equipped: true,
        equipSlot: 'main-hand',
        equippedAction: JSON.stringify({ name: 'Blade Slash', kind: 'melee', toHit: '+5', damage: '1d8+3', notes: '' }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    const moved = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/library/bulk`)
      .set(dm)
      .send({ operation: 'move_inventory_owner', ownerType: 'character', characterId: recipient.id, targets: [{ entityType: 'inventory_item', entityId: item.id }] });
    expect(moved.status).toBe(201);
    const afterMove = (await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id))).at(0)!;
    expect(afterMove.equipped).toBe(false);
    // Coordinator review: equippedAction clears together with equipped/equipSlot on the
    // FORWARD move too — the recipient never silently inherits the source's action.
    expect(afterMove.equippedAction).toBeNull();

    const undone = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${moved.body.operationId}/undo`).set(dm);
    expect(undone.status).toBe(201);
    const afterUndo = (await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id))).at(0)!;
    expect(afterUndo.characterId).toBe(source.id);
    expect(afterUndo.equipped).toBe(true);
    expect(afterUndo.equipSlot).toBe('main-hand');
    // The full triple round-trips through undo, not just equipped/equipSlot.
    expect(JSON.parse(afterUndo.equippedAction!)).toMatchObject({ name: 'Blade Slash', damage: '1d8+3' });
  });

  it('undoing a bulk move_inventory_owner rejects re-equipping into a slot another item has since claimed', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [source] = await db.insert(characters).values({ campaignId, name: 'Undo-move-conflict source', createdAt: ts, updatedAt: ts }).returning();
    const [item] = await db
      .insert(inventoryItems)
      .values({ campaignId, name: 'Undo-move-conflict blade', ownerType: 'character', characterId: source.id, equipped: true, equipSlot: 'main-hand', createdAt: ts, updatedAt: ts })
      .returning();

    const moved = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/library/bulk`)
      .set(dm)
      .send({ operation: 'move_inventory_owner', ownerType: 'party', targets: [{ entityType: 'inventory_item', entityId: item.id }] });
    expect(moved.status).toBe(201);

    // Something else now claims that same slot on the source character.
    await db.insert(inventoryItems).values({ campaignId, name: 'Interloper blade', ownerType: 'character', characterId: source.id, equipped: true, equipSlot: 'main-hand', createdAt: ts, updatedAt: ts });

    const undone = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${moved.body.operationId}/undo`).set(dm);
    expect(undone.status).toBe(409);
    // The move itself is unwound (best-effort), never left half-applied with the item
    // silently re-equipped over the interloper.
    const afterUndo = (await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id))).at(0)!;
    expect(afterUndo.equipped).toBe(false);
  });

  it('undoing a bulk archive restores the pre-archive equip state when the slot is still free', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [character] = await db.insert(characters).values({ campaignId, name: 'Undo-archive owner', createdAt: ts, updatedAt: ts }).returning();
    const [item] = await db
      .insert(inventoryItems)
      .values({ campaignId, name: 'Undo-archive shield', ownerType: 'character', characterId: character.id, equipped: true, equipSlot: 'off-hand', createdAt: ts, updatedAt: ts })
      .returning();

    const archived = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/library/bulk`)
      .set(dm)
      .send({ operation: 'archive', targets: [{ entityType: 'inventory_item', entityId: item.id }] });
    expect(archived.status).toBe(201);

    const undone = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${archived.body.operationId}/undo`).set(dm);
    expect(undone.status).toBe(201);
    const afterUndo = (await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id))).at(0)!;
    expect(afterUndo.deletedAt).toBeNull();
    expect(afterUndo.equipped).toBe(true);
    expect(afterUndo.equipSlot).toBe('off-hand');
  });

  // Issue #1326 review (coordinator): a bulk move_inventory_owner journal recorded by
  // the PRE-#1326 binary never had equipped/equip_slot in its snapshot at all — the
  // parse schema must tolerate that shape, not require it, or undo permanently 404s/
  // 500s for every such pre-upgrade record after deploy.
  it('undoes a pre-upgrade bulk move_inventory_owner journal (no equip fields recorded) without failing, leaving the item unequipped', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [source] = await db.insert(characters).values({ campaignId, name: 'Pre-upgrade source', createdAt: ts, updatedAt: ts }).returning();
    const [recipient] = await db.insert(characters).values({ campaignId, name: 'Pre-upgrade recipient', createdAt: ts, updatedAt: ts }).returning();
    const [item] = await db
      .insert(inventoryItems)
      .values({ campaignId, name: 'Pre-upgrade blade', ownerType: 'character', characterId: source.id, createdAt: ts, updatedAt: ts })
      .returning();

    const moved = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/library/bulk`)
      .set(dm)
      .send({ operation: 'move_inventory_owner', ownerType: 'character', characterId: recipient.id, targets: [{ entityType: 'inventory_item', entityId: item.id }] });
    expect(moved.status).toBe(201);

    // Rewrite the just-recorded journal to the EXACT shape a pre-#1326 binary would
    // have written: the snapshot's `value` has only ownerType/characterId, nothing else.
    const recorded = (await db.select().from(campaignLibraryBulkOperations).where(eq(campaignLibraryBulkOperations.id, moved.body.operationId))).at(0)!;
    const legacyJournal = JSON.parse(recorded.beforeJson);
    legacyJournal.snapshots = legacyJournal.snapshots.map((snap: { value: Record<string, unknown> }) => ({
      ...snap,
      value: { ownerType: snap.value.ownerType, characterId: snap.value.characterId },
    }));
    await db
      .update(campaignLibraryBulkOperations)
      .set({ beforeJson: JSON.stringify(legacyJournal), inverseJson: JSON.stringify(legacyJournal) })
      .where(eq(campaignLibraryBulkOperations.id, moved.body.operationId));

    const undone = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${moved.body.operationId}/undo`).set(dm);
    expect(undone.status).toBe(201);
    const afterUndo = (await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id))).at(0)!;
    expect(afterUndo.characterId).toBe(source.id);
    // A pre-upgrade record never claimed the item was equipped — it lands unequipped.
    expect(afterUndo.equipped).toBe(false);
    expect(afterUndo.equipSlot).toBeNull();
  });

  it('moves an item to a campaign character and undoes it without parsing a scalar journal', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [character] = await db.insert(characters).values({ campaignId, name: 'Owner', createdAt: ts, updatedAt: ts }).returning();
    const [item] = await db.insert(inventoryItems).values({ campaignId, name: 'Undo owner', ownerType: 'party', createdAt: ts, updatedAt: ts }).returning();
    const moved = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'move_inventory_owner', ownerType: 'character', characterId: character.id, targets: [{ entityType: 'inventory_item', entityId: item.id }] });
    expect(moved.status).toBe(201);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${moved.body.operationId}/undo`).set(dm)).status).toBe(201);
    expect((await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id))).at(0)).toMatchObject({ ownerType: 'party', characterId: null });
  });

  it('maps location visibility across unexplored, explored, and current without regressing progression', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const rows = await db.insert(locations).values(['unexplored', 'explored', 'current'].map((status) => ({ campaignId, name: `Place ${status}`, status, createdAt: ts, updatedAt: ts }))).returning();
    const show = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'set_visibility', visibility: 'public', targets: rows.map((row) => ({ entityType: 'location', entityId: row.id })) });
    expect(show.status).toBe(201);
    const afterShow = await db.select().from(locations).where(eq(locations.campaignId, campaignId));
    expect(afterShow.filter((r) => rows.some((row) => row.id === r.id)).map((r) => r.status).sort()).toEqual(['current', 'explored', 'explored']);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'set_visibility', visibility: 'hidden', targets: [{ entityType: 'location', entityId: rows[1].id }] })).status).toBe(201);
    expect((await db.select().from(locations).where(eq(locations.id, rows[1].id))).at(0)?.status).toBe('unexplored');
  });

  it('rolls back a multi-target undo when a later edit conflicts, leaving every target at post-bulk state', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const rows = await db.insert(quests).values(['One', 'Two'].map((title) => ({ campaignId, title, hidden: false, createdAt: ts, updatedAt: ts }))).returning();
    const bulk = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'set_visibility', visibility: 'hidden', targets: rows.map((row) => ({ entityType: 'quest', entityId: row.id })) });
    expect(bulk.status).toBe(201);
    await db.update(quests).set({ hidden: false, updatedAt: new Date(Date.now() + 1_000).toISOString() }).where(eq(quests.id, rows[1].id));
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${bulk.body.operationId}/undo`).set(dm)).status).toBe(409);
    const current = await db.select().from(quests).where(eq(quests.campaignId, campaignId));
    expect(current.find((row) => row.id === rows[0].id)?.hidden).toBe(true); // first inverse was rolled back
    expect(current.find((row) => row.id === rows[1].id)?.hidden).toBe(false);
  });

  it('allows exactly one concurrent undo claimant', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [quest] = await db.insert(quests).values({ campaignId, title: 'Concurrent undo', createdAt: ts, updatedAt: ts }).returning();
    const tag = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Concurrent' });
    const bulk = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'add_tag', taxonomyId: tag.body.id, targets: [{ entityType: 'quest', entityId: quest.id }] });
    const responses = await Promise.all([1, 2].map(() => request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${bulk.body.operationId}/undo`).set(dm)));
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses.filter((response) => response.body.alreadyUndone === false)).toHaveLength(1);
    expect(responses.filter((response) => response.body.alreadyUndone === true)).toHaveLength(1);
  });

  it('promotes a bulk location to current with demotion, pointer update, and undo restore', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [previous, next] = await db.insert(locations).values([
      { campaignId, name: 'Was current', status: 'current', createdAt: ts, updatedAt: ts },
      { campaignId, name: 'Becomes current', status: 'explored', createdAt: ts, updatedAt: ts },
    ]).returning();
    await db.update(campaigns).set({ currentLocationId: previous.id, updatedAt: ts }).where(eq(campaigns.id, campaignId));
    const bulk = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'set_status', status: 'current', targets: [{ entityType: 'location', entityId: next.id }] });
    expect(bulk.status).toBe(201);
    expect((await db.select().from(locations).where(eq(locations.id, previous.id))).at(0)?.status).toBe('explored');
    expect((await db.select().from(locations).where(eq(locations.id, next.id))).at(0)?.status).toBe('current');
    expect((await db.select().from(campaigns).where(eq(campaigns.id, campaignId))).at(0)?.currentLocationId).toBe(next.id);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'set_status', status: 'current', targets: [{ entityType: 'location', entityId: previous.id }, { entityType: 'location', entityId: next.id }] })).status).toBe(400);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${bulk.body.operationId}/undo`).set(dm)).status).toBe(201);
    expect((await db.select().from(locations).where(eq(locations.id, previous.id))).at(0)?.status).toBe('current');
    expect((await db.select().from(locations).where(eq(locations.id, next.id))).at(0)?.status).toBe('explored');
    expect((await db.select().from(campaigns).where(eq(campaigns.id, campaignId))).at(0)?.currentLocationId).toBe(previous.id);
  });

  it('audits taxonomy create, update, and delete writes', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB);
    const created = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Audited tag' });
    expect(created.status).toBe(201);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.campaignId, campaignId), eq(auditLog.action, 'campaign_library.tag.create'), eq(auditLog.entityId, created.body.id)))).toHaveLength(1);
    expect((await request(server).patch(`/api/v1/campaigns/${campaignId}/library/tags/${created.body.id}`).set(dm).send({ description: 'tracked' })).status).toBe(200);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.campaignId, campaignId), eq(auditLog.action, 'campaign_library.tag.update'), eq(auditLog.entityId, created.body.id)))).toHaveLength(1);
    expect((await request(server).delete(`/api/v1/campaigns/${campaignId}/library/tags/${created.body.id}`).set(dm)).status).toBe(200);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.campaignId, campaignId), eq(auditLog.action, 'campaign_library.tag.delete'), eq(auditLog.entityId, created.body.id)))).toHaveLength(1);
  });

  it('does not revive unrelated taxonomy links removed after a bulk add when undoing', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [quest] = await db.insert(quests).values({ campaignId, title: 'Scoped undo', createdAt: ts, updatedAt: ts }).returning();
    const keep = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Keep on undo' });
    const unrelated = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Removed by collaborator' });
    const added = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Bulk added' });
    await db.insert(campaignLibraryEntityTaxonomy).values([
      { campaignId, entityType: 'quest', entityId: quest.id, tagId: keep.body.id, collectionId: null, createdAt: ts },
      { campaignId, entityType: 'quest', entityId: quest.id, tagId: unrelated.body.id, collectionId: null, createdAt: ts },
    ]);
    const bulk = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'add_tag', taxonomyId: added.body.id, targets: [{ entityType: 'quest', entityId: quest.id }] });
    expect(bulk.status).toBe(201);
    await db.delete(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityId, quest.id), eq(campaignLibraryEntityTaxonomy.tagId, unrelated.body.id)));
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${bulk.body.operationId}/undo`).set(dm)).status).toBe(201);
    const rows = await db.select().from(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityId, quest.id)));
    expect(rows.map((row) => row.tagId).sort()).toEqual([keep.body.id]);
  });

  it('rejects taxonomy undo when a later collaborator edit conflicts with a no-op add', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [quest] = await db.insert(quests).values({ campaignId, title: 'No-op fence', createdAt: ts, updatedAt: ts }).returning();
    const tag = await request(server).post(`/api/v1/campaigns/${campaignId}/library/tags`).set(dm).send({ name: 'Already present' });
    await db.insert(campaignLibraryEntityTaxonomy).values({ campaignId, entityType: 'quest', entityId: quest.id, tagId: tag.body.id, collectionId: null, createdAt: ts });
    const bulk = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'add_tag', taxonomyId: tag.body.id, targets: [{ entityType: 'quest', entityId: quest.id }] });
    expect(bulk.status).toBe(201);
    await db.delete(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityId, quest.id), eq(campaignLibraryEntityTaxonomy.tagId, tag.body.id)));
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk/${bulk.body.operationId}/undo`).set(dm)).status).toBe(409);
    expect(await db.select().from(campaignLibraryEntityTaxonomy).where(and(eq(campaignLibraryEntityTaxonomy.campaignId, campaignId), eq(campaignLibraryEntityTaxonomy.entityId, quest.id), eq(campaignLibraryEntityTaxonomy.tagId, tag.body.id)))).toEqual([]);
  });

  it('saves, instantiates, duplicates and archives current-format templates with campaign-safe references', async () => {
    const server = ctx.app.getHttpServer(); const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [place] = await db.insert(locations).values({ campaignId, name: 'Template place', createdAt: ts, updatedAt: ts }).returning();
    const [npc] = await db.insert(npcs).values({ campaignId, name: 'Template giver', locationId: place.id, createdAt: ts, updatedAt: ts }).returning();
    const [quest] = await db.insert(quests).values({ campaignId, title: 'Template quest', giverNpcId: npc.id, createdAt: ts, updatedAt: ts }).returning();
    const saved = await request(server).post(`/api/v1/campaigns/${campaignId}/library/templates`).set(dm).send({ entityType: 'quest', entityId: quest.id, name: 'Quest template' });
    expect(saved.status).toBe(201);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/templates`).set(player).send({ entityType: 'quest', entityId: quest.id, name: 'Nope' })).status).toBe(403);
    const instantiated = await request(server).post(`/api/v1/campaigns/${campaignId}/library/templates/${saved.body.id}/instantiate`).set(dm).send({ name: 'Instantiated quest' });
    expect(instantiated.status).toBe(201);
    expect((await db.select().from(quests).where(eq(quests.id, instantiated.body.entityId))).at(0)).toMatchObject({ campaignId, title: 'Instantiated quest', giverNpcId: npc.id });
    const npcTemplate = await request(server).post(`/api/v1/campaigns/${campaignId}/library/templates`).set(dm).send({ entityType: 'npc', entityId: npc.id, name: 'NPC template' });
    const npcCopy = await request(server).post(`/api/v1/campaigns/${campaignId}/library/templates/${npcTemplate.body.id}/instantiate`).set(dm).send({ name: 'NPC copy', refs: { locationId: place.id } });
    expect(npcCopy.status).toBe(201);
    expect((await db.select().from(npcs).where(eq(npcs.id, npcCopy.body.entityId))).at(0)).toMatchObject({ name: 'NPC copy', locationId: place.id });
    const otherCampaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Outside references' });
    const [outsidePlace] = await db.insert(locations).values({ campaignId: otherCampaign.body.id, name: 'Outside place', createdAt: ts, updatedAt: ts }).returning();
    const npcCountBefore = (await db.select().from(npcs).where(eq(npcs.campaignId, campaignId))).length;
    const auditCountBefore = (await db.select().from(auditLog).where(and(eq(auditLog.campaignId, campaignId), eq(auditLog.action, 'campaign_library.template.instantiate')))).length;
    const crossCampaign = await request(server).post(`/api/v1/campaigns/${campaignId}/library/templates/${npcTemplate.body.id}/instantiate`).set(dm).send({ name: 'Should not exist', refs: { locationId: outsidePlace.id } });
    expect(crossCampaign.status).toBe(400);
    expect((await db.select().from(npcs).where(eq(npcs.campaignId, campaignId))).length).toBe(npcCountBefore);
    expect((await db.select().from(auditLog).where(and(eq(auditLog.campaignId, campaignId), eq(auditLog.action, 'campaign_library.template.instantiate')))).length).toBe(auditCountBefore);
    const locationCopy = await request(server).post(`/api/v1/campaigns/${campaignId}/library/entities/location/${place.id}/duplicate`).set(dm).send({ name: 'Location copy' });
    expect(locationCopy.status).toBe(201);
    expect((await db.select().from(locations).where(eq(locations.id, locationCopy.body.entityId))).at(0)?.name).toBe('Location copy');
    const [currentPlace] = await db.insert(locations).values({ campaignId, name: 'Current template source', status: 'current', createdAt: ts, updatedAt: ts }).returning();
    await db.update(campaigns).set({ currentLocationId: currentPlace.id, updatedAt: ts }).where(eq(campaigns.id, campaignId));
    const currentTemplate = await request(server).post(`/api/v1/campaigns/${campaignId}/library/templates`).set(dm).send({ entityType: 'location', entityId: currentPlace.id, name: 'Current place template' });
    expect(currentTemplate.status).toBe(201);
    expect(currentTemplate.body.snapshot).toMatchObject({ status: 'explored' });
    const currentCopy = await request(server).post(`/api/v1/campaigns/${campaignId}/library/entities/location/${currentPlace.id}/duplicate`).set(dm).send({ name: 'Current place copy' });
    expect(currentCopy.status).toBe(201);
    expect((await db.select().from(locations).where(eq(locations.id, currentCopy.body.entityId))).at(0)?.status).toBe('explored');
    expect((await db.select().from(locations).where(eq(locations.id, currentPlace.id))).at(0)?.status).toBe('current');
    expect((await db.select().from(campaigns).where(eq(campaigns.id, campaignId))).at(0)?.currentLocationId).toBe(currentPlace.id);
    const [monster] = await db.insert(campaignLibraryMonsters).values({ campaignId, name: 'Template monster', statblockJson: '{}', createdAt: ts, updatedAt: ts }).returning();
    const monsterTemplate = await request(server).post(`/api/v1/campaigns/${campaignId}/library/templates`).set(dm).send({ entityType: 'campaign_library_monster', entityId: monster.id, name: 'Monster template' });
    const monsterCopy = await request(server).post(`/api/v1/campaigns/${campaignId}/library/templates/${monsterTemplate.body.id}/instantiate`).set(dm).send({ name: 'Monster copy' });
    expect(monsterCopy.status).toBe(201);
    expect((await db.select().from(campaignLibraryMonsters).where(eq(campaignLibraryMonsters.id, monsterCopy.body.entityId))).at(0)?.name).toBe('Monster copy');
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/templates/${saved.body.id}/archive`).set(dm)).status).toBe(201);
    expect((await request(server).get(`/api/v1/campaigns/${campaignId}/library/templates`).set(dm)).body.map((template: { id: number }) => template.id)).not.toContain(saved.body.id);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/templates/${saved.body.id}/instantiate`).set(dm).send({})).status).toBe(404);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/library/templates`).set(dm).send({ entityType: 'attachment', entityId: 1, name: 'Bytes missing' })).status).toBe(400);
  });
});
