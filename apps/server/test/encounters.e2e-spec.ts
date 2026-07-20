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

    // Strict-validation (task P1 item 3): CombatantUpdateDto is now .strict() at
    // the DTO layer — an unknown/misnamed key like `hpCurrent` (the real column
    // name; CombatantUpdate's actual field is `hpDelta`/`hpSet`) previously
    // validated fine (the global ZodValidationPipe just silently stripped it)
    // and the PATCH would 200 with no effect. Now it 400s with a clear message
    // instead of silently no-op'ing — exactly the failure mode an AI agent
    // sending a slightly-wrong field name would otherwise hit invisibly.
    it('unknown key in combatant PATCH body (e.g. hpCurrent instead of hpSet/hpDelta) -> 400, not a silent no-op', async () => {
      const server = ctx.app.getHttpServer();
      const before = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const ariaBefore = (before.body.combatants as Array<{ id: number; hpCurrent: number }>).find((c) => c.id === ariaCombatantId)!;

      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`)
        .set(dm)
        .send({ hpCurrent: 1 });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/hpCurrent/);

      // Confirm it's truly a no-op, not a partial/silent apply.
      const after = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const ariaAfter = (after.body.combatants as Array<{ id: number; hpCurrent: number }>).find((c) => c.id === ariaCombatantId)!;
      expect(ariaAfter.hpCurrent).toBe(ariaBefore.hpCurrent);
    });

    it('a well-formed combatant PATCH (only recognized keys) still 200s as before', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`)
        .set(dm)
        .send({ hpSet: 9 });
      expect(res.status).toBe(200);
      expect(res.body.hpCurrent).toBe(9);
      // restore for subsequent tests in this block, which assume hpCurrent=15 post the earlier -5 delta test
      await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`).set(dm).send({ hpSet: 15 });
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

// ---------------------------------------------------------------------------
// Issues #49/#50/#51/#54 — combat-tracker correctness fixes. Each block owns a
// fresh campaign so the deterministic initiative ordering isn't perturbed by the
// shared-campaign suite above.
// ---------------------------------------------------------------------------

type CombatantShape = { id: number; name: string; characterId: number | null; initiative: number | null; hpCurrent: number; hpMax: number };

describe('encounters — issue #51: character uniqueness guard (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let ariaId: number;
  let encounterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Dup Guard' })).body.id;
    ariaId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Aria', hpCurrent: 20, hpMax: 20 })
    ).body.id;
    // create auto-adds the whole party (Aria) as a combatant.
    encounterId = (await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Fight' })).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('re-adding a character already present in the encounter is rejected 409', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'character', characterId: ariaId });
    expect(res.status).toBe(409);

    // and no duplicate row was created — Aria still appears exactly once.
    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const ariaRows = (getRes.body.combatants as CombatantShape[]).filter((c) => c.characterId === ariaId);
    expect(ariaRows).toHaveLength(1);
  });

  it('a different, not-yet-present character can still be added (201)', async () => {
    const server = ctx.app.getHttpServer();
    const bramId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Bram', hpCurrent: 15, hpMax: 15 })
    ).body.id;
    const res = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'character', characterId: bramId });
    expect(res.status).toBe(201);
    expect(res.body.characterId).toBe(bramId);
  });
});

describe('encounters — issue #49: identity-based turn pointer (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;
  let ariaCombatantId: number;
  let m1Id: number; // sorts above Aria
  let m2Id: number; // sorts below Aria

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Turn Pointer' })).body.id;
    await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Aria', hpCurrent: 20, hpMax: 20 });

    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Ambush' });
    encounterId = encRes.body.id;
    ariaCombatantId = encRes.body.combatants[0].id;

    m1Id = (await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'M1', hpMax: 10 })).body.id;
    m2Id = (await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'M2', hpMax: 10 })).body.id;

    // Deterministic order via explicit initiatives: M1=20, Aria=10, M2=5.
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${m1Id}`).set(dm).send({ initiative: 20 });
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`).set(dm).send({ initiative: 10 });
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${m2Id}`).set(dm).send({ initiative: 5 });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('start pins currentCombatantId to the top of the order (M1)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.currentCombatantId).toBe(m1Id);
    expect(res.body.turnIndex).toBe(0);
    // server-sorted order: M1, Aria, M2
    expect((res.body.combatants as CombatantShape[]).map((c) => c.id)).toEqual([m1Id, ariaCombatantId, m2Id]);
  });

  it('next-turn advances by identity to Aria', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.currentCombatantId).toBe(ariaCombatantId);
    expect(res.body.turnIndex).toBe(1);
  });

  it('removing a combatant that sorts ABOVE the current actor keeps the pointer on Aria (not shifted)', async () => {
    const server = ctx.app.getHttpServer();
    // Current is Aria (index 1). Remove M1 (index 0). A positional index would now
    // point at M2; the identity pointer must stay on Aria, now at index 0.
    const del = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${m1Id}`).set(dm);
    expect(del.status).toBe(200);

    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(getRes.body.currentCombatantId).toBe(ariaCombatantId);
    expect(getRes.body.turnIndex).toBe(0); // Aria is now the top of the order
  });

  it('a combatant added mid-fight does not move the current pointer', async () => {
    const server = ctx.app.getHttpServer();
    const reinf = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Reinforcement', hpMax: 8 });
    expect(reinf.status).toBe(201);
    expect(reinf.body.initiative).toBeNull();

    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(getRes.body.currentCombatantId).toBe(ariaCombatantId);
    // null-initiative joiner sorts last: Aria, M2, Reinforcement
    expect((getRes.body.combatants as CombatantShape[]).map((c) => c.id)).toEqual([ariaCombatantId, m2Id, reinf.body.id]);
  });

  it('removing the CURRENT combatant advances the pointer to the next in order (M2)', async () => {
    const server = ctx.app.getHttpServer();
    const del = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`).set(dm);
    expect(del.status).toBe(200);

    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(getRes.body.currentCombatantId).toBe(m2Id);
    expect(getRes.body.turnIndex).toBe(0); // M2 is now the top of the order
  });
});

