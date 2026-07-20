import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { diceRolls } from '../src/db/schema';
import { MAX_ROLLS_PER_CAMPAIGN } from '../src/modules/rolls/rolls.service';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('shared dice log (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Dice Campaign' });
    campaignId = campRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('POST /campaigns/:id/roll returns a persisted roll with roller identity', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(player).send({ expr: '2d6+1' });
    expect(res.status).toBe(201);
    // Old RollResult shape is preserved (backward compatible)...
    expect(res.body.expr).toBe('2d6+1');
    expect(res.body.rolls).toHaveLength(2);
    const diceSum = res.body.rolls.reduce((s: number, r: number) => s + r, 0);
    expect(res.body.total).toBe(diceSum + 1);
    // ...plus persistence + authorship.
    expect(typeof res.body.id).toBe('number');
    expect(res.body.campaignId).toBe(campaignId);
    expect(res.body.rollerUserId).toBe('dev:p-1');
    expect(typeof res.body.rollerName).toBe('string');
    expect(typeof res.body.createdAt).toBe('string');
  });

  it('accepts advantage (2d20kh1): rolls both d20s, keeps the higher, total = kept', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(player).send({ expr: '2d20kh1' });
    expect(res.status).toBe(201);
    expect(res.body.expr).toBe('2d20kh1');
    expect(res.body.rolls).toHaveLength(2); // both dice recorded (attestable)
    expect(res.body.kept).toHaveLength(1);
    expect(res.body.kept[0]).toBe(Math.max(res.body.rolls[0], res.body.rolls[1]));
    expect(res.body.total).toBe(res.body.kept[0]);
  });

  it('records a labelled check with a DC and computes success server-side', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/roll`)
      .set(player)
      .send({ expr: '1d20+100', label: 'DEX save', dc: 15 });
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('DEX save');
    expect(res.body.dc).toBe(15);
    // 1d20+100 is always >= 15, so success is deterministic here.
    expect(res.body.success).toBe(true);
  });

  it('rejects an unsupported keep clause (2d20kh3 keeps more dice than rolled)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(player).send({ expr: '2d20kh3' });
    expect(res.status).toBe(400);
  });

  it('other members see the roll in GET /campaigns/:id/rolls (shared feed, newest first)', async () => {
    const server = ctx.app.getHttpServer();
    const dmRoll = await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(dm).send({ expr: '1d20' });
    expect(dmRoll.status).toBe(201);

    // The viewer rolled nothing, but sees both the player's and the dm's rolls.
    const res = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls`).set(viewer);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    const rollers = res.body.map((r: { rollerUserId: string }) => r.rollerUserId);
    expect(rollers).toContain('dev:p-1');
    expect(rollers).toContain('dev:dm-1');
    // Newest first: the dm's roll (made after the player's) comes before it.
    expect(res.body.findIndex((r: { rollerUserId: string }) => r.rollerUserId === 'dev:dm-1')).toBeLessThan(
      res.body.findIndex((r: { rollerUserId: string }) => r.rollerUserId === 'dev:p-1'),
    );
    // Ids strictly descending.
    const ids = res.body.map((r: { id: number }) => r.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
  });

  it('viewer may roll too — any member, not gated by role', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(viewer).send({ expr: 'd20' });
    expect(res.status).toBe(201);
    expect(res.body.rollerUserId).toBe('dev:v-1');
  });

  it('limit query param caps the feed (lenient: bad values fall back to default)', async () => {
    const server = ctx.app.getHttpServer();
    const limited = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls`).query({ limit: 1 }).set(player);
    expect(limited.status).toBe(200);
    expect(limited.body).toHaveLength(1);

    const junk = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls`).query({ limit: 'wat' }).set(player);
    expect(junk.status).toBe(200);
    expect(junk.body.length).toBeGreaterThanOrEqual(3);
  });

  it('malformed dice expression still 400s and persists nothing', async () => {
    const server = ctx.app.getHttpServer();
    const before = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls`).set(player);
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(player).send({ expr: '1d7' });
    expect(res.status).toBe(400);
    const after = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls`).set(player);
    expect(after.body.length).toBe(before.body.length);
  });

  it('rolls are scoped per campaign — another campaign has its own empty feed', async () => {
    const server = ctx.app.getHttpServer();
    const otherRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Campaign' });
    const otherId = otherRes.body.id;
    const res = await request(server).get(`/api/v1/campaigns/${otherId}/rolls`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it(`retention: history is pruned to the newest ${MAX_ROLLS_PER_CAMPAIGN} rolls per campaign`, async () => {
    const server = ctx.app.getHttpServer();
    const db = ctx.app.get<DrizzleDb>(DB);

    // Seed a fresh campaign with MAX old rows directly (cheaper than 200+ HTTP posts),
    // then one real roll over the top must push the oldest out.
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Prune Campaign' });
    const pruneId = campRes.body.id;
    const ts = new Date().toISOString();
    for (let i = 0; i < MAX_ROLLS_PER_CAMPAIGN; i++) {
      await db.insert(diceRolls).values({
        campaignId: pruneId,
        rollerUserId: 'dev:dm-1',
        rollerName: 'dm-1',
        expr: '1d20',
        rolls: '[10]',
        total: 10,
        createdAt: ts,
      });
    }

    const rollRes = await request(server).post(`/api/v1/campaigns/${pruneId}/roll`).set(dm).send({ expr: '1d4' });
    expect(rollRes.status).toBe(201);

    // Stored rows for this campaign are exactly the cap — the oldest was pruned,
    // the fresh roll survived at the top.
    const stored = await db.select({ id: diceRolls.id }).from(diceRolls).where(eq(diceRolls.campaignId, pruneId));
    expect(stored).toHaveLength(MAX_ROLLS_PER_CAMPAIGN);

    const feed = await request(server).get(`/api/v1/campaigns/${pruneId}/rolls`).query({ limit: 1 }).set(dm);
    expect(feed.status).toBe(200);
    expect(feed.body[0].id).toBe(rollRes.body.id);
    expect(feed.body[0].expr).toBe('1d4');

    // Cap is per campaign, not global: the main campaign's feed was untouched.
    const feedMain = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls`).set(dm);
    expect(feedMain.body.length).toBeGreaterThanOrEqual(3);
  });
});
