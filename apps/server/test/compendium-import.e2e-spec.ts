import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { ruleEntries, rulePacks } from '../src/db/schema';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-compendium-import' };

describe('campaign import — compendium refs (issue #584, e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let db: DrizzleDb;

  let goblinEntryId: number;
  let wrongEntryId: number;
  let exportDoc: Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    db = ctx.app.get<DrizzleDb>(DB);
    const ts = new Date().toISOString();

    const [pack] = await db
      .insert(rulePacks)
      .values({
        slug: 'e2e-import-pack',
        name: 'E2E Import Pack',
        version: '1.0.0',
        license: 'OGL 1.0a',
        sourceUrl: 'https://example.com/e2e',
        installedAt: ts,
        entryCount: 2,
      })
      .returning();

    const [goblin] = await db
      .insert(ruleEntries)
      .values({
        packId: pack.id,
        slug: 'goblin',
        name: 'Goblin',
        type: 'monster',
        summary: 'CR 0.25',
        body: '',
        dataJson: JSON.stringify({ cr: 0.25, hitPoints: 7 }),
        source: 'Open5e API',
        license: 'OGL 1.0a',
        attribution: 'Wizards of the Coast',
        author: 'Open5e Team',
        sourceUrl: 'https://open5e.com/monsters/goblin',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    goblinEntryId = goblin.id;

    const [wrong] = await db
      .insert(ruleEntries)
      .values({
        packId: pack.id,
        slug: 'adult-red-dragon',
        name: 'Adult Red Dragon',
        type: 'monster',
        summary: 'CR 17',
        body: '',
        dataJson: JSON.stringify({ cr: 17 }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    wrongEntryId = wrong.id;

    const campRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Compendium Export Source', ruleSystem: 'e2e-import-pack' });
    expect(campRes.status).toBe(201);
    const campaignId = campRes.body.id as number;

    const encRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Goblin Fight', hidden: false });
    expect(encRes.status).toBe(201);

    const addRes = await request(server)
      .post(`/api/v1/encounters/${encRes.body.id}/combatants`)
      .set(dm)
      .send({ kind: 'monster', ruleEntryId: goblinEntryId });
    expect(addRes.status).toBe(201);

    const exported = await request(server).get(`/api/v1/campaigns/${campaignId}/export?format=json`).set(dm);
    expect(exported.status).toBe(200);
    exportDoc = exported.body;

    const combatant = (exported.body.encounters as Array<{ combatants: Array<Record<string, unknown>> }>)[0]
      .combatants[0];
    expect(combatant.ruleEntryId).toBeNull();
    expect(combatant.compendiumRef).toMatchObject({
      packSlug: 'e2e-import-pack',
      entrySlug: 'goblin',
      entryType: 'monster',
    });
    expect(combatant.compendiumSnapshot).toMatchObject({
      source: 'Open5e API',
      license: 'OGL 1.0a',
      attribution: 'Wizards of the Coast',
      author: 'Open5e Team',
      sourceUrl: 'https://open5e.com/monsters/goblin',
    });
    expect(exported.body.compendiumDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packSlug: 'e2e-import-pack',
          entrySlugs: ['goblin'],
        }),
      ]),
    );
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('preflight resolves when the dependency pack is installed', async () => {
    const res = await request(server).post('/api/v1/campaigns/import/preflight').set(dm).send(exportDoc);
    expect(res.status).toBe(201);
    expect(res.body.canImport).toBe(true);
    expect(res.body.unresolvedCount).toBe(0);
    expect(res.body.references[0].status).toBe('resolved');
    expect(res.body.references[0].resolvedEntryId).toBe(goblinEntryId);
  });

  it('round-trips compendium refs to the correct entry by stable slug identity', async () => {
    const imported = await request(server)
      .post('/api/v1/campaigns/import')
      .set(dm)
      .send({ ...exportDoc, name: 'Resolved Import' });
    expect(imported.status).toBe(201);

    const encs = await request(server).get(`/api/v1/campaigns/${imported.body.id}/encounters`).set(dm);
    expect(encs.body.length).toBeGreaterThan(0);
    const encDetail = await request(server).get(`/api/v1/encounters/${encs.body[0].id}`).set(dm);
    const importedCombatant = encDetail.body.combatants[0];
    expect(importedCombatant.ruleEntryId).toBe(goblinEntryId);
    expect(importedCombatant.ruleEntryId).not.toBe(wrongEntryId);
    expect(importedCombatant.name).toBe('Goblin');
  });

  it('never aliases a legacy numeric ruleEntryId (numeric collision safe)', async () => {
    const legacyDoc = structuredClone(exportDoc) as Record<string, unknown>;
    const enc = (legacyDoc.encounters as Array<Record<string, unknown>>)[0];
    const combatant = (enc.combatants as Array<Record<string, unknown>>)[0];
    combatant.ruleEntryId = wrongEntryId;
    delete combatant.compendiumRef;
    delete combatant.compendiumSnapshot;

    const preflight = await request(server).post('/api/v1/campaigns/import/preflight').set(dm).send(legacyDoc);
    expect(preflight.body.references[0].status).toBe('legacy_numeric_id');
    expect(preflight.body.canImport).toBe(false);

    const blocked = await request(server).post('/api/v1/campaigns/import').set(dm).send(legacyDoc);
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toContain('compendium');
  });

  it('blocks import when the dependency pack is missing', async () => {
    const missingPackDoc = structuredClone(exportDoc) as Record<string, unknown>;
    const enc = (missingPackDoc.encounters as Array<Record<string, unknown>>)[0];
    const combatant = (enc.combatants as Array<Record<string, unknown>>)[0];
    combatant.compendiumRef = {
      ...(combatant.compendiumRef as Record<string, unknown>),
      packSlug: 'not-installed-pack',
    };

    const preflight = await request(server).post('/api/v1/campaigns/import/preflight').set(dm).send(missingPackDoc);
    expect(preflight.status).toBe(201);
    expect(preflight.body.canImport).toBe(false);
    expect(preflight.body.references[0].status).toBe('missing_pack');
    expect(preflight.body.references[0].installHint).toMatchObject({ packSlug: 'not-installed-pack' });

    const blocked = await request(server).post('/api/v1/campaigns/import').set(dm).send(missingPackDoc);
    expect(blocked.status).toBe(400);
  });

  it('imports detached when pack is missing but compendiumSnapshot is present', async () => {
    const detachDoc = structuredClone(exportDoc) as Record<string, unknown>;
    const enc = (detachDoc.encounters as Array<Record<string, unknown>>)[0];
    const combatant = (enc.combatants as Array<Record<string, unknown>>)[0];
    combatant.compendiumRef = {
      ...(combatant.compendiumRef as Record<string, unknown>),
      packSlug: 'renamed-pack-slug',
    };
    detachDoc.onUnresolvedCompendium = 'detach';

    const preflight = await request(server).post('/api/v1/campaigns/import/preflight').set(dm).send(detachDoc);
    expect(preflight.body.canImportDetached).toBe(true);

    const imported = await request(server)
      .post('/api/v1/campaigns/import')
      .set(dm)
      .send({ ...detachDoc, name: 'Detached Import' });
    expect(imported.status).toBe(201);

    const encs = await request(server).get(`/api/v1/campaigns/${imported.body.id}/encounters`).set(dm);
    const encDetail = await request(server).get(`/api/v1/encounters/${encs.body[0].id}`).set(dm);
    expect(encDetail.body.combatants[0].ruleEntryId).toBeNull();
    expect(encDetail.body.combatants[0].name).toBe('Goblin');

    const detachedExport = await request(server).get(`/api/v1/campaigns/${imported.body.id}/export?format=json`).set(dm);
    expect(detachedExport.status).toBe(200);
    const detachedCombatant = (detachedExport.body.encounters as Array<{ combatants: Array<Record<string, unknown>> }>)[0]
      .combatants[0];
    expect(detachedCombatant.compendiumSnapshot).toMatchObject({
      source: 'Open5e API',
      license: 'OGL 1.0a',
      attribution: 'Wizards of the Coast',
      author: 'Open5e Team',
      sourceUrl: 'https://open5e.com/monsters/goblin',
    });
  });

  it('blocks import on content hash mismatch (updated entry on target)', async () => {
    const ts = new Date().toISOString();
    await db
      .update(ruleEntries)
      .set({ name: 'Goblin (updated)', updatedAt: ts })
      .where(eq(ruleEntries.id, goblinEntryId));

    try {
      const preflight = await request(server).post('/api/v1/campaigns/import/preflight').set(dm).send(exportDoc);
      expect(preflight.body.references[0].status).toBe('hash_mismatch');

      const blocked = await request(server).post('/api/v1/campaigns/import').set(dm).send(exportDoc);
      expect(blocked.status).toBe(400);
    } finally {
      await db
        .update(ruleEntries)
        .set({ name: 'Goblin', updatedAt: ts })
        .where(eq(ruleEntries.id, goblinEntryId));
    }
  });

  it('reports missing_entry when pack is installed but slug is absent', async () => {
    const missingEntryDoc = structuredClone(exportDoc) as Record<string, unknown>;
    const enc = (missingEntryDoc.encounters as Array<Record<string, unknown>>)[0];
    const combatant = (enc.combatants as Array<Record<string, unknown>>)[0];
    combatant.compendiumRef = {
      ...(combatant.compendiumRef as Record<string, unknown>),
      entrySlug: 'missing-goblin',
    };

    const preflight = await request(server).post('/api/v1/campaigns/import/preflight').set(dm).send(missingEntryDoc);
    expect(preflight.body.references[0].status).toBe('missing_entry');

    const blocked = await request(server).post('/api/v1/campaigns/import').set(dm).send(missingEntryDoc);
    expect(blocked.status).toBe(400);
  });
});