describe('encounters — issue #54: set/roll initiative for a late joiner (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;
  let ariaCombatantId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Reinforcements' })).body.id;
    await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Aria', hpCurrent: 20, hpMax: 20 });
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Fight' });
    encounterId = encRes.body.id;
    ariaCombatantId = encRes.body.combatants[0].id;
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`).set(dm).send({ initiative: 12 });
    await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a combatant added while running starts at null initiative and sorts last', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Cultist', hpMax: 11 });
    expect(res.status).toBe(201);
    expect(res.body.initiative).toBeNull();
  });

  it('roll-initiative works while running and fills the late joiner (only null values)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    expect(res.status).toBe(201);
    for (const c of res.body.combatants as CombatantShape[]) {
      expect(c.initiative).not.toBeNull();
    }
    // Aria's manually-set initiative is left untouched.
    const aria = (res.body.combatants as CombatantShape[]).find((c) => c.id === ariaCombatantId);
    expect(aria?.initiative).toBe(12);
  });

  it('dm can set a specific initiative on any combatant while running', async () => {
    const server = ctx.app.getHttpServer();
    const cultist = (await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm)).body.combatants.find(
      (c: CombatantShape) => c.name === 'Cultist',
    );
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${cultist.id}`)
      .set(dm)
      .send({ initiative: 99 });
    expect(res.status).toBe(200);
    expect(res.body.initiative).toBe(99);
    // now sorts to the top
    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect((getRes.body.combatants as CombatantShape[])[0].id).toBe(cultist.id);
  });
});

