import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

import { DB, type DrizzleDb } from '../src/db/db.module';
import { rulePacks } from '../src/db/schema';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };

describe('encounter turn loop (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;
  let playerCombatantId: number;
  let monsterCombatantId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = new Date().toISOString();

    await db
      .insert(rulePacks)
      .values({ slug: 'archmage-srd', name: 'Archmage SRD', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 0 })
      .onConflictDoNothing();

    const campRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Turn Loop Campaign', ruleSystem: 'archmage-srd' });
    campaignId = campRes.body.id;

    await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Hero', hpCurrent: 20, hpMax: 20, ownerUserId: 'dev:p-1' });

    const encRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'The Loop Fight', hidden: false });
    encounterId = encRes.body.id;
    playerCombatantId = encRes.body.combatants[0].id;

    const monRes = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Goblin', hpMax: 10, initMod: 2 });
    monsterCombatantId = monRes.body.id;

    // set initiatives so we know the order
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${playerCombatantId}`).set(dm).send({ initiative: 15 });
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${monsterCombatantId}`).set(dm).send({ initiative: 10 });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('player attempting DM-only actions gets 403', async () => {
    const server = ctx.app.getHttpServer();

    let res = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(player);
    expect(res.status).toBe(403);

    res = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(player);
    expect(res.status).toBe(403);

    res = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(player).send({ kind: 'monster', name: 'Ogre', hpMax: 50 });
    expect(res.status).toBe(403);
    
    res = await request(server).post(`/api/v1/encounters/${encounterId}/end`).set(player);
    expect(res.status).toBe(403);
  });

  it('multi-turn loop cycles combatants and increments round', async () => {
    const server = ctx.app.getHttpServer();
    
    // Encounter must be started by DM
    const startRes = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    expect(startRes.status).toBe(201);
    expect(startRes.body.round).toBe(1);
    expect(startRes.body.turnIndex).toBe(0);
    // initiative 15 vs 10 => player goes first
    expect(startRes.body.combatants[0].id).toBe(playerCombatantId);

    // turn index 0 => 1
    let nextRes = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm);
    expect(nextRes.status).toBe(201);
    expect(nextRes.body.round).toBe(1);
    expect(nextRes.body.turnIndex).toBe(1);

    // turn index 1 => round 2, turn 0
    nextRes = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm);
    expect(nextRes.status).toBe(201);
    expect(nextRes.body.round).toBe(2);
    expect(nextRes.body.turnIndex).toBe(0);
  });

  it('condition duration ticking', async () => {
    const server = ctx.app.getHttpServer();
    
    // At this point we are round 2, turn 0 (player's turn)
    const addCondRes = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${playerCombatantId}`)
      .set(dm)
      .send({
        addConditionInstance: {
          id: 'prone-instance',
          name: 'Prone',
          durationRounds: 2,
          roundsRemaining: 2,
          timing: 'end-of-turn'
        }
      });
    expect(addCondRes.status).toBe(200);
    let playerComb = addCondRes.body;
    let cond = playerComb.conditionInstances.find((c: any) => c.id === 'prone-instance');
    expect(cond.roundsRemaining).toBe(2);

    // Advance turn (player's turn ends)
    await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm);
    
    const getRes = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    playerComb = getRes.body.combatants.find((c: any) => c.id === playerCombatantId);
    cond = playerComb.conditionInstances.find((c: any) => c.id === 'prone-instance');
    expect(cond.roundsRemaining).toBe(1);
  });

  it('escalation die test', async () => {
    const server = ctx.app.getHttpServer();
    
    // The escalation die starts at 0, and increments by 1 each round (up to 6) in 13th age
    // We can also POST to /escalation to override it
    
    const escRes = await request(server).post(`/api/v1/encounters/${encounterId}/escalation`).set(dm).send({ override: 3 });
    expect(escRes.status).toBe(201);
    expect(escRes.body.escalationDie).toBe(3);
  });

  it('operating on ended encounter gets 409', async () => {
    const server = ctx.app.getHttpServer();
    
    const endRes = await request(server).post(`/api/v1/encounters/${encounterId}/end`).set(dm);
    expect(endRes.status).toBe(201);
    
    // Try to start again
    const startRes = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    expect(startRes.status).toBe(400);
    
    // Try to advance turn
    const nextRes = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm);
    expect(nextRes.status).toBe(409);
  });
});
