import request from 'supertest';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { eq, inArray, sql } from 'drizzle-orm';
import { DB, type DrizzleDb } from '../src/db/db.module';
import {
  auditLog,
  campaigns,
  characters,
  encounters as encountersTable,
  rulePacks,
  ruleEntries,
  combatants as combatantsTable,
  npcs,
  encounterEvents as encounterEventsTable,
  diceRolls,
  combatantRemovalUndos,
} from '../src/db/schema';
import { CampaignEventsService } from '../src/modules/events/campaign-events.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { EncountersService } from '../src/modules/encounters/encounters.service';
import { RollsService } from '../src/modules/rolls/rolls.service';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const otherDm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-2' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'p-2' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'v-1' };

/**
 * Smallest real PNG payload (1x1, 8-bit RGB). Needed since #604: uploads are
 * validated against the image HEADER, so a fixture must actually decode.
 */
const MINIMAL_PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

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
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Goblin Ambush', hidden: false });
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

  // Issue #491: PF2e initiative is Perception = WIS mod + trained proficiency (level+2),
  // not the bare 5e-style WIS (or DEX) modifier. A level-5 WIS 16 PC with no stored
  // Perception must seed initMod = +3 + (5+2) = +10 so roll_initiative matches a by-hand roll.
  it('PF2e create seeds character initMod with WIS + trained proficiency (issue #491)', async () => {
    const server = ctx.app.getHttpServer();
    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = new Date().toISOString();
    // Campaign create requires an installed pack slug (validateRuleSystem).
    await db
      .insert(rulePacks)
      .values({ slug: 'pf2e-srd', name: 'PF2e SRD', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 0 })
      .onConflictDoNothing();

    const camp = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'PF2e Init Campaign', ruleSystem: 'pf2e-srd' });
    expect(camp.status).toBe(201);

    const hero = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/characters`)
      .set(dm)
      .send({ name: 'Scout', stats: { WIS: 16, DEX: 20 }, level: 5, hpCurrent: 40, hpMax: 40 });
    expect(hero.status).toBe(201);

    const res = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/encounters`)
      .set(dm)
      .send({ name: 'Forest Ambush' });
    expect(res.status).toBe(201);
    expect(res.body.combatants).toHaveLength(1);
    const scout = res.body.combatants[0];
    expect(scout.characterId).toBe(hero.body.id);
    // DEX 20 must NOT win (that would be 5e); Perception is Wisdom-based.
    expect(scout.initMod).toBe(10);
  });

  it('player without dm role cannot create an encounter', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(player).send({ name: 'Nope', hidden: false });
    expect(res.status).toBe(403);
  });

  describe('encounter auto-add respects character lifecycle status (issue #115)', () => {
    let statusCampId: number;
    let activeId: number;
    let deadId: number;
    let retiredId: number;
    let draftId: number;

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

      const draft = await request(server)
        .post(`/api/v1/campaigns/${statusCampId}/characters`)
        .set(dm)
        .send({ name: 'Work In Progress' });
      expect(draft.status).toBe(201);
      expect(draft.body.status).toBe('draft');
      draftId = draft.body.id;

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

    it('only active characters are auto-added; dead/retired/draft are skipped', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).post(`/api/v1/campaigns/${statusCampId}/encounters`).set(dm).send({ name: 'New Fight', hidden: false });
      expect(res.status).toBe(201);
      const charIds = (res.body.combatants as Array<{ characterId: number | null }>).map((c) => c.characterId);
      expect(charIds).toContain(activeId);
      expect(charIds).not.toContain(deadId);
      expect(charIds).not.toContain(retiredId);
      expect(charIds).not.toContain(draftId);
      expect(res.body.combatants).toHaveLength(1);
    });

    it('marking a PC active again re-includes it in the next encounter', async () => {
      const server = ctx.app.getHttpServer();
      // Revive the fallen comrade.
      const patch = await request(server).patch(`/api/v1/characters/${deadId}`).set(dm).send({ status: 'active' });
      expect(patch.status).toBe(200);
      expect(patch.body.status).toBe('active');

      const res = await request(server).post(`/api/v1/campaigns/${statusCampId}/encounters`).set(dm).send({ name: 'Second Fight', hidden: false });
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
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'The Big Fight', hidden: false });
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

    it('applies direct 5e damage type, save-half, immunity, vulnerability, and crit dice math (issue #605)', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const ts = new Date().toISOString();
      const source = await db.select({ packId: ruleEntries.packId }).from(ruleEntries).where(eq(ruleEntries.id, ruleEntryId)).get();
      expect(source).toBeDefined();
      const [entry] = await db
        .insert(ruleEntries)
        .values({
          packId: source!.packId,
          slug: `defended-target-${Date.now()}`,
          name: 'Defended target',
          type: 'monster',
          summary: '',
          body: '',
          dataJson: JSON.stringify({
            hitPoints: 100,
            // A simple statblock string is an unconditional canonical list.
            damage_resistances: ' Fire, LIGHTNING ',
            damage_vulnerabilities: ['cold'],
            damage_immunities: ['poison'],
          }),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning();
      const add = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', ruleEntryId: entry.id });
      expect(add.status).toBe(201);
      const targetId = add.body.id;

      // 18 → saved half 9 → fire resistance 4 (round down each step).
      let res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`).set(dm)
        .send({ hpDelta: -18, damageType: 'fire', saveOutcome: 'half' });
      expect(res.status).toBe(200);
      expect(res.body.hpCurrent).toBe(96);
      const savedEvents = await request(server).get(`/api/v1/encounters/${encounterId}/events`).set(dm);
      const savedEvent = savedEvents.body.find((event: { detail: string }) => /18 fire.*saved for half/.test(event.detail));
      expect(savedEvent).toBeDefined();
      expect(savedEvent.detail).not.toContain('saved for half, halved');

      res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`).set(dm)
        .send({ hpDelta: -6, damageType: 'cold' });
      expect(res.body.hpCurrent).toBe(84); // vulnerability doubles 6 → 12

      res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`).set(dm)
        .send({ hpDelta: -20, damageType: 'poison' });
      expect(res.body.hpCurrent).toBe(84); // immunity wins
      const events = await request(server).get(`/api/v1/encounters/${encounterId}/events`).set(dm);
      expect(events.body.some((event: { detail: string }) => /took 0 damage.*immune/.test(event.detail))).toBe(true);

      res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`).set(dm)
        .send({ hpDelta: -8, damageType: 'slashing', isCrit: true, damageDice: 5 });
      expect(res.body.hpCurrent).toBe(71); // (5 dice × 2) + 3 flat modifier

      // API/MCP callers get the adapter's canonical vocabulary, normalized before
      // defence math and the combat log (not arbitrary free-form strings).
      res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`).set(dm)
        .send({ hpDelta: -4, damageType: 'FIRE' });
      expect(res.status).toBe(200);
      expect(res.body.hpCurrent).toBe(69); // uppercase FIRE normalizes and resists to 2
      const normalizedEvents = await request(server).get(`/api/v1/encounters/${encounterId}/events`).set(dm);
      expect(normalizedEvents.body.some((event: { detail: string }) => /4 fire.*resistant/.test(event.detail))).toBe(true);

      // A negative flat modifier can make the dice subtotal larger than the net roll.
      // That is still valid critical math: 2 × 4 dice - 1 flat = 7.
      res = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`).set(dm)
        .send({ hpDelta: -3, damageType: 'slashing', isCrit: true, damageDice: 4 });
      expect(res.status).toBe(200);
      expect(res.body.hpCurrent).toBe(62);

      const unknownType = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`).set(dm)
        .send({ hpDelta: -4, damageType: 'laser' });
      expect(unknownType.status).toBe(400);

      const meaninglessDiceSubtotal = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`)
        .set(dm)
        .send({ hpDelta: -4, damageDice: 4 });
      expect(meaninglessDiceSubtotal.status).toBe(400);
      expect(meaninglessDiceSubtotal.body.message).toContain('requires a critical hit');

      for (const damageDice of [0, -1]) {
        const invalidCriticalSubtotal = await request(server)
          .patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`)
          .set(dm)
          .send({ hpDelta: -4, isCrit: true, damageDice });
        expect(invalidCriticalSubtotal.status).toBe(400);
      }

      const emptyDamageType = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`)
        .set(dm)
        .send({ hpDelta: -4, damageType: '   ' });
      expect(emptyDamageType.status).toBe(400);

      const conflictingHpSet = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`)
        .set(dm)
        .send({ hpDelta: -4, hpSet: 100, damageType: 'fire' });
      expect(conflictingHpSet.status).toBe(400);
      expect(conflictingHpSet.body.message).toContain('cannot be combined with hpSet');

      // The web AoE apply path sends one PATCH per affected target. Mixed save
      // outcomes must therefore produce independent full/half results in one burst.
      const fullSaveTarget = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Failed save target', hpMax: 100 });
      const halfSaveTarget = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Successful save target', hpMax: 100 });
      expect(fullSaveTarget.status).toBe(201);
      expect(halfSaveTarget.status).toBe(201);

      const fullSaveHit = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${fullSaveTarget.body.id}`)
        .set(dm)
        .send({ hpDelta: -10, damageType: 'fire' });
      const halfSaveHit = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${halfSaveTarget.body.id}`)
        .set(dm)
        .send({ hpDelta: -10, damageType: 'fire', saveOutcome: 'half' });
      expect(fullSaveHit.status).toBe(200);
      expect(halfSaveHit.status).toBe(200);
      expect(fullSaveHit.body.hpCurrent).toBe(90);
      expect(halfSaveHit.body.hpCurrent).toBe(95);

      const [qualifiedEntry] = await db
        .insert(ruleEntries)
        .values({
          packId: source!.packId,
          slug: `qualified-defense-${Date.now()}`,
          name: 'Qualified defense target',
          type: 'monster',
          summary: '',
          body: '',
          dataJson: JSON.stringify({ hitPoints: 100, damage_resistances: 'slashing from nonmagical attacks' }),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning();
      const qualifiedTarget = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', ruleEntryId: qualifiedEntry.id });
      expect(qualifiedTarget.status).toBe(201);
      const qualifiedHit = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${qualifiedTarget.body.id}`)
        .set(dm)
        .send({ hpDelta: -10, damageType: 'slashing' });
      expect(qualifiedHit.status).toBe(200);
      expect(qualifiedHit.body.hpCurrent).toBe(90); // source tags are not modeled, so no unconditional resistance

      const invalid = await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`).set(dm)
        .send({ hpDelta: -8, isCrit: true });
      expect(invalid.status).toBe(400);
    });

    it('rejects direct-damage metadata for adapters that do not own 5e damage rules (issue #605)', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const ts = new Date().toISOString();
      await db.insert(rulePacks).values({ slug: 'pf2e-srd', name: 'PF2e SRD', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 0 }).onConflictDoNothing();
      const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'No 5e damage math', ruleSystem: 'pf2e-srd' });
      const encounter = await request(server).post(`/api/v1/campaigns/${campaign.body.id}/encounters`).set(dm).send({ name: 'Adapter gate' });
      const target = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'Target', hpMax: 20 });

      const rejected = await request(server).patch(`/api/v1/encounters/${encounter.body.id}/combatants/${target.body.id}`).set(dm)
        .send({ hpDelta: -5, damageType: 'fire' });
      expect(rejected.status).toBe(400);
      const raw = await request(server).patch(`/api/v1/encounters/${encounter.body.id}/combatants/${target.body.id}`).set(dm).send({ hpDelta: -5 });
      expect(raw.status).toBe(200);
      expect(raw.body.hpCurrent).toBe(15);
    });

    // Issue #495: players may only add conditions from the active rule vocabulary;
    // arbitrary free-text ("god_mode") must 400. MCP update_combatant shares this path.
    it('owning player cannot inject an arbitrary free-text condition (issue #495)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`)
        .set(player)
        .send({ addConditions: ['god_mode'] });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/god_mode|vocabulary|Unknown condition/i);

      const after = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const aria = (after.body.combatants as Array<{ id: number; conditions: string[] }>).find(
        (c) => c.id === ariaCombatantId,
      )!;
      expect(aria.conditions).not.toContain('god_mode');
    });

    it('owning player may add an adapter vocabulary condition (case-insensitive, issue #495)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`)
        .set(player)
        .send({ addConditions: ['prone'] });
      expect(res.status).toBe(200);
      expect(res.body.conditions).toContain('prone');
      // Clean up so later assertions in this suite are not surprised by leftover conditions.
      await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`)
        .set(player)
        .send({ removeConditions: ['prone'] });
    });

    it('DM may mint a custom condition label outside the vocabulary (issue #495)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`)
        .set(dm)
        .send({ addConditions: ['hexed_by_patron'] });
      expect(res.status).toBe(200);
      expect(res.body.conditions).toContain('hexed_by_patron');
      await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${ariaCombatantId}`)
        .set(dm)
        .send({ removeConditions: ['hexed_by_patron'] });
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
      const idempotencyKey = '7f5ccac1-fb3d-4ca5-a237-0385d22e0001';
      const res = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${ruleMonsterId}`).set(dm).send({ idempotencyKey });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ encounterId, combatantId: ruleMonsterId });
      expect(res.body.undoToken).toMatch(/^[0-9a-f-]{36}$/i);
      expect(res.body.undoToken).not.toBe(idempotencyKey);
      const replay = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${ruleMonsterId}`).set(dm).send({ idempotencyKey });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(res.body);

      const otherEncounter = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Independent removal key' });
      const otherCombatant = await request(server).post(`/api/v1/encounters/${otherEncounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'Independent key target', hpMax: 2 });
      const independent = await request(server).delete(`/api/v1/encounters/${otherEncounter.body.id}/combatants/${otherCombatant.body.id}`).set(dm).send({ idempotencyKey });
      expect(independent.status).toBe(200);
      expect(independent.body.undoToken).not.toBe(res.body.undoToken);

      const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      expect(getRes.body.combatants.some((c: { id: number }) => c.id === ruleMonsterId)).toBe(false);
    });

    it('scopes removal idempotency receipts to the requesting DM', async () => {
      const server = ctx.app.getHttpServer();
      const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Scoped removal receipt campaign' });
      const encounter = await request(server).post(`/api/v1/campaigns/${campaign.body.id}/encounters`).set(dm).send({ name: 'Scoped removal receipt' });
      const dmTarget = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'DM scoped receipt', hpMax: 2 });
      const otherDmTarget = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'Other DM scoped receipt', hpMax: 2 });
      const sharedKey = 'ba7a1d0f-8f86-45d7-8a86-c0e159c05d31';

      // Two DMs can independently choose the same key without exposing each
      // other's undo capability or suppressing the second removal.
      const dmRemoval = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${dmTarget.body.id}`).set(dm).send({ idempotencyKey: sharedKey });
      const otherDmRemoval = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${otherDmTarget.body.id}`).set(otherDm).send({ idempotencyKey: sharedKey });
      expect(dmRemoval.status).toBe(200);
      expect(otherDmRemoval.status).toBe(200);
      expect(otherDmRemoval.body.undoToken).not.toBe(dmRemoval.body.undoToken);
      const otherDmReplay = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${otherDmTarget.body.id}`).set(otherDm).send({ idempotencyKey: sharedKey });
      expect(otherDmReplay.body).toEqual(otherDmRemoval.body);
    });

    it('removal undo is DM-gated, exact, and one-shot', async () => {
      const server = ctx.app.getHttpServer();
      const added = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Undo target', hpMax: 9 });
      const id = added.body.id;
      await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${id}`).set(dm).send({ hpSet: 3, initiative: 14, addConditions: ['prone'] });
      const removed = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${id}`).set(dm);
      expect(removed.status).toBe(200);
      expect(typeof removed.body.undoToken).toBe('string');
      const denied = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(player).send({ undoToken: removed.body.undoToken });
      expect(denied.status).toBe(403);
      const [restored, raced] = await Promise.all([
        request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken }),
        request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken }),
      ]);
      expect([restored.status, raced.status].filter((status) => status === 201)).toHaveLength(2);
      const winner = restored;
      expect(winner.body).toMatchObject({ id, hpCurrent: 3, initiative: 14, conditions: ['prone'] });
      const replay = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken });
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ id, hpCurrent: 3, initiative: 14, conditions: ['prone'] });

      // A later removal runs token cleanup. It must not erase this consumed
      // receipt while the 30-second lost-response replay window is still open.
      const cleanupTrigger = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Cleanup trigger', hpMax: 2 });
      expect((await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${cleanupTrigger.body.id}`).set(dm)).status).toBe(200);
      const replayAfterCleanup = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken });
      expect(replayAfterCleanup.status).toBe(201);
      expect(replayAfterCleanup.body).toMatchObject({ id, hpCurrent: 3, initiative: 14, conditions: ['prone'] });

      const expiring = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Expired undo', hpMax: 2 });
      const expiredIdempotencyKey = 'e479599d-c776-4459-a3c6-b04483044d98';
      const removedExpired = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${expiring.body.id}`).set(dm).send({ idempotencyKey: expiredIdempotencyKey });
      const db = ctx.app.get<DrizzleDb>(DB);
      await db.update(combatantRemovalUndos).set({ expiresAt: '2000-01-01T00:00:00.000Z' }).where(eq(combatantRemovalUndos.token, removedExpired.body.undoToken));
      const expired = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: removedExpired.body.undoToken });
      expect(expired.status).toBe(404);
      const expiredRetry = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${expiring.body.id}`).set(dm).send({ idempotencyKey: expiredIdempotencyKey });
      expect(expiredRetry.status).toBe(200);
      expect(expiredRetry.body.undoToken).toBe(removedExpired.body.undoToken);
      const nonIdempotentRetry = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${expiring.body.id}`).set(dm);
      expect(nonIdempotentRetry.status).toBe(404);
    });

    it('undo nulls a rule entry reference removed during its recovery window', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const added = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', ruleEntryId });
      expect(added.status).toBe(201);
      const removed = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${added.body.id}`).set(dm);
      expect(removed.status).toBe(200);
      await db.delete(ruleEntries).where(eq(ruleEntries.id, ruleEntryId));

      const restored = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken });
      expect(restored.status).toBe(201);
      expect(restored.body.ruleEntryId).toBeNull();
    });

    it('does not restore a removal token after its encounter is trashed', async () => {
      const server = ctx.app.getHttpServer();
      const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Trashed undo encounter' });
      const encounter = await request(server).post(`/api/v1/campaigns/${campaign.body.id}/encounters`).set(dm).send({ name: 'Recovery target' });
      const added = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'Removed before trash', hpMax: 2 });
      const idempotencyKey = 'b28cf782-39e7-4428-993a-2cf819d74f21';
      const removed = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${added.body.id}`).set(dm).send({ idempotencyKey });
      expect(removed.status).toBe(200);
      expect((await request(server).delete(`/api/v1/encounters/${encounter.body.id}`).set(dm)).status).toBe(200);

      const replay = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${added.body.id}`).set(dm).send({ idempotencyKey });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(removed.body);

      const restored = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken });
      expect(restored.status).toBe(404);
    });

    it('replays a removal retry after undo without removing the restored combatant', async () => {
      const server = ctx.app.getHttpServer();
      const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Fresh removal retry campaign' });
      const encounter = await request(server).post(`/api/v1/campaigns/${campaign.body.id}/encounters`).set(dm).send({ name: 'Fresh removal retry' });
      const added = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'Fresh retry target', hpMax: 2 });
      const idempotencyKey = 'd2c59f5c-0e24-4dca-8ebb-a6f82e1a6959';
      const removed = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${added.body.id}`).set(dm).send({ idempotencyKey });
      expect((await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken })).status).toBe(201);

      const repeatedRemoval = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${added.body.id}`).set(dm).send({ idempotencyKey });
      expect(repeatedRemoval.status).toBe(200);
      expect(repeatedRemoval.body).toEqual(removed.body);
      const afterRetry = await request(server).get(`/api/v1/encounters/${encounter.body.id}`).set(dm);
      expect(afterRetry.body.combatants).toEqual(expect.arrayContaining([expect.objectContaining({ id: added.body.id })]));
    });

    it('replays a consumed undo after the restored combatant is removed again', async () => {
      const server = ctx.app.getHttpServer();
      const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Consumed undo replay campaign' });
      const encounter = await request(server).post(`/api/v1/campaigns/${campaign.body.id}/encounters`).set(dm).send({ name: 'Consumed undo replay' });
      const added = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'Replay after removal', hpMax: 2 });
      const removed = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${added.body.id}`).set(dm);
      const restored = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken });
      expect(restored.status).toBe(201);

      const laterRemoval = await request(server)
        .delete(`/api/v1/encounters/${encounter.body.id}/combatants/${added.body.id}`)
        .set(dm)
        .send({ idempotencyKey: 'a5368c9d-21e1-4a6e-8e44-57db0e36a36f' });
      expect(laterRemoval.status).toBe(200);

      const replay = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken });
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(restored.body);
    });

    it('replays the consumed undo response after the restored combatant changes', async () => {
      const server = ctx.app.getHttpServer();
      const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Undo response replay campaign' });
      const encounter = await request(server).post(`/api/v1/campaigns/${campaign.body.id}/encounters`).set(dm).send({ name: 'Undo response replay' });
      const added = await request(server)
        .post(`/api/v1/encounters/${encounter.body.id}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Replay response target', hpMax: 5 });
      const removed = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${added.body.id}`).set(dm);
      const restored = await request(server)
        .post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`)
        .set(dm)
        .send({ undoToken: removed.body.undoToken });
      expect(restored.status).toBe(201);
      expect((await request(server)
        .patch(`/api/v1/encounters/${encounter.body.id}/combatants/${added.body.id}`)
        .set(dm)
        .send({ hpDelta: -2 })).body.hpCurrent).toBe(3);

      const replay = await request(server)
        .post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`)
        .set(dm)
        .send({ undoToken: removed.body.undoToken });
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(restored.body);
    });

    it('replays a consumed removal undo after the encounter ends', async () => {
      const server = ctx.app.getHttpServer();
      const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Ended undo replay campaign' });
      const encounter = await request(server).post(`/api/v1/campaigns/${campaign.body.id}/encounters`).set(dm).send({ name: 'Ended undo replay' });
      const added = await request(server)
        .post(`/api/v1/encounters/${encounter.body.id}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Replay target', hpMax: 2 });
      expect((await request(server).post(`/api/v1/encounters/${encounter.body.id}/roll-initiative`).set(dm)).status).toBe(201);
      expect((await request(server).post(`/api/v1/encounters/${encounter.body.id}/start`).set(dm)).status).toBe(201);
      const removed = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${added.body.id}`).set(dm);
      expect(removed.status).toBe(200);
      expect((await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken })).status).toBe(201);
      expect((await request(server).post(`/api/v1/encounters/${encounter.body.id}/end`).set(dm)).status).toBe(201);

      const replay = await request(server)
        .post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`)
        .set(dm)
        .send({ undoToken: removed.body.undoToken });
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ id: added.body.id, name: 'Replay target' });
    });

    it('replays a consumed removal undo after the encounter is trashed', async () => {
      const server = ctx.app.getHttpServer();
      const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Trashed undo replay campaign' });
      const encounter = await request(server).post(`/api/v1/campaigns/${campaign.body.id}/encounters`).set(dm).send({ name: 'Trashed undo replay' });
      const added = await request(server)
        .post(`/api/v1/encounters/${encounter.body.id}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Trashed replay target', hpMax: 2 });
      const removed = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${added.body.id}`).set(dm);
      const restored = await request(server)
        .post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`)
        .set(dm)
        .send({ undoToken: removed.body.undoToken });
      expect(restored.status).toBe(201);
      expect((await request(server).delete(`/api/v1/encounters/${encounter.body.id}`).set(dm)).status).toBe(200);

      const replay = await request(server)
        .post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`)
        .set(dm)
        .send({ undoToken: removed.body.undoToken });
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ id: added.body.id, name: 'Trashed replay target' });
    });

    it('rolls back a removal when its audit write fails', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const added = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Audit rollback target', hpMax: 2 });
      const id = added.body.id as number;
      await db.run(sql.raw(`CREATE TRIGGER fail_combatant_remove_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'encounter.combatant.remove' AND NEW.entity_id = ${id} BEGIN SELECT RAISE(ABORT, 'injected combatant removal audit failure'); END`));
      try {
        const removed = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${id}`).set(dm);
        expect(removed.status).toBe(500);
        expect((await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm)).body.combatants.some((c: { id: number }) => c.id === id)).toBe(true);
        expect((await db.select().from(combatantRemovalUndos).where(eq(combatantRemovalUndos.combatantId, id))).length).toBe(0);
      } finally {
        await db.run(sql`DROP TRIGGER IF EXISTS fail_combatant_remove_audit`);
      }
    });

    it('rolls back combatant, encounter state, undo token, and escalation event when the event write fails', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const ts = new Date().toISOString();
      await db.insert(rulePacks).values({ slug: 'archmage-srd', name: 'Archmage SRD', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 0 }).onConflictDoNothing();
      const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Undo event rollback', ruleSystem: 'archmage-srd' });
      const encounter = await request(server).post(`/api/v1/campaigns/${campaign.body.id}/encounters`).set(dm).send({ name: 'Escalation rollback' });
      const first = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'First', hpMax: 2 });
      const last = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'Last', hpMax: 2 });
      expect((await request(server).patch(`/api/v1/encounters/${encounter.body.id}/combatants/${first.body.id}`).set(dm).send({ initiative: 20 })).status).toBe(200);
      expect((await request(server).patch(`/api/v1/encounters/${encounter.body.id}/combatants/${last.body.id}`).set(dm).send({ initiative: 10 })).status).toBe(200);
      expect((await request(server).post(`/api/v1/encounters/${encounter.body.id}/start`).set(dm)).status).toBe(201);
      expect((await request(server).post(`/api/v1/encounters/${encounter.body.id}/next-turn`).set(dm)).status).toBe(201);
      const before = await request(server).get(`/api/v1/encounters/${encounter.body.id}`).set(dm);
      expect(before.body.currentCombatantId).toBe(last.body.id);
      const eventsBefore = (await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, encounter.body.id))).length;
      await db.run(sql.raw(`CREATE TRIGGER fail_combatant_remove_event BEFORE INSERT ON encounter_events WHEN NEW.encounter_id = ${encounter.body.id} BEGIN SELECT RAISE(ABORT, 'injected combatant removal event failure'); END`));
      try {
        const removed = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${last.body.id}`).set(dm);
        expect(removed.status).toBe(500);
        const after = await request(server).get(`/api/v1/encounters/${encounter.body.id}`).set(dm);
        expect(after.body).toMatchObject({ currentCombatantId: before.body.currentCombatantId, turnIndex: before.body.turnIndex, round: before.body.round, escalationDie: before.body.escalationDie, escalationDieHistory: before.body.escalationDieHistory });
        expect(after.body.combatants.some((c: { id: number }) => c.id === last.body.id)).toBe(true);
        expect((await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, encounter.body.id))).length).toBe(eventsBefore);
        expect((await db.select().from(combatantRemovalUndos).where(eq(combatantRemovalUndos.combatantId, last.body.id))).length).toBe(0);
      } finally {
        await db.run(sql`DROP TRIGGER IF EXISTS fail_combatant_remove_event`);
      }
    });

    it('undo restores exact Archmage escalation state and reconciles a newer turn index', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const ts = new Date().toISOString();
      await db.insert(rulePacks).values({ slug: 'archmage-srd', name: 'Archmage SRD', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 0 }).onConflictDoNothing();
      const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Undo exact state', ruleSystem: 'archmage-srd' });
      const encounter = await request(server).post(`/api/v1/campaigns/${campaign.body.id}/encounters`).set(dm).send({ name: 'Undo state' });
      const high = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'High', hpMax: 2 });
      const low = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'Low', hpMax: 2 });
      await request(server).patch(`/api/v1/encounters/${encounter.body.id}/combatants/${high.body.id}`).set(dm).send({ initiative: 20 });
      await request(server).patch(`/api/v1/encounters/${encounter.body.id}/combatants/${low.body.id}`).set(dm).send({ initiative: 10 });
      expect((await request(server).post(`/api/v1/encounters/${encounter.body.id}/start`).set(dm)).status).toBe(201);
      expect((await request(server).post(`/api/v1/encounters/${encounter.body.id}/next-turn`).set(dm)).status).toBe(201);
      const beforeRemoval = await request(server).get(`/api/v1/encounters/${encounter.body.id}`).set(dm);
      const beforeRemovalTurnVersion = (await db.select({ turnVersion: encountersTable.turnVersion }).from(encountersTable).where(eq(encountersTable.id, encounter.body.id)).get())!.turnVersion;
      const eventsBeforeRemoval = (await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, encounter.body.id))).length;
      expect(beforeRemoval.body.currentCombatantId).toBe(low.body.id);
      const removed = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${low.body.id}`).set(dm);
      expect(removed.status).toBe(200);
      const afterRemoval = await request(server).get(`/api/v1/encounters/${encounter.body.id}`).set(dm);
      const afterRemovalTurnVersion = (await db.select({ turnVersion: encountersTable.turnVersion }).from(encountersTable).where(eq(encountersTable.id, encounter.body.id)).get())!.turnVersion;
      expect(afterRemoval.body.round).toBe(beforeRemoval.body.round + 1);
      expect(afterRemovalTurnVersion).toBeGreaterThan(beforeRemovalTurnVersion);
      const restored = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken });
      expect(restored.status).toBe(201);
      const afterUndo = await request(server).get(`/api/v1/encounters/${encounter.body.id}`).set(dm);
      const afterUndoTurnVersion = (await db.select({ turnVersion: encountersTable.turnVersion }).from(encountersTable).where(eq(encountersTable.id, encounter.body.id)).get())!.turnVersion;
      expect(afterUndo.body).toMatchObject({ currentCombatantId: beforeRemoval.body.currentCombatantId, turnIndex: beforeRemoval.body.turnIndex, round: beforeRemoval.body.round, escalationDie: beforeRemoval.body.escalationDie, escalationDieHistory: beforeRemoval.body.escalationDieHistory });
      expect(afterUndoTurnVersion).toBeGreaterThan(afterRemovalTurnVersion);
      expect((await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, encounter.body.id))).length).toBe(eventsBeforeRemoval);

      const removedHigh = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${high.body.id}`).set(dm);
      expect(removedHigh.status).toBe(200);
      expect((await request(server).patch(`/api/v1/encounters/${encounter.body.id}/combatants/${low.body.id}`).set(dm).send({ initiative: 40 })).status).toBe(200);
      const restoredAfterInitiativeEdit = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`).set(dm).send({ undoToken: removedHigh.body.undoToken });
      expect(restoredAfterInitiativeEdit.status).toBe(201);
      const afterInitiativeEditUndo = await request(server).get(`/api/v1/encounters/${encounter.body.id}`).set(dm);
      expect(afterInitiativeEditUndo.body).toMatchObject({ currentCombatantId: low.body.id, turnIndex: 0 });

      const removedHighAfterInitiativeEdit = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${high.body.id}`).set(dm);
      expect(removedHighAfterInitiativeEdit.status).toBe(200);
      expect((await request(server).post(`/api/v1/encounters/${encounter.body.id}/next-turn`).set(dm)).status).toBe(201);
      const restoredAfterTurn = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`).set(dm).send({ undoToken: removedHighAfterInitiativeEdit.body.undoToken });
      expect(restoredAfterTurn.status).toBe(201);
      const reconciled = await request(server).get(`/api/v1/encounters/${encounter.body.id}`).set(dm);
      expect(reconciled.body).toMatchObject({ currentCombatantId: low.body.id, turnIndex: 0 });

      // An ABA sequence can return every visible pointer field to the removal
      // snapshot. Keep the newer logical-turn version so Undo reconciles rather
      // than moving the pointer back and reviving a player action preview.
      const removedLowAfterNewerTurn = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${low.body.id}`).set(dm);
      expect(removedLowAfterNewerTurn.status).toBe(200);
      const postRemoval = await request(server).get(`/api/v1/encounters/${encounter.body.id}`).set(dm);
      const postRemovalTurnVersion = (await db.select({ turnVersion: encountersTable.turnVersion }).from(encountersTable).where(eq(encountersTable.id, encounter.body.id)).get())!.turnVersion;
      await db.update(encountersTable).set({ turnVersion: sql`${encountersTable.turnVersion} + 2` }).where(eq(encountersTable.id, encounter.body.id));
      const restoredAfterAba = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`).set(dm).send({ undoToken: removedLowAfterNewerTurn.body.undoToken });
      expect(restoredAfterAba.status).toBe(201);
      const afterAbaUndo = await request(server).get(`/api/v1/encounters/${encounter.body.id}`).set(dm);
      const afterAbaUndoTurnVersion = (await db.select({ turnVersion: encountersTable.turnVersion }).from(encountersTable).where(eq(encountersTable.id, encounter.body.id)).get())!.turnVersion;
      expect(afterAbaUndo.body).toMatchObject({ currentCombatantId: postRemoval.body.currentCombatantId, turnIndex: 1, round: postRemoval.body.round });
      expect(afterAbaUndoTurnVersion).toBe(postRemovalTurnVersion + 2);
    });

    it('undo restores the lair resume pointer without relying on a database foreign key', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      // This needs its own campaign so it can start a running encounter without
      // contending with the shared full-flow fixture's authoritative live fight.
      const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Undo lair resume campaign' });
      const encounter = await request(server).post(`/api/v1/campaigns/${campaign.body.id}/encounters`).set(dm).send({ name: 'Undo lair resume' });
      const target = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'Lair resume target', hpMax: 2 });
      const other = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'Lair resume other', hpMax: 2 });
      expect((await request(server).patch(`/api/v1/encounters/${encounter.body.id}/combatants/${target.body.id}`).set(dm).send({ initiative: 20 })).status).toBe(200);
      expect((await request(server).patch(`/api/v1/encounters/${encounter.body.id}/combatants/${other.body.id}`).set(dm).send({ initiative: 10 })).status).toBe(200);
      expect((await request(server).post(`/api/v1/encounters/${encounter.body.id}/start`).set(dm)).status).toBe(201);
      await db.update(encountersTable).set({ lairResumeCombatantId: target.body.id }).where(eq(encountersTable.id, encounter.body.id));

      // Older additive schemas have no ON DELETE SET NULL constraint on this column.
      // The service must still clear and restore it explicitly.
      await db.run(sql.raw('PRAGMA foreign_keys = OFF'));
      try {
        const removed = await request(server).delete(`/api/v1/encounters/${encounter.body.id}/combatants/${target.body.id}`).set(dm);
        expect(removed.status).toBe(200);
        const afterRemoval = await db.select().from(encountersTable).where(eq(encountersTable.id, encounter.body.id)).get();
        expect(afterRemoval?.lairResumeCombatantId).toBeNull();
        // A later combatant write forces Undo down its reconcile path rather than
        // the exact rewind path. It must still restore the pointer cleared solely
        // because the removed combatant was the pending lair target.
        expect((await request(server).patch(`/api/v1/encounters/${encounter.body.id}/combatants/${other.body.id}`).set(dm).send({ hpDelta: -1 })).status).toBe(200);
        const restored = await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken });
        expect(restored.status).toBe(201);
        const afterUndo = await db.select().from(encountersTable).where(eq(encountersTable.id, encounter.body.id)).get();
        expect(afterUndo?.lairResumeCombatantId).toBe(target.body.id);
      } finally {
        await db.run(sql.raw('PRAGMA foreign_keys = ON'));
      }
    });

    it('undo conflicts cleanly when the same character was re-added during its window', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const character = await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Undo identity conflict', hpCurrent: 8, hpMax: 8 });
      const original = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'character', characterId: character.body.id });
      const removed = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${original.body.id}`).set(dm);
      const replacement = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'character', characterId: character.body.id });
      expect(replacement.status).toBe(201);
      const undo = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: removed.body.undoToken });
      expect(undo.status).toBe(409);
      expect(undo.body).toMatchObject({ code: 'COMBATANT_IDENTITY_CONFLICT', combatantId: replacement.body.id });
      expect((await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm)).body.combatants.filter((c: { characterId: number | null }) => c.characterId === character.body.id)).toHaveLength(1);
      const [storedUndo] = await db.select().from(combatantRemovalUndos).where(eq(combatantRemovalUndos.token, removed.body.undoToken));
      expect(storedUndo.consumedAt).toBeNull();
    });

    it('undo restores unlinked combatants after their character or NPC is permanently deleted', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const character = await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Undo deleted character', hpCurrent: 8, hpMax: 8 });
      const characterCombatant = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'character', characterId: character.body.id });
      const removedCharacter = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${characterCombatant.body.id}`).set(dm);
      await db.delete(characters).where(eq(characters.id, character.body.id));
      const restoredCharacter = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: removedCharacter.body.undoToken });
      expect(restoredCharacter.status).toBe(201);
      expect(restoredCharacter.body.characterId).toBeNull();

      const npc = await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Undo deleted NPC' });
      const npcCombatant = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'npc', npcId: npc.body.id, hpMax: 8 });
      expect(npcCombatant.status).toBe(201);
      const removedNpc = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${npcCombatant.body.id}`).set(dm);
      expect(removedNpc.status).toBe(200);
      await db.delete(npcs).where(eq(npcs.id, npc.body.id));
      const restoredNpc = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: removedNpc.body.undoToken });
      expect(restoredNpc.status).toBe(201);
      expect(restoredNpc.body.npcId).toBeNull();
    });

    it('undo preserves encounter-local linked-combatant fields and only pulls a changed sheet', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const character = await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Undo local override', hpCurrent: 8, hpMax: 8 });
      const added = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'character', characterId: character.body.id });
      expect((await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${added.body.id}`).set(dm).send({ hpMax: 14, hpSet: 11 })).status).toBe(200);
      const unchangedSheetRemoval = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${added.body.id}`).set(dm);
      const unchangedSheetRestore = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: unchangedSheetRemoval.body.undoToken });
      expect(unchangedSheetRestore.body).toMatchObject({ hpCurrent: 11, hpMax: 14 });

      const changedRemoval = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${added.body.id}`).set(dm);
      expect((await request(server).patch(`/api/v1/characters/${character.body.id}`).set(dm).send({ hpCurrent: 4 })).status).toBe(200);
      const changedRestore = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: changedRemoval.body.undoToken });
      expect(changedRestore.body).toMatchObject({ hpCurrent: 4, hpMax: 14 });

      // A mid-window level-up mirrors both the sheet's raised maximum and its
      // increased current HP into a live combatant. Undo must preserve that
      // newer sheet slice rather than clamping it to the old local maximum.
      const raisedMaxRemoval = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${added.body.id}`).set(dm);
      expect((await request(server).post(`/api/v1/characters/${character.body.id}/level-up`).set(dm).send({ hpMax: 20 })).status).toBe(201);
      const raisedMaxRestore = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: raisedMaxRemoval.body.undoToken });
      expect(raisedMaxRestore.body).toMatchObject({ hpCurrent: 16, hpMax: 20 });

      // A sheet edit before removal is not an edit during the recovery window.
      // Preserve the snapshot rather than comparing against its older sync stamp.
      expect((await request(server).patch(`/api/v1/characters/${character.body.id}`).set(dm).send({ name: 'Undo local override renamed' })).status).toBe(200);
      await db.update(combatantsTable).set({ hpCurrent: 7 }).where(eq(combatantsTable.id, added.body.id));
      const preexistingMismatchRemoval = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${added.body.id}`).set(dm);
      expect(preexistingMismatchRemoval.status).toBe(200);
      const preexistingMismatchRestore = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: preexistingMismatchRemoval.body.undoToken });
      expect(preexistingMismatchRestore.status).toBe(201);
      expect(preexistingMismatchRestore.body).toMatchObject({ hpCurrent: 7, hpMax: 20 });
      // A name-only sheet edit changes updatedAt, but is not sheet-owned combat
      // state. Preserve the encounter-local HP (and, by the same merge rule,
      // local timed condition metadata) captured in the removal snapshot.
      const nameOnlyRemoval = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${added.body.id}`).set(dm);
      expect((await request(server).patch(`/api/v1/characters/${character.body.id}`).set(dm).send({ name: 'Undo local override renamed during removal' })).status).toBe(200);
      const nameOnlyRestore = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: nameOnlyRemoval.body.undoToken });
      expect(nameOnlyRestore.body).toMatchObject({ hpCurrent: 7, hpMax: 20 });

      // A maximum-only sheet reduction can leave its current HP unchanged while
      // an encounter-local override is higher. Undo must clamp that local value
      // to the newer sheet maximum even though there is no new sheet current HP
      // to pull.
      expect((await request(server).patch(`/api/v1/characters/${character.body.id}`).set(dm).send({ hpCurrent: 4, hpMax: 8 })).status).toBe(200);
      expect((await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${added.body.id}`).set(dm).send({ hpSet: 12, hpMax: 14 })).status).toBe(200);
      const loweredMaxRemoval = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${added.body.id}`).set(dm);
      expect((await request(server).patch(`/api/v1/characters/${character.body.id}`).set(dm).send({ hpMax: 6 })).status).toBe(200);
      const loweredMaxRestore = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: loweredMaxRemoval.body.undoToken });
      expect(loweredMaxRestore.body).toMatchObject({ hpCurrent: 6, hpMax: 6 });

      // A combat-only timed condition is absent from the sheet at removal. Adding a
      // different sheet condition during the recovery window must not replace that
      // timed instance with the sheet's metadata-free copy (or drop it entirely).
      const timedPoison = {
        id: 'undo_timed_poison', name: 'poisoned', ruleEntryId: null, source: 'Giant spider',
        sourceCombatantId: 777, durationRounds: 3, roundsRemaining: 2, timing: 'end-of-turn',
        saveTiming: 'end-of-turn', saveDc: 13, saveAbility: 'con', isConcentration: false,
        stacks: 1, notes: 'local timer', custom: false,
      };
      await db.update(combatantsTable)
        .set({ conditions: JSON.stringify(['poisoned']), conditionInstances: JSON.stringify([timedPoison]) })
        .where(eq(combatantsTable.id, added.body.id));
      const conditionRemoval = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${added.body.id}`).set(dm);
      expect((await request(server).post(`/api/v1/characters/${character.body.id}/conditions`).set(dm).send({ add: ['blessed'] })).status).toBe(201);
      const conditionRestore = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: conditionRemoval.body.undoToken });
      const restoredPoison = conditionRestore.body.conditionInstances.find((instance: { name: string }) => instance.name === 'poisoned');
      expect(restoredPoison).toMatchObject({ sourceCombatantId: 777, roundsRemaining: 2, saveTiming: 'end-of-turn', notes: 'local timer' });
      expect(conditionRestore.body.conditionInstances.find((instance: { name: string }) => instance.name === 'blessed')).toBeDefined();
      // The sheet and encounter can both have a same-named condition. Removing the
      // sheet-owned instance during the undo window must retain the distinct local
      // timer/source instance rather than filtering every matching display name.
      const sheetPoison = {
        id: 'undo_sheet_poison', name: 'poisoned', ruleEntryId: null, source: null,
        sourceCombatantId: null, durationRounds: null, roundsRemaining: null, timing: 'none',
        saveTiming: 'none', saveDc: null, saveAbility: null, isConcentration: false,
        stacks: 1, notes: '', custom: false,
      };
      const localPoison = { ...timedPoison, id: 'undo_distinct_local_poison', sourceCombatantId: 888 };
      const removalWindowSheetUpdate = new Date(Date.now() + 1_000).toISOString();
      await db.update(characters)
        .set({ conditions: JSON.stringify(['poisoned']), conditionInstances: JSON.stringify([sheetPoison]), updatedAt: removalWindowSheetUpdate })
        .where(eq(characters.id, character.body.id));
      await db.update(combatantsTable)
        .set({ conditions: JSON.stringify(['poisoned']), conditionInstances: JSON.stringify([sheetPoison, localPoison]) })
        .where(eq(combatantsTable.id, added.body.id));
      const sameNameRemoval = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${added.body.id}`).set(dm);
      const sheetRemovalUpdatedAt = new Date(Date.now() + 2_000).toISOString();
      await db.update(characters)
        .set({ conditions: JSON.stringify([]), conditionInstances: JSON.stringify([]), updatedAt: sheetRemovalUpdatedAt })
        .where(eq(characters.id, character.body.id));
      const sameNameRestore = await request(server).post(`/api/v1/encounters/${encounterId}/combatants/undo-remove`).set(dm).send({ undoToken: sameNameRemoval.body.undoToken });
      expect(sameNameRestore.status).toBe(201);
      expect(sameNameRestore.body.conditionInstances).toEqual([expect.objectContaining({ id: 'undo_distinct_local_poison', sourceCombatantId: 888, roundsRemaining: 2 })]);
      // Keep the shared full-flow encounter eligible for its later HP write-back test.
      expect((await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${added.body.id}`).set(dm)).status).toBe(200);
    });

    it('combatant routes 404 when encounterId doesn\'t own the combatant (cross-parent-id pin)', async () => {
      const server = ctx.app.getHttpServer();

      // A second, unrelated encounter in the same campaign.
      const otherEncRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Unrelated Fight', hidden: false });
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
      const freshRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Not Started Yet', hidden: false });
      const freshId = freshRes.body.id;

      const res = await request(server).post(`/api/v1/encounters/${freshId}/next-turn`).set(dm);
      expect(res.status).toBe(400);
    });

    it('/end on a non-running (preparing) encounter is rejected 400', async () => {
      const server = ctx.app.getHttpServer();
      const freshRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Never Started', hidden: false });
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
      const freshRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Still Preparing', hidden: false });
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

    it('delete trashes the encounter but keeps combatants and events for restore (issue #701)', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);

      const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Cleanup Test', hidden: false });
      expect(encRes.status).toBe(201);
      const encId = encRes.body.id;
      await request(server).post(`/api/v1/encounters/${encId}/roll-initiative`).set(dm);
      const startRes = await request(server).post(`/api/v1/encounters/${encId}/start`).set(dm);
      expect(startRes.status).toBe(201);

      const combatantsBefore = await db.select().from(combatantsTable).where(eq(combatantsTable.encounterId, encId));
      const eventsBefore = await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, encId));
      expect(combatantsBefore.length).toBeGreaterThan(0);
      expect(eventsBefore.length).toBeGreaterThan(0);

      const del = await request(server).delete(`/api/v1/encounters/${encId}`).set(dm);
      expect(del.status).toBe(200);

      const combatantsAfter = await db.select().from(combatantsTable).where(eq(combatantsTable.encounterId, encId));
      const eventsAfter = await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, encId));
      expect(combatantsAfter).toHaveLength(combatantsBefore.length);
      expect(eventsAfter).toHaveLength(eventsBefore.length);

      const restore = await request(server).post(`/api/v1/encounters/${encId}/restore`).set(dm);
      expect(restore.status).toBe(201);
      expect((await request(server).get(`/api/v1/encounters/${encId}`).set(dm)).status).toBe(200);
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

      const encRes = await request(server).post(`/api/v1/campaigns/${lcCampaignId}/encounters`).set(dm).send({ name: 'Initiative Check', hidden: false });
      expect(encRes.status).toBe(201);
      expect(encRes.body.combatants).toHaveLength(1);
      const lyra = encRes.body.combatants[0];
      expect(lyra.name).toBe('Lyra');
      expect(lyra.initMod).toBe(4); // floor((18-10)/2), NOT 0 despite the lowercase key
    });
  });

  describe('ended encounter is immutable (issues #163, #470)', () => {
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
      const encRes = await request(server).post(`/api/v1/campaigns/${endedCampaignId}/encounters`).set(dm).send({ name: 'Last Stand', hidden: false });
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

    it('encounter-level PATCHes (name, map, grid, fog, AoE, links, hidden) are rejected (409) on an ended encounter', async () => {
      const server = ctx.app.getHttpServer();

      const before = await request(server).get(`/api/v1/encounters/${endedEncounterId}`).set(dm);
      expect(before.status).toBe(200);
      const snapshot = before.body;

      const upload = await request(server)
        .post(`/api/v1/campaigns/${endedCampaignId}/attachments`)
        .set(dm)
        .field('kind', 'map')
        // Issue #604: a bare PNG signature is no longer accepted — the upload path
        // now reads the image header (to reject decompression bombs before anything
        // decodes them), so a fixture must be a real, decodable image. This test is
        // about ended-encounter immutability, not about admitting header-only bytes.
        .attach('file', MINIMAL_PNG_1X1, {
          filename: 'battle.png',
          contentType: 'image/png',
        });
      expect(upload.status).toBe(201);

      const loc = await request(server)
        .post(`/api/v1/campaigns/${endedCampaignId}/locations`)
        .set(dm)
        .send({ name: 'Frozen Hall' });
      expect(loc.status).toBe(201);

      const cases = [
        ['name', () => request(server).patch(`/api/v1/encounters/${endedEncounterId}`).set(dm).send({ name: 'Rewritten Title' })],
        [
          'mapAttachmentId',
          () => request(server).patch(`/api/v1/encounters/${endedEncounterId}`).set(dm).send({ mapAttachmentId: upload.body.id }),
        ],
        ['gridSize', () => request(server).patch(`/api/v1/encounters/${endedEncounterId}`).set(dm).send({ gridSize: 10 })],
        [
          'fog',
          () =>
            request(server)
              .patch(`/api/v1/encounters/${endedEncounterId}`)
              .set(dm)
              .send({ fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 50, h: 50 }] } }),
        ],
        [
          'aoe',
          () =>
            request(server)
              .patch(`/api/v1/encounters/${endedEncounterId}`)
              .set(dm)
              .send({ aoe: [{ id: 'aoe-1', shape: 'circle', x: 50, y: 50, sizeFt: 20, angleDeg: 0, color: null }] }),
        ],
        ['hidden', () => request(server).patch(`/api/v1/encounters/${endedEncounterId}`).set(dm).send({ hidden: true })],
        [
          'locationId',
          () => request(server).patch(`/api/v1/encounters/${endedEncounterId}`).set(dm).send({ locationId: loc.body.id }),
        ],
        [
          'generate-map',
          () => request(server).post(`/api/v1/encounters/${endedEncounterId}/generate-map`).set(dm).send({ kind: 'dungeon', size: 'large' }),
        ],
      ] as const;

      for (const [, req] of cases) {
        const res = await req();
        expect(res.status).toBe(409);
        const after = await request(server).get(`/api/v1/encounters/${endedEncounterId}`).set(dm);
        expect(after.body.name).toBe(snapshot.name);
        expect(after.body.mapAttachmentId).toBe(snapshot.mapAttachmentId);
        expect(after.body.gridSize).toBe(snapshot.gridSize);
        expect(after.body.fog).toEqual(snapshot.fog);
        expect(after.body.aoe).toEqual(snapshot.aoe);
        expect(after.body.hidden).toBe(snapshot.hidden);
        expect(after.body.locationId).toBe(snapshot.locationId);
        expect(after.body.status).toBe('ended');
      }
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

      const createRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(viewer).send({ name: 'Nope', hidden: false });
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

      const encRes = await request(server).post(`/api/v1/campaigns/${logCampaignId}/encounters`).set(dm).send({ name: 'Logged Fight', hidden: false });
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
      const turns = (res.body as Array<{ type: string; round: number }>).filter((event) => event.type === 'turn');
      expect(turns).toHaveLength(1);
      expect(turns[0].round).toBe(1);
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
  // Combat-log damage attribution (issue #620)
  // ------------------------------------------------------------------
  describe('combat-log damage attribution (issue #620)', () => {
    let actorCampId: number;
    let actorEncounterId: number;
    let emberId: number;
    let goblinId: number;

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      // A fresh campaign with NO party characters, so the only combatants are the two
      // we add explicitly — Ember (the attacker) and Goblin (the target). With no
      // party auto-add, the current-turn pointer after /start is deterministic: it
      // points at whichever of the two sorts first by initiative. We set Ember's
      // initiative high so the current turn is Ember's, exercising the
      // current-combatant fallback path; the explicit-actorId path is covered in
      // its own test below with a different shape.
      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Actor Campaign' });
      actorCampId = campRes.body.id;

      const encRes = await request(server).post(`/api/v1/campaigns/${actorCampId}/encounters`).set(dm).send({ name: 'Attributed Fight', hidden: false });
      actorEncounterId = encRes.body.id;

      const addEmber = await request(server)
        .post(`/api/v1/encounters/${actorEncounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Ember', hpMax: 30, initMod: 5 });
      expect(addEmber.status).toBe(201);
      emberId = addEmber.body.id;

      const addGoblin = await request(server)
        .post(`/api/v1/encounters/${actorEncounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Goblin', hpMax: 7, initMod: -1 });
      expect(addGoblin.status).toBe(201);
      goblinId = addGoblin.body.id;

      // Pin Ember's initiative above Goblin's so Ember is the current-turn combatant
      // once combat starts (the default-actor fallback).
      await request(server).patch(`/api/v1/encounters/${actorEncounterId}/combatants/${emberId}`).set(dm).send({ initiative: 18 });
      await request(server).patch(`/api/v1/encounters/${actorEncounterId}/combatants/${goblinId}`).set(dm).send({ initiative: 6 });

      const start = await request(server).post(`/api/v1/encounters/${actorEncounterId}/start`).set(dm);
      expect(start.status).toBe(201);
    });

    it('records the current-turn combatant as the actor of a damage event', async () => {
      const server = ctx.app.getHttpServer();
      // Ember is the current-turn combatant; damaging Goblin attributes the hit to Ember.
      const patch = await request(server)
        .patch(`/api/v1/encounters/${actorEncounterId}/combatants/${goblinId}`)
        .set(dm)
        .send({ hpDelta: -4 });
      expect(patch.status).toBe(200);

      const res = await request(server).get(`/api/v1/encounters/${actorEncounterId}/events`).set(dm);
      const damage = (res.body as Array<{ type: string; actor: string | null; target: string | null; detail: string }>).filter(
        (e) => e.type === 'damage',
      );
      expect(damage.length).toBeGreaterThanOrEqual(1);
      const last = damage[damage.length - 1];
      expect(last.actor).toBe('Ember');
      expect(last.target).toBe('Goblin');
      expect(last.detail).toContain('4');
      // Issue #43 safety still holds: no exact resulting HP leaks into the log.
      expect(last.detail).not.toContain('3');
    });

    it('accepts an explicit actorId that overrides the current-turn combatant', async () => {
      const server = ctx.app.getHttpServer();
      // Even though Ember is the current turn, the caller names Goblin as the attacker
      // (e.g. friendly fire / a reaction). The log entry should attribute to Goblin.
      const patch = await request(server)
        .patch(`/api/v1/encounters/${actorEncounterId}/combatants/${emberId}`)
        .set(dm)
        .send({ hpDelta: -2, actorId: goblinId });
      expect(patch.status).toBe(200);

      const res = await request(server).get(`/api/v1/encounters/${actorEncounterId}/events`).set(dm);
      const damage = (res.body as Array<{ type: string; actor: string | null; target: string | null }>).filter(
        (e) => e.type === 'damage' && e.target === 'Ember',
      );
      expect(damage).toHaveLength(1);
      expect(damage[0].actor).toBe('Goblin');
    });

    it('records the actor on a heal event too', async () => {
      const server = ctx.app.getHttpServer();
      const patch = await request(server)
        .patch(`/api/v1/encounters/${actorEncounterId}/combatants/${goblinId}`)
        .set(dm)
        .send({ hpDelta: 3 });
      expect(patch.status).toBe(200);

      const res = await request(server).get(`/api/v1/encounters/${actorEncounterId}/events`).set(dm);
      const heal = (res.body as Array<{ type: string; actor: string | null; target: string | null }>).filter((e) => e.type === 'heal');
      expect(heal.length).toBeGreaterThanOrEqual(1);
      expect(heal[heal.length - 1].actor).toBe('Ember');
      expect(heal[heal.length - 1].target).toBe('Goblin');
    });

    it('drops the actor when the attacker is the target itself (no "Ember: took 4 damage")', async () => {
      const server = ctx.app.getHttpServer();
      // Self-damage: the current turn is Ember, and Ember is also the target. The actor
      // must collapse to null so the log keeps its established "Ember took 4 damage"
      // phrasing instead of the awkward "Ember: took 4 damage" the attributed form
      // would produce when actor and target are the same name.
      const patch = await request(server)
        .patch(`/api/v1/encounters/${actorEncounterId}/combatants/${emberId}`)
        .set(dm)
        .send({ hpDelta: -4 });
      expect(patch.status).toBe(200);

      const res = await request(server).get(`/api/v1/encounters/${actorEncounterId}/events`).set(dm);
      const selfDamage = (res.body as Array<{ type: string; actor: string | null; target: string | null }>).filter(
        (e) => e.type === 'damage' && e.target === 'Ember' && e.actor !== 'Goblin',
      );
      expect(selfDamage.length).toBeGreaterThanOrEqual(1);
      expect(selfDamage[selfDamage.length - 1].actor).toBeNull();
      expect(selfDamage[selfDamage.length - 1].target).toBe('Ember');
    });

    it('honors actorId: null as an explicit opt-out of current-turn attribution', async () => {
      const server = ctx.app.getHttpServer();
      // Ember is the current-turn combatant, so an omitted actorId would attribute to
      // Ember. Passing null must suppress attribution entirely (tri-state contract).
      const patch = await request(server)
        .patch(`/api/v1/encounters/${actorEncounterId}/combatants/${goblinId}`)
        .set(dm)
        .send({ hpDelta: -1, actorId: null });
      expect(patch.status).toBe(200);

      const res = await request(server).get(`/api/v1/encounters/${actorEncounterId}/events`).set(dm);
      const damage = (res.body as Array<{ type: string; actor: string | null; target: string | null; detail: string }>).filter(
        (e) => e.type === 'damage' && e.target === 'Goblin' && e.detail.includes('1'),
      );
      expect(damage.length).toBeGreaterThanOrEqual(1);
      expect(damage[damage.length - 1].actor).toBeNull();
    });

    it('ignores an actorId that does not reference a combatant in this encounter', async () => {
      const server = ctx.app.getHttpServer();
      // A stale client sends an actorId that doesn't belong to any combatant here. The
      // server falls back to the current-turn combatant (Ember) rather than 400ing or
      // polluting the log with a phantom name.
      const patch = await request(server)
        .patch(`/api/v1/encounters/${actorEncounterId}/combatants/${goblinId}`)
        .set(dm)
        .send({ hpDelta: -1, actorId: 999_999 });
      expect(patch.status).toBe(200);

      const res = await request(server).get(`/api/v1/encounters/${actorEncounterId}/events`).set(dm);
      const damage = (res.body as Array<{ type: string; actor: string | null; target: string | null; detail: string }>).filter(
        (e) => e.type === 'damage' && e.target === 'Goblin',
      );
      // Most recent Goblin-targeted damage should attribute to the current turn (Ember),
      // proving the bogus actorId was dropped, not stored verbatim.
      expect(damage[damage.length - 1].actor).toBe('Ember');
    });

    it('attributes a death event to the attacker when one is known', async () => {
      const server = ctx.app.getHttpServer();
      // Drop Goblin to 0 HP on Ember's turn — the death event should name Ember as actor.
      const patch = await request(server)
        .patch(`/api/v1/encounters/${actorEncounterId}/combatants/${goblinId}`)
        .set(dm)
        .send({ hpSet: 0 });
      expect(patch.status).toBe(200);

      const res = await request(server).get(`/api/v1/encounters/${actorEncounterId}/events`).set(dm);
      const death = (res.body as Array<{ type: string; actor: string | null; target: string | null; detail: string }>).filter(
        (e) => e.type === 'death',
      );
      expect(death).toHaveLength(1);
      expect(death[0].actor).toBe('Ember');
      expect(death[0].target).toBe('Goblin');
      expect(death[0].detail).toContain('0 HP');
    });
  });

  // ------------------------------------------------------------------
  // A player applying damage to their OWN combatant (issue #1478)
  // ------------------------------------------------------------------
  /**
   * The apply-damage bar used to attach `actorId` whenever the current-turn combatant
   * differed from the target, and the server 403s any non-DM patch carrying that field.
   * So a player damaging their own character failed whenever it was not that character's
   * turn — roughly half the time, decided by initiative.
   *
   * Both turn orders are pinned explicitly here (never rolled), so the case that used to
   * fail is exercised on every run rather than every other one. The anti-spoofing rule
   * itself is unchanged and is asserted below.
   */
  describe('player apply-damage to their own combatant (issue #1478)', () => {
    /** Fresh campaign + a player-owned character + a monster, with the turn order pinned. */
    async function setupOwnedFight(name: string, initiative: { hero: number; monster: number }) {
      const server = ctx.app.getHttpServer();
      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name });
      const campId = campRes.body.id;

      const charRes = await request(server)
        .post(`/api/v1/campaigns/${campId}/characters`)
        .send({ name: 'Brixi', stats: { DEX: 14 }, hpCurrent: 45, hpMax: 45, ownerUserId: 'dev:p-1' })
        .set(dm);
      expect(charRes.status).toBe(201);

      // Creating an encounter auto-adds the party, so Brixi's combatant already exists.
      const encRes = await request(server).post(`/api/v1/campaigns/${campId}/encounters`).set(dm).send({ name: 'Drill', hidden: false });
      expect(encRes.status).toBe(201);
      const encId = encRes.body.id;
      const heroId = (encRes.body.combatants as Array<{ id: number; characterId: number | null }>).find(
        (c) => c.characterId === charRes.body.id,
      )?.id;
      expect(heroId).toBeTruthy();

      const monsterRes = await request(server)
        .post(`/api/v1/encounters/${encId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Straw Dummy', hpMax: 30 });
      expect(monsterRes.status).toBe(201);
      const monsterId = monsterRes.body.id;

      // Pin the turn order: /start orders by initiative descending, so these two writes
      // fully determine who holds the turn. No d20 anywhere in this setup.
      await request(server).patch(`/api/v1/encounters/${encId}/combatants/${heroId}`).set(dm).send({ initiative: initiative.hero });
      await request(server).patch(`/api/v1/encounters/${encId}/combatants/${monsterId}`).set(dm).send({ initiative: initiative.monster });

      const start = await request(server).post(`/api/v1/encounters/${encId}/start`).set(dm);
      expect(start.status).toBe(201);
      // Guard the premise — if initiative ordering ever changes, fail here, loudly.
      expect(start.body.currentCombatantId).toBe(initiative.hero > initiative.monster ? heroId : monsterId);

      return { encId, heroId: heroId as number, monsterId: monsterId as number };
    }

    it('succeeds while a MONSTER holds the turn, attributing the hit to the current-turn combatant', async () => {
      const server = ctx.app.getHttpServer();
      // The exact repro: the monster holds the turn, so the old client attached
      // actorId=<monster> and ate a 403. The player now omits the field entirely.
      const { encId, heroId } = await setupOwnedFight('Owned Fight — monster turn', { hero: 4, monster: 20 });

      const patch = await request(server)
        .patch(`/api/v1/encounters/${encId}/combatants/${heroId}`)
        .set(player)
        .send({ hpDelta: -7 });
      expect(patch.status).toBe(200);
      expect(patch.body.hpCurrent).toBe(38);

      // Attribution is unchanged by dropping the field: the server derives the actor from
      // the current turn, which is the identical combatant the client used to name.
      const res = await request(server).get(`/api/v1/encounters/${encId}/events`).set(dm);
      const damage = (res.body as Array<{ type: string; actor: string | null; target: string | null }>).filter((e) => e.type === 'damage');
      expect(damage).toHaveLength(1);
      expect(damage[0].actor).toBe('Straw Dummy');
      expect(damage[0].target).toBe('Brixi');
    });

    it('still succeeds while the player’s OWN character holds the turn (regression guard)', async () => {
      const server = ctx.app.getHttpServer();
      // The half that always passed, because actor === target made the client omit actorId.
      const { encId, heroId } = await setupOwnedFight('Owned Fight — own turn', { hero: 20, monster: 4 });

      const patch = await request(server)
        .patch(`/api/v1/encounters/${encId}/combatants/${heroId}`)
        .set(player)
        .send({ hpDelta: -7 });
      expect(patch.status).toBe(200);
      expect(patch.body.hpCurrent).toBe(38);

      // Actor collapses to null: the current-turn combatant IS the target, so the log keeps
      // its "Brixi took 7 damage" phrasing rather than "Brixi: took 7 damage".
      const res = await request(server).get(`/api/v1/encounters/${encId}/events`).set(dm);
      const damage = (res.body as Array<{ type: string; actor: string | null; target: string | null }>).filter((e) => e.type === 'damage');
      expect(damage).toHaveLength(1);
      expect(damage[0].actor).toBeNull();
      expect(damage[0].target).toBe('Brixi');
    });

    it('still REJECTS a non-DM patch that carries an explicit actorId (anti-spoofing intact)', async () => {
      const server = ctx.app.getHttpServer();
      // The client-side fix must not have weakened the server rule. A player naming the
      // attacker is refused outright — including when the id they name is exactly the
      // current-turn combatant the server would have derived anyway. The field is
      // rejected, never ignored-when-redundant: tolerating it would be racy (the client's
      // notion of the current turn is a cached read) and would blur an absolute rule.
      const { encId, heroId, monsterId } = await setupOwnedFight('Owned Fight — spoof attempt', { hero: 4, monster: 20 });

      const spoof = await request(server)
        .patch(`/api/v1/encounters/${encId}/combatants/${heroId}`)
        .set(player)
        .send({ hpDelta: -7, actorId: monsterId });
      expect(spoof.status).toBe(403);
      // A machine-readable code so the UI can explain the refusal instead of a bare 403.
      expect(spoof.body.code).toBe('COMBAT_LOG_ACTOR_DM_ONLY');

      // Rejected means rejected: no HP moved and nothing reached the combat log.
      const after = await request(server).get(`/api/v1/encounters/${encId}`).set(dm);
      expect((after.body.combatants as Array<{ id: number; hpCurrent: number }>).find((c) => c.id === heroId)?.hpCurrent).toBe(45);
      const events = await request(server).get(`/api/v1/encounters/${encId}/events`).set(dm);
      expect((events.body as Array<{ type: string }>).filter((e) => e.type === 'damage')).toHaveLength(0);
    });

    it('rejects an explicit actorId from a non-DM even when it names the target itself', async () => {
      const server = ctx.app.getHttpServer();
      // `actorId === targetId` resolves to "no attribution" for a DM, so it is tempting to
      // treat it as harmless. It is still refused: the rule is about who may set the field
      // at all, not about which values happen to be inert.
      const { encId, heroId } = await setupOwnedFight('Owned Fight — self actor', { hero: 20, monster: 4 });

      const res = await request(server)
        .patch(`/api/v1/encounters/${encId}/combatants/${heroId}`)
        .set(player)
        .send({ hpDelta: -7, actorId: heroId });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('COMBAT_LOG_ACTOR_DM_ONLY');
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
      const encRes = await request(server).post(`/api/v1/campaigns/${sbCampaignId}/encounters`).set(dm).send({ name: 'SB Fight', hidden: false });
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
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Ambush at the Crossroads', hidden: false })
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

describe('encounters — lifecycle write serialization (issue #1461, e2e)', () => {
  let ctx: TestAppContext;
  let encounterId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Lifecycle Race Campaign' });
    const encounter = await request(server)
      .post(`/api/v1/campaigns/${campaign.body.id}/encounters`)
      .set(dm)
      .send({ name: 'Lifecycle Race' });
    encounterId = encounter.body.id;
    await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'First', hpMax: 12 });
    await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Second', hpMax: 12 });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function freshRunningEncounter(withCharacter = false) {
    const server = ctx.app.getHttpServer();
    const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: `Lifecycle Gate ${Date.now()}` });
    let characterId: number | undefined;
    if (withCharacter) {
      characterId = (await request(server).post(`/api/v1/campaigns/${campaign.body.id}/characters`).set(dm).send({ name: 'Gate Aria', hpCurrent: 20, hpMax: 20 })).body.id;
    }
    const encounter = await request(server).post(`/api/v1/campaigns/${campaign.body.id}/encounters`).set(dm).send({ name: 'Gated Fight' });
    if (!withCharacter) {
      await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'Gate One', hpMax: 12 });
      await request(server).post(`/api/v1/encounters/${encounter.body.id}/combatants`).set(dm).send({ kind: 'monster', name: 'Gate Two', hpMax: 12 });
    }
    await request(server).post(`/api/v1/encounters/${encounter.body.id}/roll-initiative`).set(dm).send({});
    const started = await request(server).post(`/api/v1/encounters/${encounter.body.id}/start`).set(dm).send({});
    return { encounterId: encounter.body.id as number, characterId, currentCombatantId: started.body.currentCombatantId as number };
  }

  function holdFirstEncounterRead(encounterId: number) {
    const service = ctx.app.get(EncountersService) as unknown as { getRowOrThrow: (id: number) => Promise<unknown> };
    const original = EncountersService.prototype.getRowOrThrow;
    let hold = true;
    let observed!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { observed = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    jest.spyOn(service, 'getRowOrThrow').mockImplementation(async (id) => {
      const row = await original.call(service as never, id);
      if (hold && id === encounterId) {
        hold = false;
        observed();
        await resume;
      }
      return row;
    });
    return { reached, release, restore: () => jest.restoreAllMocks() };
  }

  it('keeps a manual initiative written after roll reads but before its transaction', async () => {
    const server = ctx.app.getHttpServer();
    const { encounterId: gatedEncounterId } = await freshRunningEncounter();
    const combatant = (await request(server).get(`/api/v1/encounters/${gatedEncounterId}`).set(dm)).body.combatants[0];
    await request(server).patch(`/api/v1/encounters/${gatedEncounterId}/combatants/${combatant.id}`).set(dm).send({ initiative: null });
    const gate = holdFirstEncounterRead(gatedEncounterId);
    const rolling = request(server).post(`/api/v1/encounters/${gatedEncounterId}/roll-initiative`).set(dm).send({}).then((response) => response);
    await gate.reached;
    expect((await request(server).patch(`/api/v1/encounters/${gatedEncounterId}/combatants/${combatant.id}`).set(dm).send({ initiative: 19 })).status).toBe(200);
    gate.release();
    await rolling;
    gate.restore();
    const after = await request(server).get(`/api/v1/encounters/${gatedEncounterId}`).set(dm);
    expect(after.body.combatants.find((row: { id: number }) => row.id === combatant.id).initiative).toBe(19);
  });

  it('writes a heal that lands after End reads but before its transaction', async () => {
    const server = ctx.app.getHttpServer();
    const { encounterId: gatedEncounterId, characterId } = await freshRunningEncounter(true);
    const combatantId = (await request(server).get(`/api/v1/encounters/${gatedEncounterId}`).set(dm)).body.combatants[0].id;
    expect((await request(server).patch(`/api/v1/encounters/${gatedEncounterId}/combatants/${combatantId}`).set(dm).send({ hpSet: 10 })).status).toBe(200);
    const gate = holdFirstEncounterRead(gatedEncounterId);
    const ending = request(server).post(`/api/v1/encounters/${gatedEncounterId}/end`).set(dm).send({}).then((response) => response);
    await gate.reached;
    const healed = await request(server).patch(`/api/v1/encounters/${gatedEncounterId}/combatants/${combatantId}`).set(dm).send({ hpSet: 17 });
    expect(healed.status).toBe(200);
    expect(healed.body.hpCurrent).toBe(17);
    expect((await request(server).get(`/api/v1/encounters/${gatedEncounterId}`).set(dm)).body.combatants[0].hpCurrent).toBe(17);
    gate.release();
    expect((await ending).status).toBe(201);
    gate.restore();
    expect((await request(server).get(`/api/v1/characters/${characterId}`).set(dm)).body.hpCurrent).toBe(17);
  });

  it('concurrent next-turn and end-turn advance exactly once', async () => {
    const server = ctx.app.getHttpServer();
    const { encounterId: gatedEncounterId, currentCombatantId } = await freshRunningEncounter();
    const [next, end] = await Promise.all([
      request(server).post(`/api/v1/encounters/${gatedEncounterId}/next-turn`).set(dm).send({ expectedCurrentCombatantId: currentCombatantId }),
      request(server).post(`/api/v1/encounters/${gatedEncounterId}/end-turn`).set({ ...dm, 'x-dev-user': 'dm-2' }).send({ expectedCurrentCombatantId: currentCombatantId }),
    ]);
    expect([next.status, end.status].sort()).toEqual([201, 409]);
    const loser = next.status === 409 ? next : end;
    expect(loser.body.code ?? loser.body.message?.code).toBe('TURN_ALREADY_ADVANCED');
  });

  it('concurrent initiative rolls commit one value/log set, then only one concurrent end wins', async () => {
    const server = ctx.app.getHttpServer();
    const [firstRoll, secondRoll] = await Promise.all([
      request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm).send({}),
      request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set({ ...dm, 'x-dev-user': 'dm-2' }).send({}),
    ]);
    expect([firstRoll.body.rolledCount, secondRoll.body.rolledCount].sort()).toEqual([0, 2]);

    const db = ctx.app.get<DrizzleDb>(DB);
    const rollEvents = (await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, encounterId))).filter(
      (event) => event.type === 'roll',
    );
    expect(rollEvents).toHaveLength(2);

    expect((await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm).send({})).status).toBe(201);
    const [firstEnd, secondEnd] = await Promise.all([
      request(server).post(`/api/v1/encounters/${encounterId}/end`).set(dm).send({}),
      request(server).post(`/api/v1/encounters/${encounterId}/end`).set({ ...dm, 'x-dev-user': 'dm-2' }).send({}),
    ]);
    // A request that reaches the end transaction after the winner returns 409, while
    // one that observes the already-ended encounter before entering it retains the
    // established 400 endpoint contract. Either path must leave exactly one winner.
    const endStatuses = [firstEnd.status, secondEnd.status];
    expect(endStatuses.filter((status) => status === 201)).toHaveLength(1);
    expect([400, 409]).toContain(endStatuses.find((status) => status !== 201));
    expect((await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm)).body.status).toBe('ended');
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

    const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Secret Fight', hidden: false });
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
    const res = await outsiderAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Nope', hidden: false });
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
    encounterId = (await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Fight', hidden: false })).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('re-adding a character already present in the encounter is rejected 409', async () => {
    const server = ctx.app.getHttpServer();
    // Capture the winning combatant id (Aria was auto-added by create) so we can
    // assert the 409 body carries it (issue #749: the loser must learn which row won).
    const before = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const existingAria = (before.body.combatants as CombatantShape[]).find((c) => c.characterId === ariaId)!;
    const res = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'character', characterId: ariaId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COMBATANT_IDENTITY_CONFLICT');
    expect(res.body.combatantId).toBe(existingAria.id);

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

    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Ambush', hidden: false });
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

describe('encounters — issue #610: next-turn skips dead/downed combatants (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;
  let aliveId: number;
  let downedId: number;
  let nextAliveId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Skip Downed' })).body.id;

    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Skip Fight', hidden: false });
    encounterId = encRes.body.id;

    aliveId = (await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Alive', hpMax: 10 })).body.id;
    downedId = (await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Downed', hpMax: 10 })).body.id;
    nextAliveId = (await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Next', hpMax: 10 })).body.id;

    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${aliveId}`).set(dm).send({ initiative: 20 });
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${downedId}`).set(dm).send({ initiative: 15 });
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${nextAliveId}`).set(dm).send({ initiative: 10 });

    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${downedId}`).set(dm).send({ hpSet: 0 });

    const startRes = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    expect(startRes.status).toBe(201);
    expect(startRes.body.currentCombatantId).toBe(aliveId);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('next-turn skips a 0-HP monster and lands on the next living combatant', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.currentCombatantId).toBe(nextAliveId);
    expect(res.body.turnIndex).toBe(2);
    expect(res.body.round).toBe(1);
  });

  it('appends a skipped (down) turn event for the defeated monster', async () => {
    const server = ctx.app.getHttpServer();
    const events = (await request(server).get(`/api/v1/encounters/${encounterId}/events`).set(dm)).body as Array<{
      type: string;
      detail: string;
      targetId: number;
    }>;
    const skipped = events.filter((e) => e.type === 'turn' && e.detail === 'skipped (down)' && e.targetId === downedId);
    expect(skipped.length).toBeGreaterThanOrEqual(1);
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

    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Wrap Fight', hidden: false });
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
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Fight', hidden: false });
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
    const db = ctx.app.get<DrizzleDb>(DB);
    const before = await db
      .select({ combatantStateVersion: encountersTable.combatantStateVersion })
      .from(encountersTable)
      .where(eq(encountersTable.id, encounterId))
      .get();
    const res = await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    expect(res.status).toBe(201);
    for (const c of res.body.combatants as CombatantShape[]) {
      expect(c.initiative).not.toBeNull();
    }
    // Aria's manually-set initiative is left untouched.
    const aria = (res.body.combatants as CombatantShape[]).find((c) => c.id === ariaCombatantId);
    expect(aria?.initiative).toBe(12);
    const after = await db
      .select({ combatantStateVersion: encountersTable.combatantStateVersion })
      .from(encountersTable)
      .where(eq(encountersTable.id, encounterId))
      .get();
    expect(after?.combatantStateVersion).toBe((before?.combatantStateVersion ?? 0) + 1);
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

describe('encounters — issue #702: no-op roll-initiative + rolledCount (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'No-op Initiative Campaign' })).body.id;
    // An active party member so encounter auto-add yields a real combatant to roll for.
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Aria', stats: { DEX: 12 }, hpCurrent: 20, hpMax: 20 });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // Helper: count audit rows for a given action+entity so the no-op assertion can prove
  // the audit trail was NOT touched by an empty roll.
  async function countInitiativeAudits(encounterId: number): Promise<number> {
    const db = ctx.app.get<DrizzleDb>(DB);
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, encounterId));
    return rows.filter((row) => row.action === 'encounter.roll_initiative').length;
  }

  it('a fully-rolled roster is a no-op: rolledCount=0, no audit entry, no SSE broadcast', async () => {
    const server = ctx.app.getHttpServer();
    const encounterId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'All Rolled', hidden: false })
    ).body.id;
    // One party combatant; fill it once with a real roll.
    const first = await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    expect(first.status).toBe(201);
    expect(first.body.rolledCount).toBe(1);
    const auditsBefore = await countInitiativeAudits(encounterId);

    // Watch for an encounter.updated broadcast — a no-op must NOT emit one.
    const broadcasts: Array<{ type: string; encounterId?: number }> = [];
    const subscription = ctx.app
      .get(CampaignEventsService)
      .streamFor(campaignId)
      .subscribe((event) => broadcasts.push(event));

    try {
      const again = await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
      expect(again.status).toBe(201);
      // rolledCount=0 signals the no-op to the client (issue #702).
      expect(again.body.rolledCount).toBe(0);
      // Combatants are still returned as a fresh snapshot.
      for (const c of again.body.combatants as CombatantShape[]) {
        expect(c.initiative).not.toBeNull();
      }
      // No new audit row was written for the empty roll.
      const auditsAfter = await countInitiativeAudits(encounterId);
      expect(auditsAfter).toBe(auditsBefore);
      // No SSE broadcast fired (mirrors the PATCH no-op contract).
      expect(broadcasts.filter((event) => event.type === 'encounter.updated' && event.encounterId === encounterId)).toHaveLength(0);
    } finally {
      subscription.unsubscribe();
    }
  });

  it('a partial roster rolls only the missing ones and returns the count', async () => {
    const server = ctx.app.getHttpServer();
    const encounterId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Partial', hidden: false })
    ).body.id;
    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const partyId = (getRes.body.combatants as CombatantShape[])[0].id;

    // Pin the party member's initiative, then add two monsters at null initiative.
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${partyId}`).set(dm).send({ initiative: 7 });
    await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'M1', hpMax: 10 });
    await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'M2', hpMax: 10 });

    const auditsBefore = await countInitiativeAudits(encounterId);
    const rollRes = await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    expect(rollRes.status).toBe(201);
    // Exactly the two monsters were rolled (issue #702: count is surfaced to the client).
    expect(rollRes.body.rolledCount).toBe(2);
    // Everyone now has an initiative; the pinned party member is untouched.
    for (const c of rollRes.body.combatants as CombatantShape[]) {
      expect(c.initiative).not.toBeNull();
    }
    const pinned = (rollRes.body.combatants as CombatantShape[]).find((c) => c.id === partyId);
    expect(pinned?.initiative).toBe(7);
    // A meaningful roll writes exactly one audit row.
    const auditsAfter = await countInitiativeAudits(encounterId);
    expect(auditsAfter).toBe(auditsBefore + 1);
  });

  it('reinforcements added mid-fight roll to a non-zero count, then a fully-rolled re-roll is a no-op', async () => {
    const server = ctx.app.getHttpServer();
    const encounterId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Reinforce', hidden: false })
    ).body.id;
    // Roll the initial roster, then start so the fight is running.
    const initial = await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    expect(initial.status).toBe(201);
    expect(initial.body.rolledCount).toBeGreaterThan(0);
    await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);

    // Add a reinforcement mid-fight — it lands at null initiative.
    const reinf = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Late Orc', hpMax: 12 });
    expect(reinf.status).toBe(201);
    expect(reinf.body.initiative).toBeNull();

    // Rolling now fills ONLY the reinforcement and reports exactly one.
    const fillRes = await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    expect(fillRes.status).toBe(201);
    expect(fillRes.body.rolledCount).toBe(1);
    const lateOrc = (fillRes.body.combatants as CombatantShape[]).find((c) => c.name === 'Late Orc');
    expect(lateOrc?.initiative).not.toBeNull();

    // A second roll is now a no-op: nothing left to fill.
    const auditsBefore = await countInitiativeAudits(encounterId);
    const noop = await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    expect(noop.status).toBe(201);
    expect(noop.body.rolledCount).toBe(0);
    const auditsAfter = await countInitiativeAudits(encounterId);
    expect(auditsAfter).toBe(auditsBefore);
  });

  it('a zero-combatant encounter rolls nothing and reports rolledCount=0 without auditing', async () => {
    const server = ctx.app.getHttpServer();
    // A fresh campaign with no party members, so the encounter starts truly empty.
    const emptyCampaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Empty Encounter Campaign' })).body.id;
    const encounterId = (
      await request(server).post(`/api/v1/campaigns/${emptyCampaignId}/encounters`).set(dm).send({ name: 'Empty', hidden: false })
    ).body.id;
    const auditsBefore = await countInitiativeAudits(encounterId);
    const res = await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.rolledCount).toBe(0);
    expect((res.body.combatants as CombatantShape[]).length).toBe(0);
    const auditsAfter = await countInitiativeAudits(encounterId);
    expect(auditsAfter).toBe(auditsBefore);
  });
});

describe('encounters — issue #469: reject Start when there are zero combatants (e2e)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('starting a truly empty encounter (no party, never added) is rejected 400 and stays preparing', async () => {
    const server = ctx.app.getHttpServer();
    const campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Empty Roster Campaign' })).body.id;
    const encounterId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'No Combatants', hidden: false })
    ).body.id;

    const res = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no combatants/i);

    // The encounter must not have been silently flipped to running.
    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(getRes.body.status).toBe('preparing');
    expect(getRes.body.currentCombatantId).toBeNull();
  });

  it('a campaign whose only characters are dead/retired auto-adds nobody, so Start is rejected 400', async () => {
    const server = ctx.app.getHttpServer();
    const campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'All Defeated Campaign' })).body.id;
    // Issue #115: encounter auto-add only picks up ACTIVE characters — dead/retired PCs
    // are skipped, so an all-defeated party still yields a zero-combatant encounter.
    await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Fallen Aria', status: 'dead' });
    await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Retired Boro', status: 'retired' });

    const encounterId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Nobody Left', hidden: false })
    ).body.id;
    const getBeforeStart = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect((getBeforeStart.body.combatants as CombatantShape[]).length).toBe(0);

    const res = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no combatants/i);
  });

  it('removing every combatant after auto-add empties the roster and Start is rejected 400', async () => {
    const server = ctx.app.getHttpServer();
    const campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Removed Roster Campaign' })).body.id;
    await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Aria', hpCurrent: 20, hpMax: 20 });

    const encounterId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Emptied Out', hidden: false })
    ).body.id;
    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const combatants = getRes.body.combatants as CombatantShape[];
    expect(combatants.length).toBeGreaterThan(0);

    // Roll initiative first so the only remaining guard, once combatants are removed,
    // is the zero-combatant check (not the initiative check).
    await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    for (const c of combatants) {
      const del = await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${c.id}`).set(dm);
      expect(del.status).toBe(200);
    }

    const res = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no combatants/i);
  });

  it('two concurrent Start attempts on a zero-combatant encounter both 400 (no partial/racy running state)', async () => {
    const server = ctx.app.getHttpServer();
    const campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Concurrent Empty Start Campaign' })).body.id;
    const encounterId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Race', hidden: false })
    ).body.id;

    const [a, b] = await Promise.all([
      request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm),
      request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm),
    ]);
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);

    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(getRes.body.status).toBe('preparing');
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
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Fight', hidden: false });
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

