import request from 'supertest';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { rulePacks, ruleEntries } from '../src/db/schema';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'p-2' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

describe('encounters (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let ownedCharacterId: number;
  let ruleEntryId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();

    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Encounter Campaign' });
    campaignId = campRes.body.id;

    // Party member with DEX 16 (mod +3), owned by "dev:p-1" (see character ownership
    // convention: dev-header players carry serverRole admin but ownerUserId is still set
    // explicitly here so the player-owns-combatant path can be exercised for real).
    const charRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Aria', stats: { DEX: 16 }, hpCurrent: 20, hpMax: 20, ownerUserId: 'dev:p-1' });
    expect(charRes.status).toBe(201);
    ownedCharacterId = charRes.body.id;

    // Seed a rule pack + a monster rule entry directly via the DB (simplest path — no
    // network dependency on the Open5e fake server for a single fixture row).
    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = new Date().toISOString();
    const [pack] = await db
      .insert(rulePacks)
      .values({ slug: 'test-pack', name: 'Test Pack', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 1 })
      .returning();
    const [entry] = await db
      .insert(ruleEntries)
      .values({
        packId: pack.id,
        slug: 'test-goblin',
        name: 'Test Goblin',
        type: 'monster',
        summary: 'CR 0.25',
        body: '',
        dataJson: JSON.stringify({ hitPoints: 7 }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    ruleEntryId = entry.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('create auto-adds the party with DEX-derived initMod', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Goblin Ambush' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('preparing');
    expect(res.body.round).toBe(0);
    expect(res.body.combatants).toHaveLength(1);
    const aria = res.body.combatants[0];
    expect(aria.characterId).toBe(ownedCharacterId);
    expect(aria.kind).toBe('character');
    expect(aria.name).toBe('Aria');
    expect(aria.initMod).toBe(3); // floor((16-10)/2)
    expect(aria.hpCurrent).toBe(20);
    expect(aria.hpMax).toBe(20);
    expect(aria.initiative).toBeNull();
  });

  it('player without dm role cannot create an encounter', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(player).send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });

  describe('full combat flow', () => {
    let encounterId: number;
    let monsterId: number;
    let ruleMonsterId: number;
    let ariaCombatantId: number;

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'The Big Fight' });
      encounterId = res.body.id;
      ariaCombatantId = res.body.combatants[0].id;
    });

    it('member can GET the encounter', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(encounterId);
    });

    it('GET /campaigns/:id/encounters lists it, filterable by status', async () => {
      const server = ctx.app.getHttpServer();
      const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(player);
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((e: { id: number }) => e.id === encounterId)).toBe(true);

      const filteredRes = await request(server)
        .get(`/api/v1/campaigns/${campaignId}/encounters`)
        .query({ status: 'preparing' })
        .set(player);
      expect(filteredRes.status).toBe(200);
      expect(filteredRes.body.every((e: { status: string }) => e.status === 'preparing')).toBe(true);
    });

    it('dm adds a manual monster combatant', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Ogre', hpMax: 59, initMod: -1 });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Ogre');
      expect(res.body.hpMax).toBe(59);
      expect(res.body.hpCurrent).toBe(59);
      expect(res.body.kind).toBe('monster');
      monsterId = res.body.id;
    });

    it('dm adds a monster from a seeded rule entry (name + hp resolved from dataJson)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', ruleEntryId });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Test Goblin');
      expect(res.body.hpMax).toBe(7);
      expect(res.body.hpCurrent).toBe(7);
      expect(res.body.ruleEntryId).toBe(ruleEntryId);
      ruleMonsterId = res.body.id;
    });

    it('unresolvable combatant (no name, no ruleEntryId, no hpMax) is rejected 400', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster' });
      expect(res.status).toBe(400);
    });

    it('player cannot add a combatant', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(player)
        .send({ kind: 'monster', name: 'Sneaky', hpMax: 5 });
      expect(res.status).toBe(403);
    });

    it('starting before initiative is rolled is rejected 400', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
      expect(res.status).toBe(400);
    });

    it('roll-initiative fills only null initiatives', async () => {
      const server = ctx.app.getHttpServer();

      // Manually set the ogre's initiative first so we can prove roll-initiative
      // leaves it untouched.
      const setRes = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterId}`)
        .set(dm)
        .send({ initiative: 99 });
      expect(setRes.status).toBe(200);
      expect(setRes.body.initiative).toBe(99);

      const rollRes = await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
      expect(rollRes.status).toBe(201);
      for (const c of rollRes.body.combatants as Array<{ id: number; initiative: number | null }>) {
        expect(c.initiative).not.toBeNull();
      }
      const ogre = (rollRes.body.combatants as Array<{ id: number; initiative: number }>).find((c) => c.id === monsterId);
      expect(ogre?.initiative).toBe(99); // untouched by roll-initiative
    });

    it('dm starts the encounter: running, round=1, turnIndex=0, sorted by initiative desc', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('running');
      expect(res.body.round).toBe(1);
      expect(res.body.turnIndex).toBe(0);

      const initiatives = (res.body.combatants as Array<{ initiative: number }>).map((c) => c.initiative);
      const sorted = [...initiatives].sort((a, b) => b - a);
      expect(initiatives).toEqual(sorted);
    });

    it('next-turn advances turnIndex and wraps to round+1', async () => {
      const server = ctx.app.getHttpServer();

      const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const combatantCount = getRes.body.combatants.length;

      let lastBody: { round: number; turnIndex: number } = { round: 1, turnIndex: 0 };
      for (let i = 0; i < combatantCount; i++) {
        const res = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm);
        expect(res.status).toBe(201);
        lastBody = res.body;
      }
      // after exactly `combatantCount` advances from turnIndex 0, we wrap once
      expect(lastBody.round).toBe(2);
      expect(lastBody.turnIndex).toBe(0);
    });

    it('owning player can adjust their own combatant hp', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`)
        .set(player)
        .send({ hpDelta: -5 });
      expect(res.status).toBe(200);
      expect(res.body.hpCurrent).toBe(15);
    });

    it('non-owning player gets 403 modifying someone else’s combatant', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`)
        .set(otherPlayer)
        .send({ hpDelta: -1 });
      expect(res.status).toBe(403);
    });

    it('player cannot set initiative on their own combatant', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`)
        .set(player)
        .send({ initiative: 5 });
      expect(res.status).toBe(403);
    });

    it('player cannot modify a monster combatant (not theirs)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterId}`)
        .set(player)
        .send({ hpDelta: -1 });
      expect(res.status).toBe(403);
    });

    it('dm can modify any combatant, including conditions', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterId}`)
        .set(dm)
        .send({ hpDelta: -10, addConditions: ['prone'] });
      expect(res.status).toBe(200);
      expect(res.body.hpCurrent).toBe(49);
      expect(res.body.conditions).toEqual(['prone']);
    });

    it('hp is clamped between 0 and hpMax', async () => {
      const server = ctx.app.getHttpServer();

      const overheal = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterId}`)
        .set(dm)
        .send({ hpSet: 9999 });
      expect(overheal.status).toBe(200);
      expect(overheal.body.hpCurrent).toBe(59); // clamped to hpMax

      const overkill = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterId}`)
        .set(dm)
        .send({ hpDelta: -99999 });
      expect(overkill.status).toBe(200);
      expect(overkill.body.hpCurrent).toBe(0); // clamped to 0
    });

    it('dm removes a combatant', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${ruleMonsterId}`).set(dm);
      expect(res.status).toBe(200);

      const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      expect(getRes.body.combatants.some((c: { id: number }) => c.id === ruleMonsterId)).toBe(false);
    });

    it('combatant routes 404 when encounterId doesn\'t own the combatant (cross-parent-id pin)', async () => {
      const server = ctx.app.getHttpServer();

      // A second, unrelated encounter in the same campaign.
      const otherEncRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Unrelated Fight' });
      const otherEncounterId = otherEncRes.body.id;

      // ariaCombatantId belongs to `encounterId`, not `otherEncounterId`.
      const wrongPatch = await request(server)
        .patch(`/api/v1/encounters/${otherEncounterId}/combatants/${ariaCombatantId}`)
        .set(dm)
        .send({ hpDelta: -1 });
      expect(wrongPatch.status).toBe(404);

      const wrongDelete = await request(server).delete(`/api/v1/encounters/${otherEncounterId}/combatants/${ariaCombatantId}`).set(dm);
      expect(wrongDelete.status).toBe(404);
    });

    it('dangling ruleEntryId (nonexistent rule entry) is rejected 400', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', ruleEntryId: 999_999 });
      expect(res.status).toBe(400);
    });

    it('characterId belonging to a different campaign is rejected 404 (round-2 finding #5)', async () => {
      const server = ctx.app.getHttpServer();

      // A second campaign with its own character — not a member of `campaignId`.
      const otherCampRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Campaign' });
      const otherCampaignId = otherCampRes.body.id;
      const otherCharRes = await request(server)
        .post(`/api/v1/campaigns/${otherCampaignId}/characters`)
        .set(dm)
        .send({ name: 'Foreign Character', stats: { DEX: 10 }, hpCurrent: 5, hpMax: 5 });
      expect(otherCharRes.status).toBe(201);
      const otherCharacterId = otherCharRes.body.id;

      // encounterId belongs to `campaignId` — the foreign character must not be addable.
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'character', characterId: otherCharacterId });
      expect(res.status).toBe(404);
    });

    it('/next-turn on a non-running encounter is rejected 400 (state machine, verify existing guard)', async () => {
      // `encounterId` is currently 'running' at this point in the suite (started earlier) —
      // exercise the guard against a fresh 'preparing' encounter instead.
      const server = ctx.app.getHttpServer();
      const freshRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Not Started Yet' });
      const freshId = freshRes.body.id;

      const res = await request(server).post(`/api/v1/encounters/${freshId}/next-turn`).set(dm);
      expect(res.status).toBe(400);
    });

    it('/end on a non-running (preparing) encounter is rejected 400', async () => {
      const server = ctx.app.getHttpServer();
      const freshRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Never Started' });
      const freshId = freshRes.body.id;

      const res = await request(server).post(`/api/v1/encounters/${freshId}/end`).set(dm);
      expect(res.status).toBe(400);
    });

    it('dm ends the encounter and character hp is written back', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/encounters/${encounterId}/end`).set(dm);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ended');
      expect(res.body.endedAt).not.toBeNull();

      const charRes = await request(server).get(`/api/v1/characters/${ownedCharacterId}`).set(dm);
      expect(charRes.status).toBe(200);
      expect(charRes.body.hpCurrent).toBe(15); // matches the combatant's hp at end time
    });

    it('/start on an already-ended encounter is rejected 400 (no stale-endedAt revival)', async () => {
      // `encounterId` is now 'ended' from the previous test.
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
      expect(res.status).toBe(400);
    });

    it('/end on an already-ended encounter is rejected 400 (no double-fire)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/encounters/${encounterId}/end`).set(dm);
      expect(res.status).toBe(400);
    });

    it('dm deletes the encounter', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).delete(`/api/v1/encounters/${encounterId}`).set(dm);
      expect(res.status).toBe(200);

      const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      expect(getRes.status).toBe(404);
    });
  });

  describe('viewer access', () => {
    it('viewer can read but not create encounters', async () => {
      const server = ctx.app.getHttpServer();
      const listRes = await request(server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(viewer);
      expect(listRes.status).toBe(200);

      const createRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(viewer).send({ name: 'Nope' });
      expect(createRes.status).toBe(403);
    });
  });

  describe('dice rolling', () => {
    it('2d6+3 rolls two d6 and returns the correct shape/range', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(player).send({ expr: '2d6+3' });
      expect(res.status).toBe(201);
      expect(res.body.expr).toBe('2d6+3');
      expect(res.body.rolls).toHaveLength(2);
      for (const r of res.body.rolls) {
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(6);
      }
      const rollSum = (res.body.rolls as number[]).reduce((a, b) => a + b, 0);
      expect(res.body.total).toBe(rollSum + 3);
      expect(res.body.total).toBeGreaterThanOrEqual(5); // 1+1+3
      expect(res.body.total).toBeLessThanOrEqual(15); // 6+6+3
    });

    it('any member (including viewer) may roll', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(viewer).send({ expr: '1d20' });
      expect(res.status).toBe(201);
    });

    it('99d99 is rejected (400 - invalid sides)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(player).send({ expr: '99d99' });
      expect(res.status).toBe(400);
    });

    it('1d7 is rejected (400 - not a standard die)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(player).send({ expr: '1d7' });
      expect(res.status).toBe(400);
    });

    it('"x" is rejected (400 - doesn\'t match the expression pattern at all)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/roll`).set(player).send({ expr: 'x' });
      expect(res.status).toBe(400);
    });

    it('a roll audit entry exists', async () => {
      const db = ctx.app.get<DrizzleDb>(DB);
      const { auditLog } = await import('../src/db/schema');
      const { eq } = await import('drizzle-orm');
      const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'dice.roll'));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => r.campaignId === campaignId)).toBe(true);
    });
  });
});

