import request from 'supertest';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { eq } from 'drizzle-orm';
import { DB, type DrizzleDb } from '../src/db/db.module';
import {
  auditLog,
  encounters as encountersTable,
  rulePacks,
  ruleEntries,
  combatants as combatantsTable,
  encounterEvents as encounterEventsTable,
} from '../src/db/schema';
import { CampaignEventsService } from '../src/modules/events/campaign-events.service';

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

  describe('encounter auto-add respects character lifecycle status (issue #115)', () => {
    let statusCampId: number;
    let activeId: number;
    let deadId: number;
    let retiredId: number;

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Graveyard Campaign' });
      statusCampId = campRes.body.id;

      const active = await request(server)
        .post(`/api/v1/campaigns/${statusCampId}/characters`)
        .set(dm)
        .send({ name: 'Living Hero', hpMax: 20, hpCurrent: 20 });
      expect(active.status).toBe(201);
      expect(active.body.status).toBe('active');
      activeId = active.body.id;

      const dead = await request(server)
        .post(`/api/v1/campaigns/${statusCampId}/characters`)
        .set(dm)
        .send({ name: 'Fallen Comrade', hpMax: 20, hpCurrent: 20, status: 'dead' });
      expect(dead.status).toBe(201);
      deadId = dead.body.id;

      const retired = await request(server)
        .post(`/api/v1/campaigns/${statusCampId}/characters`)
        .set(dm)
        .send({ name: 'Old Adventurer', hpMax: 20, hpCurrent: 20, status: 'retired' });
      expect(retired.status).toBe(201);
      retiredId = retired.body.id;
    });

    it('only active characters are auto-added; dead/retired are skipped', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/campaigns/${statusCampId}/encounters`).set(dm).send({ name: 'New Fight' });
      expect(res.status).toBe(201);
      const charIds = (res.body.combatants as Array<{ characterId: number | null }>).map((c) => c.characterId);
      expect(charIds).toContain(activeId);
      expect(charIds).not.toContain(deadId);
      expect(charIds).not.toContain(retiredId);
      expect(res.body.combatants).toHaveLength(1);
    });

    it('marking a PC active again re-includes it in the next encounter', async () => {
      const server = ctx.app.getHttpServer();
      // Revive the fallen comrade.
      const patch = await request(server).patch(`/api/v1/characters/${deadId}`).set(dm).send({ status: 'active' });
      expect(patch.status).toBe(200);
      expect(patch.body.status).toBe('active');

      const res = await request(server).post(`/api/v1/campaigns/${statusCampId}/encounters`).set(dm).send({ name: 'Second Fight' });
      expect(res.status).toBe(201);
      const charIds = (res.body.combatants as Array<{ characterId: number | null }>).map((c) => c.characterId);
      expect(charIds).toContain(activeId);
      expect(charIds).toContain(deadId);
      expect(charIds).not.toContain(retiredId);
      expect(res.body.combatants).toHaveLength(2);
    });
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

    it('/reopen on a non-ended (preparing) encounter is rejected 400', async () => {
      const server = ctx.app.getHttpServer();
      const freshRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Still Preparing' });
      const freshId = freshRes.body.id;

      const res = await request(server).post(`/api/v1/encounters/${freshId}/reopen`).set(dm);
      expect(res.status).toBe(400);
    });

    it('a non-dm cannot reopen an ended encounter (403)', async () => {
      // `encounterId` is still 'ended' from the earlier end test.
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/encounters/${encounterId}/reopen`).set(player);
      expect(res.status).toBe(403);
    });

    it('dm reopens an ended encounter back to running, preserving round and clearing endedAt', async () => {
      const server = ctx.app.getHttpServer();
      const before = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      expect(before.body.status).toBe('ended');
      const priorRound = before.body.round;
      const priorCurrent = before.body.currentCombatantId;

      const res = await request(server).post(`/api/v1/encounters/${encounterId}/reopen`).set(dm);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('running');
      expect(res.body.endedAt).toBeNull();
      // Combat resumes exactly where it stopped — round/turn pointer are preserved.
      expect(res.body.round).toBe(priorRound);
      expect(res.body.currentCombatantId).toBe(priorCurrent);

      // A reopened (running) encounter can be ended again (no lingering guard).
      const endAgain = await request(server).post(`/api/v1/encounters/${encounterId}/end`).set(dm);
      expect(endAgain.status).toBe(201);
      expect(endAgain.body.status).toBe('ended');
    });

    it('dm deletes the encounter', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).delete(`/api/v1/encounters/${encounterId}`).set(dm);
      expect(res.status).toBe(200);

      const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      expect(getRes.status).toBe(404);
    });

    it('delete removes combatants AND events with the encounter — no orphans (atomic remove, issue #272)', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);

      // Fresh, self-contained encounter: create (auto-adds the party), start it (which
      // seeds a combat-log 'turn' event), so both child tables have rows to orphan.
      const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Cleanup Test' });
      expect(encRes.status).toBe(201);
      const encId = encRes.body.id;
      await request(server).post(`/api/v1/encounters/${encId}/roll-initiative`).set(dm);
      const startRes = await request(server).post(`/api/v1/encounters/${encId}/start`).set(dm);
      expect(startRes.status).toBe(201);

      // Precondition: child rows exist before the delete.
      const combatantsBefore = await db.select().from(combatantsTable).where(eq(combatantsTable.encounterId, encId));
      const eventsBefore = await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, encId));
      expect(combatantsBefore.length).toBeGreaterThan(0);
      expect(eventsBefore.length).toBeGreaterThan(0);

      const del = await request(server).delete(`/api/v1/encounters/${encId}`).set(dm);
      expect(del.status).toBe(200);

      // The whole family is gone: no combatants and no events left dangling on the
      // vanished encounter (the three deletes committed as one transaction).
      const combatantsAfter = await db.select().from(combatantsTable).where(eq(combatantsTable.encounterId, encId));
      const eventsAfter = await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, encId));
      expect(combatantsAfter).toHaveLength(0);
      expect(eventsAfter).toHaveLength(0);
    });
  });

  describe('lowercase stat keys (issue #162)', () => {
    // A character stored with lowercase ability keys ({ dex: 18 }) — schema-valid, and
    // what MCP/AI or raw-API writers produce — must still yield a DEX-derived initMod on
    // its auto-added combatant, not silently roll initiative at +0 forever. Uses its own
    // campaign so the extra party member doesn't perturb the shared-campaign counts above.
    it('a lowercase-dex character gets the correct DEX-derived initMod on its combatant', async () => {
      const server = ctx.app.getHttpServer();
      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Lowercase Stats' });
      const lcCampaignId = campRes.body.id;

      const charRes = await request(server)
        .post(`/api/v1/campaigns/${lcCampaignId}/characters`)
        .set(dm)
        .send({ name: 'Lyra', stats: { dex: 18, wis: 15 }, hpCurrent: 24, hpMax: 24 });
      expect(charRes.status).toBe(201);

      const encRes = await request(server).post(`/api/v1/campaigns/${lcCampaignId}/encounters`).set(dm).send({ name: 'Initiative Check' });
      expect(encRes.status).toBe(201);
      expect(encRes.body.combatants).toHaveLength(1);
      const lyra = encRes.body.combatants[0];
      expect(lyra.name).toBe('Lyra');
      expect(lyra.initMod).toBe(4); // floor((18-10)/2), NOT 0 despite the lowercase key
    });
  });

  describe('ended encounter is immutable (issue #163)', () => {
    // An ended encounter's combatant rows are a frozen historical snapshot. Patching a
    // combatant on it must be rejected AND must not rewrite the linked character's live
    // sheet HP (the pre-fix bug: a post-combat combatant patch leaked back onto current HP).
    let endedCampaignId: number;
    let endedEncounterId: number;
    let heroCharacterId: number;
    let heroCombatantId: number;

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Ended Encounter Campaign' });
      endedCampaignId = campRes.body.id;

      const charRes = await request(server)
        .post(`/api/v1/campaigns/${endedCampaignId}/characters`)
        .set(dm)
        .send({ name: 'Pete', stats: { DEX: 12 }, hpCurrent: 44, hpMax: 50, ownerUserId: 'dev:p-1' });
      expect(charRes.status).toBe(201);
      heroCharacterId = charRes.body.id;

      // Create → roll initiative → start → end, leaving one character combatant behind.
      const encRes = await request(server).post(`/api/v1/campaigns/${endedCampaignId}/encounters`).set(dm).send({ name: 'Last Stand' });
      endedEncounterId = encRes.body.id;
      heroCombatantId = encRes.body.combatants[0].id;

      await request(server).post(`/api/v1/encounters/${endedEncounterId}/roll-initiative`).set(dm);
      const startRes = await request(server).post(`/api/v1/encounters/${endedEncounterId}/start`).set(dm);
      expect(startRes.status).toBe(201);
      const endRes = await request(server).post(`/api/v1/encounters/${endedEncounterId}/end`).set(dm);
      expect(endRes.status).toBe(201);
      expect(endRes.body.status).toBe('ended');
    });

    it('the ended encounter is still viewable', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/encounters/${endedEncounterId}`).set(player);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ended');
    });

    it('patching a combatant on an ended encounter is rejected (409) and does NOT change the character sheet', async () => {
      const server = ctx.app.getHttpServer();

      // Character HP at end time was 44 (never damaged in this trivial fight).
      const before = await request(server).get(`/api/v1/characters/${heroCharacterId}`).set(dm);
      expect(before.status).toBe(200);
      const hpBefore = before.body.hpCurrent;
      expect(hpBefore).toBe(44);

      // DM patch is rejected...
      const dmPatch = await request(server)
        .patch(`/api/v1/encounters/${endedEncounterId}/combatants/${heroCombatantId}`)
        .set(dm)
        .send({ hpSet: 13 });
      expect(dmPatch.status).toBe(409);

      // ...and so is an owning player's patch (the exact live-verified repro in #163).
      const playerPatch = await request(server)
        .patch(`/api/v1/encounters/${endedEncounterId}/combatants/${heroCombatantId}`)
        .set(player)
        .send({ hpSet: 13 });
      expect(playerPatch.status).toBe(409);

      // The character's live sheet HP is untouched by either rejected patch.
      const after = await request(server).get(`/api/v1/characters/${heroCharacterId}`).set(dm);
      expect(after.body.hpCurrent).toBe(hpBefore);
    });

    it('adding / removing a combatant and rolling initiative are also rejected (409) on an ended encounter', async () => {
      const server = ctx.app.getHttpServer();

      const add = await request(server)
        .post(`/api/v1/encounters/${endedEncounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Latecomer', hpMax: 10 });
      expect(add.status).toBe(409);

      const roll = await request(server).post(`/api/v1/encounters/${endedEncounterId}/roll-initiative`).set(dm);
      expect(roll.status).toBe(409);

      const del = await request(server).delete(`/api/v1/encounters/${endedEncounterId}/combatants/${heroCombatantId}`).set(dm);
      expect(del.status).toBe(409);
    });

    it('after /reopen the same combatant patch succeeds and mirrors to the character sheet again', async () => {
      const server = ctx.app.getHttpServer();
      const reopen = await request(server).post(`/api/v1/encounters/${endedEncounterId}/reopen`).set(dm);
      expect(reopen.status).toBe(201);
      expect(reopen.body.status).toBe('running');

      const patch = await request(server)
        .patch(`/api/v1/encounters/${endedEncounterId}/combatants/${heroCombatantId}`)
        .set(dm)
        .send({ hpSet: 13 });
      expect(patch.status).toBe(200);
      expect(patch.body.hpCurrent).toBe(13);

      // Now that the encounter is live again, the write-through is back on.
      const after = await request(server).get(`/api/v1/characters/${heroCharacterId}`).set(dm);
      expect(after.body.hpCurrent).toBe(13);
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

  // ------------------------------------------------------------------
  // Persistent per-encounter combat log (issue #61)
  // ------------------------------------------------------------------
  describe('persistent combat log (issue #61)', () => {
    let logCampaignId: number;
    let logEncounterId: number;
    let houndId: number;

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      // Fresh campaign with no party characters, so the only combatant is the monster we
      // add — deterministic event counts.
      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Combat Log Campaign' });
      logCampaignId = campRes.body.id;

      const encRes = await request(server).post(`/api/v1/campaigns/${logCampaignId}/encounters`).set(dm).send({ name: 'Logged Fight' });
      logEncounterId = encRes.body.id;

      const add = await request(server)
        .post(`/api/v1/encounters/${logEncounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Ember Hound', hpMax: 30, initMod: 2 });
      expect(add.status).toBe(201);
      houndId = add.body.id;

      await request(server).post(`/api/v1/encounters/${logEncounterId}/roll-initiative`).set(dm);
      const start = await request(server).post(`/api/v1/encounters/${logEncounterId}/start`).set(dm);
      expect(start.status).toBe(201);
    });

    it('starting the encounter seeds a single opening-turn event', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/encounters/${logEncounterId}/events`).set(dm);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].type).toBe('turn');
      expect(res.body[0].round).toBe(1);
    });

    it('a damage mutation appends a damage event carrying the delta, never the resulting HP total', async () => {
      const server = ctx.app.getHttpServer();
      const patch = await request(server)
        .patch(`/api/v1/encounters/${logEncounterId}/combatants/${houndId}`)
        .set(dm)
        .send({ hpDelta: -8 });
      expect(patch.status).toBe(200);
      expect(patch.body.hpCurrent).toBe(22);

      const res = await request(server).get(`/api/v1/encounters/${logEncounterId}/events`).set(dm);
      const damage = (res.body as Array<{ type: string; target: string; detail: string; round: number }>).filter((e) => e.type === 'damage');
      expect(damage).toHaveLength(1);
      expect(damage[0].target).toBe('Ember Hound');
      expect(damage[0].detail).toContain('8');
      expect(damage[0].round).toBe(1);
      // Issue #43 safety: the log must not leak the monster's resulting exact HP (22).
      expect(damage[0].detail).not.toContain('22');
    });

    it('a condition mutation appends a condition event', async () => {
      const server = ctx.app.getHttpServer();
      const patch = await request(server)
        .patch(`/api/v1/encounters/${logEncounterId}/combatants/${houndId}`)
        .set(dm)
        .send({ addConditions: ['Poisoned'] });
      expect(patch.status).toBe(200);

      const res = await request(server).get(`/api/v1/encounters/${logEncounterId}/events`).set(dm);
      const cond = (res.body as Array<{ type: string; detail: string }>).filter((e) => e.type === 'condition');
      expect(cond).toHaveLength(1);
      expect(cond[0].detail).toContain('Poisoned');
    });

    it('a heal mutation appends a heal event', async () => {
      const server = ctx.app.getHttpServer();
      const patch = await request(server)
        .patch(`/api/v1/encounters/${logEncounterId}/combatants/${houndId}`)
        .set(dm)
        .send({ hpDelta: 3 });
      expect(patch.status).toBe(200);

      const res = await request(server).get(`/api/v1/encounters/${logEncounterId}/events`).set(dm);
      const heal = (res.body as Array<{ type: string; detail: string }>).filter((e) => e.type === 'heal');
      expect(heal).toHaveLength(1);
      expect(heal[0].detail).toContain('3');
    });

    it('a next-turn mutation appends a turn event', async () => {
      const server = ctx.app.getHttpServer();
      const before = (await request(server).get(`/api/v1/encounters/${logEncounterId}/events`).set(dm)).body.filter(
        (e: { type: string }) => e.type === 'turn',
      ).length;

      const turn = await request(server).post(`/api/v1/encounters/${logEncounterId}/next-turn`).set(dm);
      expect(turn.status).toBe(201);

      const res = await request(server).get(`/api/v1/encounters/${logEncounterId}/events`).set(dm);
      const turns = (res.body as Array<{ type: string }>).filter((e) => e.type === 'turn');
      expect(turns).toHaveLength(before + 1);
    });

    it('a lethal mutation appends a death event for the monster', async () => {
      const server = ctx.app.getHttpServer();
      const patch = await request(server)
        .patch(`/api/v1/encounters/${logEncounterId}/combatants/${houndId}`)
        .set(dm)
        .send({ hpSet: 0 });
      expect(patch.status).toBe(200);
      expect(patch.body.hpCurrent).toBe(0);

      const res = await request(server).get(`/api/v1/encounters/${logEncounterId}/events`).set(dm);
      const death = (res.body as Array<{ type: string; target: string }>).filter((e) => e.type === 'death');
      expect(death).toHaveLength(1);
      expect(death[0].target).toBe('Ember Hound');
    });

    it('the log persists and lists in chronological order across the mutations above', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/encounters/${logEncounterId}/events`).set(dm);
      expect(res.status).toBe(200);

      const ids = (res.body as Array<{ id: number }>).map((e) => e.id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b)); // insertion / chronological order

      const types = new Set((res.body as Array<{ type: string }>).map((e) => e.type));
      expect(types.has('turn')).toBe(true);
      expect(types.has('damage')).toBe(true);
      expect(types.has('condition')).toBe(true);
      expect(types.has('heal')).toBe(true);
      expect(types.has('death')).toBe(true);
    });

    it('a non-DM campaign member (viewer) can list the log', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/encounters/${logEncounterId}/events`).set(viewer);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------
  // Combatant statblock exposure (issue #56)
  // ------------------------------------------------------------------
  describe('combatant statblock exposure (issue #56)', () => {
    it('a compendium-linked combatant exposes its statblock (AC / actions / abilities) via the rules read path', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const ts = new Date().toISOString();
      const [pack] = await db
        .insert(rulePacks)
        .values({ slug: 'sb-pack', name: 'SB Pack', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 1 })
        .returning();
      const [entry] = await db
        .insert(ruleEntries)
        .values({
          packId: pack.id,
          slug: 'ember-hound-sb',
          name: 'Ember Hound',
          type: 'monster',
          summary: 'CR 1',
          body: '',
          dataJson: JSON.stringify({
            armorClass: '13 (natural armor)',
            hitPoints: 30,
            abilityScores: { strength: 15, dexterity: 14, constitution: 13 },
            actions: [{ name: 'Bite', desc: '+5 to hit, reach 5 ft., one target. 2d6+3 fire damage.' }],
          }),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning();

      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Statblock Campaign' });
      const sbCampaignId = campRes.body.id;
      const encRes = await request(server).post(`/api/v1/campaigns/${sbCampaignId}/encounters`).set(dm).send({ name: 'SB Fight' });
      const sbEncounterId = encRes.body.id;

      // Adding by ruleEntryId stores the link on the combatant (as the tracker relies on).
      const add = await request(server)
        .post(`/api/v1/encounters/${sbEncounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', ruleEntryId: entry.id });
      expect(add.status).toBe(201);
      expect(add.body.ruleEntryId).toBe(entry.id);

      // The tracker fetches the linked entry through the existing rules read path — assert
      // the statblock fields the combatant row now surfaces (issue #56) are exposed there.
      const entryRes = await request(server).get(`/api/v1/rules/entries/${entry.id}`).set(dm);
      expect(entryRes.status).toBe(200);
      const data = JSON.parse(entryRes.body.dataJson);
      expect(data.armorClass).toContain('13');
      expect(data.actions[0].name).toBe('Bite');
      expect(data.abilityScores.strength).toBe(15);
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #532 — optimistic concurrency for encounters. Live combat is the
// highest-contention entity (the same encounter open across multiple DM devices
// — a laptop + a tablet at the table), so PATCH /encounters/:id enforces the
// same `expectedUpdatedAt` CAS invariant as quests/npcs/locations/sessions.
// A stale tab's save 409s instead of silently clobbering the fresher edit (the
// "lost fog/grid edit looks like the map reverted" failure).
// ---------------------------------------------------------------------------
describe('encounters — optimistic concurrency (issue #532, e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'CAS Encounter Campaign' })).body.id;
    encounterId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Ambush at the Crossroads' })
    ).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('omitting expectedUpdatedAt is unchanged back-compat (unconditional write)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ name: 'Ambush' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Ambush');
  });

  it('a stale expectedUpdatedAt PATCH 409s with STALE_WRITE and does NOT mutate the row', async () => {
    const server = ctx.app.getHttpServer();
    const before = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(before.body.name).toBe('Ambush');

    const conflict = await request(server)
      .patch(`/api/v1/encounters/${encounterId}`)
      .set(dm)
      .send({ name: 'CLOBBER', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('STALE_WRITE');

    // The row is untouched — no clobber.
    const after = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(after.body.name).toBe('Ambush');
    expect(after.body.updatedAt).toBe(before.body.updatedAt);
  });

  it('a matching expectedUpdatedAt PATCH succeeds', async () => {
    const server = ctx.app.getHttpServer();
    const current = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);

    const ok = await request(server)
      .patch(`/api/v1/encounters/${encounterId}`)
      .set(dm)
      .send({ name: 'Crossroads Ambush', expectedUpdatedAt: current.body.updatedAt });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('Crossroads Ambush');
  });

  // The headline regression: two DM tabs both load the encounter, both save. The
  // first write commits (and bumps updatedAt); the second tab's stale expectedUpdatedAt
  // must now 409 instead of overwriting the first edit. This is the exact repro from
  // the issue (Tab A saves a fog edit; stale Tab B's name edit would silently win).
  it('two concurrent updates: the second (stale) one gets 409 and the first edit survives', async () => {
    const server = ctx.app.getHttpServer();

    // Both tabs load the same version.
    const tabA = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const tabB = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(tabA.body.updatedAt).toBe(tabB.body.updatedAt);
    const loadedAt = tabA.body.updatedAt;

    // Tab A saves a fog edit first — succeeds and bumps updatedAt.
    const fog = { enabled: true, revealed: [{ x: 0, y: 0, w: 50, h: 50 }] };
    const firstSave = await request(server)
      .patch(`/api/v1/encounters/${encounterId}`)
      .set(dm)
      .send({ fog, expectedUpdatedAt: loadedAt });
    expect(firstSave.status).toBe(200);
    expect(firstSave.body.fog.enabled).toBe(true);
    expect(firstSave.body.updatedAt).not.toBe(loadedAt); // bumped

    // Tab B (still holding the pre-A updatedAt) tries a name edit — must 409, not clobber.
    const staleSave = await request(server)
      .patch(`/api/v1/encounters/${encounterId}`)
      .set(dm)
      .send({ name: 'Tab B Wins', expectedUpdatedAt: loadedAt });
    expect(staleSave.status).toBe(409);
    expect(staleSave.body.code).toBe('STALE_WRITE');

    // Tab A's fog edit survives; Tab B's name change did NOT land.
    const after = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(after.body.name).toBe('Crossroads Ambush'); // unchanged from the prior test
    expect(after.body.fog.enabled).toBe(true); // Tab A's edit survived
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

describe('encounters — issue #528: removeCombatant increments round on turn wrap (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;
  let c1Id: number; // top of initiative
  let c2Id: number; // middle
  let c3Id: number; // LAST in initiative (the wrap point)

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Round Wrap' })).body.id;

    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Wrap Fight' });
    encounterId = encRes.body.id;

    c1Id = (await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'C1', hpMax: 10 })).body.id;
    c2Id = (await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'C2', hpMax: 10 })).body.id;
    c3Id = (await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'C3', hpMax: 10 })).body.id;

    // Deterministic order via explicit initiatives: C1=20, C2=10, C3=5.
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${c1Id}`).set(dm).send({ initiative: 20 });
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${c2Id}`).set(dm).send({ initiative: 10 });
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${c3Id}`).set(dm).send({ initiative: 5 });

    // Start (round=1, turnIndex=0, current=C1) then advance twice so C3 (the LAST in
    // initiative order) is the current actor.
    const startRes = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    expect(startRes.status).toBe(201);
    expect(startRes.body.currentCombatantId).toBe(c1Id);
    expect(startRes.body.round).toBe(1);

    const next1 = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm);
    expect(next1.body.currentCombatantId).toBe(c2Id);
    const next2 = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm);
    expect(next2.body.currentCombatantId).toBe(c3Id);
    expect(next2.body.round).toBe(1); // still round 1 — C3 is the last actor this round
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('removing the last-in-order current combatant wraps to the top AND increments the round (matches advanceTurn)', async () => {
    const server = ctx.app.getHttpServer();
    // Current is C3 (last in initiative). Removing it must wrap the pointer to C1
    // (top of the next round) and bump the round — exactly as advanceTurn does when
    // stepping past the end of the order.
    const del = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${c3Id}`).set(dm);
    expect(del.status).toBe(200);

    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(getRes.body.currentCombatantId).toBe(c1Id); // wrapped to the top
    expect(getRes.body.turnIndex).toBe(0);
    expect(getRes.body.round).toBe(2); // regression: was 1 before the fix
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
  let npcCombatantId: number;
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

    // An NPC combatant at 20/100 -> 20% -> 'critical'. NPCs are DM-controlled, so their
    // exact HP must be redacted to a band for non-DM viewers exactly like a monster's.
    const npcEntityId = (await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Captain Vex' })).body.id;
    npcCombatantId = (
      await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'npc', npcId: npcEntityId, hpMax: 100 })
    ).body.id;
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${npcCombatantId}`).set(dm).send({ hpSet: 20 });
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

  it('DM sees exact NPC HP; a non-DM sees only a band (NPC HP is DM-controlled, like a monster)', async () => {
    const server = ctx.app.getHttpServer();
    type Row = { id: number; name: string; kind: string; npcId: number | null; hpCurrent: number | null; hpMax: number | null; hpBand: string | null };
    const dmRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const dmNpc = (dmRes.body.combatants as Row[]).find((c) => c.id === npcCombatantId)!;
    expect(dmNpc.kind).toBe('npc');
    expect(dmNpc.name).toBe('Captain Vex');
    expect(dmNpc.npcId).not.toBeNull();
    expect(dmNpc.hpCurrent).toBe(20);
    expect(dmNpc.hpBand).toBeNull();

    for (const headers of [player, viewer]) {
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(headers);
      const npc = (res.body.combatants as Row[]).find((c) => c.id === npcCombatantId)!;
      expect(npc.hpCurrent).toBeNull();
      expect(npc.hpMax).toBeNull();
      expect(npc.hpBand).toBe('critical'); // 20/100 = 20% -> critical
      // The raw serialized body must not leak the NPC's exact HP to a non-DM.
      expect(JSON.stringify(npc)).not.toMatch(/"hpCurrent":\s*20/);
    }
  });

  it('the same NPC cannot be added as a combatant twice (#374 uniqueness guard)', async () => {
    const server = ctx.app.getHttpServer();
    const npcId = (await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Twiceborn' })).body.id;
    const first = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'npc', npcId, hpMax: 10 });
    expect(first.status).toBe(201);
    const second = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'npc', npcId, hpMax: 10 });
    expect(second.status).toBe(409); // already a combatant — no silent duplicate row
  });

  it('a soft-deleted (trashed) NPC cannot be added as a combatant (#374)', async () => {
    const server = ctx.app.getHttpServer();
    const npcId = (await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Ghosted' })).body.id;
    const del = await request(server).delete(`/api/v1/npcs/${npcId}`).set(dm);
    expect(del.status).toBeGreaterThanOrEqual(200);
    expect(del.status).toBeLessThan(300);
    const add = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'npc', npcId, hpMax: 10 });
    expect(add.status).toBe(400); // not found — a trashed NPC is not addable
  });

  it('a hidden NPC combatant hides its identity (npcId + name) from non-DMs (#374)', async () => {
    const server = ctx.app.getHttpServer();
    const npcId = (await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'The Traitor', hidden: true })).body.id;
    const combatantId = (
      await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'npc', npcId, name: 'The Traitor', hpMax: 50 })
    ).body.id;
    // The DM still sees the real identity link + name.
    const dmRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const dmC = (dmRes.body.combatants as Array<{ id: number; name: string; npcId: number | null }>).find((c) => c.id === combatantId)!;
    expect(dmC.npcId).toBe(npcId);
    expect(dmC.name).toBe('The Traitor');
    // A non-DM sees the token in initiative but NOT who it is: identity link severed, name masked.
    for (const headers of [player, viewer]) {
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(headers);
      const c = (res.body.combatants as Array<{ id: number; name: string; npcId: number | null }>).find((x) => x.id === combatantId)!;
      expect(c).toBeTruthy();
      expect(c.npcId).toBeNull();
      expect(c.name).not.toBe('The Traitor');
      expect(JSON.stringify(c)).not.toMatch(/Traitor/);
    }
  });

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