// ---------------------------------------------------------------------------
// Issue #1492 (review): reviving a downed character from the sheet during a
// running encounter must mirror the death slice into the live combatant, or
// /end's CAS write-back treats the stale combatant slice as authoritative and
// silently reverts the revive. Before the fix, a PATCH setting
// { hpCurrent: 1, deathState: 'none', deathSaveFailures: 0 } mirrored HP but
// left the combatant's deathState at 'dead', and ending the fight wrote that
// 'dead' back onto the sheet. The death/temp-HP slice now syncs alongside HP.
// ---------------------------------------------------------------------------
describe('encounters — issue #1492: reviving a downed PC from the sheet mirrors death state into the live combatant (e2e)', () => {
  let ctx: TestAppContext;
  let server: import('http').Server;
  let db: DrizzleDb;
  let charId: number;
  let encounterId: number;
  let combatantId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    db = ctx.app.get<DrizzleDb>(DB);
    const campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Revive Sync' })).body.id;
    charId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Cleric', hpCurrent: 20, hpMax: 20 })
    ).body.id;
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Boss', hidden: false });
    encounterId = encRes.body.id;
    combatantId = encRes.body.combatants[0].id;
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`).set(dm).send({ initiative: 10 });
    await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function combatantDeath() {
    const [row] = await db
      .select({ deathState: combatantsTable.deathState, hpCurrent: combatantsTable.hpCurrent, deathSaveFailures: combatantsTable.deathSaveFailures })
      .from(combatantsTable)
      .where(eq(combatantsTable.id, combatantId))
      .limit(1);
    return row!;
  }

  it('downs the character on the tracker (setup: hpCurrent 0, deathState dead)', async () => {
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`)
      .set(dm)
      .send({ hpSet: 0, deathState: 'dead', deathSaveFailures: 3 });
    expect(res.status).toBe(200);
    expect(res.body.deathState).toBe('dead');
    expect(res.body.hpCurrent).toBe(0);
  });

  it('a sheet PATCH reviving the PC mirrors both HP and deathState into the live combatant (the fix)', async () => {
    const revived = await request(server)
      .patch(`/api/v1/characters/${charId}`)
      .set(dm)
      .send({ hpCurrent: 1, deathState: 'none', deathSaveFailures: 0, deathSaveSuccesses: 0 });
    expect(revived.status).toBe(200);
    expect(revived.body.deathState).toBe('none');
    expect(revived.body.hpCurrent).toBe(1);

    // The combatant row must reflect the revive — not just HP, but the death slice too.
    // Before the fix this kept deathState 'dead' while hpCurrent became 1.
    const combatant = await combatantDeath();
    expect(combatant.hpCurrent).toBe(1);
    expect(combatant.deathState).toBe('none');
    expect(combatant.deathSaveFailures).toBe(0);
  });

  it('ending the encounter does NOT revert the revive onto the sheet', async () => {
    const endRes = await request(server).post(`/api/v1/encounters/${encounterId}/end`).set(dm);
    expect(endRes.status).toBe(201);
    const charRes = await request(server).get(`/api/v1/characters/${charId}`).set(dm);
    // Before the fix, /end wrote the stale combatant deathState 'dead' back onto the sheet.
    expect(charRes.body.deathState).toBe('none');
    expect(charRes.body.hpCurrent).toBe(1);
    expect(charRes.body.deathSaveFailures).toBe(0);
  });

  it('ending the encounter preserves an explicit non-active status set mid-encounter (#1758)', async () => {
    await request(server).post(`/api/v1/encounters/${encounterId}/reopen`).set(dm);
    const patchRes = await request(server)
      .patch(`/api/v1/characters/${charId}`)
      .set(dm)
      .send({ deathState: 'none', hpCurrent: 5, status: 'retired' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe('retired');

    const endRes = await request(server).post(`/api/v1/encounters/${encounterId}/end`).set(dm);
    expect(endRes.status).toBe(201);

    const charRes = await request(server).get(`/api/v1/characters/${charId}`).set(dm);
    expect(charRes.body.status).toBe('retired');
    expect(charRes.body.hpCurrent).toBe(5);
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
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Boss Fight', hidden: false });
    encounterId = encRes.body.id;
    ariaCombatantId = encRes.body.combatants[0].id;

    // A monster at 30/100 -> 30% -> 'bloodied'.
    monsterId = (
      await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Boss', hpMax: 100 })
    ).body.id;
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${monsterId}`).set(dm).send({ hpSet: 30 });

    // An NPC combatant at 20/100 -> 20% -> 'critical'. NPCs are DM-controlled, so their
    // exact HP must be redacted to a band for non-DM viewers exactly like a monster's.
    const npcEntityId = (await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Captain Vex', hidden: false })).body.id;
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
    expect(second.body.code).toBe('COMBATANT_IDENTITY_CONFLICT');
    expect(second.body.combatantId).toBe(first.body.id); // issue #749: carries the winning combatant id
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
    const npcId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'The Traitor', hidden: true, disposition: 'hostile' })
    ).body.id;
    const combatantId = (
      await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'npc', npcId, name: 'The Traitor', hpMax: 50 })
    ).body.id;
    // The DM still sees the real identity link + name.
    const dmRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const dmC = (
      dmRes.body.combatants as Array<{ id: number; name: string; npcId: number | null; npcDispositionSnapshot: string | null }>
    ).find((c) => c.id === combatantId)!;
    expect(dmC.npcId).toBe(npcId);
    expect(dmC.name).toBe('The Traitor');
    expect(dmC.npcDispositionSnapshot).toBe('hostile');
    // A non-DM sees the token in initiative but NOT who it is: identity link severed, name masked.
    for (const headers of [player, viewer]) {
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(headers);
      const c = (
        res.body.combatants as Array<{ id: number; name: string; npcId: number | null; npcDispositionSnapshot: string | null }>
      ).find((x) => x.id === combatantId)!;
      expect(c).toBeTruthy();
      expect(c.npcId).toBeNull();
      expect(c.name).not.toBe('The Traitor');
      expect(c.npcDispositionSnapshot).toBeNull();
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
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Fight', hidden: false });
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

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'HP Model' })).body.id;
    // Auto-add (issue #115) picks this character up as a combatant once the
    // encounter below is created — we only need the combatant id, not this id.
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Thorn', hpCurrent: 20, hpMax: 20, ownerUserId: 'dev:p-1' });
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Grave Peril', hidden: false });
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
// Issue #1462 — the d20 that resolves a death save must be the one in the
// campaign's shared dice tray. The face is server-owned: neither REST nor MCP
// callers may submit it through the generic combatant PATCH.
// ---------------------------------------------------------------------------

describe('encounters — issue #1462: authoritative death-save rolls (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;
  let heroCombatantId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'One True d20' })).body.id;
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Nyx', hpCurrent: 12, hpMax: 12, ownerUserId: 'dev:p-1' });
    const encounter = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Last Breath', hidden: false });
    encounterId = encounter.body.id;
    heroCombatantId = encounter.body.combatants[0].id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function setDying(): Promise<void> {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`)
      .set(dm)
      .send({ hpSet: 0 });
    expect(res.status).toBe(200);
    expect(res.body.deathState).toBe('dying');
  }

  async function setConscious(): Promise<void> {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`)
      .set(dm)
      .send({ hpSet: 12 });
    expect(res.status).toBe(200);
  }

  async function current(): Promise<HpShape> {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/encounters/${encounterId}`).set(player);
    return (res.body.combatants as HpShape[]).find((combatant) => combatant.id === heroCombatantId)!;
  }

  async function deathSaveRolls(): Promise<Array<{ label?: string; expr?: string; rolls?: number[]; total?: number }>> {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/rolls`).set(player);
    return res.body.filter((roll: { label?: string }) => roll.label === 'Nyx · death save');
  }

  it('rejects a caller-selected deathSaveRoll on the generic PATCH', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`)
      .set(player)
      .send({ deathSaveRoll: 20 });
    expect(res.status).toBe(400);
  });

  it('keeps hidden death saves out of the shared feed and hides their existence from non-DMs', async () => {
    const server = ctx.app.getHttpServer();
    await setDying();
    const beforeRolls = await deathSaveRolls();
    expect((await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ hidden: true })).status).toBe(200);
    const viewerAttempt = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
      .set(viewer)
      .send({ idempotencyKey: 'hidden-death-save-viewer' });
    const dmAttempt = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
      .set(dm)
      .send({ idempotencyKey: 'hidden-death-save-dm' });
    expect(viewerAttempt.status).toBe(404);
    expect(dmAttempt.status).toBe(403);
    expect(
      (await request(server).get(`/api/v1/campaigns/${campaignId}/rolls`).set(dm)).body.filter((roll: { label?: string }) => roll.label === 'Nyx · death save'),
    ).toHaveLength(beforeRolls.length);
    expect((await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ hidden: false })).status).toBe(200);
  });

  it('rejects a stabilized character before rolling or persisting evidence', async () => {
    const server = ctx.app.getHttpServer();
    await setDying();
    expect(
      (
        await request(server)
          .patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`)
          .set(dm)
          .send({ deathSaveSuccesses: 3 })
      ).status,
    ).toBe(200);
    const beforeRolls = await deathSaveRolls();
    const service = ctx.app.get(EncountersService);
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20');
    try {
      const rejected = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
        .set(player)
        .send({ idempotencyKey: 'stable-death-save' });

      expect(rejected.status).toBe(400);
      expect(rollSpy).not.toHaveBeenCalled();
      expect(await deathSaveRolls()).toHaveLength(beforeRolls.length);
      expect(await current()).toMatchObject({ hpCurrent: 0, deathState: 'stable', deathSaveSuccesses: 3, deathSaveFailures: 0 });
    } finally {
      rollSpy.mockRestore();
      await setConscious();
    }
  });

  it('rolls back the death-save outcome when the matching dice entry cannot persist', async () => {
    const server = ctx.app.getHttpServer();
    await setDying();
    const rolls = ctx.app.get(RollsService);
    const recordSpy = jest.spyOn(rolls, 'recordInTransaction').mockImplementation(() => {
      throw new Error('simulated dice storage failure');
    });
    try {
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
        .set(player)
        .send({ idempotencyKey: 'death-save-storage-failure' });
      expect(res.status).toBe(500);
      expect(await current()).toMatchObject({ hpCurrent: 0, deathState: 'dying', deathSaveSuccesses: 0, deathSaveFailures: 0 });
      const feed = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls`).set(player);
      expect(feed.body.filter((roll: { label?: string }) => roll.label === 'Nyx · death save')).toHaveLength(0);
    } finally {
      recordSpy.mockRestore();
    }
  });

  it('rolls back the death-save outcome when its required audit entry cannot persist', async () => {
    const server = ctx.app.getHttpServer();
    await setDying();
    const audit = ctx.app.get(AuditService);
    const auditSpy = jest.spyOn(audit, 'logInTx').mockImplementation(() => {
      throw new Error('simulated audit storage failure');
    });
    try {
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
        .set(player)
        .send({ idempotencyKey: 'death-save-audit-failure' });
      expect(res.status).toBe(500);
      expect(await current()).toMatchObject({ hpCurrent: 0, deathState: 'dying', deathSaveSuccesses: 0, deathSaveFailures: 0 });
      const feed = await request(server).get(`/api/v1/campaigns/${campaignId}/rolls`).set(player);
      expect(feed.body.filter((roll: { label?: string }) => roll.label === 'Nyx · death save')).toHaveLength(0);
    } finally {
      auditSpy.mockRestore();
    }
  });

  it('rolls back every death-save event with its keyed outcome, then writes one death and roll event on retry', async () => {
    const server = ctx.app.getHttpServer();
    await setDying();
    expect(
      (
        await request(server)
          .patch(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}`)
          .set(player)
          .send({ deathSaveFailures: 2 })
      ).status,
    ).toBe(200);
    const db = ctx.app.get<DrizzleDb>(DB);
    const deathSaveEvents = async () =>
      (await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, encounterId))).filter(
        (event) => event.targetId === heroCombatantId && (event.detail === 'died' || event.detail.startsWith('death save d20 roll ')),
      );
    const beforeEvents = await deathSaveEvents();
    const service = ctx.app.get(EncountersService);
    const eventSpy = jest.spyOn(service as any, 'appendEventInTransaction').mockImplementationOnce(() => {
      throw new Error('simulated event storage failure');
    });
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20').mockReturnValue({ expr: '1d20', rolls: [1], total: 1 });
    const body = { idempotencyKey: 'death-save-event-retry' };
    try {
      const failed = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
        .set(player)
        .send(body);
      expect(failed.status).toBe(500);
      expect(await current()).toMatchObject({ hpCurrent: 0, deathState: 'dying', deathSaveSuccesses: 0, deathSaveFailures: 2 });
      expect(await deathSaveEvents()).toEqual(beforeEvents);

      const retry = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
        .set(player)
        .send(body);
      expect(retry.status).toBe(201);
      expect(rollSpy).toHaveBeenCalledTimes(2);
      expect(await current()).toMatchObject({ hpCurrent: 0, deathState: 'dead', deathSaveSuccesses: 0, deathSaveFailures: 3 });
      const afterEvents = await deathSaveEvents();
      expect(afterEvents.slice(beforeEvents.length)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'death', detail: 'died' }),
          expect.objectContaining({ type: 'roll', detail: expect.stringContaining('death save d20 roll 1: Natural 1!') }),
        ]),
      );
      expect(afterEvents).toHaveLength(beforeEvents.length + 2);
      await setConscious();
    } finally {
      eventSpy.mockRestore();
      rollSpy.mockRestore();
    }
  });

  it('uses exactly the logged natural 1 to add two failures', async () => {
    const server = ctx.app.getHttpServer();
    await setDying();
    const beforeRolls = await deathSaveRolls();
    const service = ctx.app.get(EncountersService);
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20').mockReturnValue({ expr: '1d20', rolls: [1], total: 1 });
    try {
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
        .set(player)
        .send({ idempotencyKey: 'death-save-natural-one' });

      expect(res.status).toBe(201);
      expect(rollSpy).toHaveBeenCalledTimes(1);
      expect(res.body.roll).toMatchObject({ expr: '1d20', rolls: [1], total: 1, label: 'Nyx · death save' });
      expect(res.body.combatant).toMatchObject({ deathState: 'dying', deathSaveSuccesses: 0, deathSaveFailures: 2 });

      const matching = await deathSaveRolls();
      expect(matching).toHaveLength(beforeRolls.length + 1);
      expect(matching[0]).toMatchObject({ expr: '1d20', rolls: [1], total: 1 });
      const audits = await ctx.app
        .get<DrizzleDb>(DB)
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'encounter.combatant.death_save_roll'));
      expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ campaignId, entityId: heroCombatantId, actor: 'dev:p-1' })]));
    } finally {
      rollSpy.mockRestore();
    }
  });

  it('uses exactly the logged natural 20 to revive the character', async () => {
    const server = ctx.app.getHttpServer();
    await setConscious();
    await setDying();
    const beforeRolls = await deathSaveRolls();
    const service = ctx.app.get(EncountersService);
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20').mockReturnValue({ expr: '1d20', rolls: [20], total: 20 });
    try {
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
        .set(player)
        .send({ idempotencyKey: 'death-save-natural-twenty' });

      expect(res.status).toBe(201);
      expect(rollSpy).toHaveBeenCalledTimes(1);
      expect(res.body.roll).toMatchObject({ expr: '1d20', rolls: [20], total: 20, label: 'Nyx · death save' });
      expect(res.body.combatant).toMatchObject({ hpCurrent: 1, deathState: 'none', deathSaveSuccesses: 0, deathSaveFailures: 0 });

      const matching = await deathSaveRolls();
      expect(matching).toHaveLength(beforeRolls.length + 1);
      expect(matching[0]).toMatchObject({ expr: '1d20', rolls: [20], total: 20 });
    } finally {
      rollSpy.mockRestore();
    }
  });

  it('replays one committed REST death-save intent after a lost response without another d20 or dice row', async () => {
    const server = ctx.app.getHttpServer();
    await setConscious();
    await setDying();
    const beforeRolls = await deathSaveRolls();
    const db = ctx.app.get<DrizzleDb>(DB);
    const deathSaveEventCount = async () =>
      (await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, encounterId))).filter(
        (event) => event.targetId === heroCombatantId && event.detail.startsWith('death save d20 roll '),
      ).length;
    const beforeEvents = await deathSaveEventCount();
    const service = ctx.app.get(EncountersService);
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20').mockReturnValue({ expr: '1d20', rolls: [10], total: 10 });
    const body = { idempotencyKey: 'death-save-rest-lost-response' };
    try {
      const first = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
        .set(player)
        .send(body);
      const replay = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
        .set(player)
        .send(body);

      expect(first.status).toBe(201);
      expect(await deathSaveEventCount()).toBe(beforeEvents + 1);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      expect(rollSpy).toHaveBeenCalledTimes(1);
      expect(await deathSaveEventCount()).toBe(beforeEvents + 1);
      expect(await deathSaveRolls()).toHaveLength(beforeRolls.length + 1);
    } finally {
      rollSpy.mockRestore();
    }
  });

  it('retries cleanly after an atomic audit failure without leaving a committed unaudited death save', async () => {
    const server = ctx.app.getHttpServer();
    await setConscious();
    await setDying();
    const beforeRolls = (await request(server).get(`/api/v1/campaigns/${campaignId}/rolls`).set(player)).body
      .filter((roll: { label?: string }) => roll.label === 'Nyx · death save').length;
    const db = ctx.app.get<DrizzleDb>(DB);
    const beforeAudits = (await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))).length;
    const audit = ctx.app.get(AuditService);
    const auditSpy = jest.spyOn(audit, 'logInTx').mockImplementationOnce(() => {
      throw new Error('simulated transient audit storage failure');
    });
    const service = ctx.app.get(EncountersService);
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20').mockReturnValue({ expr: '1d20', rolls: [10], total: 10 });
    const body = { idempotencyKey: 'death-save-audit-retry' };
    try {
      const failed = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
        .set(player)
        .send(body);
      expect(failed.status).toBe(500);
      expect(await current()).toMatchObject({ hpCurrent: 0, deathState: 'dying', deathSaveSuccesses: 0, deathSaveFailures: 0 });

      const retry = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants/${heroCombatantId}/death-save`)
        .set(player)
        .send(body);
      expect(retry.status).toBe(201);
      expect(rollSpy).toHaveBeenCalledTimes(2);
      const afterRolls = (await request(server).get(`/api/v1/campaigns/${campaignId}/rolls`).set(player)).body
        .filter((roll: { label?: string }) => roll.label === 'Nyx · death save').length;
      expect(afterRolls).toBe(beforeRolls + 1);
      const afterAudits = (await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))).length;
      expect(afterAudits).toBe(beforeAudits + 1);
    } finally {
      auditSpy.mockRestore();
      rollSpy.mockRestore();
    }
  });

  it('replays a committed death save after its combatant is removed without creating new evidence', async () => {
    const server = ctx.app.getHttpServer();
    const replayEncounter = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Lost response after removal', hidden: false });
    expect(replayEncounter.status).toBe(201);
    const replayEncounterId = replayEncounter.body.id as number;
    const replayCombatantId = replayEncounter.body.combatants[0].id as number;
    expect((await request(server).post(`/api/v1/encounters/${replayEncounterId}/roll-initiative`).set(dm)).status).toBe(201);
    expect((await request(server).post(`/api/v1/encounters/${replayEncounterId}/start`).set(dm)).status).toBe(201);
    expect(
      (
        await request(server)
          .patch(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}`)
          .set(dm)
          .send({ hpSet: 0 })
      ).status,
    ).toBe(200);
    const beforeRolls = await deathSaveRolls();
    const db = ctx.app.get<DrizzleDb>(DB);
    const beforeAudits = (await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))).length;
    const beforeEvents = (
      await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, replayEncounterId))
    ).filter((event) => event.targetId === replayCombatantId && event.detail.startsWith('death save d20 roll ')).length;
    const service = ctx.app.get(EncountersService);
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20').mockReturnValue({ expr: '1d20', rolls: [10], total: 10 });
    const body = { idempotencyKey: 'death-save-removed-replay' };
    try {
      const first = await request(server)
        .post(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}/death-save`)
        .set(player)
        .send(body);
      expect(first.status).toBe(201);
      expect((await request(server).delete(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}`).set(dm)).status).toBe(200);

      const replay = await request(server)
        .post(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}/death-save`)
        .set(player)
        .send(body);

      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      expect(rollSpy).toHaveBeenCalledTimes(1);
      expect(await deathSaveRolls()).toHaveLength(beforeRolls.length + 1);
      const afterAudits = (await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))).length;
      expect(afterAudits).toBe(beforeAudits + 1);
      const afterEvents = (
        await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, replayEncounterId))
      ).filter((event) => event.targetId === replayCombatantId && event.detail.startsWith('death save d20 roll '));
      expect(afterEvents).toHaveLength(beforeEvents + 1);
      expect((await request(server).post(`/api/v1/encounters/${replayEncounterId}/end`).set(dm)).status).toBe(201);
    } finally {
      rollSpy.mockRestore();
    }
  });

  it('rejects a death save for a ruleset without 5e death saves before rolling or persisting evidence', async () => {
    const server = ctx.app.getHttpServer();
    const starfinderCampaign = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'No 5e death saves' });
    expect(starfinderCampaign.status).toBe(201);
    const starfinderCampaignId = starfinderCampaign.body.id as number;
    // Campaign writes rightly reject a rule-system slug without its installed pack.
    // This adapter-bound regression only needs the persisted campaign selection.
    const db = ctx.app.get<DrizzleDb>(DB);
    await db.update(campaigns).set({ ruleSystem: 'starfinder-1e' }).where(eq(campaigns.id, starfinderCampaignId));
    expect(
      (
        await request(server)
          .post(`/api/v1/campaigns/${starfinderCampaignId}/characters`)
          .set(dm)
          .send({ name: 'Vesk', hpCurrent: 12, hpMax: 12 })
      ).status,
    ).toBe(201);
    const starfinderEncounter = await request(server)
      .post(`/api/v1/campaigns/${starfinderCampaignId}/encounters`)
      .set(dm)
      .send({ name: 'Zero G', hidden: false });
    expect(starfinderEncounter.status).toBe(201);
    const starfinderEncounterId = starfinderEncounter.body.id as number;
    const starfinderCombatantId = starfinderEncounter.body.combatants[0].id as number;
    expect(
      (
        await request(server)
          .patch(`/api/v1/encounters/${starfinderEncounterId}/combatants/${starfinderCombatantId}`)
          .set(dm)
          .send({ hpSet: 0 })
      ).status,
    ).toBe(200);
    const beforeAudits = (await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))).length;
    const beforeRolls = (await request(server).get(`/api/v1/campaigns/${starfinderCampaignId}/rolls`).set(dm)).body.length;
    const service = ctx.app.get(EncountersService);
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20');
    try {
      const rejected = await request(server)
        .post(`/api/v1/encounters/${starfinderEncounterId}/combatants/${starfinderCombatantId}/death-save`)
        .set(dm)
        .send({ idempotencyKey: 'starfinder-death-save' });
      expect(rejected.status).toBe(400);
      expect(rollSpy).not.toHaveBeenCalled();
      expect((await request(server).get(`/api/v1/campaigns/${starfinderCampaignId}/rolls`).set(dm)).body).toHaveLength(beforeRolls);
      const afterAudits = (await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))).length;
      expect(afterAudits).toBe(beforeAudits);
    } finally {
      rollSpy.mockRestore();
    }
  });

  it('rejects a fresh death save when the encounter ends after preflight but before its keyed transaction', async () => {
    const server = ctx.app.getHttpServer();
    const raceEncounter = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'End race', hidden: false });
    expect(raceEncounter.status).toBe(201);
    const raceEncounterId = raceEncounter.body.id as number;
    const raceCombatantId = raceEncounter.body.combatants[0].id as number;
    const raceCharacterId = raceEncounter.body.combatants[0].characterId as number;
    expect((await request(server).post(`/api/v1/encounters/${raceEncounterId}/roll-initiative`).set(dm)).status).toBe(201);
    expect((await request(server).post(`/api/v1/encounters/${raceEncounterId}/start`).set(dm)).status).toBe(201);
    expect(
      (
        await request(server)
          .patch(`/api/v1/encounters/${raceEncounterId}/combatants/${raceCombatantId}`)
          .set(dm)
          .send({ hpSet: 0 })
      ).status,
    ).toBe(200);
    const service = ctx.app.get(EncountersService);
    const realAdapterForCampaign = (service as any).adapterForCampaign.bind(service);
    let adapterLookups = 0;
    let sheetAfterEnd: Record<string, unknown> | null = null;
    const adapterSpy = jest.spyOn(service as any, 'adapterForCampaign').mockImplementation(async (...args: unknown[]) => {
      adapterLookups += 1;
      // The first lookup is death-save preflight; the second is updateCombatant
      // after it has captured its outer encounter row but before the transaction.
      if (adapterLookups === 2) {
        expect((await request(server).post(`/api/v1/encounters/${raceEncounterId}/end`).set(dm)).status).toBe(201);
        const sheet = await request(server).get(`/api/v1/characters/${raceCharacterId}`).set(dm);
        expect(sheet.status).toBe(200);
        sheetAfterEnd = sheet.body;
      }
      return realAdapterForCampaign(args[0] as number);
    });
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20');
    const db = ctx.app.get<DrizzleDb>(DB);
    try {
      const beforeRolls = await deathSaveRolls();
      const beforeAudits = (await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))).length;
      const beforeEvents = (
        await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, raceEncounterId))
      ).filter((event) => event.targetId === raceCombatantId && event.detail.startsWith('death save d20 roll ')).length;

      const rejected = await request(server)
        .post(`/api/v1/encounters/${raceEncounterId}/combatants/${raceCombatantId}/death-save`)
        .set(player)
        .send({ idempotencyKey: 'death-save-end-race' });

      expect(rejected.status).toBe(409);
      expect(adapterLookups).toBeGreaterThanOrEqual(2);
      expect(rollSpy).not.toHaveBeenCalled();
      expect(await deathSaveRolls()).toHaveLength(beforeRolls.length);
      const afterAudits = (await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))).length;
      expect(afterAudits).toBe(beforeAudits);
      const afterEvents = (
        await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, raceEncounterId))
      ).filter((event) => event.targetId === raceCombatantId && event.detail.startsWith('death save d20 roll '));
      expect(afterEvents).toHaveLength(beforeEvents);
      expect(sheetAfterEnd).not.toBeNull();
      expect((await request(server).get(`/api/v1/characters/${raceCharacterId}`).set(dm)).body).toMatchObject(sheetAfterEnd!);
    } finally {
      adapterSpy.mockRestore();
      rollSpy.mockRestore();
    }
  });

  it('rejects a fresh death save when character ownership changes after preflight but before its keyed transaction', async () => {
    const server = ctx.app.getHttpServer();
    const raceCampaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Death save owner race' });
    expect(raceCampaign.status).toBe(201);
    const raceCampaignId = raceCampaign.body.id as number;
    const character = await request(server)
      .post(`/api/v1/campaigns/${raceCampaignId}/characters`)
      .set(dm)
      .send({ name: 'Ownership Nyx', hpCurrent: 12, hpMax: 12, ownerUserId: 'dev:p-1' });
    expect(character.status).toBe(201);
    const raceCharacterId = character.body.id as number;
    const raceEncounter = await request(server)
      .post(`/api/v1/campaigns/${raceCampaignId}/encounters`)
      .set(dm)
      .send({ name: 'Ownership race', hidden: false });
    expect(raceEncounter.status).toBe(201);
    const raceEncounterId = raceEncounter.body.id as number;
    const raceCombatantId = raceEncounter.body.combatants[0].id as number;
    expect(
      (
        await request(server)
          .patch(`/api/v1/encounters/${raceEncounterId}/combatants/${raceCombatantId}`)
          .set(dm)
          .send({ hpSet: 0 })
      ).status,
    ).toBe(200);

    const db = ctx.app.get<DrizzleDb>(DB);
    const beforeDice = (await db.select().from(diceRolls).where(eq(diceRolls.campaignId, raceCampaignId))).length;
    const beforeAudits = (
      await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))
    ).filter((audit) => audit.campaignId === raceCampaignId).length;
    const beforeEvents = (
      await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, raceEncounterId))
    ).filter((event) => event.targetId === raceCombatantId && event.detail.startsWith('death save d20 roll ')).length;
    const service = ctx.app.get(EncountersService);
    const realAdapterForCampaign = (service as any).adapterForCampaign.bind(service);
    let adapterLookups = 0;
    const adapterSpy = jest.spyOn(service as any, 'adapterForCampaign').mockImplementation(async (...args: unknown[]) => {
      adapterLookups += 1;
      // Lookup one is death-save preflight; lookup two is updateCombatant after its
      // outer read but before the keyed transaction's fresh ownership recheck.
      if (adapterLookups === 2) {
        const reassign = await request(server)
          .patch(`/api/v1/characters/${raceCharacterId}`)
          .set(dm)
          .send({ ownerUserId: 'dev:p-2' });
        expect(reassign.status).toBe(200);
        expect(reassign.body.ownerUserId).toBe('dev:p-2');
      }
      return realAdapterForCampaign(args[0] as number);
    });
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20');
    try {
      const rejected = await request(server)
        .post(`/api/v1/encounters/${raceEncounterId}/combatants/${raceCombatantId}/death-save`)
        .set(player)
        .send({ idempotencyKey: 'death-save-ownership-race' });

      expect(rejected.status).toBe(403);
      expect(adapterLookups).toBeGreaterThanOrEqual(2);
      expect(rollSpy).not.toHaveBeenCalled();
      expect((await db.select().from(diceRolls).where(eq(diceRolls.campaignId, raceCampaignId))).length).toBe(beforeDice);
      const afterAudits = (
        await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))
      ).filter((audit) => audit.campaignId === raceCampaignId).length;
      expect(afterAudits).toBe(beforeAudits);
      const afterEvents = (
        await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, raceEncounterId))
      ).filter((event) => event.targetId === raceCombatantId && event.detail.startsWith('death save d20 roll '));
      expect(afterEvents).toHaveLength(beforeEvents);
      expect((await db.select().from(combatantsTable).where(eq(combatantsTable.id, raceCombatantId)).limit(1))[0]).toMatchObject({
        hpCurrent: 0,
        deathState: 'dying',
        deathSaveSuccesses: 0,
        deathSaveFailures: 0,
      });
    } finally {
      adapterSpy.mockRestore();
      rollSpy.mockRestore();
    }
  });

  it('rejects a fresh death save when the encounter is trashed after preflight but before its keyed transaction', async () => {
    const server = ctx.app.getHttpServer();
    const trashCampaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Death save trash race' });
    expect(trashCampaign.status).toBe(201);
    const trashCampaignId = trashCampaign.body.id as number;
    const character = await request(server)
      .post(`/api/v1/campaigns/${trashCampaignId}/characters`)
      .set(dm)
      .send({ name: 'Trash Nyx', hpCurrent: 12, hpMax: 12, ownerUserId: 'dev:p-1' });
    expect(character.status).toBe(201);
    const trashEncounter = await request(server)
      .post(`/api/v1/campaigns/${trashCampaignId}/encounters`)
      .set(dm)
      .send({ name: 'Trash race', hidden: false });
    expect(trashEncounter.status).toBe(201);
    const trashEncounterId = trashEncounter.body.id as number;
    const trashCombatantId = trashEncounter.body.combatants[0].id as number;
    const trashCharacterId = trashEncounter.body.combatants[0].characterId as number;
    expect(
      (
        await request(server)
          .patch(`/api/v1/encounters/${trashEncounterId}/combatants/${trashCombatantId}`)
          .set(dm)
          .send({ hpSet: 0 })
      ).status,
    ).toBe(200);

    const db = ctx.app.get<DrizzleDb>(DB);
    const beforeRolls = (await request(server).get(`/api/v1/campaigns/${trashCampaignId}/rolls`).set(player)).body.length;
    const beforeAudits = (
      await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))
    ).filter((audit) => audit.campaignId === trashCampaignId).length;
    const beforeEvents = (
      await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, trashEncounterId))
    ).filter((event) => event.targetId === trashCombatantId && event.detail.startsWith('death save d20 roll ')).length;
    const service = ctx.app.get(EncountersService);
    const realAdapterForCampaign = (service as any).adapterForCampaign.bind(service);
    let adapterLookups = 0;
    const adapterSpy = jest.spyOn(service as any, 'adapterForCampaign').mockImplementation(async (...args: unknown[]) => {
      adapterLookups += 1;
      if (adapterLookups === 2) {
        expect((await request(server).delete(`/api/v1/encounters/${trashEncounterId}`).set(dm)).status).toBe(200);
      }
      return realAdapterForCampaign(args[0] as number);
    });
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20');
    try {
      const rejected = await request(server)
        .post(`/api/v1/encounters/${trashEncounterId}/combatants/${trashCombatantId}/death-save`)
        .set(player)
        .send({ idempotencyKey: 'death-save-trash-race' });

      expect(rejected.status).toBe(404);
      expect(adapterLookups).toBeGreaterThanOrEqual(2);
      expect(rollSpy).not.toHaveBeenCalled();
      expect((await request(server).get(`/api/v1/campaigns/${trashCampaignId}/rolls`).set(player)).body).toHaveLength(beforeRolls);
      const afterAudits = (
        await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))
      ).filter((audit) => audit.campaignId === trashCampaignId).length;
      expect(afterAudits).toBe(beforeAudits);
      const afterEvents = (
        await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, trashEncounterId))
      ).filter((event) => event.targetId === trashCombatantId && event.detail.startsWith('death save d20 roll ')).length;
      expect(afterEvents).toBe(beforeEvents);
      expect((await request(server).get(`/api/v1/characters/${trashCharacterId}`).set(dm)).body).toMatchObject({ hpCurrent: 0, deathState: 'dying' });
    } finally {
      adapterSpy.mockRestore();
      rollSpy.mockRestore();
    }
  });

  it('rejects a fresh death save when the campaign is trashed after preflight but before its keyed transaction', async () => {
    const server = ctx.app.getHttpServer();
    const trashCampaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Death save campaign trash race' });
    expect(trashCampaign.status).toBe(201);
    const trashCampaignId = trashCampaign.body.id as number;
    const character = await request(server)
      .post(`/api/v1/campaigns/${trashCampaignId}/characters`)
      .set(dm)
      .send({ name: 'Campaign Trash Nyx', hpCurrent: 12, hpMax: 12, ownerUserId: 'dev:p-1' });
    expect(character.status).toBe(201);
    const trashEncounter = await request(server)
      .post(`/api/v1/campaigns/${trashCampaignId}/encounters`)
      .set(dm)
      .send({ name: 'Campaign trash race', hidden: false });
    expect(trashEncounter.status).toBe(201);
    const trashEncounterId = trashEncounter.body.id as number;
    const trashCombatantId = trashEncounter.body.combatants[0].id as number;
    expect(
      (
        await request(server)
          .patch(`/api/v1/encounters/${trashEncounterId}/combatants/${trashCombatantId}`)
          .set(dm)
          .send({ hpSet: 0 })
      ).status,
    ).toBe(200);

    const db = ctx.app.get<DrizzleDb>(DB);
    const beforeDice = (await db.select().from(diceRolls).where(eq(diceRolls.campaignId, trashCampaignId))).length;
    const beforeAudits = (
      await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))
    ).filter((audit) => audit.campaignId === trashCampaignId).length;
    const service = ctx.app.get(EncountersService);
    const realAdapterForCampaign = (service as any).adapterForCampaign.bind(service);
    let adapterLookups = 0;
    const adapterSpy = jest.spyOn(service as any, 'adapterForCampaign').mockImplementation(async (...args: unknown[]) => {
      adapterLookups += 1;
      if (adapterLookups === 2) {
        expect((await request(server).delete(`/api/v1/campaigns/${trashCampaignId}`).set(dm)).status).toBe(200);
      }
      return realAdapterForCampaign(args[0] as number);
    });
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20');
    try {
      const rejected = await request(server)
        .post(`/api/v1/encounters/${trashEncounterId}/combatants/${trashCombatantId}/death-save`)
        .set(player)
        .send({ idempotencyKey: 'death-save-campaign-trash-race' });

      expect(rejected.status).toBe(403);
      expect(adapterLookups).toBeGreaterThanOrEqual(2);
      expect(rollSpy).not.toHaveBeenCalled();
      expect((await db.select().from(diceRolls).where(eq(diceRolls.campaignId, trashCampaignId))).length).toBe(beforeDice);
      const afterAudits = (
        await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))
      ).filter((audit) => audit.campaignId === trashCampaignId).length;
      expect(afterAudits).toBe(beforeAudits);
      expect(
        (await db.select().from(combatantsTable).where(eq(combatantsTable.id, trashCombatantId)).limit(1))[0],
      ).toMatchObject({ hpCurrent: 0, deathState: 'dying' });
    } finally {
      adapterSpy.mockRestore();
      rollSpy.mockRestore();
    }
  });

  it('returns not found when a combatant is removed after death-save preflight but before its keyed transaction', async () => {
    const server = ctx.app.getHttpServer();
    const raceCampaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Death save combatant race' });
    expect(raceCampaign.status).toBe(201);
    const raceCampaignId = raceCampaign.body.id as number;
    expect(
      (
        await request(server)
          .post(`/api/v1/campaigns/${raceCampaignId}/characters`)
          .set(dm)
          .send({ name: 'Vanishing Nyx', hpCurrent: 12, hpMax: 12, ownerUserId: 'dev:p-1' })
      ).status,
    ).toBe(201);
    const raceEncounter = await request(server)
      .post(`/api/v1/campaigns/${raceCampaignId}/encounters`)
      .set(dm)
      .send({ name: 'Combatant race', hidden: false });
    expect(raceEncounter.status).toBe(201);
    const raceEncounterId = raceEncounter.body.id as number;
    const raceCombatantId = raceEncounter.body.combatants[0].id as number;
    expect(
      (
        await request(server)
          .patch(`/api/v1/encounters/${raceEncounterId}/combatants/${raceCombatantId}`)
          .set(dm)
          .send({ hpSet: 0 })
      ).status,
    ).toBe(200);

    const service = ctx.app.get(EncountersService);
    const realAdapterForCampaign = (service as any).adapterForCampaign.bind(service);
    let adapterLookups = 0;
    const adapterSpy = jest.spyOn(service as any, 'adapterForCampaign').mockImplementation(async (...args: unknown[]) => {
      adapterLookups += 1;
      if (adapterLookups === 2) {
        expect(
          (await request(server).delete(`/api/v1/encounters/${raceEncounterId}/combatants/${raceCombatantId}`).set(dm)).status,
        ).toBe(200);
      }
      return realAdapterForCampaign(args[0] as number);
    });
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20');
    try {
      const beforeRolls = (await request(server).get(`/api/v1/campaigns/${raceCampaignId}/rolls`).set(player)).body.length;
      const rejected = await request(server)
        .post(`/api/v1/encounters/${raceEncounterId}/combatants/${raceCombatantId}/death-save`)
        .set(player)
        .send({ idempotencyKey: 'death-save-combatant-remove-race' });

      expect(rejected.status).toBe(404);
      expect(adapterLookups).toBeGreaterThanOrEqual(2);
      expect(rollSpy).not.toHaveBeenCalled();
      expect((await request(server).get(`/api/v1/campaigns/${raceCampaignId}/rolls`).set(player)).body).toHaveLength(beforeRolls);
    } finally {
      adapterSpy.mockRestore();
      rollSpy.mockRestore();
    }
  });

  it('replays a same-key death save that commits during retry preflight after combatant removal', async () => {
    const server = ctx.app.getHttpServer();
    const replayCampaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Death save late replay' });
    expect(replayCampaign.status).toBe(201);
    const replayCampaignId = replayCampaign.body.id as number;
    expect(
      (
        await request(server)
          .post(`/api/v1/campaigns/${replayCampaignId}/characters`)
          .set(dm)
          .send({ name: 'Late Replay Nyx', hpCurrent: 12, hpMax: 12, ownerUserId: 'dev:p-1' })
      ).status,
    ).toBe(201);
    const replayEncounter = await request(server)
      .post(`/api/v1/campaigns/${replayCampaignId}/encounters`)
      .set(dm)
      .send({ name: 'Late replay', hidden: false });
    expect(replayEncounter.status).toBe(201);
    const replayEncounterId = replayEncounter.body.id as number;
    const replayCombatantId = replayEncounter.body.combatants[0].id as number;
    expect(
      (
        await request(server)
          .patch(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}`)
          .set(dm)
          .send({ hpSet: 0 })
      ).status,
    ).toBe(200);

    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let retryAtBarrier!: () => void;
    const retryBarrier = new Promise<void>((resolve) => {
      retryAtBarrier = resolve;
    });
    const waitForRetryBarrier = async () => {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          retryBarrier,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('retry did not reach the death-save preflight barrier')), 5_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    const service = ctx.app.get(EncountersService);
    const realAdapterForCampaign = (service as any).adapterForCampaign.bind(service);
    let adapterLookups = 0;
    const adapterSpy = jest.spyOn(service as any, 'adapterForCampaign').mockImplementation(async (...args: unknown[]) => {
      adapterLookups += 1;
      if (adapterLookups === 1) {
        retryAtBarrier();
        await retryGate;
      }
      return realAdapterForCampaign(args[0] as number);
    });
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20').mockReturnValue({ expr: '1d20', rolls: [10], total: 10 });
    const body = { idempotencyKey: 'death-save-late-replay' };
    let retryRequest: Promise<request.Response> | undefined;
    try {
      // Park the retry after its initial replay lookup but before the mutable-row
      // preflight. The original request can then commit the same key without two
      // mutually blocked HTTP requests, making the late-replay window deterministic.
      retryRequest = request(server)
        .post(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}/death-save`)
        .set(player)
        .send(body)
        .then((response) => response);
      await waitForRetryBarrier();

      const original = await request(server)
        .post(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}/death-save`)
        .set(player)
        .send(body)
      expect(original.status).toBe(201);
      expect((await request(server).delete(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}`).set(dm)).status).toBe(200);

      releaseRetry();
      const replay = await retryRequest;
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(original.body);
      expect(adapterLookups).toBeGreaterThanOrEqual(3);
      expect(rollSpy).toHaveBeenCalledTimes(1);
    } finally {
      // If an assertion fails while the retry is parked, let its request finish so
      // the shared Nest test app can shut down cleanly instead of timing out in afterAll.
      releaseRetry();
      await retryRequest?.catch(() => undefined);
      adapterSpy.mockRestore();
      rollSpy.mockRestore();
    }
  });

  it('replays a committed REST death save after encounter trashing without allowing a fresh key', async () => {
    const server = ctx.app.getHttpServer();
    const replayCampaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Death save trash replay' });
    expect(replayCampaign.status).toBe(201);
    const replayCampaignId = replayCampaign.body.id as number;
    expect(
      (
        await request(server)
          .post(`/api/v1/campaigns/${replayCampaignId}/characters`)
          .set(dm)
          .send({ name: 'Replay Nyx', hpCurrent: 12, hpMax: 12, ownerUserId: 'dev:p-1' })
      ).status,
    ).toBe(201);
    const replayEncounter = await request(server)
      .post(`/api/v1/campaigns/${replayCampaignId}/encounters`)
      .set(dm)
      .send({ name: 'Trash replay', hidden: false });
    expect(replayEncounter.status).toBe(201);
    const replayEncounterId = replayEncounter.body.id as number;
    const replayCombatantId = replayEncounter.body.combatants[0].id as number;
    expect(
      (
        await request(server)
          .patch(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}`)
          .set(dm)
          .send({ hpSet: 0 })
      ).status,
    ).toBe(200);

    const service = ctx.app.get(EncountersService);
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20').mockReturnValue({ expr: '1d20', rolls: [10], total: 10 });
    const body = { idempotencyKey: 'death-save-trashed-replay' };
    try {
      const first = await request(server)
        .post(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}/death-save`)
        .set(player)
        .send(body);
      expect(first.status).toBe(201);
      expect((await request(server).delete(`/api/v1/encounters/${replayEncounterId}`).set(dm)).status).toBe(200);

      const replay = await request(server)
        .post(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}/death-save`)
        .set(player)
        .send(body);
      const fresh = await request(server)
        .post(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}/death-save`)
        .set(player)
        .send({ idempotencyKey: 'death-save-trashed-fresh' });

      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      expect(fresh.status).toBe(404);
      expect(rollSpy).toHaveBeenCalledTimes(1);
    } finally {
      rollSpy.mockRestore();
    }
  });

  it('replays a committed death save after the encounter and campaign end without creating new evidence', async () => {
    const server = ctx.app.getHttpServer();
    // This lifecycle transition must be self-contained: other death-save regressions
    // intentionally leave the shared fixture in different terminal states.
    const replayEncounter = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Lost response after end', hidden: false });
    expect(replayEncounter.status).toBe(201);
    const replayEncounterId = replayEncounter.body.id as number;
    const replayCombatantId = replayEncounter.body.combatants[0].id as number;
    expect((await request(server).post(`/api/v1/encounters/${replayEncounterId}/roll-initiative`).set(dm)).status).toBe(201);
    expect((await request(server).post(`/api/v1/encounters/${replayEncounterId}/start`).set(dm)).status).toBe(201);
    expect(
      (
        await request(server)
          .patch(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}`)
          .set(dm)
          .send({ hpSet: 0 })
      ).status,
    ).toBe(200);
    const beforeRolls = await deathSaveRolls();
    const db = ctx.app.get<DrizzleDb>(DB);
    const beforeAudits = (await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))).length;
    const beforeEvents = (
      await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, replayEncounterId))
    ).filter((event) => event.targetId === replayCombatantId && event.detail.startsWith('death save d20 roll ')).length;
    const service = ctx.app.get(EncountersService);
    const rollSpy = jest.spyOn(service as any, 'rollDeathSaveD20').mockReturnValue({ expr: '1d20', rolls: [10], total: 10 });
    const body = { idempotencyKey: 'death-save-ended-replay' };
    try {
      const first = await request(server)
        .post(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}/death-save`)
        .set(player)
        .send(body);
      expect(first.status).toBe(201);
      expect((await request(server).post(`/api/v1/encounters/${replayEncounterId}/end`).set(dm)).status).toBe(201);
      expect((await request(server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ status: 'paused' })).status).toBe(200);

      const replay = await request(server)
        .post(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}/death-save`)
        .set(player)
        .send(body);

      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      expect(rollSpy).toHaveBeenCalledTimes(1);
      expect(await deathSaveRolls()).toHaveLength(beforeRolls.length + 1);
      const afterAudits = (await db.select().from(auditLog).where(eq(auditLog.action, 'encounter.combatant.death_save_roll'))).length;
      expect(afterAudits).toBe(beforeAudits + 1);
      const afterEvents = (
        await db.select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, replayEncounterId))
      ).filter((event) => event.targetId === replayCombatantId && event.detail.startsWith('death save d20 roll '));
      expect(afterEvents).toHaveLength(beforeEvents + 1);
      const fresh = await request(server)
        .post(`/api/v1/encounters/${replayEncounterId}/combatants/${replayCombatantId}/death-save`)
        .set(player)
        .send({ idempotencyKey: 'death-save-after-archive' });
      expect(fresh.status).toBe(403);
    } finally {
      rollSpy.mockRestore();
    }
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
    encounterId = (await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Ambush', hidden: false })).body.id;
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
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Map Fight', hidden: false });
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

  // Issue #259/#463: attaching does not reveal a hidden map as a raw handout. The
  // canvas loads it only through the role-aware encounter endpoint; with fog off,
  // that endpoint may return the complete image without making its source URL public.
  it('attaching a map keeps its raw URL hidden while the scoped encounter canvas can load it', async () => {
    const server = ctx.app.getHttpServer();
    const raw = await request(server).get(`/api/v1/attachments/${mapAttachmentId}/file`).set(player);
    expect(raw.status).toBe(404);

    const safe = await request(server).get(`/api/v1/encounters/${encounterId}/map`).set(player);
    expect(safe.status).toBe(200);
    expect(safe.headers['x-campfire-map-view']).toBe('fully-revealed');
    expect(Buffer.compare(safe.body, BATTLE_MAP_PNG)).toBe(0);
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

    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Grid Fight', hidden: false });
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

  it('grid calibration (issue #417): defaults are the pre-#417 top-left square grid', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body.gridOffsetX).toBe(0);
    expect(res.body.gridOffsetY).toBe(0);
    expect(res.body.gridCellHeight).toBeNull();
    expect(res.body.gridRotation).toBe(0);
    expect(res.body.gridOpacity).toBeCloseTo(0.35, 5);
  });

  it('grid calibration (issue #417): offset/cellHeight/rotation/opacity round-trip and persist', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}`)
      .set(dm)
      .send({ gridOffsetX: 3.5, gridOffsetY: -2.25, gridCellHeight: 11, gridRotation: 12.5, gridOpacity: 0.6 });
    expect(res.status).toBe(200);
    expect(res.body.gridOffsetX).toBeCloseTo(3.5, 5);
    expect(res.body.gridOffsetY).toBeCloseTo(-2.25, 5);
    expect(res.body.gridCellHeight).toBe(11);
    expect(res.body.gridRotation).toBeCloseTo(12.5, 5);
    expect(res.body.gridOpacity).toBeCloseTo(0.6, 5);

    // A player sees the same persisted calibration (same transform, every viewport).
    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
    expect(getRes.body.gridOffsetX).toBeCloseTo(3.5, 5);
    expect(getRes.body.gridCellHeight).toBe(11);

    // gridCellHeight: null restores square cells.
    const cleared = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ gridCellHeight: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.gridCellHeight).toBeNull();
  });

  it('grid calibration (issue #417): out-of-range rotation/opacity are rejected (400)', async () => {
    const server = ctx.app.getHttpServer();
    expect((await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ gridRotation: 90 })).status).toBe(400);
    expect((await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ gridOpacity: 2 })).status).toBe(400);
  });

  it('grid calibration (issue #417): a player cannot calibrate (dm only, 403)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch(`/api/v1/encounters/${encounterId}`).set(player).send({ gridOffsetX: 10 });
    expect(res.status).toBe(403);
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
      // Issue #418: fog-hidden (not truly unplaced) so the client can avoid a false Unplaced tray.
      expect(monster.tokenHiddenByFog).toBe(true);
      // PC at (80,80) is inside the revealed rectangle — position visible.
      expect(pc.tokenX).toBe(80);
      expect(pc.tokenY).toBe(80);
      expect(pc.tokenHiddenByFog).toBe(false);
    });

    it('issue #418: owned / allied / enemy tokens crossing fog get tokenHiddenByFog without leaking coords', async () => {
      const server = ctx.app.getHttpServer();
      // Second PC (allied) owned by another player — place it in the dark with the monster.
      const allyCharacterId = (
        await request(server)
          .post(`/api/v1/campaigns/${campaignId}/characters`)
          .set(dm)
          .send({ name: 'Borin', hpCurrent: 18, hpMax: 18, ownerUserId: 'dev:p-2' })
      ).body.id;
      const allyCombatantId = (
        await request(server)
          .post(`/api/v1/encounters/${encounterId}/combatants`)
          .set(dm)
          .send({ kind: 'character', characterId: allyCharacterId })
      ).body.id;
      // Reveal only a small corner that covers none of the tokens; place owned PC in fog too.
      await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({ fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 5, h: 5 }] } });
      await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${charCombatantId}`)
        .set(dm)
        .send({ tokenX: 80, tokenY: 80 });
      await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${allyCombatantId}`)
        .set(dm)
        .send({ tokenX: 40, tokenY: 40 });
      await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterCombatantId}`)
        .set(dm)
        .send({ tokenX: 10, tokenY: 10 });

      const playerView = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
      expect(playerView.status).toBe(200);
      const owned = playerView.body.combatants.find((c: CombatantShape) => c.id === charCombatantId);
      const allied = playerView.body.combatants.find((c: CombatantShape) => c.id === allyCombatantId);
      const enemy = playerView.body.combatants.find((c: CombatantShape) => c.id === monsterCombatantId);

      for (const c of [owned, allied, enemy]) {
        expect(c.tokenX).toBeNull();
        expect(c.tokenY).toBeNull();
        expect(c.tokenHiddenByFog).toBe(true);
      }

      // Reveal the owned PC's corner — it transitions to real coords; others stay fog-hidden.
      await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({ fog: { enabled: true, revealed: [{ x: 60, y: 60, w: 40, h: 40 }] } });
      const afterReveal = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
      const ownedAfter = afterReveal.body.combatants.find((c: CombatantShape) => c.id === charCombatantId);
      const alliedAfter = afterReveal.body.combatants.find((c: CombatantShape) => c.id === allyCombatantId);
      const enemyAfter = afterReveal.body.combatants.find((c: CombatantShape) => c.id === monsterCombatantId);

      expect(ownedAfter.tokenX).toBe(80);
      expect(ownedAfter.tokenY).toBe(80);
      expect(ownedAfter.tokenHiddenByFog).toBe(false);
      expect(alliedAfter.tokenHiddenByFog).toBe(true);
      expect(alliedAfter.tokenX).toBeNull();
      expect(enemyAfter.tokenHiddenByFog).toBe(true);
      expect(enemyAfter.tokenX).toBeNull();

      // DM still sees every real coordinate (no false Unplaced on the DM client either).
      const dmView = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const dmOwned = dmView.body.combatants.find((c: CombatantShape) => c.id === charCombatantId);
      expect(dmOwned.tokenX).toBe(80);
      expect(dmOwned.tokenHiddenByFog).toBe(false);
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

    it('issue #472: per-region fog edits with ids persist for every client read', async () => {
      const server = ctx.app.getHttpServer();
      const write = await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({
          fog: {
            enabled: true,
            revealed: [
              { id: 'west', x: 0, y: 0, w: 40, h: 40 },
              { id: 'east', x: 55, y: 55, w: 35, h: 35 },
            ],
          },
        });
      expect(write.status).toBe(200);
      expect(write.body.fog.revealed).toHaveLength(2);

      const trimmed = await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({
          fog: {
            enabled: true,
            revealed: [{ id: 'east', x: 50, y: 50, w: 35, h: 35 }],
          },
        });
      expect(trimmed.status).toBe(200);

      const playerRead = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
      expect(playerRead.body.fog.revealed).toEqual([{ id: 'east', x: 50, y: 50, w: 35, h: 35 }]);
    });
  });

  describe('issue #465: AoE template fog secrecy', () => {
    const darkAoe = { id: 'dark-circle', shape: 'circle' as const, x: 10, y: 10, sizeFt: 20, angleDeg: 0, color: null };
    const litAoe = { id: 'lit-cone', shape: 'cone' as const, x: 80, y: 80, sizeFt: 15, angleDeg: 90, color: null };
    const ownedAoe = {
      id: 'player-fireball',
      shape: 'circle' as const,
      x: 12,
      y: 12,
      sizeFt: 20,
      angleDeg: 0,
      color: null,
      declaredByUserId: 'dev:p-1',
    };

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({
          fog: { enabled: true, revealed: [{ x: 60, y: 60, w: 40, h: 40 }] },
          aoe: [darkAoe, litAoe, ownedAoe],
        });
    });

    it('the DM still receives every AoE template', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      expect(res.body.aoe.map((t: { id: string }) => t.id).sort()).toEqual(['dark-circle', 'lit-cone', 'player-fireball']);
    });

    it('a player does NOT receive AoE templates in unrevealed fog', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
      expect(res.body.aoe.map((t: { id: string }) => t.id)).toEqual(['lit-cone', 'player-fireball']);
    });

    it('another player does not see a peer-declared template in unrevealed fog', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set('x-dev-user', 'p-2').set('x-dev-role', 'player');
      expect(res.body.aoe.map((t: { id: string }) => t.id)).toEqual(['lit-cone']);
    });

    it('revealing the dark corner exposes the hidden template to every player', async () => {
      const server = ctx.app.getHttpServer();
      await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({ fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 100, h: 100 }] } });
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
      expect(res.body.aoe.map((t: { id: string }) => t.id).sort()).toEqual(['dark-circle', 'lit-cone', 'player-fireball']);
    });

    it('moving an AoE into unrevealed fog hides it from players on the next read', async () => {
      const server = ctx.app.getHttpServer();
      await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({
          fog: { enabled: true, revealed: [{ x: 60, y: 60, w: 40, h: 40 }] },
          aoe: [{ ...litAoe, x: 15, y: 15 }],
        });
      const res = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
      expect(res.body.aoe).toEqual([]);
    });

    it('clearing the aoe array removes templates for every role', async () => {
      const server = ctx.app.getHttpServer();
      await request(server).patch(`/api/v1/encounters/${encounterId}`).set(dm).send({ aoe: [] });
      const dmRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const playerRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(player);
      expect(dmRes.body.aoe).toEqual([]);
      expect(playerRes.body.aoe).toEqual([]);
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
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Stable Grid', hidden: false })
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
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Two-client Grid', hidden: false })
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
    encounterId = (await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Hexy Fight', hidden: false })).body.id;
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

  it('DM sets hex orientation; it round-trips with default pointy for legacy encounters', async () => {
    const server = ctx.app.getHttpServer();
    const fresh = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Hex orient', hidden: false })
    ).body.id;
    expect((await request(server).get(`/api/v1/encounters/${fresh}`).set(dm)).body.hexOrientation).toBe('pointy');
    const res = await request(server).patch(`/api/v1/encounters/${fresh}`).set(dm).send({ gridType: 'hex', hexOrientation: 'flat' });
    expect(res.status).toBe(200);
    expect(res.body.hexOrientation).toBe('flat');
    expect((await request(server).get(`/api/v1/encounters/${fresh}`).set(player)).body.hexOrientation).toBe('flat');
    const bad = await request(server).patch(`/api/v1/encounters/${fresh}`).set(dm).send({ hexOrientation: 'diamond' });
    expect(bad.status).toBe(400);
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

  // Issue #1636: `POST /encounters/:id/ping` was gated only by
  // `requireMember(..., { write: true })`, which asserts the CAMPAIGN is writable, not
  // that the CALLER has write authority — a viewer passed it unchanged, and no
  // downstream check enforced the route's own documented "any DM or player" contract.
  // Dev-auth's role header IS the effective role per request (no DB membership row
  // backs it), so sending the SAME dev-user with a different `x-dev-role` on a later
  // request faithfully simulates "demoted mid-session, same identity".
  it("a member demoted from player to viewer loses ping authority on the very next request, and no ping event is broadcast (#1636)", async () => {
    const server = ctx.app.getHttpServer();
    const demotedPlayer = { 'x-dev-role': 'viewer', 'x-dev-user': 'p-1' }; // same identity as `player`, now viewer

    const broadcasts: Array<{ type: string; encounterId?: number }> = [];
    const subscription = ctx.app
      .get(CampaignEventsService)
      .streamFor(campaignId)
      .subscribe((event) => broadcasts.push(event));

    try {
      const res = await request(server).post(`/api/v1/encounters/${encounterId}/ping`).set(demotedPlayer).send({ x: 50, y: 50 });
      expect(res.status).toBe(403);

      // State assertion (the point of the issue): nothing was persisted by ping in the
      // first place, but the SIGNAL (the SSE broadcast every open client renders) must
      // also not have gone out — a 403 that still broadcasts would be the bug this
      // test pins.
      expect(broadcasts.filter((event) => event.type === 'encounter.ping' && event.encounterId === encounterId)).toHaveLength(0);
    } finally {
      subscription.unsubscribe();
    }

    // The still-player identity can still ping — proves the 403 above was really the
    // role floor and not some unrelated breakage.
    const stillPlayer = await request(server).post(`/api/v1/encounters/${encounterId}/ping`).set(player).send({ x: 51, y: 51 });
    expect(stillPlayer.status).toBe(201);
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

    const loc = await request(server).post(`/api/v1/campaigns/${campaignId}/locations`).set(dm).send({ name: 'Thornbridge', status: 'explored' });
    locationId = loc.body.id;
    const quest = await request(server).post(`/api/v1/campaigns/${campaignId}/quests`).set(dm).send({ title: 'The Everflame', hidden: false });
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
    const created = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Loose fight', hidden: false });
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
    const enc = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'X', hidden: false });
    const res = await request(server).patch(`/api/v1/encounters/${enc.body.id}`).set(dm).send({ locationId: otherLoc.body.id });
    expect(res.status).toBe(404);
  });

  // Issue #864: CREATE must apply the same campaign-scope check PATCH already had —
  // a foreign/missing location, quest, or session link 404s with zero partial rows.
  it('create rejects foreign location/quest/session links with 404 and writes nothing (issue #864)', async () => {
    const server = ctx.app.getHttpServer();
    const otherCamp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Create Links' });
    const otherLoc = await request(server).post(`/api/v1/campaigns/${otherCamp.body.id}/locations`).set(dm).send({ name: 'Elsewhere' });
    const otherQuest = await request(server).post(`/api/v1/campaigns/${otherCamp.body.id}/quests`).set(dm).send({ title: 'Foreign' });
    const otherSession = await request(server).post(`/api/v1/campaigns/${otherCamp.body.id}/sessions`).set(dm).send({ title: 'Foreign Session' });

    const before = await request(server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(dm);
    expect(before.status).toBe(200);
    const beforeCount = before.body.length;

    for (const body of [
      { name: 'Bad loc', locationId: otherLoc.body.id },
      { name: 'Bad quest', questId: otherQuest.body.id },
      { name: 'Bad session', sessionId: otherSession.body.id },
      { name: 'Mixed', locationId, questId: otherQuest.body.id, sessionId },
    ]) {
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send(body);
      expect(res.status).toBe(404);
      // Non-enumerating: message names the kind, not whether the id exists elsewhere.
      expect(String(res.body.message ?? res.body.error ?? '')).toMatch(/not found/i);
    }

    const after = await request(server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(dm);
    expect(after.body.length).toBe(beforeCount);
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
    expect(digest.monstersDefeated).toBe(0); // no monsters in this fight
  });

  // Issue #625: the campaign-summary down tally used to sum EVERY combatant at 0 HP /
  // dead — including dead monsters — so 5 dropped goblins + 1 fallen PC read as "6 down."
  // downCount must now count only PCs/NPCs who fell, with monsters reported separately
  // in monstersDefeated.
  it('digest downCount excludes dead monsters and reports them via monstersDefeated (issue #625)', async () => {
    const server = ctx.app.getHttpServer();
    const enc = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Goblin ambush' });

    // Add two CR-10 ogres (the seeded statblock) — auto-added PCs make up the party.
    const mon1 = await request(server)
      .post(`/api/v1/encounters/${enc.body.id}/combatants`)
      .set(dm)
      .send({ kind: 'monster', ruleEntryId: cr10EntryId });
    expect(mon1.status).toBe(201);
    const mon2 = await request(server)
      .post(`/api/v1/encounters/${enc.body.id}/combatants`)
      .set(dm)
      .send({ kind: 'monster', ruleEntryId: cr10EntryId });
    expect(mon2.status).toBe(201);

    // Drop both ogres to 0 HP (defeated) and drop ONE of the four PCs to 0 HP (fallen).
    await request(server).patch(`/api/v1/encounters/${enc.body.id}/combatants/${mon1.body.id}`).set(dm).send({ hpSet: 0 });
    await request(server).patch(`/api/v1/encounters/${enc.body.id}/combatants/${mon2.body.id}`).set(dm).send({ hpSet: 0 });
    const pcList = await request(server).get(`/api/v1/encounters/${enc.body.id}`).set(dm);
    const firstPc = pcList.body.combatants.find((c: { kind: string }) => c.kind === 'character');
    expect(firstPc).toBeDefined();
    await request(server).patch(`/api/v1/encounters/${enc.body.id}/combatants/${firstPc.id}`).set(dm).send({ hpSet: 0 });

    const summary = await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(dm);
    expect(summary.status).toBe(200);
    const digest = summary.body.encounters.find((e: { id: number }) => e.id === enc.body.id);
    expect(digest).toBeDefined();
    expect(digest.combatantCount).toBe(6); // 4 PCs + 2 ogres
    // The fix: only the one fallen PC is counted, not the two dead ogres.
    expect(digest.downCount).toBe(1);
    expect(digest.monstersDefeated).toBe(2);
  });

  it("a note can pin to entityType 'encounter'", async () => {
    const server = ctx.app.getHttpServer();
    const enc = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Noted fight', hidden: false });
    const note = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .set(dm)
      .send({ body: 'They fled north', entityType: 'encounter', entityId: enc.body.id });
    expect(note.status).toBe(201);
    expect(note.body.entityType).toBe('encounter');
    expect(note.body.entityId).toBe(enc.body.id);
    expect(note.body.entityName).toBe('Noted fight');
  });

  // Issue #480: encounter links resolve role-safe display metadata; related records
  // surface backlinks; hidden/deleted targets are handled safely.
  describe('encounter link metadata & backlinks (issue #480)', () => {
    it('GET encounter returns resolved link labels for every role', async () => {
      const server = ctx.app.getHttpServer();
      const enc = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Bridge fight', locationId, questId, sessionId, hidden: false });

      for (const headers of [dm, player, viewer]) {
        const got = await request(server).get(`/api/v1/encounters/${enc.body.id}`).set(headers);
        expect(got.status).toBe(200);
        expect(got.body.locationLink).toEqual({ id: locationId, label: 'Thornbridge' });
        expect(got.body.questLink).toEqual({ id: questId, label: 'The Everflame' });
        expect(got.body.sessionLink).toEqual({ id: sessionId, label: 'Session One' });
      }
    });

    it('redacts hidden linked entities for non-DM and omits their labels', async () => {
      const server = ctx.app.getHttpServer();
      const secretQuest = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/quests`)
        .set(dm)
        .send({ title: 'Hidden Plot', hidden: true });
      const secretLoc = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/locations`)
        .set(dm)
        .send({ name: 'Secret Cave', status: 'unexplored' });
      const enc = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Secret ambush', questId: secretQuest.body.id, locationId: secretLoc.body.id, hidden: false });

      const dmGot = await request(server).get(`/api/v1/encounters/${enc.body.id}`).set(dm);
      expect(dmGot.body.questLink).toEqual({ id: secretQuest.body.id, label: 'Hidden Plot' });
      expect(dmGot.body.locationLink).toEqual({ id: secretLoc.body.id, label: 'Secret Cave' });

      for (const headers of [player, viewer]) {
        const got = await request(server).get(`/api/v1/encounters/${enc.body.id}`).set(headers);
        expect(got.body.questId).toBeNull();
        expect(got.body.locationId).toBeNull();
        expect(got.body.questLink).toBeUndefined();
        expect(got.body.locationLink).toBeUndefined();
      }
    });

    it('broken links stay unavailable for the DM without leaking a label', async () => {
      const server = ctx.app.getHttpServer();
      const loc = await request(server).post(`/api/v1/campaigns/${campaignId}/locations`).set(dm).send({ name: 'Gone Place', status: 'explored' });
      const enc = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Orphan link', locationId: loc.body.id, hidden: false });
      const removed = await request(server).delete(`/api/v1/locations/${loc.body.id}`).set(dm);
      expect(removed.status).toBe(200);

      const got = await request(server).get(`/api/v1/encounters/${enc.body.id}`).set(dm);
      expect(got.body.locationId).toBe(loc.body.id);
      expect(got.body.locationLink).toBeNull();
    });

    it('location/quest/session GET surfaces linked encounter backlinks', async () => {
      const server = ctx.app.getHttpServer();
      const enc = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Backlink fight', locationId, questId, sessionId, hidden: false });
      const hiddenEnc = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Prep ambush', locationId, hidden: true });

      const loc = await request(server).get(`/api/v1/locations/${locationId}`).set(player);
      expect(loc.body.linkedEncounters).toEqual(
        expect.arrayContaining([{ id: enc.body.id, name: 'Backlink fight', status: 'preparing' }]),
      );
      expect(loc.body.linkedEncounters.some((e: { id: number }) => e.id === hiddenEnc.body.id)).toBe(false);

      const quest = await request(server).get(`/api/v1/quests/${questId}`).set(player);
      expect(quest.body.linkedEncounters).toEqual(
        expect.arrayContaining([{ id: enc.body.id, name: 'Backlink fight', status: 'preparing' }]),
      );

      const session = await request(server).get(`/api/v1/sessions/${sessionId}`).set(player);
      expect(session.body.linkedEncounters).toEqual(
        expect.arrayContaining([{ id: enc.body.id, name: 'Backlink fight', status: 'preparing' }]),
      );
    });

    it('campaign summary digests include resolved link metadata', async () => {
      const server = ctx.app.getHttpServer();
      const enc = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Summary links', locationId, questId, hidden: false });
      const summary = await request(server).get(`/api/v1/campaigns/${campaignId}/summary`).set(player);
      const digest = summary.body.encounters.find((e: { id: number }) => e.id === enc.body.id);
      expect(digest).toBeDefined();
      expect(digest.locationLink).toEqual({ id: locationId, label: 'Thornbridge' });
      expect(digest.questLink).toEqual({ id: questId, label: 'The Everflame' });
    });
  });

  it('difficulty band computes correctly for a known party + monster set', async () => {
    const server = ctx.app.getHttpServer();
    const enc = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Ogre fight', hidden: false });
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
    expect(diff.body.status).toBe('ok');
    expect(diff.body.label).toBe('Deadly');
  });

  it('includes NPC combatants with statblocks in difficulty and XP estimates (issue #1454)', async () => {
    const server = ctx.app.getHttpServer();
    const hostileNpcId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Hostile bandit', disposition: 'hostile' })
    ).body.id;
    const friendlyNpcId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Friendly guide', disposition: 'friendly' })
    ).body.id;
    const neutralNpcId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Neutral bystander', disposition: 'neutral' })
    ).body.id;
    const mixedHostileNpcId = (
      await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Mixed hostile bandit', disposition: 'hostile' })
    ).body.id;
    const npcOnly = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'NPC-only fight', hidden: false });
    const addNpc = await request(server)
      .post(`/api/v1/encounters/${npcOnly.body.id}/combatants`)
      .set(dm)
      .send({ kind: 'npc', npcId: hostileNpcId, ruleEntryId: cr10EntryId });
    expect(addNpc.status).toBe(201);

    const npcDifficulty = await request(server).get(`/api/v1/encounters/${npcOnly.body.id}/difficulty`).set(dm);
    expect(npcDifficulty.body).toMatchObject({ status: 'ok', monsterCount: 1, totalMonsterXp: 5900, adjustedXp: 5900 });
    // Before play begins, a preparation estimate follows the NPC's current
    // disposition rather than the snapshot captured when it was added.
    expect((await request(server).patch(`/api/v1/npcs/${hostileNpcId}`).set(dm).send({ disposition: 'friendly' })).status).toBe(200);
    const prepDifficultyAfterDispositionChange = await request(server).get(`/api/v1/encounters/${npcOnly.body.id}/difficulty`).set(dm);
    expect(prepDifficultyAfterDispositionChange.body).toMatchObject({ monsterCount: 0, totalMonsterXp: 0 });

    const friendlyAndNeutral = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Allied NPCs', hidden: false });
    const addFriendly = await request(server)
      .post(`/api/v1/encounters/${friendlyAndNeutral.body.id}/combatants`)
      .set(dm)
      .send({ kind: 'npc', npcId: friendlyNpcId, ruleEntryId: cr10EntryId });
    const addNeutral = await request(server)
      .post(`/api/v1/encounters/${friendlyAndNeutral.body.id}/combatants`)
      .set(dm)
      .send({ kind: 'npc', npcId: neutralNpcId, ruleEntryId: cr10EntryId });
    expect(addFriendly.status).toBe(201);
    expect(addNeutral.status).toBe(201);
    const alliedDifficulty = await request(server).get(`/api/v1/encounters/${friendlyAndNeutral.body.id}/difficulty`).set(dm);
    expect(alliedDifficulty.body).toMatchObject({ monsterCount: 0, totalMonsterXp: 0 });

    const mixed = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Mixed fight', hidden: false });
    const addMonster = await request(server)
      .post(`/api/v1/encounters/${mixed.body.id}/combatants`)
      .set(dm)
      .send({ kind: 'monster', ruleEntryId: cr10EntryId });
    const addMixedNpc = await request(server)
      .post(`/api/v1/encounters/${mixed.body.id}/combatants`)
      .set(dm)
      .send({ kind: 'npc', npcId: mixedHostileNpcId, ruleEntryId: cr10EntryId });
    const addMixedFriendlyNpc = await request(server)
      .post(`/api/v1/encounters/${mixed.body.id}/combatants`)
      .set(dm)
      .send({ kind: 'npc', npcId: friendlyNpcId, ruleEntryId: cr10EntryId });
    const addMixedNeutralNpc = await request(server)
      .post(`/api/v1/encounters/${mixed.body.id}/combatants`)
      .set(dm)
      .send({ kind: 'npc', npcId: neutralNpcId, ruleEntryId: cr10EntryId });
    expect(addMonster.status).toBe(201);
    expect(addMixedNpc.status).toBe(201);
    expect(addMixedFriendlyNpc.status).toBe(201);
    expect(addMixedNeutralNpc.status).toBe(201);

    const mixedDifficulty = await request(server).get(`/api/v1/encounters/${mixed.body.id}/difficulty`).set(dm);
    expect(mixedDifficulty.body).toMatchObject({ status: 'ok', monsterCount: 2, totalMonsterXp: 11800, adjustedXp: 17700 });

    const unresolvedPrep = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Unresolved NPC prep', hidden: false });
    expect(
      (
        await request(server)
          .post(`/api/v1/encounters/${unresolvedPrep.body.id}/combatants`)
          .set(dm)
          .send({ kind: 'npc', npcId: mixedHostileNpcId, ruleEntryId: cr10EntryId })
      ).status,
    ).toBe(201);

    const db = ctx.app.get<DrizzleDb>(DB);
    await db.update(encountersTable).set({ status: 'ended' }).where(eq(encountersTable.id, npcOnly.body.id));
    const endedDifficulty = await request(server).get(`/api/v1/encounters/${npcOnly.body.id}/difficulty`).set(dm);
    expect(endedDifficulty.body).toMatchObject({ status: 'ok', monsterCount: 1, totalMonsterXp: 5900, adjustedXp: 5900 });
    await db.update(npcs).set({ deletedAt: new Date().toISOString() }).where(inArray(npcs.id, [hostileNpcId, mixedHostileNpcId]));
    const exported = await request(server).get(`/api/v1/campaigns/${campaignId}/export?format=json`).set(dm);
    const imported = await request(server).post('/api/v1/campaigns/import').set(dm).send(exported.body);
    expect(imported.status).toBe(201);
    const importedEncounters = await request(server).get(`/api/v1/campaigns/${imported.body.id}/encounters`).set(dm);
    const importedNpcOnly = importedEncounters.body.find((encounter: { name: string }) => encounter.name === 'NPC-only fight');
    const importedNpcOnlyDetail = await request(server).get(`/api/v1/encounters/${importedNpcOnly.id}`).set(dm);
    const importedNpcCombatant = importedNpcOnlyDetail.body.combatants.find((combatant: { kind: string }) => combatant.kind === 'npc');
    expect(importedNpcCombatant.npcId).toBeNull();
    const importedDifficulty = await request(server).get(`/api/v1/encounters/${importedNpcOnly.id}/difficulty`).set(dm);
    expect(importedDifficulty.body).toMatchObject({ status: 'ok', monsterCount: 1, totalMonsterXp: 5900, adjustedXp: 5900 });
    const importedUnresolvedPrep = importedEncounters.body.find((encounter: { name: string }) => encounter.name === 'Unresolved NPC prep');
    const importedUnresolvedPrepDetail = await request(server).get(`/api/v1/encounters/${importedUnresolvedPrep.id}`).set(dm);
    const importedUnresolvedPrepCombatant = importedUnresolvedPrepDetail.body.combatants.find((combatant: { kind: string }) => combatant.kind === 'npc');
    expect(importedUnresolvedPrepCombatant).toMatchObject({ npcId: null, npcDispositionSnapshot: null });
    expect((await request(server).get(`/api/v1/encounters/${importedUnresolvedPrep.id}/difficulty`).set(dm)).body).toMatchObject({ monsterCount: 0, totalMonsterXp: 0 });
    expect((await request(server).post(`/api/v1/encounters/${importedUnresolvedPrep.id}/roll-initiative`).set(dm).send({})).status).toBe(201);
    expect((await request(server).post(`/api/v1/encounters/${importedUnresolvedPrep.id}/start`).set(dm).send({})).status).toBe(201);
    expect((await request(server).get(`/api/v1/encounters/${importedUnresolvedPrep.id}/difficulty`).set(dm)).body).toMatchObject({ monsterCount: 0, totalMonsterXp: 0 });
    await db.update(combatantsTable).set({ npcDispositionSnapshot: null }).where(eq(combatantsTable.encounterId, npcOnly.body.id));
    const legacyDifficulty = await request(server).get(`/api/v1/encounters/${npcOnly.body.id}/difficulty`).set(dm);
    expect(legacyDifficulty.body).toMatchObject({ monsterCount: 0, totalMonsterXp: 0 });
  });

  it('withholds hidden hostile NPCs from non-DM difficulty aggregates (issue #1454)', async () => {
    const server = ctx.app.getHttpServer();
    const hiddenNpcId = (
      await request(server)
        .post(`/api/v1/campaigns/${campaignId}/npcs`)
        .set(dm)
        .send({ name: 'Hidden antagonist', hidden: true, disposition: 'hostile' })
    ).body.id;
    const encounter = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Visible fight with hidden antagonist', hidden: false });
    await request(server)
      .post(`/api/v1/encounters/${encounter.body.id}/combatants`)
      .set(dm)
      .send({ kind: 'npc', npcId: hiddenNpcId, ruleEntryId: cr10EntryId });

    const dmDifficulty = await request(server).get(`/api/v1/encounters/${encounter.body.id}/difficulty`).set(dm);
    expect(dmDifficulty.body).toMatchObject({ monsterCount: 1, totalMonsterXp: 5900 });

    for (const headers of [player, viewer]) {
      const nonDmDifficulty = await request(server).get(`/api/v1/encounters/${encounter.body.id}/difficulty`).set(headers);
      expect(nonDmDifficulty.body).toMatchObject({ monsterCount: 0, totalMonsterXp: 0 });
    }
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

  // Issue #412: preview-and-tune wizard. Reuses the 4×L5 party + CR-2 goblin + CR-10 ogre above.
  describe('encounter preview / tune / idempotent commit (issue #412)', () => {
    let previewGoblinId: number;

    beforeAll(async () => {
      const db = ctx.app.get<DrizzleDb>(DB);
      const ts = new Date().toISOString();
      const [pack] = await db
        .insert(rulePacks)
        .values({ slug: 'preview-pack', name: 'Preview Pack', version: '1', license: 'OGL', sourceUrl: '', installedAt: ts, entryCount: 1 })
        .returning();
      const [goblin] = await db
        .insert(ruleEntries)
        .values({
          packId: pack.id,
          slug: 'preview-goblin',
          name: 'Preview Goblin',
          type: 'monster',
          summary: 'CR 2',
          body: '',
          dataJson: JSON.stringify({ challengeRating: 2, hitPoints: 22, armor_class: 15, type: 'humanoid', actions: [{ name: 'Scimitar', desc: 'Melee attack.' }], dexterity_save: 4 }),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning();
      previewGoblinId = goblin.id;
    });

    it('returns a roster with per-creature inspection, a difficulty explanation, and warnings', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/preview`)
        .set(dm)
        .send({ difficulty: 'medium', seed: 42, filters: { maxCr: 3 } });
      expect(res.status).toBe(200);
      expect(res.body.roster.length).toBeGreaterThan(0);
      const slot = res.body.roster[0];
      expect(typeof slot.slotId).toBe('string');
      expect(slot.inspection).toBeDefined();
      expect(slot.inspection).toHaveProperty('armorClass');
      expect(slot.inspection).toHaveProperty('actions');
      // Explanation is more than a color band.
      expect(res.body.explanation.headline.length).toBeGreaterThan(0);
      expect(Array.isArray(res.body.explanation.detail)).toBe(true);
      expect(Array.isArray(res.body.warnings)).toBe(true);
      // The plan round-trips.
      expect(res.body.plan[0].slotId).toBe(slot.slotId);
    });

    it('tunes deterministically: reroll one slot is reproducible and pin survives reroll-all', async () => {
      const server = ctx.app.getHttpServer();
      const base = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/preview`)
        .set(dm)
        .send({ difficulty: 'hard', seed: 7 });
      expect(base.status).toBe(200);
      const plan = base.body.plan;
      const slotId = plan[0].slotId;

      const a = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/preview`)
        .set(dm)
        .send({ difficulty: 'hard', seed: base.body.seed, roster: plan, tune: { op: 'reroll-slot', slotId, seed: 321 } });
      const b = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/preview`)
        .set(dm)
        .send({ difficulty: 'hard', seed: base.body.seed, roster: plan, tune: { op: 'reroll-slot', slotId, seed: 321 } });
      expect(a.body.plan).toEqual(b.body.plan);

      const pinned = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/preview`)
        .set(dm)
        .send({ difficulty: 'hard', seed: base.body.seed, roster: plan, tune: { op: 'pin', slotId, pinned: true } });
      const afterAll = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/preview`)
        .set(dm)
        .send({ difficulty: 'hard', seed: pinned.body.seed, roster: pinned.body.plan, tune: { op: 'reroll-all', seed: 9999 } });
      const survivor = afterAll.body.plan.find((s: { slotId: string }) => s.slotId === slotId);
      expect(survivor).toBeDefined();
      expect(survivor.ruleEntryId).toBe(pinned.body.plan[0].ruleEntryId);
      expect(survivor.count).toBe(pinned.body.plan[0].count);
    });

    it('commits a tuned roster atomically and is idempotent by key', async () => {
      const server = ctx.app.getHttpServer();
      const preview = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/preview`)
        .set(dm)
        .send({ difficulty: 'medium', seed: 11, filters: { maxCr: 3 } });
      expect(preview.status).toBe(200);
      const key = `commit-${Date.now()}`;
      const body = { idempotencyKey: key, name: 'Tuned Ambush', targetBand: 'medium', roster: preview.body.plan, source: 'wizard' };

      const first = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters/commit`).set(dm).send(body);
      expect(first.status).toBe(201);
      expect(first.body.idempotent).toBe(false);
      expect(first.body.encounter.name).toBe('Tuned Ambush');
      expect(first.body.encounter.status).toBe('preparing');
      expect(first.body.encounter.hidden).toBe(true);
      const monsters = (first.body.encounter.combatants as Array<{ kind: string }>).filter((c) => c.kind === 'monster');
      expect(monsters.length).toBeGreaterThan(0);
      const encounterId = first.body.encounter.id;

      // Retry with the same key -> same encounter, no duplicate combatants.
      const second = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters/commit`).set(dm).send(body);
      expect(second.status).toBe(201);
      expect(second.body.idempotent).toBe(true);
      expect(second.body.encounter.id).toBe(encounterId);
      expect(second.body.encounter.combatants.length).toBe(first.body.encounter.combatants.length);
    });

    it('a non-DM may preview but not commit', async () => {
      const server = ctx.app.getHttpServer();
      const preview = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/preview`)
        .set(player)
        .send({ difficulty: 'easy', seed: 3 });
      expect(preview.status).toBe(200);
      const commit = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/commit`)
        .set(player)
        .send({ idempotencyKey: 'nope', roster: preview.body.plan.length ? preview.body.plan : [{ slotId: 's1', ruleEntryId: previewGoblinId, count: 1, pinned: false, seed: 1 }] });
      expect(commit.status).toBe(403);
    });

    it('rejects a commit that references a non-existent rule entry', async () => {
      const server = ctx.app.getHttpServer();
      const commit = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters/commit`)
        .set(dm)
        .send({ idempotencyKey: `bad-${Date.now()}`, roster: [{ slotId: 's1', ruleEntryId: 99999999, count: 1, pinned: false, seed: 1 }] });
      expect(commit.status).toBe(400);
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

    it('a player/viewer events + ping of a hidden encounter are denied (404); the DM can list events (issue #869)', async () => {
      const server = ctx.app.getHttpServer();
      const id = await createHidden();

      const dmEvents = await request(server).get(`/api/v1/encounters/${id}/events`).set(dm);
      expect(dmEvents.status).toBe(200);
      expect(Array.isArray(dmEvents.body)).toBe(true);

      for (const who of [player, viewer]) {
        expect((await request(server).get(`/api/v1/encounters/${id}/events`).set(who)).status).toBe(404);
        expect(
          (await request(server).post(`/api/v1/encounters/${id}/ping`).set(who).send({ x: 40, y: 60 })).status,
        ).toBe(404);
      }

      // DM may still ping a hidden prep fight (they can see it).
      const dmPing = await request(server).post(`/api/v1/encounters/${id}/ping`).set(dm).send({ x: 40, y: 60 });
      expect(dmPing.status).toBe(201);

      // Reveal restores events parity with roster/difficulty.
      await request(server).patch(`/api/v1/encounters/${id}`).set(dm).send({ hidden: false });
      expect((await request(server).get(`/api/v1/encounters/${id}/events`).set(player)).status).toBe(200);
    });
  });

  // Issue #869: combat-log projection must mask hidden NPC identities (and name-bearing
  // detail) for non-DMs, keep stable combatant ids, and unmask after reveal. Covers the
  // damage/heal/condition/death/turn/roll families plus a reconnect-style re-list.
  describe('combat-log event secrecy for hidden NPCs (issue #869)', () => {
    let secrecyCampId: number;
    let secrecyEncounterId: number;
    let traitorCombatantId: number;
    let ariaCombatantIdLocal: number;

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Event Secrecy Camp' });
      secrecyCampId = campRes.body.id;

      // Party PC so we have a non-hidden actor for attributed damage.
      const charRes = await request(server)
        .post(`/api/v1/campaigns/${secrecyCampId}/characters`)
        .set(dm)
        .send({ name: 'Aria', hpMax: 30 });
      expect(charRes.status).toBe(201);

      const npcId = (
        await request(server)
          .post(`/api/v1/campaigns/${secrecyCampId}/npcs`)
          .set(dm)
          .send({ name: 'The Traitor', hidden: true })
      ).body.id as number;

      const encRes = await request(server)
        .post(`/api/v1/campaigns/${secrecyCampId}/encounters`)
        .set(dm)
        // #754: encounters are private-by-default now; this suite asserts players
        // can VIEW the encounter's events (with hidden NPC names masked), so it
        // must be created explicitly player-visible.
        .send({ name: 'Traitor Fight', hidden: false });
      secrecyEncounterId = encRes.body.id;

      const traitorAdd = await request(server)
        .post(`/api/v1/encounters/${secrecyEncounterId}/combatants`)
        .set(dm)
        .send({ kind: 'npc', npcId, name: 'The Traitor', hpMax: 40 });
      expect(traitorAdd.status).toBe(201);
      traitorCombatantId = traitorAdd.body.id;
      await request(server)
        .patch(`/api/v1/encounters/${secrecyEncounterId}/combatants/${traitorCombatantId}`)
        .set(dm)
        .send({ initiative: 10 });

      // Find the auto-added Aria combatant (or add if the campaign create didn't).
      const roster = await request(server).get(`/api/v1/encounters/${secrecyEncounterId}`).set(dm);
      const aria = (roster.body.combatants as Array<{ id: number; name: string; kind: string }>).find(
        (c) => c.name === 'Aria',
      );
      if (aria) {
        ariaCombatantIdLocal = aria.id;
      } else {
        const add = await request(server)
          .post(`/api/v1/encounters/${secrecyEncounterId}/combatants`)
          .set(dm)
          .send({ kind: 'character', characterId: charRes.body.id });
        expect(add.status).toBe(201);
        ariaCombatantIdLocal = add.body.id;
      }
      await request(server)
        .patch(`/api/v1/encounters/${secrecyEncounterId}/combatants/${ariaCombatantIdLocal}`)
        .set(dm)
        .send({ initiative: 20 });

      // DEV_AUTH headers short-circuit RoleResolver (player/viewer/dm) without a
      // campaign_members row — same pattern as the issue #43 redaction suite above.

      const start = await request(server).post(`/api/v1/encounters/${secrecyEncounterId}/start`).set(dm);
      expect(start.status).toBe(201);

      // Produce one of each name-bearing event family against the hidden NPC.
      await request(server)
        .patch(`/api/v1/encounters/${secrecyEncounterId}/combatants/${traitorCombatantId}`)
        .set(dm)
        .send({ hpDelta: -5, actorId: ariaCombatantIdLocal });
      await request(server)
        .patch(`/api/v1/encounters/${secrecyEncounterId}/combatants/${traitorCombatantId}`)
        .set(dm)
        .send({ addConditions: ['Poisoned'] });
      await request(server)
        .patch(`/api/v1/encounters/${secrecyEncounterId}/combatants/${traitorCombatantId}`)
        .set(dm)
        .send({ hpDelta: 2, actorId: null });
      await request(server).post(`/api/v1/encounters/${secrecyEncounterId}/next-turn`).set(dm);
      await request(server)
        .patch(`/api/v1/encounters/${secrecyEncounterId}/combatants/${traitorCombatantId}`)
        .set(dm)
        .send({ hpSet: 0, actorId: ariaCombatantIdLocal });
    });

    it('DM sees raw NPC names + stable combatant ids on every event type', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/encounters/${secrecyEncounterId}/events`).set(dm);
      expect(res.status).toBe(200);
      const body = res.body as Array<{
        type: string;
        actor: string | null;
        target: string | null;
        actorId: number | null;
        targetId: number | null;
        detail: string;
      }>;
      const types = new Set(body.map((e) => e.type));
      for (const t of ['turn', 'damage', 'condition', 'heal', 'death'] as const) {
        expect(types.has(t)).toBe(true);
      }
      const againstTraitor = body.filter((e) => e.targetId === traitorCombatantId);
      expect(againstTraitor.length).toBeGreaterThan(0);
      for (const e of againstTraitor) {
        expect(e.target).toBe('The Traitor');
        expect(e.detail).not.toMatch(/Traitor/); // name-free detail
      }
      const opening = body.find((e) => e.type === 'turn' && e.detail === 'Combat started');
      expect(opening).toBeTruthy();
      expect(opening!.actorId).toBeTruthy();
    });

    it('non-DM list masks hidden NPC identity across event types; detail cannot bypass', async () => {
      const server = ctx.app.getHttpServer();
      for (const who of [player, viewer]) {
        const res = await request(server).get(`/api/v1/encounters/${secrecyEncounterId}/events`).set(who);
        expect(res.status).toBe(200);
        const raw = JSON.stringify(res.body);
        expect(raw).not.toMatch(/Traitor/);
        const body = res.body as Array<{
          type: string;
          actor: string | null;
          target: string | null;
          actorId: number | null;
          targetId: number | null;
          detail: string;
        }>;
        const againstTraitor = body.filter((e) => e.targetId === traitorCombatantId);
        expect(againstTraitor.length).toBeGreaterThan(0);
        for (const e of againstTraitor) {
          expect(e.target).toBe('Unknown combatant');
          expect(e.detail).not.toMatch(/Traitor/i);
        }
        // Stable ids remain for roster correlation / client projection.
        expect(againstTraitor.some((e) => e.targetId === traitorCombatantId)).toBe(true);
      }
    });

    it('revealing the NPC unmasks historical events on reconnect/poll-style re-list', async () => {
      const server = ctx.app.getHttpServer();
      const npcList = await request(server).get(`/api/v1/campaigns/${secrecyCampId}/npcs`).set(dm);
      const traitorNpc = (npcList.body as Array<{ id: number; name: string }>).find((n) => n.name === 'The Traitor')!;
      const revealed = await request(server).patch(`/api/v1/npcs/${traitorNpc.id}`).set(dm).send({ hidden: false });
      expect(revealed.status).toBe(200);

      // Re-list (poll / SSE-driven refetch) sees current projection with real names.
      const res = await request(server).get(`/api/v1/encounters/${secrecyEncounterId}/events`).set(player);
      expect(res.status).toBe(200);
      const againstTraitor = (res.body as Array<{ target: string | null; targetId: number | null }>).filter(
        (e) => e.targetId === traitorCombatantId,
      );
      expect(againstTraitor.length).toBeGreaterThan(0);
      expect(againstTraitor.every((e) => e.target === 'The Traitor')).toBe(true);
    });
  });

  // Issue #715 — initiative is nullable in storage but the update schema only accepted
  // numbers, so a mistaken value could not be cleared back to the unrolled state. The
  // PATCH body now accepts `initiative: null`, the service writes NULL onto the row,
  // the audit log records the clear, and a running encounter reconciles its positional
  // turnIndex against the re-sorted order while keeping the identity-based current-turn
  // pointer stable.
  describe('clearing initiative back to null (issue #715)', () => {
    let encounterId: number;
    let goblinAId: number;
    let goblinBId: number;

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Clear Initiative Fight' });
      encounterId = res.body.id;
      const a = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Goblin A', hpMax: 7 });
      goblinAId = a.body.id;
      const b = await request(server)
        .post(`/api/v1/encounters/${encounterId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Goblin B', hpMax: 7 });
      goblinBId = b.body.id;
    });

    it('dm sets then clears initiative to null while preparing', async () => {
      const server = ctx.app.getHttpServer();
      const setRes = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinAId}`)
        .set(dm)
        .send({ initiative: 18 });
      expect(setRes.status).toBe(200);
      expect(setRes.body.initiative).toBe(18);

      // The regression: before #715 this body (`{ initiative: null }`) was rejected by
      // the CombatantUpdate schema (initiative was z.number().int().optional()), so a
      // mistaken value could never be honestly cleared. Now it 200s and writes NULL.
      const clearRes = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinAId}`)
        .set(dm)
        .send({ initiative: null });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.initiative).toBeNull();

      // Persisted: a fresh GET reads null back (not a stale 18, not 0).
      const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const a = (getRes.body.combatants as Array<{ id: number; initiative: number | null }>).find((c) => c.id === goblinAId);
      expect(a?.initiative).toBeNull();
    });

    it('clearing initiative is audited with the null payload', async () => {
      const db = ctx.app.get<DrizzleDb>(DB);
      const audits = (await db.select().from(auditLog).where(eq(auditLog.entityId, goblinAId))).filter(
        (row) => row.action === 'encounter.combatant.update' && row.detail.includes('initiative'),
      );
      // The clear wrote `{"initiative":null}` into the audit detail — proving the null
      // value flows through the audit path, not just the column write.
      const cleared = audits.find((row) => row.detail.includes('"initiative":null'));
      expect(cleared).toBeDefined();
    });

    it('clearing initiative while running re-sorts order and keeps the current-turn pointer stable', async () => {
      const server = ctx.app.getHttpServer();
      // Roll initiative for every combatant. The party characters get 8, goblinA gets 12,
      // goblinB gets 20, so the running order starts: B(20), A(12), <party at 8>...
      const beforeStart = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const partyIds = (beforeStart.body.combatants as Array<{ id: number; kind: string }>)
        .filter((c) => c.kind === 'character')
        .map((c) => c.id);
      for (const c of beforeStart.body.combatants as Array<{ id: number }>) {
        const target = c.id === goblinAId ? 12 : c.id === goblinBId ? 20 : 8;
        await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${c.id}`).set(dm).send({ initiative: target });
      }

      const startRes = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
      expect(startRes.status).toBe(201);
      expect(startRes.body.status).toBe('running');
      // B (20) is first.
      expect(startRes.body.currentCombatantId).toBe(goblinBId);
      expect(startRes.body.turnIndex).toBe(0);

      // Clear B's initiative: B sinks below everyone with a roll (goblinA + the party),
      // landing at the very bottom of the order. The current-turn pointer is identity-based
      // (issue #49) so it stays on B, but turnIndex must reconcile to B's new (last) position.
      const clearRes = await request(server)
        .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinBId}`)
        .set(dm)
        .send({ initiative: null });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.initiative).toBeNull();

      const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const order = (getRes.body.combatants as Array<{ id: number }>).map((c) => c.id);
      // B slid from top (index 0) to the very bottom; goblinA (12) is now the top.
      expect(order[0]).toBe(goblinAId);
      expect(order[order.length - 1]).toBe(goblinBId);
      // The last index is exactly where B's reconciled turnIndex should point.
      const lastIndex = order.length - 1;
      // Current-turn pointer is unchanged (still B), but its positional turnIndex moved
      // from 0 to `lastIndex` to track the re-sort.
      expect(getRes.body.currentCombatantId).toBe(goblinBId);
      expect(getRes.body.turnIndex).toBe(lastIndex);

      // next-turn still works: from B (last index) it wraps to A (top) and round+1.
      const nextRes = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm);
      expect(nextRes.status).toBe(201);
      expect(nextRes.body.currentCombatantId).toBe(goblinAId);
      expect(nextRes.body.round).toBe(2);
      expect(nextRes.body.turnIndex).toBe(0);
      // Silence the unused-var lint: partyIds documents the party-at-8 setup above.
      expect(partyIds.length).toBeGreaterThan(0);
    });

    it('roll-initiative re-fills a cleared initiative (preparing flow parity)', async () => {
      const server = ctx.app.getHttpServer();
      // End the running encounter so we can reopen to preparing-like state, then make a
      // fresh preparing encounter to prove roll-initiative still fills cleared nulls.
      await request(server).post(`/api/v1/encounters/${encounterId}/end`).set(dm);
      const res = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Clear Initiative 2', hidden: false });
      const enc2 = res.body.id;
      const m = await request(server)
        .post(`/api/v1/encounters/${enc2}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Wolf', hpMax: 11 });
      const wolfId = m.body.id;
      await request(server).patch(`/api/v1/encounters/${enc2}/combatants/${wolfId}`).set(dm).send({ initiative: 5 });
      await request(server).patch(`/api/v1/encounters/${enc2}/combatants/${wolfId}`).set(dm).send({ initiative: null });

      const rollRes = await request(server).post(`/api/v1/encounters/${enc2}/roll-initiative`).set(dm);
      expect(rollRes.status).toBe(201);
      const wolf = (rollRes.body.combatants as Array<{ id: number; initiative: number | null }>).find((c) => c.id === wolfId);
      expect(wolf?.initiative).not.toBeNull();
    });

    it('a player still cannot clear initiative (DM-only, unchanged)', async () => {
      const server = ctx.app.getHttpServer();
      // Fresh preparing encounter (encounterId above was ended in the running test) so the
      // only gate exercised here is the DM-only initiative guard, not ended-immutability.
      const res = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Clear Initiative 3' });
      const enc3 = res.body.id;
      const m = await request(server)
        .post(`/api/v1/encounters/${enc3}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Brute', hpMax: 20 });
      await request(server).patch(`/api/v1/encounters/${enc3}/combatants/${m.body.id}`).set(dm).send({ initiative: 10 });

      const denied = await request(server)
        .patch(`/api/v1/encounters/${enc3}/combatants/${m.body.id}`)
        .set(player)
        .send({ initiative: null });
      expect(denied.status).toBe(403);
    });
  });

  // Issue #744: a campaign may have at most one authoritative live ('running') fight.
  // Start/Reopen are transactional and reject with 409 when another fight is already live,
  // carrying the winner's id + name + deep link. End clears the campaign's
  // activeEncounterId so the next fight may start. Dashboard / Player Display / AI Table
  // read the active pointer (falling back to a status scan) instead of picking an
  // arbitrary first result.
  describe('one authoritative live fight (issue #744)', () => {
    // Build a preparing encounter with all combatants' initiative set, ready to start.
    // Creating an encounter auto-adds the campaign's party (Aria) with null initiative, so
    // /roll-initiative is what actually makes every combatant start-eligible.
    async function makePreparedEncounter(name: string): Promise<number> {
      const server = ctx.app.getHttpServer();
      const created = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name });
      expect(created.status).toBe(201);
      const id = created.body.id as number;
      const m = await request(server)
        .post(`/api/v1/encounters/${id}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: `${name} foe`, hpMax: 10 });
      expect(m.status).toBe(201);
      const roll = await request(server).post(`/api/v1/encounters/${id}/roll-initiative`).set(dm);
      expect(roll.status).toBe(201);
      return id;
    }

    async function startEncounter(id: number): Promise<request.Response> {
      return request(server()).post(`/api/v1/encounters/${id}/start`).set(dm);
    }

    function server() {
      return ctx.app.getHttpServer();
    }

    it('starting a second encounter while one is already running is rejected 409 with the winner name + deep link', async () => {
      const first = await makePreparedEncounter('Live Fight A');
      const second = await makePreparedEncounter('Live Fight B');

      const ok = await startEncounter(first);
      expect(ok.status).toBe(201);

      const conflict = await startEncounter(second);
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('ENCOUNTER_ALREADY_RUNNING');
      expect(conflict.body.encounterId).toBe(first);
      expect(conflict.body.encounterName).toBe('Live Fight A');
      expect(conflict.body.deepLink).toBe(`/c/${campaignId}/encounters/${first}`);

      // The loser stayed 'preparing' — its status flip was atomic with the assertion.
      const loserGet = await request(server()).get(`/api/v1/encounters/${second}`).set(dm);
      expect(loserGet.body.status).toBe('preparing');

      // Clean up: end the winner so subsequent tests start fresh.
      await request(server()).post(`/api/v1/encounters/${first}/end`).set(dm);
    });

    it('reopening an ended encounter while another is running is rejected 409', async () => {
      const first = await makePreparedEncounter('Reopen Winner');
      const second = await makePreparedEncounter('Reopen Loser');

      // Start + end `second` so it is eligible to reopen.
      await startEncounter(second);
      await request(server()).post(`/api/v1/encounters/${second}/end`).set(dm);

      // Now start `first` — it becomes the authoritative live fight.
      const ok = await startEncounter(first);
      expect(ok.status).toBe(201);

      // Reopening `second` must fail: `first` is live.
      const conflict = await request(server()).post(`/api/v1/encounters/${second}/reopen`).set(dm);
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('ENCOUNTER_ALREADY_RUNNING');
      expect(conflict.body.encounterId).toBe(first);

      // The loser stayed 'ended'.
      const loserGet = await request(server()).get(`/api/v1/encounters/${second}`).set(dm);
      expect(loserGet.body.status).toBe('ended');

      await request(server()).post(`/api/v1/encounters/${first}/end`).set(dm);
    });

    it('ending the active encounter clears the pointer, allowing a new fight to start', async () => {
      const first = await makePreparedEncounter('End Then Start 1');
      const second = await makePreparedEncounter('End Then Start 2');

      await startEncounter(first);
      const endRes = await request(server()).post(`/api/v1/encounters/${first}/end`).set(dm);
      expect(endRes.status).toBe(201);

      // After ending, the second encounter may start without a 409.
      const ok = await startEncounter(second);
      expect(ok.status).toBe(201);
      expect(ok.body.status).toBe('running');

      await request(server()).post(`/api/v1/encounters/${second}/end`).set(dm);
    });

    it('GET /campaigns/:id/encounters?status=running surfaces the authoritative fight first', async () => {
      const live = await makePreparedEncounter('Authoritative Surfacing');
      await startEncounter(live);

      const list = await request(server()).get(`/api/v1/campaigns/${campaignId}/encounters?status=running`).set(dm);
      expect(list.status).toBe(200);
      const running = list.body as Array<{ id: number }>;
      expect(running.length).toBe(1);
      expect(running[0].id).toBe(live);

      await request(server()).post(`/api/v1/encounters/${live}/end`).set(dm);
    });

    it('a hidden encounter can still be the authoritative live fight and is the 409 winner by name', async () => {
      const server = ctx.app.getHttpServer();
      // Hidden prep encounter that the DM starts — it becomes the authoritative fight.
      const hiddenCreated = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Secret Ambush', hidden: true });
      expect(hiddenCreated.status).toBe(201);
      const hiddenId = hiddenCreated.body.id as number;
      await request(server)
        .post(`/api/v1/encounters/${hiddenId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Ambusher', hpMax: 8 });
      // Roll initiative for every combatant (the auto-added party + the monster) so /start is eligible.
      const roll = await request(server).post(`/api/v1/encounters/${hiddenId}/roll-initiative`).set(dm);
      expect(roll.status).toBe(201);

      const started = await request(server).post(`/api/v1/encounters/${hiddenId}/start`).set(dm);
      expect(started.status).toBe(201);

      // A second (revealed) encounter cannot start while the hidden one is live.
      const revealed = await makePreparedEncounter('Revealed Rival');
      const conflict = await startEncounter(revealed);
      expect(conflict.status).toBe(409);
      expect(conflict.body.encounterName).toBe('Secret Ambush');

      // And the hidden fight is still hidden from a player's running list (issue #262 holds).
      const playerList = await request(server).get(`/api/v1/campaigns/${campaignId}/encounters?status=running`).set(player);
      expect(playerList.body.some((e: { id: number }) => e.id === hiddenId)).toBe(false);

      await request(server).post(`/api/v1/encounters/${hiddenId}/end`).set(dm);
    });

    it('deleting the active encounter clears the pointer so a new fight may start', async () => {
      const live = await makePreparedEncounter('Delete Active');
      await startEncounter(live);

      const del = await request(server()).delete(`/api/v1/encounters/${live}`).set(dm);
      expect(del.status).toBe(200);

      // Pointer is cleared by remove(); a new encounter starts cleanly.
      const next = await makePreparedEncounter('After Delete');
      const ok = await startEncounter(next);
      expect(ok.status).toBe(201);

      await request(server()).post(`/api/v1/encounters/${next}/end`).set(dm);
    });
  });

  describe('encounter list filter/sort/search (issue #490)', () => {
    let listCampId: number;
    let runningId: number;
    let preparingId: number;
    let endedGoblinId: number;

    beforeAll(async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'List Filter Campaign' });
      expect(campRes.status).toBe(201);
      listCampId = campRes.body.id;

      const ts = new Date().toISOString();
      const endedRows = Array.from({ length: 50 }, (_, i) => ({
        campaignId: listCampId,
        name: `Ended fight ${i + 1}`,
        status: 'ended' as const,
        round: 1,
        turnIndex: 0,
        createdAt: ts,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      }));
      await db.insert(encountersTable).values(endedRows);

      const preparing = await request(server)
        .post(`/api/v1/campaigns/${listCampId}/encounters`)
        .set(dm)
        .send({ name: 'Prep Ambush', hidden: false });
      expect(preparing.status).toBe(201);
      preparingId = preparing.body.id;

      const running = await request(server)
        .post(`/api/v1/campaigns/${listCampId}/encounters`)
        .set(dm)
        .send({ name: 'Live Boss Fight', hidden: false });
      expect(running.status).toBe(201);
      runningId = running.body.id;
      const runningMonster = await request(server)
        .post(`/api/v1/encounters/${runningId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Boss', hpMax: 100 });
      expect(runningMonster.status).toBe(201);
      const roll = await request(server).post(`/api/v1/encounters/${runningId}/roll-initiative`).set(dm);
      expect(roll.status).toBe(201);
      const start = await request(server).post(`/api/v1/encounters/${runningId}/start`).set(dm);
      expect(start.status).toBe(201);

      const endedNamed = await request(server)
        .post(`/api/v1/campaigns/${listCampId}/encounters`)
        .set(dm)
        .send({ name: 'Goblin Skirmish', hidden: false });
      expect(endedNamed.status).toBe(201);
      endedGoblinId = endedNamed.body.id;
      const goblin = await request(server)
        .post(`/api/v1/encounters/${endedGoblinId}/combatants`)
        .set(dm)
        .send({ kind: 'monster', name: 'Goblin', hpMax: 7 });
      expect(goblin.status).toBe(201);
      await request(server).post(`/api/v1/encounters/${endedGoblinId}/roll-initiative`).set(dm);
      await request(server).post(`/api/v1/encounters/${endedGoblinId}/start`).set(dm);
      await request(server).post(`/api/v1/encounters/${endedGoblinId}/end`).set(dm);
    });

    it('surfaces the running encounter ahead of dozens of ended fights', async () => {
      const server = ctx.app.getHttpServer();
      const list = await request(server).get(`/api/v1/campaigns/${listCampId}/encounters`).set(dm);
      expect(list.status).toBe(200);
      expect(list.body.length).toBeGreaterThanOrEqual(52);
      expect(list.body[0].id).toBe(runningId);
      expect(list.body[0].status).toBe('running');
    });

    it('filters by status', async () => {
      const server = ctx.app.getHttpServer();
      const preparing = await request(server)
        .get(`/api/v1/campaigns/${listCampId}/encounters`)
        .query({ status: 'preparing' })
        .set(dm);
      expect(preparing.status).toBe(200);
      expect(preparing.body.every((e: { status: string }) => e.status === 'preparing')).toBe(true);
      expect(preparing.body.some((e: { id: number }) => e.id === preparingId)).toBe(true);
      expect(preparing.body.some((e: { id: number }) => e.id === runningId)).toBe(false);
    });

    it('searches by name substring', async () => {
      const server = ctx.app.getHttpServer();
      const search = await request(server)
        .get(`/api/v1/campaigns/${listCampId}/encounters`)
        .query({ q: 'goblin' })
        .set(dm);
      expect(search.status).toBe(200);
      expect(search.body).toHaveLength(1);
      expect(search.body[0].id).toBe(endedGoblinId);
      expect(search.body[0].name).toBe('Goblin Skirmish');
    });

    it('rejects an invalid status filter', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .get(`/api/v1/campaigns/${listCampId}/encounters`)
        .query({ status: 'bogus' })
        .set(dm);
      expect(res.status).toBe(400);
    });
  });

  describe('starting hidden encounter and reveal SSE lifecycle (issue #1475)', () => {
    it('starting a hidden encounter returns status running with warning and evaluates post-start visibility', async () => {
      const server = ctx.app.getHttpServer();
      const eventsService = ctx.app.get(CampaignEventsService);
      const emittedEvents: any[] = [];
      const sub = eventsService.streamFor(campaignId).subscribe((evt) => emittedEvents.push(evt));

      // Create a hidden encounter with party character
      const enc = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Secret Hidden Trap', hidden: true });
      expect(enc.status).toBe(201);
      const hiddenEncId = enc.body.id;

      // Roll initiative so start is permitted
      await request(server)
        .post(`/api/v1/encounters/${hiddenEncId}/roll-initiative`)
        .set(dm);

      // Start hidden encounter
      const startRes = await request(server)
        .post(`/api/v1/encounters/${hiddenEncId}/start`)
        .set(dm);

      expect(startRes.status).toBe(201);
      expect(startRes.body.status).toBe('running');
      expect(startRes.body.hidden).toBe(true);

      // Player GET should be 404 secrecy check
      const playerReadBefore = await request(server)
        .get(`/api/v1/encounters/${hiddenEncId}`)
        .set(player);
      expect(playerReadBefore.status).toBe(404);

      // Verify no SSE event was emitted on stream for hidden start
      const hiddenStartEvents = emittedEvents.filter((e) => e.encounterId === hiddenEncId);
      expect(hiddenStartEvents).toHaveLength(0);

      // Now DM reveals the encounter (hidden -> false)
      const revealRes = await request(server)
        .patch(`/api/v1/encounters/${hiddenEncId}`)
        .set(dm)
        .send({ hidden: false });
      expect(revealRes.status).toBe(200);
      expect(revealRes.body.hidden).toBe(false);

      // Verify SSE event was emitted after reveal
      const revealEvents = emittedEvents.filter((e) => e.encounterId === hiddenEncId && e.type === 'encounter.updated');
      expect(revealEvents.length).toBeGreaterThan(0);

      // Player can now read the running encounter
      const playerReadAfter = await request(server)
        .get(`/api/v1/encounters/${hiddenEncId}`)
        .set(player);
      expect(playerReadAfter.status).toBe(200);
      expect(playerReadAfter.body.status).toBe('running');

      sub.unsubscribe();
    });
  });
});

