import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { startFakeDdb, PUBLIC_DDB_CHARACTER, PUBLIC_DDB_CHARACTER_ID, type FakeDdb } from './fake-ddb';
import { mapDdbCharacter, parseDdbId } from '../src/modules/characters/ddb-importer';

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
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'DDB Import Campaign' });
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
