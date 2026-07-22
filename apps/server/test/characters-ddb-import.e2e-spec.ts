import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { startFakeDdb, PUBLIC_DDB_CHARACTER, PUBLIC_DDB_CHARACTER_ID, type FakeDdb } from './fake-ddb';
import { mapDdbCharacter, parseDdbId } from '../src/modules/characters/ddb-importer';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { rulePacks } from '../src/db/schema';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'ddb-owner' };

/**
 * Issue #18 — D&D Beyond public character import. Two layers:
 *  1. Pure-mapper unit tests against the representative captured sheet in fake-ddb.ts
 *     (no server, no app) — the mapping is the load-bearing logic.
 *  2. Endpoint tests through the real Nest app, with the character-service base URL
 *     pointed at an in-process fake server (DDB_CHARACTER_SERVICE_BASE_URL), mirroring
 *     how the Open5e importer is tested against a fake API. Covers the happy path plus
 *     the private/404/unavailable clean-error paths.
 */
describe('D&D Beyond character import — mapper (unit)', () => {
  it('parseDdbId accepts a bare id and several URL shapes', () => {
    expect(parseDdbId('12345678')).toBe('12345678');
    expect(parseDdbId('https://www.dndbeyond.com/characters/12345678')).toBe('12345678');
    expect(parseDdbId('https://www.dndbeyond.com/profile/someone/characters/12345678')).toBe('12345678');
    expect(parseDdbId('  12345678  ')).toBe('12345678');
    expect(() => parseDdbId('not-a-character')).toThrow();
    expect(() => parseDdbId('')).toThrow();
  });

  it('maps a representative public sheet into a Campfire character', () => {
    const c = mapDdbCharacter(PUBLIC_DDB_CHARACTER);
    expect(c.name).toBe('Thornbeard Ironfist');
    expect(c.species).toBe('Hill Dwarf');
    // Multiclass -> per-class levels in the label; total level is the sum.
    expect(c.className).toBe('Fighter 3 / Rogue 2');
    expect(c.level).toBe(5);
    // Con 14 base + 2 racial ASI (from modifiers) = 16.
    expect(c.stats).toEqual({ STR: 16, DEX: 12, CON: 16, INT: 10, WIS: 13, CHA: 8 });
    // Chain mail (heavy AC 16, no Dex) + shield (+2) = 18.
    expect(c.ac).toBe(18);
    // 39 base + Con-mod(+3) * 5 levels = 54; 7 damage -> 47 current.
    expect(c.hpMax).toBe(54);
    expect(c.hpCurrent).toBe(47);
    expect(c.background).toBe('Soldier');
    expect(c.xp).toBe(6500);
    expect(c.ddbId).toBe(String(PUBLIC_DDB_CHARACTER_ID));
    expect(new Set(c.saveProficiencies)).toEqual(new Set(['STR', 'CON']));
    expect(c.skills).toEqual({ Perception: 'proficient', Stealth: 'expertise' });
    expect(c.portraitUrl).toBe('https://www.dndbeyond.com/avatars/thornbeard.png');
    expect(c.notes).toContain('left the mountain halls');
  });

  it('tolerates a sparse sheet without throwing', () => {
    const c = mapDdbCharacter({ name: 'Nobody' });
    expect(c.name).toBe('Nobody');
    expect(c.species).toBe('');
    expect(c.className).toBe('');
    expect(c.level).toBe(1);
    expect(c.stats).toEqual({});
    // No armor + no Dex score -> unarmored 10 + 0.
    expect(c.ac).toBe(10);
    expect(c.hpMax).toBe(1);
    expect(c.saveProficiencies).toEqual([]);
    expect(c.skills).toEqual({});
  });

  it('overrideStats and overrideHitPoints win over the computed values', () => {
    const c = mapDdbCharacter({
      name: 'Override',
      stats: [{ id: 1, value: 10 }],
      overrideStats: [{ id: 1, value: 20 }],
      overrideHitPoints: 123,
      classes: [{ level: 4, definition: { name: 'Wizard' } }],
    });
    expect(c.stats?.STR).toBe(20);
    expect(c.hpMax).toBe(123);
    expect(c.className).toBe('Wizard'); // single class, no subclass -> bare class name
    expect(c.level).toBe(4);
  });
});