describe('encounters — issue #487: player end-turn + ready/delay (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Issue 487 Campaign' });
    campaignId = campRes.body.id;
    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Aria', stats: { DEX: 16 }, hpCurrent: 20, hpMax: 20, ownerUserId: 'dev:p-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function seedRunningFight(): Promise<{ encounterId: number; ariaId: number; monsterId: number }> {
    const server = ctx.app.getHttpServer();
    const running = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/encounters`)
      .query({ status: 'running' })
      .set(dm);
    for (const e of running.body as Array<{ id: number }>) {
      await request(server).post(`/api/v1/encounters/${e.id}/end`).set(dm);
    }

    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Player Turn Drill', hidden: false });
    const encounterId = res.body.id as number;
    const ariaId = (res.body.combatants as Array<{ id: number }>)[0].id;
    const monster = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Goblin', hpMax: 7, initMod: -1 });
    const monsterId = monster.body.id as number;
    await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${ariaId}`)
      .set(dm)
      .send({ initiative: 20 });
    await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterId}`)
      .set(dm)
      .send({ initiative: 5 });
    await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    expect((await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm)).body.status).toBe('running');
    return { encounterId, ariaId, monsterId };
  }

  it('player may set delay and readied on their own turn via turn-state', async () => {
    const { encounterId, ariaId } = await seedRunningFight();
    const server = ctx.app.getHttpServer();

    const delayed = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants/${ariaId}/turn-state`)
      .set(player)
      .send({ delaying: true });
    expect(delayed.status).toBe(201);
    expect(delayed.body.turnState.delaying).toBe(true);

    const readied = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants/${ariaId}/turn-state`)
      .set(player)
      .send({ readied: 'When the door opens' });
    expect(readied.status).toBe(201);
    expect(readied.body.turnState.readied).toBe('When the door opens');
  });

  it('player POST /end-turn advances when it is their turn', async () => {
    const { encounterId, ariaId, monsterId } = await seedRunningFight();
    const server = ctx.app.getHttpServer();

    const before = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(before.body.currentCombatantId).toBe(ariaId);

    const res = await request(server)
      .post(`/api/v1/encounters/${encounterId}/end-turn`)
      .set(player)
      .send({ expectedCurrentCombatantId: ariaId });
    expect(res.status).toBe(201);
    expect(res.body.currentCombatantId).toBe(monsterId);
  });

  it('player POST /end-turn is forbidden when it is not their turn', async () => {
    const { encounterId, ariaId } = await seedRunningFight();
    const server = ctx.app.getHttpServer();
    await request(server)
      .post(`/api/v1/encounters/${encounterId}/end-turn`)
      .set(player)
      .send({ expectedCurrentCombatantId: ariaId });

    const res = await request(server).post(`/api/v1/encounters/${encounterId}/end-turn`).set(player).send({});
    expect(res.status).toBe(403);
  });

  it('DM POST /next-turn still advances (override)', async () => {
    const { encounterId } = await seedRunningFight();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('running');
  });

  describe('encounters — issue #1459: turn-lifecycle correctness (e2e)', () => {
    it('first combatant executes turn-start triggers; removing lair pointer does not wrap round; deathState is not clobbered', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      
      const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: '1459 Test Campaign' });
      const campId = campaign.body.id;
      
      const encounter = await request(server).post(`/api/v1/campaigns/${campId}/encounters`).set(dm).send({ name: '1459 Test' });
      const encounterId = encounter.body.id;
      
      const target = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Target', hpMax: 20 });
      const other = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', name: 'Other', hpMax: 20 });
      const targetId = target.body.id;
      const otherId = other.body.id;
      
      await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`).set(dm).send({ initiative: 20 });
      await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${otherId}`).set(dm).send({ initiative: 10 });
      
      // 1. Setup turn-start condition on target (who will go first)
      await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${targetId}`).set(dm).send({
        conditionInstances: [{ id: 'cond-1', name: 'Stunned', timing: 'start-of-turn', roundsRemaining: 1, stacks: 1, custom: true }],
      });
      
      // START the encounter
      await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
      
      // Verify turn-start triggered and condition ticked/expired
      let state = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const targetState = state.body.combatants.find((c: any) => c.id === targetId);
      expect(targetState.conditionInstances.find((ci: any) => ci.name === 'Stunned')).toBeUndefined();
      
      // 2. Verify removing lair pointer does not wrap round
      await db.update(encountersTable).set({ turnPhase: 'lair', currentCombatantId: null, lairResumeCombatantId: targetId }).where(eq(encountersTable.id, encounterId));
      await request(server).delete(`/api/v1/encounters/${encounterId}/combatants/${targetId}`).set(dm);
      
      state = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      expect(state.body.round).toBe(1);
      
      // 3. Verify deathState is not clobbered
      await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${otherId}`).set(dm).send({
        hpDelta: -20,
        deathState: 'stable',
      });
      state = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const otherState = state.body.combatants.find((c: any) => c.id === otherId);
      expect(otherState.hpCurrent).toBe(0);
      expect(otherState.deathState).toBe('stable');
    });
  });
});
