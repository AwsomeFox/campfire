import request from 'supertest';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { ruleEntries, rulePacks } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('compendium inventory (#738 e2e)', () => {
  let ctx: TestAppContext; let campaignId: number; let entryId: number; let ownCharacterId: number; let foreignCharacterId: number;
  beforeAll(async () => {
    ctx = await createTestApp(); const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Compendium inventory' })).body.id;
    ownCharacterId = (await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(player).send({ name: 'Owned' })).body.id;
    foreignCharacterId = (await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Foreign' })).body.id;
    const db = ctx.app.get<DrizzleDb>(DB); const ts = new Date().toISOString();
    const [pack] = await db.insert(rulePacks).values({ slug: 'test-items', name: 'Test Items', version: '1', installedAt: ts }).returning();
    const [entry] = await db.insert(ruleEntries).values({ packId: pack.id, slug: 'wand', name: 'Test Wand', type: 'item', summary: 'Spark', body: 'A safe snapshot.', source: 'Test SRD', license: 'CC-BY', attribution: 'Test', sourceUrl: 'https://example.test/wand', createdAt: ts, updatedAt: ts }).returning(); entryId = entry.id;
  });
  afterAll(async () => { if (ctx) await closeTestApp(ctx); });
  it('executes acquisition permission, duplicate, idempotency, and link transitions', async () => {
    const server = ctx.app.getHttpServer(); const url = `/api/v1/campaigns/${campaignId}/inventory/from-compendium`;
    expect((await request(server).post(url).set(viewer).send({ ruleEntryId: entryId })).status).toBe(403);
    expect((await request(server).post(url).set(player).send({ ruleEntryId: entryId, ownerType: 'character', characterId: ownCharacterId })).status).toBe(201);
    expect((await request(server).post(url).set(player).send({ ruleEntryId: entryId, ownerType: 'character', characterId: foreignCharacterId })).status).toBe(403);
    expect((await request(server).post(`/api/v1/campaigns/${campaignId}/inventory`).set(player).send({ name: 'forged', ruleEntryId: entryId })).status).toBe(400);
    const first = await request(server).post(url).set(player).send({ ruleEntryId: entryId, qty: 2, notes: 'local', idempotencyKey: 'acq-738' });
    expect(first.status).toBe(201); expect(first.body.compendiumSnapshot.license).toBe('CC-BY');
    const replay = await request(server).post(url).set(player).send({ ruleEntryId: entryId, qty: 2, notes: 'local', idempotencyKey: 'acq-738' });
    expect(replay.status).toBe(201); expect(replay.body.id).toBe(first.body.id);
    expect((await request(server).post(url).set(player).send({ ruleEntryId: entryId, qty: 3, idempotencyKey: 'acq-738' })).status).toBe(409);
    expect((await request(server).post(url).set(player).send({ ruleEntryId: entryId })).status).toBe(409);
    const increment = await request(server).post(url).set(player).send({ ruleEntryId: entryId, qty: 1, duplicateMode: 'increment' }); expect(increment.body.qty).toBe(3);
    const separate = await request(server).post(url).set(player).send({ ruleEntryId: entryId, duplicateMode: 'separate' }); expect(separate.status).toBe(201);
    const item = first.body.id;
    const db = ctx.app.get<DrizzleDb>(DB); await db.update(ruleEntries).set({ body: 'Updated source', updatedAt: new Date().toISOString() }).where(eq(ruleEntries.id, entryId));
    const listed = await request(server).get(`/api/v1/campaigns/${campaignId}/inventory`).set(player); expect(listed.body.find((row: any) => row.id === item).compendiumState).toBe('linked_updated');
    const refreshed = await request(server).post(`/api/v1/inventory/${item}/compendium/refresh`).set(player); expect(refreshed.body.qty).toBe(3); expect(refreshed.body.notes).toBe('local'); expect(refreshed.body.compendiumSnapshot.body).toBe('Updated source');
    expect((await request(server).post(`/api/v1/inventory/${item}/compendium/overridden`).set(player)).status).toBe(200);
    const detached = await request(server).post(`/api/v1/inventory/${item}/compendium/detached`).set(player); expect(detached.body.notes).toBe('local'); expect(detached.body.qty).toBe(3); expect(detached.body.compendiumState).toBe('detached');
  });
});
