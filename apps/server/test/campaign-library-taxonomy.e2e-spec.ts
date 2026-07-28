import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { closeTestApp, createTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { auditLog, campaignLibraryEntityTaxonomy, inventoryItems, locations, npcs, quests } from '../src/db/schema';

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
    expect(collections.body).toEqual([expect.objectContaining({ id: child.body.id, parentCollectionId: null })]);
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
    const bad = await request(server).post(`/api/v1/campaigns/${campaignId}/library/bulk`).set(dm).send({ operation: 'set_visibility', visibility: 'hidden', targets: [{ entityType: 'quest', entityId: quest.id }, { entityType: 'location', entityId: 123456 }] });
    expect(bad.status).toBe(400);
  });
});