// ---------------------------------------------------------------------------
// Issue #57 — richer 5e HP model: temp HP, damage past 0 / overkill, death saves.
// ---------------------------------------------------------------------------

type HpShape = {
  id: number;
  name: string;
  hpCurrent: number | null;
  hpMax: number | null;
  hpTemp: number | null;
  deathState: 'none' | 'dying' | 'stable' | 'dead';
  deathSaveSuccesses: number;
  deathSaveFailures: number;
};

describe('encounters — issue #57: temp HP / death saves / overkill (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;
  let heroCombatantId: number; // character, owned by p-1
  let heroCharacterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'HP Model' })).body.id;
    heroCharacterId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Thorn', hpCurrent: 20, hpMax: 20, ownerUserId: 'dev:p-1' })
    ).body.id;
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Grave Peril' });
    encounterId = encRes.body.id;
    heroCombatantId = encRes.body.combatants[0].id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function hero(): Promise<HpShape> {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    return (res.body.combatants as HpShape[]).find((c) => c.id === heroCombatantId)!;
  }

  it('new combatants default to 0 temp HP / deathState none', async () => {
    const h = await hero();
    expect(h.hpTemp).toBe(0);
    expect(h.deathState).toBe('none');
    expect(h.deathSaveSuccesses).toBe(0);
    expect(h.deathSaveFailures).toBe(0);
  });

  it('temp HP absorbs damage before real HP, then spills over', async () => {
    const server = ctx.app.getHttpServer();
    // Grant 8 temp HP.
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(dm).send({ hpTemp: 8 });
    expect((await hero()).hpTemp).toBe(8);

    // 5 damage: fully absorbed, real HP untouched.
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(dm).send({ hpDelta: -5 });
    let h = await hero();
    expect(h.hpTemp).toBe(3);
    expect(h.hpCurrent).toBe(20);

    // 6 more: 3 soaked by remaining temp, 3 to real HP.
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(dm).send({ hpDelta: -6 });
    h = await hero();
    expect(h.hpTemp).toBe(0);
    expect(h.hpCurrent).toBe(17);
  });

  it('an owning player may set their own temp HP', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(player).send({ hpTemp: 4 });
    expect(res.status).toBe(200);
    expect(res.body.hpTemp).toBe(4);
    // reset for the following tests
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(dm).send({ hpTemp: 0, hpSet: 17 });
  });

  it('dropping a character to 0 makes them dying (with a clean death-save slate)', async () => {
    const server = ctx.app.getHttpServer();
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(dm).send({ hpDelta: -17 });
    const h = await hero();
    expect(h.hpCurrent).toBe(0);
    expect(h.deathState).toBe('dying');
    expect(h.deathSaveSuccesses).toBe(0);
    expect(h.deathSaveFailures).toBe(0);
  });

  it('taking damage while already at 0 records a death-save failure', async () => {
    const server = ctx.app.getHttpServer();
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(dm).send({ hpDelta: -3 });
    const h = await hero();
    expect(h.deathState).toBe('dying');
    expect(h.deathSaveFailures).toBe(1);
  });

  it('recording a third failure flips the character to dead', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(dm).send({ deathSaveFailures: 3 });
    expect(res.status).toBe(200);
    expect(res.body.deathState).toBe('dead');
  });

  it('any healing revives a downed character and clears the death-save slate', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(dm).send({ hpDelta: 6 });
    expect(res.status).toBe(200);
    expect(res.body.hpCurrent).toBe(6);
    expect(res.body.deathState).toBe('none');
    expect(res.body.deathSaveFailures).toBe(0);
  });

  it('three successes stabilizes a dying character', async () => {
    const server = ctx.app.getHttpServer();
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(dm).send({ hpSet: 0 });
    expect((await hero()).deathState).toBe('dying');
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(dm).send({ deathSaveSuccesses: 3 });
    expect(res.body.deathState).toBe('stable');
    // full heal back to fighting shape for isolation
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(dm).send({ hpSet: 20 });
  });

  it('massive damage (overflow past 0 >= hpMax) kills a character outright', async () => {
    const server = ctx.app.getHttpServer();
    // Thorn is at 20/20. 45 damage: 25 overflow >= 20 hpMax -> instant death.
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`).set(dm).send({ hpDelta: -45 });
    expect(res.status).toBe(200);
    expect(res.body.hpCurrent).toBe(0);
    expect(res.body.deathState).toBe('dead');
    expect(res.body.deathSaveFailures).toBe(0); // outright, no saves rolled
  });

  it('a monster reduced to 0 just goes down — no death saves', async () => {
    const server = ctx.app.getHttpServer();
    const ogreId = (
      await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Ogre', hpMax: 30 })
    ).body.id;
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${ogreId}`).set(dm).send({ hpDelta: -999 });
    expect(res.status).toBe(200);
    expect(res.body.hpCurrent).toBe(0);
    expect(res.body.deathState).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Issue #114 — combatant identity: count-add distinguishable copies, and
// rename / hpMax / initMod edits via CombatantUpdate.
// ---------------------------------------------------------------------------

describe('encounters — issue #114: count add + rename (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Goblin Horde' })).body.id;
    encounterId = (await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Ambush' })).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('count=3 adds three distinguishable, auto-numbered goblins', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Goblin', hpMax: 7, count: 3 });
    expect(res.status).toBe(201);

    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const goblins = (getRes.body.combatants as Array<{ id: number; name: string; hpMax: number }>).filter((c) => c.name.startsWith('Goblin'));
    expect(goblins).toHaveLength(3);
    // Names are distinct and suffixed 1..3.
    expect(goblins.map((g) => g.name).sort()).toEqual(['Goblin 1', 'Goblin 2', 'Goblin 3']);
    expect(new Set(goblins.map((g) => g.id)).size).toBe(3);
    for (const g of goblins) expect(g.hpMax).toBe(7);
  });

  it('count=1 (or omitted) adds a single un-suffixed combatant', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Hobgoblin', hpMax: 11, count: 1 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Hobgoblin'); // no "Hobgoblin 1"
  });

  it('dm can rename a combatant and fix its hpMax / initMod via PATCH', async () => {
    const server = ctx.app.getHttpServer();
    const gobId = (
      await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm)
    ).body.combatants.find((c: { name: string }) => c.name === 'Goblin 1').id;

    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${gobId}`)
      .set(dm)
      .send({ name: 'Goblin archer', hpMax: 12, initMod: 3 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Goblin archer');
    expect(res.body.hpMax).toBe(12);
    expect(res.body.initMod).toBe(3);
  });

  it('lowering hpMax below current HP re-clamps hpCurrent', async () => {
    const server = ctx.app.getHttpServer();
    const gobId = (
      await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm)
    ).body.combatants.find((c: { name: string }) => c.name === 'Goblin 2').id;
    // Goblin 2 is at 7/7. Set hpMax to 4 -> hpCurrent clamps to 4.
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${gobId}`).set(dm).send({ hpMax: 4 });
    expect(res.status).toBe(200);
    expect(res.body.hpMax).toBe(4);
    expect(res.body.hpCurrent).toBe(4);
  });

  it('a player cannot rename or edit hpMax/initMod (dm-only identity fields)', async () => {
    const server = ctx.app.getHttpServer();
    const gobId = (
      await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm)
    ).body.combatants.find((c: { name: string }) => c.name === 'Goblin 3').id;

    const rename = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${gobId}`).set(player).send({ name: 'Hacked' });
    expect(rename.status).toBe(403);
    const hp = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${gobId}`).set(player).send({ hpMax: 999 });
    expect(hp.status).toBe(403);
  });
});

