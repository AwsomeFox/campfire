import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const owner = { 'x-dev-role': 'player', 'x-dev-user': 'owner-1' };
const nonOwner = { 'x-dev-role': 'player', 'x-dev-user': 'other-1' };

// Issue #14: XP tracking + guided level-up.
describe('xp & levelling (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let characterId: number; // owned by owner-1
  let secondCharacterId: number; // DM-managed
  const legacyIds = {} as Record<'dead' | 'retired' | 'inactive', number>;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campaignRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'XP Campaign' });
    campaignId = campaignRes.body.id;

    const charRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(owner)
      .send({ name: 'Grindy McLevels', hpMax: 12, hpCurrent: 12 });
    expect(charRes.status).toBe(201);
    characterId = charRes.body.id;

    const char2Res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Sidekick', hpMax: 8, hpCurrent: 8 });
    expect(char2Res.status).toBe(201);
    secondCharacterId = char2Res.body.id;

    for (const [status, xp] of [['dead', 100], ['retired', 200], ['inactive', 300]] as const) {
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: `${status[0].toUpperCase()}${status.slice(1)} Hero`, status, xp });
      expect(res.status).toBe(201);
      legacyIds[status] = res.body.id;
    }
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('new characters start with xp 0', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/characters/${characterId}`).set(owner);
    expect(res.status).toBe(200);
    expect(res.body.xp).toBe(0);
    expect(res.body.level).toBe(1);
  });

  it('xp delta accrues', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(owner).send({ delta: 250 });
    expect(res.status).toBe(201);
    expect(res.body.xp).toBe(250);
  });

  it('xp set is absolute', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(dm).send({ set: 300 });
    expect(res.status).toBe(201);
    expect(res.body.xp).toBe(300);
  });

  it('xp clamps at 0 (never negative)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(owner).send({ delta: -9999 });
    expect(res.status).toBe(201);
    expect(res.body.xp).toBe(0);
  });

  it('non-owner, non-dm player gets 403 on xp patch', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(nonOwner).send({ delta: 100 });
    expect(res.status).toBe(403);
  });

  it('negative xp set -> 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/xp`).set(owner).send({ set: -5 });
    expect(res.status).toBe(400);
  });

  // ---------- party award ----------

  it('dm party award defaults to active characters and leaves mixed legacy roster untouched', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/characters/xp`).set(dm).send({ amount: 300 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    const byId = new Map<number, { xp: number }>(res.body.map((c: { id: number; xp: number }) => [c.id, c]));
    expect(byId.get(characterId)!.xp).toBe(300); // was clamped to 0 above
    expect(byId.get(secondCharacterId)!.xp).toBe(300);

    for (const [status, xp] of [['dead', 100], ['retired', 200], ['inactive', 300]] as const) {
      const legacy = await request(server).get(`/api/v1/characters/${legacyIds[status]}`).set(dm);
      expect(legacy.body).toMatchObject({ status, xp });
    }
  });

  it('dm awards xp to a characterIds subset only', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/xp`)
      .set(dm)
      .send({ amount: 600, characterIds: [characterId] });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(characterId);
    expect(res.body[0].xp).toBe(900); // 300 + 600 — enough for level 2 (5e threshold: 300) and 3 (900)

    const other = await request(server).get(`/api/v1/characters/${secondCharacterId}`).set(dm);
    expect(other.body.xp).toBe(300); // untouched
  });

  it('player (even a character owner) gets 403 on party award', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/characters/xp`).set(owner).send({ amount: 100 });
    expect(res.status).toBe(403);
  });

  it('rejects a selected non-active recipient without opt-in and rolls the whole mixed selection back', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/xp`)
      .set(dm)
      .send({ amount: 50, characterIds: [characterId, legacyIds.retired] });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('includeNonActive');

    const [active, retired] = await Promise.all([
      request(server).get(`/api/v1/characters/${characterId}`).set(dm),
      request(server).get(`/api/v1/characters/${legacyIds.retired}`).set(dm),
    ]);
    expect(active.body.xp).toBe(900);
    expect(retired.body.xp).toBe(200);
  });

  it('rejects a broad non-active opt-in without explicit recipient IDs', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/xp`)
      .set(dm)
      .send({ amount: 50, includeNonActive: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('explicit characterIds');
  });

  it('preserves a deliberate retired-character correction with explicit selection and opt-in, and audits status-at-award', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/xp`)
      .set(dm)
      .send({ amount: 75, characterIds: [legacyIds.retired], includeNonActive: true });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: legacyIds.retired, status: 'retired', xp: 275 });

    const audit = await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
    const entry = audit.body.find((row: { action: string; detail: string }) => {
      if (row.action !== 'character.xp_award') return false;
      const detail = JSON.parse(row.detail) as { recipients?: Array<{ characterId: number }> };
      return detail.recipients?.some((recipient) => recipient.characterId === legacyIds.retired);
    });
    expect(entry).toBeDefined();
    expect(JSON.parse(entry.detail)).toEqual({
      amount: 75,
      recipients: [{
        characterId: legacyIds.retired,
        name: 'Retired Hero',
        status: 'retired',
        xpBefore: 200,
        xpAfter: 275,
      }],
    });
  });

  it('party award with a foreign characterId -> 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/xp`)
      .set(dm)
      .send({ amount: 100, characterIds: [characterId, 999999] });
    expect(res.status).toBe(400);
    const unchanged = await request(server).get(`/api/v1/characters/${characterId}`).set(dm);
    expect(unchanged.body.xp).toBe(900);
  });

  it('party award rejects duplicate recipient IDs at the schema boundary', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/xp`)
      .set(dm)
      .send({ amount: 100, characterIds: [characterId, characterId] });
    expect(res.status).toBe(400);
  });

  it('party award amount must be positive', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/characters/xp`).set(dm).send({ amount: 0 });
    expect(res.status).toBe(400);
  });

  it('composes concurrent exact-recipient awards without losing either increment', async () => {
    const server = ctx.app.getHttpServer();
    const [first, second] = await Promise.all([
      request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters/xp`)
        .set(dm)
        .send({ amount: 11, characterIds: [secondCharacterId] }),
      request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters/xp`)
        .set(dm)
        .send({ amount: 13, characterIds: [secondCharacterId] }),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const current = await request(server).get(`/api/v1/characters/${secondCharacterId}`).set(dm);
    expect(current.body.xp).toBe(324); // 300 + 11 + 13
  });

  // ---------- guided level-up ----------

  it('level-up bumps level and grows hp (gained hp added to current)', async () => {
    const server = ctx.app.getHttpServer();
    // Take some damage first so we can verify the delta-based heal (12 -> 5).
    const dmg = await request(server).post(`/api/v1/characters/${characterId}/hp`).set(owner).send({ set: 5 });
    expect(dmg.body.hpCurrent).toBe(5);

    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/level-up`)
      .set(owner)
      .send({ hpMax: 19 });
    expect(res.status).toBe(201);
    expect(res.body.level).toBe(2);
    expect(res.body.hpMax).toBe(19);
    expect(res.body.hpCurrent).toBe(12); // 5 + (19 - 12) gained — damage taken is kept
  });

  it('level-up without hpMax just bumps the level', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/level-up`).set(dm).send({});
    expect(res.status).toBe(201);
    expect(res.body.level).toBe(3);
    expect(res.body.hpMax).toBe(19);
    expect(res.body.hpCurrent).toBe(12);
  });

  it('non-owner, non-dm player gets 403 on level-up', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${characterId}/level-up`).set(nonOwner).send({});
    expect(res.status).toBe(403);
  });

  it('level-up at 20 -> 400', async () => {
    const server = ctx.app.getHttpServer();
    const patch = await request(server).patch(`/api/v1/characters/${secondCharacterId}`).set(dm).send({ level: 20 });
    expect(patch.status).toBe(200);
    const res = await request(server).post(`/api/v1/characters/${secondCharacterId}/level-up`).set(dm).send({});
    expect(res.status).toBe(400);
  });

  it('unknown key in level-up body -> 400 (strict DTO)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/characters/${characterId}/level-up`)
      .set(dm)
      .send({ hp: 30 }); // real field is hpMax
    expect(res.status).toBe(400);
  });

  it('xp is patchable via PATCH /characters/:id too (escape hatch)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/characters/${characterId}`).set(dm).send({ xp: 1234 });
    expect(res.status).toBe(200);
    expect(res.body.xp).toBe(1234);
  });
});

describe('party XP transaction atomicity against the real SQLite database (issue #814)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('rolls XP back when the audit write fails', async () => {
    const server = ctx.app.getHttpServer();
    const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Atomic XP' });
    const character = await request(server)
      .post(`/api/v1/campaigns/${campaign.body.id}/characters`)
      .set(dm)
      .send({ name: 'Transaction Tester', xp: 40 });

    // Force the final statement in CharactersService.awardXp's transaction to fail.
    const db = ctx.app.get<DrizzleDb>(DB);
    db.run(sql`DROP TABLE audit_log`);

    const award = await request(server)
      .post(`/api/v1/campaigns/${campaign.body.id}/characters/xp`)
      .set(dm)
      .send({ amount: 10, characterIds: [character.body.id] });
    expect(award.status).toBe(500);

    const unchanged = await request(server).get(`/api/v1/characters/${character.body.id}`).set(dm);
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.xp).toBe(40);
  });
});