describe('D&D Beyond character import — endpoint (e2e)', () => {
  let ctx: TestAppContext;
  let fake: FakeDdb;
  let campaignId: number;
  const prevBaseUrl = process.env.DDB_CHARACTER_SERVICE_BASE_URL;

  beforeAll(async () => {
    fake = await startFakeDdb();
    process.env.DDB_CHARACTER_SERVICE_BASE_URL = fake.baseUrl;
    ctx = await createTestApp();
    // Seed the rule packs these tests reference as installed, so campaign-create validation
    // (campaigns.service validateRuleSystem) accepts the slugs. Mirrors campaigns.e2e-spec.ts.
    // 'open5e-srd' is the real 5e pack slug; the gate suite also uses 'pf2e-srd' (incompatible)
    // and 'dnd5e' (the adapter family id, treated as installed here for the accept-case).
    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = new Date().toISOString();
    for (const slug of ['open5e-srd', 'pf2e-srd', 'dnd5e']) {
      await db
        .insert(rulePacks)
        .values({ slug, name: slug, version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 0 })
        .onConflictDoNothing();
    }
    const server = ctx.app.getHttpServer();
    // Issue #714: the import is only valid for an explicitly-D&D-5e campaign. The happy-path
    // tests below therefore create the campaign WITH the 5e SRD pack slug selected, mirroring
    // a real campaign where the DM has installed the Open5e pack. The gate-rejection cases
    // (incompatible / homebrew / malicious) live in their own describe block below.
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'DDB Import Campaign', ruleSystem: 'open5e-srd' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    await fake.close();
    if (prevBaseUrl === undefined) delete process.env.DDB_CHARACTER_SERVICE_BASE_URL;
    else process.env.DDB_CHARACTER_SERVICE_BASE_URL = prevBaseUrl;
  });

  it('imports a public sheet by ddbId (201) and persists the mapped character', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: String(PUBLIC_DDB_CHARACTER_ID) });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Thornbeard Ironfist');
    expect(res.body.species).toBe('Hill Dwarf');
    expect(res.body.className).toBe('Fighter 3 / Rogue 2');
    expect(res.body.level).toBe(5);
    expect(res.body.stats).toEqual({ STR: 16, DEX: 12, CON: 16, INT: 10, WIS: 13, CHA: 8 });
    expect(res.body.ac).toBe(18);
    expect(res.body.hpMax).toBe(54);
    expect(res.body.hpCurrent).toBe(47);
    expect(res.body.ddbId).toBe(String(PUBLIC_DDB_CHARACTER_ID));
    // Owner is the importing player (normal create ownership rules).
    expect(res.body.ownerUserId).toBe('dev:ddb-owner');

    // It's a real persisted character.
    const list = await request(server).get(`/api/v1/campaigns/${campaignId}/characters`).set(player);
    expect(list.body.some((c: { ddbId: string | null }) => c.ddbId === String(PUBLIC_DDB_CHARACTER_ID))).toBe(true);
  });

  it('imports by character URL (id parsed from the link)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({ url: `https://www.dndbeyond.com/characters/${PUBLIC_DDB_CHARACTER_ID}` });
    expect(res.status).toBe(201);
    expect(res.body.ddbId).toBe(String(PUBLIC_DDB_CHARACTER_ID));
  });

  it('private sheet (403) -> clean 400 with a make-it-public hint', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: '777' });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/private/i);
  });

  it('unavailable sheet (200 success:false) -> clean 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: '9999' });
    expect(res.status).toBe(400);
  });

  it('unknown id (404) -> clean 404', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: '424242' });
    expect(res.status).toBe(404);
  });

  it('empty body (neither ddbId nor url) -> 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({});
    expect(res.status).toBe(400);
  });
});

/**
 * Issue #714 — the import endpoint is the server-side enforcement of the same gate the UI
 * applies. A direct API request (curl, a scripted client, a browser extension bypassing the
 * form) must be rejected with 400 BEFORE any DDB network/parse work happens, so an
 * incompatible campaign can never end up with a character whose numbers belong to a
 * different game. These cases cover the three acceptance categories the issue calls out:
 *
 *   - incompatible: a real non-5e pack is selected (Pathfinder 2e) — different AC/HP/skill
 *     math; importing a 5e-shaped sheet would produce silently wrong numbers.
 *   - homebrew: no pack selected at all (empty `ruleSystem`). Combat still falls back to
 *     the 5e adapter, but that fallback is a default, not a declaration that the campaign
 *     IS 5e — the issue requires an EXPLICITLY compatible D&D pack.
 *   - malicious direct API: the gate must hold even when the request is otherwise perfectly
 *     formed (a valid public id, a logged-in owner). The system mismatch alone is the
 *     rejection reason, and the DDB service is never reached.
 *
 * The fake DDB server is shared with the happy-path suite; these tests assert it is NOT
 * contacted for a rejected campaign by checking the response is the system-gate 400 (not a
 * DDB-derived 400/404), which arrives before the fetch.
 */