// Minimal valid 1x1 PNG (smallest possible real PNG payload — mirrors attachments.e2e-spec.ts).
const BATTLE_MAP_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

describe('encounters — issue #39: per-encounter battle map + combatant tokens (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let ownedCharacterId: number; // owned by dev:p-1 — exercises the player-token path
  let encounterId: number;
  let charCombatantId: number; // the character combatant (dev:p-1's)
  let monsterCombatantId: number;
  let mapAttachmentId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Battle Map Campaign' })).body.id;

    ownedCharacterId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Aria', hpCurrent: 20, hpMax: 20, ownerUserId: 'dev:p-1' })
    ).body.id;

    // create auto-adds the party (Aria) as a combatant.
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Map Fight' });
    encounterId = encRes.body.id;
    charCombatantId = encRes.body.combatants.find((c: CombatantShape) => c.characterId === ownedCharacterId).id;

    monsterCombatantId = (
      await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Goblin', hpMax: 7 })
    ).body.id;

    // Upload a map-kind image to the campaign (the attachments pipeline the DM would use).
    const upload = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'map')
      .attach('file', BATTLE_MAP_PNG, { filename: 'battle.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    mapAttachmentId = upload.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a fresh encounter has no map and null token positions (unchanged behavior)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body.mapAttachmentId).toBeNull();
    for (const c of res.body.combatants) {
      expect(c.tokenX).toBeNull();
      expect(c.tokenY).toBeNull();
    }
  });

  it('DM attaches a battle map to the encounter (mapAttachmentId round-trips)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ mapAttachmentId });
    expect(res.status).toBe(200);
    expect(res.body.mapAttachmentId).toBe(mapAttachmentId);

    // persisted — a fresh GET shows the same map.
    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(getRes.body.mapAttachmentId).toBe(mapAttachmentId);
  });

  // Issue #259: the battle map stays hidden (DM-only) as a handout — attaching it does NOT
  // reveal it — but the fogged encounter canvas can still load it (the file route's
  // encounter-map exception). (Dev-auth `player` resolves to admin/dm, so it always gets
  // 200 here; the real non-DM-member secrecy is exercised in attachments.e2e-spec.ts.)
  it('attaching a map keeps it hidden but the encounter canvas can still load it', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/attachments/${mapAttachmentId}/file`).set(player);
    expect(res.status).toBe(200);
  });

  it('rejects an attachment id that does not exist in this campaign (400)', async () => {
    const server = ctx.app.getHttpServer();
    const otherCampId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other' })).body.id;
    const otherMap = await request(server)
      .post(`/api/v1/campaigns/${otherCampId}/attachments`)
      .set(dm)
      .field('kind', 'map')
      .attach('file', BATTLE_MAP_PNG, { filename: 'other.png', contentType: 'image/png' });
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ mapAttachmentId: otherMap.body.id });
    expect(res.status).toBe(400);
  });

  it('a player cannot attach a battle map (dm only, 403)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(player).send({ mapAttachmentId: null });
    expect(res.status).toBe(403);
  });

  it('DM sets a monster token position; it round-trips', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterCombatantId}`)
      .set(dm)
      .send({ tokenX: 25, tokenY: 40 });
    expect(res.status).toBe(200);
    expect(res.body.tokenX).toBe(25);
    expect(res.body.tokenY).toBe(40);
  });

  it('out-of-range token coordinates are clamped to 0–100', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterCombatantId}`)
      .set(dm)
      .send({ tokenX: 150, tokenY: -20 });
    expect(res.status).toBe(200);
    expect(res.body.tokenX).toBe(100);
    expect(res.body.tokenY).toBe(0);
  });

  it('a player may move their OWN character token', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${charCombatantId}`)
      .set(player)
      .send({ tokenX: 60, tokenY: 70 });
    expect(res.status).toBe(200);
    expect(res.body.tokenX).toBe(60);
    expect(res.body.tokenY).toBe(70);
  });

  it('a player may NOT move a monster token (not their character, 403)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterCombatantId}`)
      .set(player)
      .send({ tokenX: 10, tokenY: 10 });
    expect(res.status).toBe(403);
  });

  // Issue #260: a placed token must actually PERSIST — a fresh GET (what a reloading/other
  // client sees) has to return the same coordinates, not fall back to "Unplaced".
  it('a placed token persists across a fresh GET (issue #260)', async () => {
    const server = ctx.app.getHttpServer();
    const patch = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterCombatantId}`)
      .set(dm)
      .send({ tokenX: 33, tokenY: 66 });
    expect(patch.status).toBe(200);

    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const monster = getRes.body.combatants.find((c: CombatantShape) => c.id === monsterCombatantId);
    expect(monster.tokenX).toBe(33);
    expect(monster.tokenY).toBe(66);
  });

  // Issue #271: an explicit null clears the position (unplace) rather than 400ing, and
  // does NOT clamp to 0 — the token returns to the "Unplaced" tray.
  it('an explicit null clears a token position (unplace, issue #271)', async () => {
    const server = ctx.app.getHttpServer();
    // Pre-condition: monster is placed from the previous test.
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterCombatantId}`)
      .set(dm)
      .send({ tokenX: null, tokenY: null });
    expect(res.status).toBe(200);
    expect(res.body.tokenX).toBeNull();
    expect(res.body.tokenY).toBeNull();

    // Persisted: a fresh GET shows it unplaced (null, not 0).
    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const monster = getRes.body.combatants.find((c: CombatantShape) => c.id === monsterCombatantId);
    expect(monster.tokenX).toBeNull();
    expect(monster.tokenY).toBeNull();
  });

  // Issue #271: unplacing keeps the combatant (and its HP/conditions/initiative) — it is
  // NOT a delete. Regression guard for "the only way to remove a token was to delete the row".
  it('unplacing a token preserves the combatant and its HP/conditions (issue #271)', async () => {
    const server = ctx.app.getHttpServer();
    // Give the monster some combat state, place it, then unplace it.
    await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterCombatantId}`)
      .set(dm)
      .send({ tokenX: 50, tokenY: 50, addConditions: ['prone'], hpSet: 3 });
    const clear = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterCombatantId}`)
      .set(dm)
      .send({ tokenX: null, tokenY: null });
    expect(clear.status).toBe(200);

    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const monster = getRes.body.combatants.find((c: CombatantShape) => c.id === monsterCombatantId);
    expect(monster).toBeDefined(); // still present — not deleted
    expect(monster.tokenX).toBeNull();
    expect(monster.tokenY).toBeNull();
    expect(monster.hpCurrent).toBe(3);
    expect(monster.conditions).toContain('prone');
  });

  // Issue #271: a player may unplace their OWN token (same gate as moving it).
  it('a player may unplace their own character token (issue #271)', async () => {
    const server = ctx.app.getHttpServer();
    await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${charCombatantId}`)
      .set(player)
      .send({ tokenX: 20, tokenY: 20 });
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${charCombatantId}`)
      .set(player)
      .send({ tokenX: null, tokenY: null });
    expect(res.status).toBe(200);
    expect(res.body.tokenX).toBeNull();
    expect(res.body.tokenY).toBeNull();
  });

  it('DM can clear the battle map (mapAttachmentId back to null)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ mapAttachmentId: null });
    expect(res.status).toBe(200);
    expect(res.body.mapAttachmentId).toBeNull();
  });

  it('an unknown key in the encounter PATCH body is rejected (strict, 400)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ round: 99 });
    expect(res.status).toBe(400);
  });
});

