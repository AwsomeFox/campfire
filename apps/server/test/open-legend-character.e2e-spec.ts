import request from 'supertest';
import { eq } from 'drizzle-orm';
import { OPEN_LEGEND_ADAPTER_ID, OPEN_LEGEND_ATTRIBUTE_FIELDS } from '@campfire/schema';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { campaigns } from '../src/db/schema';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-open-legend' };

describe('Open Legend character sheets (e2e)', () => {
  let ctx: TestAppContext;
  let db: DrizzleDb;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    db = ctx.app.get(DB);
    const server = ctx.app.getHttpServer();
    const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Open Legend PCs' });
    expect(campaign.status).toBe(201);
    campaignId = campaign.body.id;
    await db.update(campaigns).set({ ruleSystem: OPEN_LEGEND_ADAPTER_ID }).where(eq(campaigns.id, campaignId));
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('preserves native attributes on edit and uses Agility for initiative after save', async () => {
    const server = ctx.app.getHttpServer();
    const nativeStats = Object.fromEntries(OPEN_LEGEND_ATTRIBUTE_FIELDS.map((field) => [field.key, 0]));
    nativeStats.AGILITY = 4;
    nativeStats.MIGHT = 5;
    nativeStats.ENERGY = 3;
    nativeStats.CUSTOM_NATIVE = 7;

    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({
        name: 'Kara',
        className: '',
        level: 1,
        hpMax: 20,
        hpCurrent: 20,
        ac: 14,
        stats: nativeStats,
      });
    expect(created.status).toBe(201);

    const saved = await request(server)
      .patch(`/api/v1/characters/${created.body.id}`)
      .set(dm)
      .send({ stats: { AGILITY: 5 } });
    expect(saved.status).toBe(200);
    expect(saved.body.className).toBe('');
    for (const field of OPEN_LEGEND_ATTRIBUTE_FIELDS) {
      expect(saved.body.stats).toHaveProperty(field.key);
    }
    expect(saved.body.stats).toMatchObject({
      AGILITY: 5,
      MIGHT: 5,
      ENERGY: 3,
      CUSTOM_NATIVE: 7,
    });

    const checks = await request(server).get(`/api/v1/characters/${created.body.id}/checks`).set(dm);
    expect(checks.status).toBe(200);
    expect(checks.body.find((check: { id: string; modifier: number }) => check.id === 'initiative')?.modifier).toBe(5);
  });
});