// Dev-auth headers (x-dev-role/x-dev-user) always resolve to serverRole 'admin', and admins
// are always treated as dm regardless of campaign membership (see RoleResolver.baseEffectiveRole)
// — so a genuine "not a member" 403 can't be expressed with dev-auth users. Use real
// cookie-session users instead, same pattern as attachments.e2e-spec.ts.
describe('encounters (e2e, real cookie sessions — non-member access)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let outsiderAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let encounterId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'root-admin-enc', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'dm-real-enc', password: 'password-dm-1', serverRole: 'user' });
    await adminAgent.post('/api/v1/users').send({ username: 'outsider-real-enc', password: 'password-out-1', serverRole: 'user' });

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/login').send({ username: 'dm-real-enc', password: 'password-dm-1' });

    outsiderAgent = request.agent(server);
    await outsiderAgent.post('/api/v1/auth/login').send({ username: 'outsider-real-enc', password: 'password-out-1' });

    const createRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Private Encounter Campaign' });
    campaignId = createRes.body.id;

    const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Secret Fight' });
    encounterId = encRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('member (dm) can GET the encounter', async () => {
    const res = await dmAgent.get(`/api/v1/encounters/${encounterId}`);
    expect(res.status).toBe(200);
  });

  it('non-member gets 403 on encounter GET', async () => {
    const res = await outsiderAgent.get(`/api/v1/encounters/${encounterId}`);
    expect(res.status).toBe(403);
  });

  it('non-member gets 403 rolling dice for the campaign', async () => {
    const res = await outsiderAgent.post(`/api/v1/campaigns/${campaignId}/roll`).send({ expr: '1d20' });
    expect(res.status).toBe(403);
  });

  it('non-member gets 403 creating an encounter', async () => {
    const res = await outsiderAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });
});