// Issue #40 — VTT phase 2–3: grid config, token size, fog of war (+ its server-side
// token redaction). Own campaign so the party/fixtures don't leak in from other suites.
describe('encounters — issue #40: VTT grid, token size & fog of war (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let ownedCharacterId: number; // owned by dev:p-1 — exercises the player path
  let encounterId: number;
  let charCombatantId: number;
  let monsterCombatantId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'VTT Campaign' })).body.id;

    ownedCharacterId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name: 'Aria', hpCurrent: 20, hpMax: 20, ownerUserId: 'dev:p-1' })
    ).body.id;

    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Grid Fight' });
    encounterId = encRes.body.id;
    charCombatantId = encRes.body.combatants.find((c: CombatantShape) => c.characterId === ownedCharacterId).id;
    monsterCombatantId = (
      await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Ogre', hpMax: 59 })
    ).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a fresh encounter has null grid config, no fog, and medium-size tokens (unchanged behaviour)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body.gridSize).toBeNull();
    expect(res.body.gridScale).toBeNull();
    expect(res.body.gridUnit).toBeNull();
    expect(res.body.gridSnap).toBe(false);
    expect(res.body.fog).toBeNull();
    // Issue #238 defaults: square grid, no AoE templates.
    expect(res.body.gridType).toBe('square');
    expect(res.body.aoe).toEqual([]);
    for (const c of res.body.combatants) expect(c.tokenSize).toBe('medium');
  });

  it('DM configures the grid (size/scale/unit/snap round-trip and persist)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}`)
      .set(dm)
      .send({ gridSize: 8, gridScale: 5, gridUnit: 'ft', gridSnap: true });
    expect(res.status).toBe(200);
    expect(res.body.gridSize).toBe(8);
    expect(res.body.gridScale).toBe(5);
    expect(res.body.gridUnit).toBe('ft');
    expect(res.body.gridSnap).toBe(true);

    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
    expect(getRes.body.gridSize).toBe(8);
    expect(getRes.body.gridScale).toBe(5);
  });

  it('gridSize: null turns the grid off again', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ gridSize: null });
    expect(res.status).toBe(200);
    expect(res.body.gridSize).toBeNull();
    // other grid fields are independent — scale/unit are untouched.
    expect(res.body.gridScale).toBe(5);
  });

  it('a bad gridScale (0 / negative) is rejected (400)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ gridScale: 0 });
    expect(res.status).toBe(400);
  });

  it('a player cannot change grid config (dm only, 403)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(player).send({ gridSize: 12 });
    expect(res.status).toBe(403);
  });

  it('DM sets a combatant token size; it round-trips', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterCombatantId}`)
      .set(dm)
      .send({ tokenSize: 'huge' });
    expect(res.status).toBe(200);
    expect(res.body.tokenSize).toBe('huge');
  });

  it('an invalid token size is rejected (400)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterCombatantId}`)
      .set(dm)
      .send({ tokenSize: 'colossal' });
    expect(res.status).toBe(400);
  });

  it('a player may NOT change token size, even on their own combatant (dm only, 403)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${charCombatantId}`)
      .set(player)
      .send({ tokenSize: 'large' });
    expect(res.status).toBe(403);
  });

  describe('fog of war + server-side token redaction', () => {
    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      // Place the monster top-left (10,10) and the PC bottom-right (80,80).
      await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${monsterCombatantId}`).set(dm).send({ tokenX: 10, tokenY: 10 });
      await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${charCombatantId}`).set(dm).send({ tokenX: 80, tokenY: 80 });
    });

    it('DM sets fog with a revealed region covering only the PC corner', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({ fog: { enabled: true, revealed: [{ x: 60, y: 60, w: 40, h: 40 }] } });
      expect(res.status).toBe(200);
      expect(res.body.fog.enabled).toBe(true);
      expect(res.body.fog.revealed).toHaveLength(1);
    });

    it('the DM still sees every token position (no redaction)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const monster = res.body.combatants.find((c: CombatantShape) => c.id === monsterCombatantId);
      expect(monster.tokenX).toBe(10);
      expect(monster.tokenY).toBe(10);
    });

    it('a player does NOT receive the monster in the dark, but DOES see the token in the revealed region', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
      const monster = res.body.combatants.find((c: CombatantShape) => c.id === monsterCombatantId);
      const pc = res.body.combatants.find((c: CombatantShape) => c.id === charCombatantId);
      // Monster at (10,10) is outside the revealed rectangle — position withheld server-side.
      expect(monster.tokenX).toBeNull();
      expect(monster.tokenY).toBeNull();
      // PC at (80,80) is inside the revealed rectangle — position visible.
      expect(pc.tokenX).toBe(80);
      expect(pc.tokenY).toBe(80);
    });

    it('reveal_map_region-style reveal (via PATCH) lights the monster corner for players', async () => {
      const server = ctx.app.getHttpServer();
      // Reveal the whole map for this assertion.
      await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({ fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 100, h: 100 }] } });
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
      const monster = res.body.combatants.find((c: CombatantShape) => c.id === monsterCombatantId);
      expect(monster.tokenX).toBe(10);
      expect(monster.tokenY).toBe(10);
    });

    it('disabling fog reveals all token positions to players regardless of revealed regions', async () => {
      const server = ctx.app.getHttpServer();
      await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({ fog: { enabled: false, revealed: [] } });
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
      const monster = res.body.combatants.find((c: CombatantShape) => c.id === monsterCombatantId);
      expect(monster.tokenX).toBe(10);
      expect(monster.tokenY).toBe(10);
    });

    it('a player cannot edit fog (dm only, 403)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(player)
        .send({ fog: { enabled: true, revealed: [] } });
      expect(res.status).toBe(403);
    });

    it('an out-of-range fog rectangle is rejected (400)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({ fog: { enabled: true, revealed: [{ x: -5, y: 0, w: 200, h: 10 }] } });
      expect(res.status).toBe(400);
    });
  });
});

