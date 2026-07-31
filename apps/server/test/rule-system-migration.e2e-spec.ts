import request from 'supertest';
import { OPEN_LEGEND_ADAPTER_ID, DND5E_PACK_SLUG } from '@campfire/schema';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { rulePacks } from '../src/db/schema';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-rule-migration' };

describe('mid-campaign ruleSystem migration (issue #1508, e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let db: DrizzleDb;
  let campaignId: number;
  let characterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    db = ctx.app.get<DrizzleDb>(DB);

    const ts = new Date().toISOString();
    // Ensure both open-legend and open5e-srd packs exist in db for validateRuleSystem
    await db
      .insert(rulePacks)
      .values([
        {
          slug: OPEN_LEGEND_ADAPTER_ID,
          name: 'Open Legend',
          version: '1.0.0',
          license: 'CC-BY-SA-4.0',
          installedAt: ts,
          entryCount: 1,
        },
        {
          slug: DND5E_PACK_SLUG,
          name: 'D&D 5e SRD',
          version: '1.0.0',
          license: 'OGL 1.0a',
          installedAt: ts,
          entryCount: 10,
        },
      ])
      .onConflictDoNothing();

    // Create campaign with Open Legend system
    const campRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Migration Campaign', ruleSystem: OPEN_LEGEND_ADAPTER_ID });
    expect(campRes.status).toBe(201);
    campaignId = campRes.body.id;

    // Create a level 25 Open Legend character (allowed under Open Legend's maxLevel: Infinity)
    const charRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({
        name: 'Aurelius',
        level: 25,
        hpMax: 100,
        hpCurrent: 100,
        stats: { MIGHT: 18, GRACE: 14 },
      });
    expect(charRes.status).toBe(201);
    characterId = charRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('preserves stored character data when switching ruleSystem and reinterprets mechanics under new adapter', async () => {
    // 1. Verify initial Open Legend check catalog returns native attributes
    const initialChecks = await request(server)
      .get(`/api/v1/characters/${characterId}/checks`)
      .set(dm);
    expect(initialChecks.status).toBe(200);
    const initialAbilities = initialChecks.body
      .filter((c: { category: string }) => c.category === 'ability')
      .map((c: { ability: string }) => c.ability);
    expect(initialAbilities).toContain('MIGHT');

    // 2. PATCH campaign ruleSystem to open5e-srd
    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${campaignId}`)
      .set(dm)
      .send({ ruleSystem: DND5E_PACK_SLUG });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.ruleSystem).toBe(DND5E_PACK_SLUG);

    // 3. Stored character data remains preserved
    const charRes = await request(server)
      .get(`/api/v1/characters/${characterId}`)
      .set(dm);
    expect(charRes.status).toBe(200);
    expect(charRes.body.level).toBe(25);
    expect(charRes.body.stats).toMatchObject({ MIGHT: 18, GRACE: 14 });

    // 4. Check catalog reinterprets under 5e adapter (STR/DEX/CON/INT/WIS/CHA)
    const newChecks = await request(server)
      .get(`/api/v1/characters/${characterId}/checks`)
      .set(dm);
    expect(newChecks.status).toBe(200);
    const newAbilities = newChecks.body
      .filter((c: { category: string }) => c.category === 'ability')
      .map((c: { ability: string }) => c.ability);
    expect(newAbilities).toEqual(expect.arrayContaining(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']));

    // 5. Level-up API now enforces 5e maxLevel 20 cap on the level 25 character
    const levelUpRes = await request(server)
      .post(`/api/v1/characters/${characterId}/level-up`)
      .set(dm);
    expect(levelUpRes.status).toBe(400);
    expect(levelUpRes.body.message).toMatch(/Already at level 20|maximum level|max level|cannot level up/i);
  });
});