describe('D&D Beyond import — system gate (issue #714)', () => {
  let ctx: TestAppContext;
  let fake: FakeDdb;
  const prevBaseUrl = process.env.DDB_CHARACTER_SERVICE_BASE_URL;

  beforeAll(async () => {
    fake = await startFakeDdb();
    process.env.DDB_CHARACTER_SERVICE_BASE_URL = fake.baseUrl;
    ctx = await createTestApp();
    // Seed the same slugs as the happy-path suite (separate app/DB instance).
    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = new Date().toISOString();
    for (const slug of ['open5e-srd', 'pf2e-srd', 'dnd5e']) {
      await db
        .insert(rulePacks)
        .values({ slug, name: slug, version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 0 })
        .onConflictDoNothing();
    }
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    await fake.close();
    if (prevBaseUrl === undefined) delete process.env.DDB_CHARACTER_SERVICE_BASE_URL;
    else process.env.DDB_CHARACTER_SERVICE_BASE_URL = prevBaseUrl;
  });

  async function createCampaign(ruleSystem?: string): Promise<number> {
    const server = ctx.app.getHttpServer();
    const body: { name: string; ruleSystem?: string } = { name: `714 Gate Campaign ${Math.random()}` };
    if (ruleSystem !== undefined) body.ruleSystem = ruleSystem;
    const res = await request(server).post('/api/v1/campaigns').set(dm).send(body);
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  it('REJECTS a Pathfinder 2e campaign with 400 before reaching DDB (incompatible system)', async () => {
    // Reset the fake's request counter: any hit after this means the gate leaked.
    fake.resetHitCount();
    const pf2eCampaignId = await createCampaign('pf2e-srd');

    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${pf2eCampaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: String(PUBLIC_DDB_CHARACTER_ID) }); // a valid public id — the system is the only problem

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/5e|D&D Beyond|rule system/i);
    // The gate ran before the fetch, so the fake was never contacted.
    expect(fake.hitCount).toBe(0);
  });

  it('REJECTS a homebrew campaign (no ruleSystem) with 400 — fallback-to-5e is not "explicitly 5e"', async () => {
    fake.resetHitCount();
    const homebrewCampaignId = await createCampaign(); // no ruleSystem -> homebrew

    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${homebrewCampaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: String(PUBLIC_DDB_CHARACTER_ID) });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/5e|D&D Beyond|rule system/i);
    expect(fake.hitCount).toBe(0);
  });

  it('REJECTS a campaign whose ruleSystem slug is unrecognized (e.g. an uninstalled pack)', async () => {
    fake.resetHitCount();
    // The campaigns service refuses to CREATE a campaign with an unknown slug (validateRuleSystem),
    // so the realistic way a campaign ends up with one is: the pack was installed, the campaign
    // selected it, then the pack was uninstalled — leaving a stale slug in the row. Simulate that
    // by creating a homebrew campaign and writing the stale slug straight to the DB.
    const staleCampaignId = await createCampaign(); // homebrew, then stamp a stale slug below
    const db = ctx.app.get<DrizzleDb>(DB);
    const { eq } = await import('drizzle-orm');
    const { campaigns: campaignsTable } = await import('../src/db/schema');
    await db.update(campaignsTable).set({ ruleSystem: 'my-uninstalled-5e-ish' }).where(eq(campaignsTable.id, staleCampaignId));

    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${staleCampaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: String(PUBLIC_DDB_CHARACTER_ID) });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/5e|D&D Beyond|rule system/i);
    expect(fake.hitCount).toBe(0);
  });

  it('malicious direct-API: a perfectly-formed request is still rejected on a non-5e campaign', async () => {
    fake.resetHitCount();
    // Same id the happy path imports successfully — proves the ONLY difference is the system.
    const pf2eCampaignId = await createCampaign('pf2e-srd');

    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${pf2eCampaignId}/characters/import-ddb`)
      .set(player)
      .send({ url: `https://www.dndbeyond.com/characters/${PUBLIC_DDB_CHARACTER_ID}` });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/5e|D&D Beyond|rule system/i);
    expect(fake.hitCount).toBe(0);
  });

  it('ACCEPTS the import on an explicitly-5e campaign (the family id resolves to the 5e adapter)', async () => {
    fake.resetHitCount();
    // 'dnd5e' is the adapter family id; a campaign could store it directly. It must be
    // recognized as explicitly-5e, not rejected as an unknown slug.
    const dnd5eCampaignId = await createCampaign('dnd5e');

    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${dnd5eCampaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: String(PUBLIC_DDB_CHARACTER_ID) });

    expect(res.status).toBe(201);
    expect(res.body.ddbId).toBe(String(PUBLIC_DDB_CHARACTER_ID));
    // And in this case the fake WAS contacted — proves the counter is wired correctly and
    // the 0-assertions above aren't passing because the counter is broken.
    expect(fake.hitCount).toBe(1);
  });
});