// Issue #865 — an equivalent encounter PATCH is a read-equivalent no-op. The conditional
// UPDATE is exercised against real SQLite so this covers persisted timestamps/audit rows and
// the real in-process event broadcaster, including two clients racing the same defaults.
describe('encounters — issue #865: semantic PATCH no-ops (real DB)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    campaignId = (
      await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name: 'No-op Grid Campaign' })
    ).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('returns the encounter without touching updatedAt, audit, or SSE for a semantic no-op', async () => {
    const server = ctx.app.getHttpServer();
    const encounterId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Stable Grid' })
    ).body.id;
    const patch = {
      name: 'Stable Grid',
      locationId: null,
      questId: null,
      sessionId: null,
      mapAttachmentId: null,
      gridSize: 8,
      gridScale: 5,
      gridUnit: 'ft',
      gridSnap: true,
      gridType: 'hex',
      fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 25, h: 25 }] },
      aoe: [{ id: 'noop-circle', shape: 'circle', x: 50, y: 50, sizeFt: 20, angleDeg: 0, color: null }],
      hidden: true,
    };
    expect((await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send(patch)).status).toBe(200);

    const db = ctx.app.get<DrizzleDb>(DB);
    const [beforeRow] = await db.select().from(encountersTable).where(eq(encountersTable.id, encounterId));
    const beforeAudit = (await db.select().from(auditLog).where(eq(auditLog.entityId, encounterId))).filter(
      (row) => row.action === 'encounter.update',
    );
    const broadcasts: Array<{ type: string; encounterId?: number }> = [];
    const subscription = ctx.app
      .get(CampaignEventsService)
      .streamFor(campaignId)
      .subscribe((event) => broadcasts.push(event));

    try {
      // JSON values are compared as domain values, not storage strings; key insertion order
      // therefore cannot turn an equivalent fog/template payload into a write.
      const response = await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({ ...patch, fog: { revealed: [{ h: 25, w: 25, y: 0, x: 0 }], enabled: true } });
      expect(response.status).toBe(200);
      expect(response.body.gridScale).toBe(5);

      const [afterRow] = await db.select().from(encountersTable).where(eq(encountersTable.id, encounterId));
      const afterAudit = (await db.select().from(auditLog).where(eq(auditLog.entityId, encounterId))).filter(
        (row) => row.action === 'encounter.update',
      );
      expect(afterRow.updatedAt).toBe(beforeRow.updatedAt);
      expect(afterAudit).toHaveLength(beforeAudit.length);
      expect(broadcasts.filter((event) => event.type === 'encounter.updated' && event.encounterId === encounterId)).toHaveLength(0);
    } finally {
      subscription.unsubscribe();
    }
  });

  it('allows exactly one meaningful default PATCH when two clients race', async () => {
    const server = ctx.app.getHttpServer();
    const encounterId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Two-client Grid' })
    ).body.id;
    expect((await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ gridSize: 8 })).status).toBe(200);

    const broadcasts: Array<{ type: string; encounterId?: number }> = [];
    const subscription = ctx.app
      .get(CampaignEventsService)
      .streamFor(campaignId)
      .subscribe((event) => broadcasts.push(event));

    try {
      const [left, right] = await Promise.all([
        request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ gridScale: 5, gridUnit: 'ft' }),
        request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ gridUnit: 'ft', gridScale: 5 }),
      ]);
      expect(left.status).toBe(200);
      expect(right.status).toBe(200);
      expect(left.body).toMatchObject({ gridSize: 8, gridScale: 5, gridUnit: 'ft' });
      expect(right.body).toMatchObject({ gridSize: 8, gridScale: 5, gridUnit: 'ft' });

      const db = ctx.app.get<DrizzleDb>(DB);
      const audits = (await db.select().from(auditLog).where(eq(auditLog.entityId, encounterId))).filter(
        (row) => row.action === 'encounter.update' && row.detail.includes('gridScale'),
      );
      expect(audits).toHaveLength(1);
      expect(broadcasts.filter((event) => event.type === 'encounter.updated' && event.encounterId === encounterId)).toHaveLength(1);
    } finally {
      subscription.unsubscribe();
    }
  });
});

