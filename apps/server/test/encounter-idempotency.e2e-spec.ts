/**
 * Mutation-retry idempotency for encounters (issue #580) — fault-injection suite.
 *
 * The bug this guards is specifically the COMMITTED-THEN-LOST case: the server applied the
 * damage (or advanced the turn) and then the response never reached the client, so the
 * client's automatic retry re-sent the same non-idempotent write. A test that merely calls
 * the endpoint twice does not reproduce that — it proves dedup, but not that dedup holds
 * when the first attempt looked like a failure to everyone involved.
 *
 * So these tests inject the fault at the transport, not at the call site: an Express
 * middleware installed ahead of the Nest router lets the handler run to completion (the
 * better-sqlite3 transaction commits) and then destroys the socket, or rewrites the
 * response into a 502/504. The client genuinely observes a network error / gateway error
 * and genuinely does not know the outcome — which is the whole reason it retries.
 */
import fs from 'node:fs';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import {
  combatants as combatantsTable,
  encounters as encountersTable,
  encounterEvents as encounterEventsTable,
  encounterOpIdempotency,
} from '../src/db/schema';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const dm2 = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-2' };

/**
 * Fault injection, installed in front of the Nest router. `x-fault-inject` on a request
 * decides what happens to its RESPONSE — never to its handler, which always runs and
 * always commits. That asymmetry is the point: the damage lands, the client is told
 * nothing (or told 502), and the retry that follows is the dangerous one.
 */
type FaultRes = {
  end: (...args: unknown[]) => unknown;
  write: (...args: unknown[]) => unknown;
  socket?: { destroy: () => void };
  statusCode: number;
  removeHeader: (name: string) => void;
};

function faultInjectionMiddleware(req: unknown, res: unknown, next: () => void): void {
  const headers = (req as { headers: Record<string, string | undefined> }).headers;
  const mode = headers['x-fault-inject'];
  if (!mode) {
    next();
    return;
  }
  const r = res as FaultRes;
  const origEnd = r.end.bind(r);
  // Swallow the body write; the response is decided entirely in `end` below.
  r.write = () => true;
  if (mode === 'drop-response') {
    // The commit happened; the bytes never leave. Destroying the socket is what a flaky
    // hotel AP does to a request mid-flight, and produces a real ECONNRESET client-side.
    r.end = () => {
      r.socket?.destroy();
      return r;
    };
  } else {
    const status = mode === 'gateway-504' ? 504 : 502;
    r.end = () => {
      r.statusCode = status;
      // Express already sized the (now discarded) JSON body; let the replacement be chunked.
      r.removeHeader('Content-Length');
      r.removeHeader('ETag');
      return origEnd(JSON.stringify({ message: 'gateway error' }));
    };
  }
  next();
}

/**
 * Await a request that is EXPECTED to fail at the transport, returning the error. A
 * resolved response here would mean the fault never fired and the test below would be
 * proving nothing, so that case throws loudly rather than passing quietly.
 */
async function expectTransportFailure(pending: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await pending;
  } catch (err) {
    const e = err as { message?: string; code?: string };
    return { message: e.message ?? '', code: e.code };
  }
  throw new Error('expected the request to fail at the transport, but it resolved');
}