describe('encounters — issue #50: character/combatant HP stay in sync (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let charId: number;
  let encounterId: number;
  let combatantId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'HP Sync' })).body.id;
    charId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Aria', hpCurrent: 30, hpMax: 30 })
    ).body.id;
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Fight' });
    encounterId = encRes.body.id;
    combatantId = encRes.body.combatants[0].id;
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`).set(dm).send({ initiative: 10 });
    await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function combatantHp(): Promise<{ hpCurrent: number; hpMax: number }> {
    const server = ctx.app.getHttpServer();
    const c = (await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm)).body.combatants.find(
      (x: CombatantShape) => x.id === combatantId,
    );
    return { hpCurrent: c.hpCurrent, hpMax: c.hpMax };
  }

  it('combatant damage still writes through to the character (existing behavior preserved)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`).set(dm).send({ hpDelta: -10 });
    expect(res.status).toBe(200);
    expect(res.body.hpCurrent).toBe(20);
    const charRes = await request(server).get(`/api/v1/characters/${charId}`).set(dm);
    expect(charRes.body.hpCurrent).toBe(20);
  });

  it('healing on the character sheet mirrors into the live combatant row (the fix)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/characters/${charId}/hp`).set(dm).send({ delta: 5 });
    expect(res.status).toBe(201);
    expect(res.body.hpCurrent).toBe(25);
    expect((await combatantHp()).hpCurrent).toBe(25);
  });

  it('raising hpMax on the character (level-up) mirrors hpMax into the combatant row', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/characters/${charId}`).set(dm).send({ hpMax: 40 });
    expect(res.status).toBe(200);
    expect(res.body.hpMax).toBe(40);
    expect((await combatantHp()).hpMax).toBe(40);
  });

  it('mid-fight heal is NOT reverted when the encounter ends', async () => {
    const server = ctx.app.getHttpServer();
    // character is at 25/40 (healed on sheet); the combatant mirrors it. Ending writes
    // combatant HP back — which now equals the healed value, so nothing is reverted.
    const endRes = await request(server).post(`/api/v1/encounters/${encounterId}/end`).set(dm);
    expect(endRes.status).toBe(201);
    const charRes = await request(server).get(`/api/v1/characters/${charId}`).set(dm);
    expect(charRes.body.hpCurrent).toBe(25);
  });

  it('after the encounter has ended, character HP edits no longer touch the historical combatant row', async () => {
    const server = ctx.app.getHttpServer();
    const before = await combatantHp();
    const res = await request(server).post(`/api/v1/characters/${charId}/hp`).set(dm).send({ set: 3 });
    expect(res.status).toBe(201);
    expect((await combatantHp()).hpCurrent).toBe(before.hpCurrent); // unchanged — ended encounter is a snapshot
  });
});

describe('encounters — issue #43: monster HP is redacted for non-DM viewers (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;
  let monsterId: number;
  let ariaCombatantId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Secret HP' })).body.id;
    // A party character (owned by p-1) so we can prove character HP stays exact for everyone.
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Aria', hpCurrent: 20, hpMax: 30, ownerUserId: 'dev:p-1' });
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Boss Fight' });
    encounterId = encRes.body.id;
    ariaCombatantId = encRes.body.combatants[0].id;

    // A monster at 30/100 -> 30% -> 'bloodied'.
    monsterId = (
      await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Boss', hpMax: 100 })
    ).body.id;
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${monsterId}`).set(dm).send({ hpSet: 30 });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('DM sees exact monster HP (no band)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(res.status).toBe(200);
    const boss = (res.body.combatants as Array<{ id: number; hpCurrent: number | null; hpMax: number | null; hpBand: string | null }>).find(
      (c) => c.id === monsterId,
    )!;
    expect(boss.hpCurrent).toBe(30);
    expect(boss.hpMax).toBe(100);
    expect(boss.hpBand).toBeNull();
  });

  for (const [label, headers] of [
    ['player', player],
    ['viewer', viewer],
  ] as const) {
    it(`${label} sees a banded monster HP, never exact numbers`, async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(headers);
      expect(res.status).toBe(200);
      const boss = (res.body.combatants as Array<{ id: number; hpCurrent: number | null; hpMax: number | null; hpBand: string | null }>).find(
        (c) => c.id === monsterId,
      )!;
      // Exact HP redacted...
      expect(boss.hpCurrent).toBeNull();
      expect(boss.hpMax).toBeNull();
      // ...replaced by a coarse band (30/100 = 30% -> bloodied).
      expect(boss.hpBand).toBe('bloodied');
      // And the raw serialized body must not leak the exact numbers for this monster.
      expect(JSON.stringify(boss)).not.toMatch(/"hpCurrent":\s*30/);
    });
  }

  it('character combatant HP stays exact for a non-DM viewer (party HP is shared)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
    const aria = (res.body.combatants as Array<{ id: number; hpCurrent: number | null; hpMax: number | null; hpBand: string | null }>).find(
      (c) => c.id === ariaCombatantId,
    )!;
    expect(aria.hpCurrent).toBe(20);
    expect(aria.hpMax).toBe(30);
    expect(aria.hpBand).toBeNull();
  });

  it('a downed monster (0 HP) bands to "down" for a player', async () => {
    const server = ctx.app.getHttpServer();
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${monsterId}`).set(dm).send({ hpSet: 0 });
    const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
    const boss = (res.body.combatants as Array<{ id: number; hpBand: string | null }>).find((c) => c.id === monsterId)!;
    expect(boss.hpBand).toBe('down');
  });
});

describe('encounters — issue #86: concurrent HP updates are not lost (e2e)', () => {
  let ctx: TestAppContext;
  // The app under test is only `.init()`-ed (not listening). supertest opens an
  // ephemeral port per `request(server)` call, which races/ECONNRESETs when many
  // requests fire concurrently — so we bind the server to a real port ONCE here
  // and let every request reuse it. That's exactly the concurrency this issue is
  // about, so it must be exercised against a genuinely-listening server.
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;
  let encounterId: number;
  let ariaCombatantId: number;
  let charId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Race Conditions' })).body.id;
    charId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Aria', hpCurrent: 100, hpMax: 100, ownerUserId: 'dev:p-1' })
    ).body.id;
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Fight' });
    encounterId = encRes.body.id;
    ariaCombatantId = encRes.body.combatants[0].id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestApp(ctx);
  });

  it('20 concurrent hpDelta requests (DM + owning player) all apply — no lost update', async () => {
    // Mirrors the issue scenario: the DM and the owning player both apply damage
    // near-simultaneously. Each request is authorized; with a read-modify-write
    // across awaits, some deltas would be silently lost (last write wins).
    const dmDeltas = Array.from({ length: 10 }, () =>
      request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`).set(dm).send({ hpDelta: -5 }),
    );
    const playerDeltas = Array.from({ length: 10 }, () =>
      request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`).set(player).send({ hpDelta: -3 }),
    );
    const results = await Promise.all([...dmDeltas, ...playerDeltas]);
    for (const r of results) expect(r.status).toBe(200);

    // 100 - (10*5 + 10*3) = 20. Every delta must have composed.
    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const aria = (getRes.body.combatants as CombatantShape[]).find((c) => c.id === ariaCombatantId)!;
    expect(aria.hpCurrent).toBe(20);

    // The linked character mirror (issue #50) must match — the paired write is
    // now inside one transaction, so it can't drift from the combatant.
    const charRes = await request(server).get(`/api/v1/characters/${charId}`).set(dm);
    expect(charRes.body.hpCurrent).toBe(20);
  });

  it('concurrent hpDelta is clamped at 0, never negative', async () => {
    // Aria is at 20. Fire 10 concurrent -5 deltas (total -50): clamped to 0, not -30.
    const deltas = Array.from({ length: 10 }, () =>
      request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`).set(dm).send({ hpDelta: -5 }),
    );
    const results = await Promise.all(deltas);
    for (const r of results) expect(r.status).toBe(200);

    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const aria = (getRes.body.combatants as CombatantShape[]).find((c) => c.id === ariaCombatantId)!;
    expect(aria.hpCurrent).toBe(0);
  });

  it('concurrent addCombatant calls get distinct sortOrders (no collision)', async () => {
    const adds = Array.from({ length: 6 }, (_, i) =>
      request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: `Add${i}`, hpMax: 10 }),
    );
    const results = await Promise.all(adds);
    for (const r of results) expect(r.status).toBe(201);

    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const sortOrders = (getRes.body.combatants as Array<{ sortOrder: number }>).map((c) => c.sortOrder);
    // All sortOrders are unique.
    expect(new Set(sortOrders).size).toBe(sortOrders.length);
  });
});