// Issue #238 — VTT follow-ups: hex grid option, shared (persisted) AoE templates, and transient
// map pings. Own campaign so the party/fixtures don't leak in from other suites.
describe('encounters — issue #238: hex grid, shared AoE templates & pings (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'VTT238 Campaign' })).body.id;
    encounterId = (await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Hexy Fight' })).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('DM switches the grid to hex; it round-trips and persists for players', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ gridType: 'hex' });
    expect(res.status).toBe(200);
    expect(res.body.gridType).toBe('hex');
    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
    expect(getRes.body.gridType).toBe('hex');
  });

  it('an invalid gridType is rejected (400)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ gridType: 'octagon' });
    expect(res.status).toBe(400);
  });

  it('DM adds shared cone + line + circle AoE templates; they round-trip and persist for players', async () => {
    const server = ctx.app.getHttpServer();
    const aoe = [
      { id: 'a1', shape: 'circle', x: 50, y: 50, sizeFt: 20, angleDeg: 0, color: null },
      { id: 'a2', shape: 'cone', x: 30, y: 30, sizeFt: 15, angleDeg: 90, color: null },
      { id: 'a3', shape: 'line', x: 10, y: 10, sizeFt: 30, angleDeg: 45, color: null },
    ];
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ aoe });
    expect(res.status).toBe(200);
    expect(res.body.aoe).toHaveLength(3);
    expect(res.body.aoe.map((t: { shape: string }) => t.shape).sort()).toEqual(['circle', 'cone', 'line']);
    // Shared, not client-local: a player reads the same templates.
    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
    expect(getRes.body.aoe).toHaveLength(3);
  });

  it('an empty aoe array clears the templates', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ aoe: [] });
    expect(res.status).toBe(200);
    expect(res.body.aoe).toEqual([]);
  });

  it('an out-of-range AoE template is rejected (400)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}`)
      .set(dm)
      .send({ aoe: [{ id: 'bad', shape: 'circle', x: 150, y: 0, sizeFt: 10, angleDeg: 0, color: null }] });
    expect(res.status).toBe(400);
  });

  it('a player cannot change grid type or AoE (dm only, 403)', async () => {
    const server = ctx.app.getHttpServer();
    expect((await request(server).patch(`/api/v1/encounters/${encounterId}`).set(player).send({ gridType: 'hex' })).status).toBe(403);
    expect((await request(server).patch(`/api/v1/encounters/${encounterId}`).set(player).send({ aoe: [] })).status).toBe(403);
  });

  it('any member (DM or player) may ping the map; a bad coordinate is rejected (400)', async () => {
    const server = ctx.app.getHttpServer();
    expect((await request(server).post(`/api/v1/encounters/${encounterId}/ping`).set(dm).send({ x: 40, y: 60 })).status).toBe(201);
    expect((await request(server).post(`/api/v1/encounters/${encounterId}/ping`).set(player).send({ x: 10, y: 10 })).status).toBe(201);
    expect((await request(server).post(`/api/v1/encounters/${encounterId}/ping`).set(dm).send({ x: 200, y: 10 })).status).toBe(400);
  });
});