describe('encounter mutation idempotency (e2e, issue #580)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;
  let heroId: number;
  let goblinId: number;

  const server = () => ctx.app.getHttpServer();
  const db = () => ctx.app.get<DrizzleDb>(DB);

  /** Fresh running encounter with two combatants, initiative rolled, per test. */
  async function freshRunningEncounter(): Promise<void> {
    // Only one encounter may be running per campaign — retire the previous test's.
    if (encounterId) await request(server()).post(`/api/v1/encounters/${encounterId}/end`).set(dm).send({});
    const encRes = await request(server())
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Retry Test', hidden: false });
    expect(encRes.status).toBe(201);
    encounterId = encRes.body.id;
    heroId = encRes.body.combatants[0].id;

    const gobRes = await request(server())
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ name: 'Goblin', kind: 'monster', hpMax: 30 });
    expect(gobRes.status).toBe(201);
    goblinId = gobRes.body.id;

    // Deterministic order: hero acts first (20), goblin second (1).
    await request(server()).patch(`/api/v1/encounters/${encounterId}/combatants/${heroId}`).set(dm).send({ initiative: 20 });
    await request(server()).patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`).set(dm).send({ initiative: 1 });
    const started = await request(server()).post(`/api/v1/encounters/${encounterId}/start`).set(dm).send({});
    expect(started.status).toBe(201);
  }

  async function hpOf(combatantId: number): Promise<number> {
    const [row] = await db().select().from(combatantsTable).where(eq(combatantsTable.id, combatantId)).limit(1);
    return row.hpCurrent;
  }

  async function encounterRow() {
    const [row] = await db().select().from(encountersTable).where(eq(encountersTable.id, encounterId)).limit(1);
    return row;
  }

  /** Combat-log events of a type carrying a given operation id (issue #580 audit trail). */
  async function eventsForOperation(type: string, operationId: string) {
    const rows = await db().select().from(encounterEventsTable).where(eq(encounterEventsTable.encounterId, encounterId));
    return rows.filter((r) => r.type === type && (r.metadataJson ?? '').includes(operationId));
  }

  beforeAll(async () => {
    ctx = await createTestApp({ middleware: [faultInjectionMiddleware] });
    const campRes = await request(server()).post('/api/v1/campaigns').set(dm).send({ name: 'Retry Campaign' });
    campaignId = campRes.body.id;
    const charRes = await request(server())
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Hero', stats: { DEX: 14 }, hpCurrent: 20, hpMax: 20 });
    expect(charRes.status).toBe(201);
    // Second DM on the same campaign, for the simultaneous-DM race.
    await request(server()).post(`/api/v1/campaigns/${campaignId}/members`).set(dm).send({ userId: 'dev:dm-2', role: 'dm' });
  });

  beforeEach(async () => {
    await freshRunningEncounter();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // -------------------------------------------------------------------------
  // The headline case: the server committed, the response was lost, the client
  // retried. Without idempotency this deals the damage twice.
  // -------------------------------------------------------------------------

  it('HP delta: a lost response after commit does not double-damage on retry, and replays the original body', async () => {
    const key = 'op-hp-lost-response';
    const patch = { hpDelta: -5, idempotencyKey: key };

    const failure = await expectTransportFailure(
      request(server())
        .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
        .set(dm)
        .set('x-fault-inject', 'drop-response')
        .send(patch),
    );
    // The client saw a transport error, not a status code — it cannot know the outcome.
    // (ECONNRESET / "socket hang up", depending on where the destroy lands.)
    expect(`${failure.code ?? ''} ${failure.message}`).toMatch(/ECONNRESET|socket hang up|aborted/i);

    // …but the server committed.
    expect(await hpOf(goblinId)).toBe(25);

    // The automatic retry (same key — minted once for the click, not per attempt).
    const retry = await request(server())
      .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
      .set(dm)
      .send(patch);
    expect(retry.status).toBe(200);
    // Replayed ORIGINAL response: the committed HP, so the client can reconcile without
    // guessing. A bare 200/409 would leave it exactly as ignorant as before it retried.
    expect(retry.body.hpCurrent).toBe(25);
    expect(await hpOf(goblinId)).toBe(25);

    // And the combat log records ONE damage event for the operation, not two.
    expect(await eventsForOperation('damage', key)).toHaveLength(1);
  });

  it('HP delta: a 502 after commit does not double-damage on retry', async () => {
    const key = 'op-hp-502';
    const patch = { hpDelta: -7, idempotencyKey: key };

    const bad = await request(server())
      .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
      .set(dm)
      .set('x-fault-inject', 'gateway-502')
      .send(patch);
    expect(bad.status).toBe(502);
    expect(await hpOf(goblinId)).toBe(23);

    const retry = await request(server()).patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`).set(dm).send(patch);
    expect(retry.status).toBe(200);
    expect(retry.body.hpCurrent).toBe(23);
    expect(await hpOf(goblinId)).toBe(23);
  });

  it('HP delta: a 504 after commit does not double-damage on retry', async () => {
    const key = 'op-hp-504';
    const patch = { hpDelta: -4, idempotencyKey: key };

    const bad = await request(server())
      .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
      .set(dm)
      .set('x-fault-inject', 'gateway-504')
      .send(patch);
    expect(bad.status).toBe(504);
    expect(await hpOf(goblinId)).toBe(26);

    const retry = await request(server()).patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`).set(dm).send(patch);
    expect(retry.status).toBe(200);
    expect(await hpOf(goblinId)).toBe(26);
  });

  it('without a key the same retry DOES double-apply — the key is what does the work', async () => {
    // Not a defect being enshrined: it is the control that proves the tests above are
    // measuring idempotency rather than some incidental server behavior.
    const patch = { hpDelta: -5 };
    await expectTransportFailure(
      request(server())
        .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
        .set(dm)
        .set('x-fault-inject', 'drop-response')
        .send(patch),
    );
    expect(await hpOf(goblinId)).toBe(25);
    await request(server()).patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`).set(dm).send(patch);
    expect(await hpOf(goblinId)).toBe(20);
  });

  // -------------------------------------------------------------------------
  // Turn advancement — the same lost-response case, plus the genuine cross-device
  // race that idempotency alone cannot fix.
  // -------------------------------------------------------------------------

  it('next-turn: a lost response after commit advances exactly once and replays the original turn pointer', async () => {
    const before = await encounterRow();
    expect(before.currentCombatantId).toBe(heroId);
    const key = 'op-turn-lost-response';
    const body = { idempotencyKey: key, expectedCurrentCombatantId: heroId };

    await expectTransportFailure(
      request(server()).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm).set('x-fault-inject', 'drop-response').send(body),
    );

    // Committed: the turn moved to the goblin.
    const afterCommit = await encounterRow();
    expect(afterCommit.currentCombatantId).toBe(goblinId);
    expect(afterCommit.turnIndex).toBe(1);
    expect(afterCommit.round).toBe(1);

    const retry = await request(server()).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm).send(body);
    expect(retry.status).toBe(201);
    // The retry gets the turn THIS operation produced — not a second advance, and not a
    // bare acknowledgement it cannot act on.
    expect(retry.body.currentCombatantId).toBe(goblinId);
    expect(retry.body.turnIndex).toBe(1);
    expect(retry.body.round).toBe(1);

    const afterRetry = await encounterRow();
    expect(afterRetry.currentCombatantId).toBe(goblinId);
    expect(afterRetry.round).toBe(1);

    // One turn marker for the operation, not two.
    expect(await eventsForOperation('turn', key)).toHaveLength(1);
  });

  it('next-turn: a 502 after commit does not advance twice on retry', async () => {
    const key = 'op-turn-502';
    const body = { idempotencyKey: key, expectedCurrentCombatantId: heroId };
    const bad = await request(server())
      .post(`/api/v1/encounters/${encounterId}/next-turn`)
      .set(dm)
      .set('x-fault-inject', 'gateway-502')
      .send(body);
    expect(bad.status).toBe(502);
    expect((await encounterRow()).currentCombatantId).toBe(goblinId);

    const retry = await request(server()).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm).send(body);
    expect(retry.status).toBe(201);
    expect((await encounterRow()).currentCombatantId).toBe(goblinId);
    expect((await encounterRow()).round).toBe(1);
  });

  it('simultaneous DMs: two DISTINCT intents racing produce one advance and one 409 (CAS, not dedup)', async () => {
    // Distinct keys — this is not a retry, it is two humans tapping "next turn" on two
    // devices at the same moment. Idempotency cannot help (nothing is duplicated); the
    // compare-and-swap on the live turn pointer is what stops the double advance.
    const [a, b] = await Promise.all([
      request(server())
        .post(`/api/v1/encounters/${encounterId}/next-turn`)
        .set(dm)
        .send({ idempotencyKey: 'dm1-advance', expectedCurrentCombatantId: heroId }),
      request(server())
        .post(`/api/v1/encounters/${encounterId}/next-turn`)
        .set(dm2)
        .send({ idempotencyKey: 'dm2-advance', expectedCurrentCombatantId: heroId }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const conflict = a.status === 409 ? a : b;
    expect(conflict.body.code ?? conflict.body.message?.code).toBe('TURN_ALREADY_ADVANCED');

    // Exactly ONE advance: still round 1, goblin's turn — not round 2 back on the hero.
    const row = await encounterRow();
    expect(row.currentCombatantId).toBe(goblinId);
    expect(row.round).toBe(1);
    expect(row.turnIndex).toBe(1);
  });

  it('two DMs may use the same key string — keys are scoped by actor', async () => {
    // dm-1 and dm-2 both mint "advance-1" locally. These are different intents by
    // different people and must both be honored; a globally-keyed table would swallow
    // the second as a bogus replay.
    const first = await request(server())
      .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
      .set(dm)
      .send({ hpDelta: -3, idempotencyKey: 'shared-key' });
    expect(first.status).toBe(200);
    expect(first.body.hpCurrent).toBe(27);

    const second = await request(server())
      .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
      .set(dm2)
      .send({ hpDelta: -3, idempotencyKey: 'shared-key' });
    expect(second.status).toBe(200);
    expect(second.body.hpCurrent).toBe(24);
  });

  it('reusing one key for a DIFFERENT payload is a 409, not a silent replay', async () => {
    const first = await request(server())
      .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
      .set(dm)
      .send({ hpDelta: -2, idempotencyKey: 'reused-key' });
    expect(first.status).toBe(200);

    const reuse = await request(server())
      .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
      .set(dm)
      .send({ hpDelta: -9, idempotencyKey: 'reused-key' });
    expect(reuse.status).toBe(409);
    expect(reuse.body.code ?? reuse.body.message?.code).toBe('IDEMPOTENCY_KEY_REUSE');
    // The second, different damage was NOT applied.
    expect(await hpOf(goblinId)).toBe(28);
  });

  it('a key minted for one encounter cannot be replayed against another', async () => {
    const applied = await request(server())
      .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
      .set(dm)
      .send({ hpDelta: -6, idempotencyKey: 'cross-encounter' });
    expect(applied.status).toBe(200);

    // A second encounter, same campaign, same actor, same key.
    const otherEnc = await request(server())
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Other', hidden: false });
    const otherGoblin = await request(server())
      .post(`/api/v1/encounters/${otherEnc.body.id}/combatants`)
      .set(dm)
      .send({ name: 'Other Goblin', kind: 'monster', hpMax: 30 });

    const crossed = await request(server())
      .patch(`/api/v1/encounters/${otherEnc.body.id}/combatants/${otherGoblin.body.id}`)
      .set(dm)
      .send({ hpDelta: -6, idempotencyKey: 'cross-encounter' });
    expect(crossed.status).toBe(409);
    expect(crossed.body.code ?? crossed.body.message?.code).toBe('IDEMPOTENCY_KEY_REUSE');
    expect(await hpOf(otherGoblin.body.id)).toBe(30);
  });

  // -------------------------------------------------------------------------
  // Durability of the guarantee: it has to survive a device sleeping and a server
  // restarting, which is exactly what an in-memory dedup map cannot do.
  // -------------------------------------------------------------------------

  it('sleep/resume: a retry hours later (inside the replay window) still replays rather than re-applying', async () => {
    const key = 'op-sleep-resume';
    const patch = { hpDelta: -8, idempotencyKey: key };
    await expectTransportFailure(
      request(server())
        .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
        .set(dm)
        .set('x-fault-inject', 'drop-response')
        .send(patch),
    );
    expect(await hpOf(goblinId)).toBe(22);

    // Simulate the tablet sleeping for five hours by aging the record — inside the
    // six-hour window, which is chosen for exactly this scenario rather than for the
    // seconds-scale HTTP retry.
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await db()
      .update(encounterOpIdempotency)
      .set({ createdAt: fiveHoursAgo })
      .where(and(eq(encounterOpIdempotency.key, key), eq(encounterOpIdempotency.actorId, 'dev:dm-1')));

    const retry = await request(server()).patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`).set(dm).send(patch);
    expect(retry.status).toBe(200);
    expect(retry.body.hpCurrent).toBe(22);
    expect(await hpOf(goblinId)).toBe(22);
  });

  it('retention is bounded: records past the replay window are pruned on the next keyed write', async () => {
    await request(server())
      .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
      .set(dm)
      .send({ hpDelta: -1, idempotencyKey: 'op-expiring' });

    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    await db()
      .update(encounterOpIdempotency)
      .set({ createdAt: sevenHoursAgo })
      .where(eq(encounterOpIdempotency.key, 'op-expiring'));

    // Any subsequent keyed write prunes.
    await request(server())
      .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
      .set(dm)
      .send({ hpDelta: -1, idempotencyKey: 'op-pruner' });

    const survivors = await db().select().from(encounterOpIdempotency).where(eq(encounterOpIdempotency.key, 'op-expiring'));
    expect(survivors).toHaveLength(0);
    // The pruner itself is still replayable — pruning is by age, not wholesale.
    const fresh = await db().select().from(encounterOpIdempotency).where(eq(encounterOpIdempotency.key, 'op-pruner'));
    expect(fresh).toHaveLength(1);
  });

  it('server restart: the guarantee survives a process restart (the record is persisted, not in-memory)', async () => {
    const key = 'op-restart';
    const patch = { hpDelta: -10, idempotencyKey: key };
    await expectTransportFailure(
      request(server())
        .patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`)
        .set(dm)
        .set('x-fault-inject', 'drop-response')
        .send(patch),
    );
    expect(await hpOf(goblinId)).toBe(20);

    // Restart against the SAME data dir — a client whose queued retry survives an app
    // restart (or a DM who reloads after the server redeploys) must not double-apply.
    const dataDir = ctx.dataDir;
    await ctx.app.close();
    ctx = await createTestApp({ dataDir, middleware: [faultInjectionMiddleware] });

    const retry = await request(server()).patch(`/api/v1/encounters/${encounterId}/combatants/${goblinId}`).set(dm).send(patch);
    expect(retry.status).toBe(200);
    expect(retry.body.hpCurrent).toBe(20);
    expect(await hpOf(goblinId)).toBe(20);
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  it('end-turn keeps its CAS while gaining retry protection', async () => {
    const key = 'op-end-turn';
    const body = { idempotencyKey: key, expectedCurrentCombatantId: heroId };
    await expectTransportFailure(
      request(server()).post(`/api/v1/encounters/${encounterId}/end-turn`).set(dm).set('x-fault-inject', 'drop-response').send(body),
    );
    expect((await encounterRow()).currentCombatantId).toBe(goblinId);

    // Retry of the same intent: replayed.
    const retry = await request(server()).post(`/api/v1/encounters/${encounterId}/end-turn`).set(dm).send(body);
    expect(retry.status).toBe(201);
    expect(retry.body.currentCombatantId).toBe(goblinId);
    expect((await encounterRow()).currentCombatantId).toBe(goblinId);

    // A NEW intent still carrying the stale expectation is a genuine conflict, not a replay.
    const stale = await request(server())
      .post(`/api/v1/encounters/${encounterId}/end-turn`)
      .set(dm)
      .send({ idempotencyKey: 'op-end-turn-stale', expectedCurrentCombatantId: heroId });
    expect(stale.status).toBe(409);
    expect(stale.body.code ?? stale.body.message?.code).toBe('TURN_ALREADY_ADVANCED');
  });

  it('end-turn WITHOUT an explicit expectation still replays (the fingerprint tracks the request, not the resolved default)', async () => {
    // Regression guard: end-turn defaults an omitted expectedCurrentCombatantId to the
    // live current combatant. On the retry of an already-committed advance that default
    // resolves to a DIFFERENT combatant, so fingerprinting the resolved value would make
    // the retry look like a new intent and 409 as key reuse — the one case that must replay.
    const key = 'op-end-turn-no-expectation';
    await expectTransportFailure(
      request(server())
        .post(`/api/v1/encounters/${encounterId}/end-turn`)
        .set(dm)
        .set('x-fault-inject', 'drop-response')
        .send({ idempotencyKey: key }),
    );
    expect((await encounterRow()).currentCombatantId).toBe(goblinId);

    const retry = await request(server()).post(`/api/v1/encounters/${encounterId}/end-turn`).set(dm).send({ idempotencyKey: key });
    expect(retry.status).toBe(201);
    expect(retry.body.currentCombatantId).toBe(goblinId);
    expect((await encounterRow()).round).toBe(1);
  });

  it('bodyless next-turn still works (unprotected legacy/MCP path is unchanged)', async () => {
    const res = await request(server()).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm).send();
    expect(res.status).toBe(201);
    expect(res.body.currentCombatantId).toBe(goblinId);
  });
});