// Issue #126 (location/quest/session linking + summary + note pinning) and
// issue #58 (difficulty band). Own campaign + fixtures so nothing else pollutes the
// party or the campaign summary.
describe('encounter linking, campaign-summary digest & difficulty (e2e, issues #126 + #58)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let locationId: number;
  let questId: number;
  let sessionId: number;
  let cr10EntryId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();

    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Linking Campaign' });
    campaignId = camp.body.id;

    // A four-PC level-5 party. Encounter create auto-adds every ACTIVE character, so
    // these four become the party the difficulty math reads levels from.
    for (const name of ['Aria', 'Borin', 'Cyra', 'Doran']) {
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/characters`)
        .set(dm)
        .send({ name, level: 5, hpCurrent: 30, hpMax: 30 });
      expect(res.status).toBe(201);
    }

    const loc = await request(server).post(`/api/v1/campaigns/${campaignId}/locations`).set(dm).send({ name: 'Thornbridge' });
    locationId = loc.body.id;
    const quest = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'The Everflame' });
    questId = quest.body.id;
    const session = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ title: 'Session One' });
    sessionId = session.body.id;

    // A CR-10 monster (5900 XP) seeded directly so difficulty has a known statblock.
    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = new Date().toISOString();
    const [pack] = await db
      .insert(rulePacks)
      .values({ slug: 'link-pack', name: 'Link Pack', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 1 })
      .returning();
    const [entry] = await db
      .insert(ruleEntries)
      .values({
        packId: pack.id,
        slug: 'cr10-ogre',
        name: 'Fearsome Ogre',
        type: 'monster',
        summary: 'CR 10',
        body: '',
        dataJson: JSON.stringify({ challengeRating: 10, hitPoints: 90 }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    cr10EntryId = entry.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('create with location/quest/session links round-trips', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Ambush at Thornbridge', locationId, questId, sessionId });
    expect(res.status).toBe(201);
    expect(res.body.locationId).toBe(locationId);
    expect(res.body.questId).toBe(questId);
    expect(res.body.sessionId).toBe(sessionId);

    // GET reflects the persisted links.
    const got = await request(server).get(`/api/v1/encounters/${res.body.id}`).set(dm);
    expect(got.body.locationId).toBe(locationId);
    expect(got.body.questId).toBe(questId);
    expect(got.body.sessionId).toBe(sessionId);
  });

  it('update edits the name and re-attaches / clears links', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Loose fight' });
    const id = created.body.id;
    expect(created.body.locationId).toBeNull();

    const patched = await request(server)
      .patch(`/api/v1/encounters/${id}`)
      .set(dm)
      .send({ name: 'Named fight', locationId, questId });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe('Named fight');
    expect(patched.body.locationId).toBe(locationId);
    expect(patched.body.questId).toBe(questId);

    // null clears a link.
    const cleared = await request(server).patch(`/api/v1/encounters/${id}`).set(dm).send({ locationId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.locationId).toBeNull();
    expect(cleared.body.questId).toBe(questId); // untouched field stays
  });

  it('rejects a cross-campaign link target with 404', async () => {
    const server = ctx.app.getHttpServer();
    const otherCamp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other' });
    const otherLoc = await request(server).post(`/api/v1/campaigns/${otherCamp.body.id}/locations`).set(dm).send({ name: 'Elsewhere' });
    const enc = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'X' });
    const res = await request(server).patch(`/api/v1/encounters/${enc.body.id}`).set(dm).send({ locationId: otherLoc.body.id });
    expect(res.status).toBe(404);
  });

  it('get_campaign_summary (REST) now includes an encounters digest', async () => {
    const server = ctx.app.getHttpServer();
    const enc = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Digest fight', locationId, questId });
    const summary = await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(dm);
    expect(summary.status).toBe(200);
    expect(Array.isArray(summary.body.encounters)).toBe(true);
    const digest = summary.body.encounters.find((e: { id: number }) => e.id === enc.body.id);
    expect(digest).toBeDefined();
    expect(digest.name).toBe('Digest fight');
    expect(digest.locationId).toBe(locationId);
    expect(digest.questId).toBe(questId);
    expect(digest.combatantCount).toBe(4); // the four auto-added PCs
    expect(digest.downCount).toBe(0);
  });

  it("a note can pin to entityType 'encounter'", async () => {
    const server = ctx.app.getHttpServer();
    const enc = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Noted fight' });
    const note = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(dm)
      .send({ body: 'They fled north', entityType: 'encounter', entityId: enc.body.id });
    expect(note.status).toBe(201);
    expect(note.body.entityType).toBe('encounter');
    expect(note.body.entityId).toBe(enc.body.id);
    expect(note.body.entityName).toBe('Noted fight');
  });

  it('redacts hidden-quest, unexplored-location, and hidden-session links for a player while DM sees them (issue #485)', async () => {
    const server = ctx.app.getHttpServer();

    const hiddenQuest = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Secret Plan', hidden: true });
    expect(hiddenQuest.status).toBe(201);
    const hiddenQuestId = hiddenQuest.body.id;

    const unexploredLoc = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/locations`)
      .set(dm)
      .send({ name: 'Uncharted Cavern', status: 'unexplored' });
    expect(unexploredLoc.status).toBe(201);
    const unexploredLocId = unexploredLoc.body.id;

    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Hidden Linked Fight', questId: hiddenQuestId, locationId: unexploredLocId });
    expect(created.status).toBe(201);
    const encId = created.body.id;

    // DM GET single encounter: sees questId & locationId
    const dmGet = await request(server).get(`/api/v1/encounters/${encId}`).set(dm);
    expect(dmGet.status).toBe(200);
    expect(dmGet.body.questId).toBe(hiddenQuestId);
    expect(dmGet.body.locationId).toBe(unexploredLocId);

    // Player GET single encounter: questId & locationId are redacted to null
    const playerGet = await request(server).get(`/api/v1/encounters/${encId}`).set(player);
    expect(playerGet.status).toBe(200);
    expect(playerGet.body.questId).toBeNull();
    expect(playerGet.body.locationId).toBeNull();

    // DM list encounters: sees questId & locationId
    const dmList = await request(server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(dm);
    expect(dmList.status).toBe(200);
    const dmEnc = dmList.body.find((e: { id: number }) => e.id === encId);
    expect(dmEnc.questId).toBe(hiddenQuestId);
    expect(dmEnc.locationId).toBe(unexploredLocId);

    // Player list encounters: questId & locationId are redacted to null
    const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(player);
    expect(playerList.status).toBe(200);
    const playerEnc = playerList.body.find((e: { id: number }) => e.id === encId);
    expect(playerEnc.questId).toBeNull();
    expect(playerEnc.locationId).toBeNull();
  });

  it('difficulty band computes correctly for a known party + monster set', async () => {
    const server = ctx.app.getHttpServer();
    const enc = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Ogre fight' });
    // Add the CR-10 ogre (5900 XP). Party = 4 level-5 PCs -> deadly threshold 4*1100=4400.
    // One monster -> ×1 multiplier -> adjusted 5900 >= 4400 -> deadly.
    const add = await request(server)
      .post(`/api/v1/encounters/${enc.body.id}/combatants`)
      .set(dm)
      .send({ kind: 'monster', ruleEntryId: cr10EntryId });
    expect(add.status).toBe(201);

    const diff = await request(server).get(`/api/v1/encounters/${enc.body.id}/difficulty`).set(dm);
    expect(diff.status).toBe(200);
    expect(diff.body.partySize).toBe(4);
    expect(diff.body.partyLevels.sort()).toEqual([5, 5, 5, 5]);
    expect(diff.body.thresholds).toEqual({ easy: 1000, medium: 2000, hard: 3000, deadly: 4400 });
    expect(diff.body.monsterCount).toBe(1);
    expect(diff.body.totalMonsterXp).toBe(5900);
    expect(diff.body.multiplier).toBe(1);
    expect(diff.body.adjustedXp).toBe(5900);
    expect(diff.body.band).toBe('deadly');
  });

  // Issue #304: first-party encounter generator. Reuses the 4×L5 party + CR-10 ogre above,
  // plus a weaker CR-2 goblin seeded here so a "medium" group build has something to pick.
  describe('encounter generator (issue #304)', () => {
    let goblinEntryId: number;

    beforeAll(async () => {
      const db = ctx.app.get<DrizzleDb>(DB);
      const ts = new Date().toISOString();
      const [pack] = await db
        .insert(rulePacks)
        .values({ slug: 'gen-pack', name: 'Gen Pack', version: '1', license: 'OGL', sourceUrl: '', installedAt: ts, entryCount: 1 })
        .returning();
      const [goblin] = await db
        .insert(ruleEntries)
        .values({
          packId: pack.id,
          slug: 'gen-goblin',
          name: 'Scrap Goblin',
          type: 'monster',
          summary: 'CR 2',
          body: '',
          dataJson: JSON.stringify({ challengeRating: 2, hitPoints: 22, type: 'humanoid', environments: ['forest'] }),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning();
      goblinEntryId = goblin.id;
    });

    it('generates a deadly group (read-only preview) within the target band using compendium monsters', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/generate`)
        .set(dm)
        .send({ difficulty: 'deadly', seed: 123 });
      expect(res.status).toBe(200);
      expect(res.body.targetBand).toBe('deadly');
      expect(res.body.matchedBand).toBe(true);
      expect(res.body.difficulty.band).toBe('deadly');
      expect(res.body.combatants.length).toBeGreaterThan(0);
      // Every suggested line references a real compendium statblock and carries CR/XP.
      for (const c of res.body.combatants) {
        expect(typeof c.ruleEntryId).toBe('number');
        expect(c.count).toBeGreaterThanOrEqual(1);
        expect(c.xp).toBeGreaterThan(0);
      }
      // Non-mutating: no encounter was persisted by the preview.
      const list = await request(server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(dm);
      expect(list.body.every((e: { name: string }) => e.name !== `Generated deadly encounter`)).toBe(true);
    });

    it('is reproducible by seed', async () => {
      const server = ctx.app.getHttpServer();
      const a = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters/generate`).set(dm).send({ difficulty: 'medium', seed: 99 });
      const b = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters/generate`).set(dm).send({ difficulty: 'medium', seed: 99 });
      expect(a.status).toBe(200);
      expect(b.body.combatants).toEqual(a.body.combatants);
      expect(b.body.seed).toBe(a.body.seed);
      expect(b.body.seed).toBe(99);
    });

    it('honors an explicit party override and CR filters', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/generate`)
        .set(dm)
        .send({ difficulty: 'medium', party: [5, 5, 5, 5], filters: { maxCr: 3 }, seed: 7 });
      expect(res.status).toBe(200);
      // maxCr:3 excludes the CR-10 ogre, so only the CR-2 goblin can be picked.
      expect(res.body.combatants.every((c: { ruleEntryId: number }) => c.ruleEntryId === goblinEntryId)).toBe(true);
    });

    it('commit=true persists a hidden, preparing encounter with the generated monsters (dm only)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/generate?commit=true`)
        .set(dm)
        .send({ difficulty: 'deadly', seed: 5, name: 'Sprung Trap', filters: { maxCr: 3 } });
      expect(res.status).toBe(200);
      expect(res.body.encounter).toBeDefined();
      expect(res.body.encounter.name).toBe('Sprung Trap');
      expect(res.body.encounter.status).toBe('preparing');
      expect(res.body.encounter.hidden).toBe(true);
      // The created encounter carries the 4 auto-added PCs PLUS the generated monster combatants.
      const monsters = (res.body.encounter.combatants as Array<{ kind: string }>).filter((c) => c.kind === 'monster');
      expect(monsters.length).toBeGreaterThan(0);
      expect(res.body.suggestion.combatants.length).toBeGreaterThan(0);
    });

    it('a non-DM can preview (read-only) but cannot commit', async () => {
      const server = ctx.app.getHttpServer();
      const preview = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters/generate`).set(player).send({ difficulty: 'easy', seed: 1 });
      expect(preview.status).toBe(200);
      const commit = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters/generate?commit=true`).set(player).send({ difficulty: 'easy', seed: 1 });
      expect(commit.status).toBe(403);
    });
  });

  // Issue #262: a DM's prepared, not-yet-sprung fight must not leak its combatant roster or
  // computed 5e difficulty to players. hidden gates the encounter WHOLESALE for a non-DM.
  describe('hidden encounter secrecy (issue #262)', () => {
    async function createHidden() {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Ambush (prep)', hidden: true });
      expect(created.status).toBe(201);
      expect(created.body.hidden).toBe(true);
      // Seed a monster so the roster + difficulty carry real secrets.
      await request(server)
        .post(`/api/v1/encounters/${created.body.id}/combatants`)
        .set(dm)
        .send({ kind: 'monster', ruleEntryId: cr10EntryId });
      return created.body.id as number;
    }

    it('a hidden encounter is visible to the DM but hidden wholesale from a player/viewer list', async () => {
      const server = ctx.app.getHttpServer();
      const id = await createHidden();

      const dmList = await request(server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(dm);
      expect(dmList.status).toBe(200);
      expect(dmList.body.some((e: { id: number }) => e.id === id)).toBe(true);

      for (const who of [player, viewer]) {
        const list = await request(server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(who);
        expect(list.status).toBe(200);
        expect(list.body.some((e: { id: number }) => e.id === id)).toBe(false);
      }
    });

    it("a player/viewer GET of a hidden encounter's roster is denied (404); the DM sees it", async () => {
      const server = ctx.app.getHttpServer();
      const id = await createHidden();

      const dmGet = await request(server).get(`/api/v1/encounters/${id}`).set(dm);
      expect(dmGet.status).toBe(200);
      expect(dmGet.body.combatants.some((c: { kind: string }) => c.kind === 'monster')).toBe(true);

      for (const who of [player, viewer]) {
        const res = await request(server).get(`/api/v1/encounters/${id}`).set(who);
        expect(res.status).toBe(404);
      }
    });

    it("a player/viewer difficulty read of a hidden encounter is denied (404); the DM sees it", async () => {
      const server = ctx.app.getHttpServer();
      const id = await createHidden();

      const dmDiff = await request(server).get(`/api/v1/encounters/${id}/difficulty`).set(dm);
      expect(dmDiff.status).toBe(200);
      expect(dmDiff.body.monsterCount).toBe(1);

      for (const who of [player, viewer]) {
        const res = await request(server).get(`/api/v1/encounters/${id}/difficulty`).set(who);
        expect(res.status).toBe(404);
      }
    });

    it('revealing a hidden encounter (hidden=false) makes its roster + difficulty visible to a player again', async () => {
      const server = ctx.app.getHttpServer();
      const id = await createHidden();

      // Player is blocked while hidden...
      expect((await request(server).get(`/api/v1/encounters/${id}`).set(player)).status).toBe(404);

      // ...DM reveals it...
      const revealed = await request(server).patch(`/api/v1/encounters/${id}`).set(dm).send({ hidden: false });
      expect(revealed.status).toBe(200);
      expect(revealed.body.hidden).toBe(false);

      // ...now the player can read the roster and the difficulty.
      const got = await request(server).get(`/api/v1/encounters/${id}`).set(player);
      expect(got.status).toBe(200);
      const diff = await request(server).get(`/api/v1/encounters/${id}/difficulty`).set(player);
      expect(diff.status).toBe(200);
      expect(diff.body.monsterCount).toBe(1);
    });
  });
});
