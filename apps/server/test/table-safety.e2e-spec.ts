import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { auditLog, sessionZero as sessionZeroTable } from '../src/db/schema';
import { CampaignEventsService } from '../src/modules/events/campaign-events.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import type { CampaignEvent } from '@campfire/schema';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'safety-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'safety-player' };
const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'safety-player-2' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'safety-viewer' };

/**
 * Issue #599 — the table safety hold (X-Card).
 *
 * The two acceptance criteria everything else bends around get their own tests and are
 * asserted from the OUTSIDE, over HTTP, in the shape a panicking participant actually hits:
 * a viewer with no character, sending a body with no reason, getting a 200.
 */
describe('table safety hold / X-Card (#599)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let db: DrizzleDb;

  const newCampaign = async (name: string): Promise<number> => {
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name });
    expect(res.status).toBe(201);
    return res.body.id as number;
  };

  /** A one-combatant encounter, started and running, ready to have its turn advanced. */
  const runningEncounter = async (campaignId: number): Promise<number> => {
    const enc = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Ambush' });
    const encounterId = enc.body.id as number;
    await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ name: 'Goblin', kind: 'monster', hpMax: 7 });
    await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ name: 'Bandit', kind: 'monster', hpMax: 9 });
    await request(server).post(`/api/v1/encounters/${encounterId}/roll-initiative`).set(dm);
    const started = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm);
    expect(started.status).toBe(201);
    return encounterId;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    db = ctx.app.get<DrizzleDb>(DB);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // -------------------------------------------------------------------------
  // The two non-negotiable acceptance criteria.
  // -------------------------------------------------------------------------

  it('any seated participant can activate — a VIEWER, with no reason, with no vote', async () => {
    const campaignId = await newCampaign('Viewer X-Card');

    // A viewer: the weakest role in the system, no character, no write permission anywhere
    // else in the app. If this 403s, the mechanism has failed the person most likely to need it.
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(viewer).send({});
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);

    // No vote was opened, and none is required: the hold is in effect on the FIRST request.
    const state = await request(server).get(`/api/v1/campaigns/${campaignId}/safety`).set(player);
    expect(state.body.active).toBe(true);
  });

  it('rejects any attempt to attach a reason — the schema has no field for one', async () => {
    const campaignId = await newCampaign('No Reason');
    // `.strict()` on the request schema. A reason field is not merely ignored, it is refused,
    // so no client can grow a "why did you stop us" prompt against this endpoint by accident.
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/safety/hold`)
      .set(player)
      .send({ anonymous: true, reason: 'it was upsetting' });
    expect(res.status).toBe(400);
  });

  it('is idempotent: a second activation succeeds, does not double-count, and does not move the timestamp', async () => {
    const campaignId = await newCampaign('Idempotent');
    const first = await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(player).send({});
    expect(first.status).toBe(200);
    const firstAt = first.body.activatedAt as string;
    expect(firstAt).toBeTruthy();

    const second = await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(otherPlayer).send({});
    expect(second.status).toBe(200);
    expect(second.body.active).toBe(true);
    // A second tap during a live hold must not make the stop look newer than it is.
    expect(second.body.activatedAt).toBe(firstAt);
    expect(second.body.activationCount).toBe(1);
  });

  it('two simultaneous activations both succeed and the table pauses once', async () => {
    const campaignId = await newCampaign('Race');
    const [a, b] = await Promise.all([
      request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(player).send({}),
      request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(otherPlayer).send({}),
    ]);
    // Neither loses. The whole point of the idempotent upsert is that there is no loser to
    // hand a 409 to at the exact moment two people independently decided to stop the table.
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const state = await request(server).get(`/api/v1/campaigns/${campaignId}/safety`).set(dm);
    expect(state.body.active).toBe(true);
    expect(state.body.activationCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Anonymity, and the back doors around it.
  // -------------------------------------------------------------------------

  it('an anonymous hold stores no name, audits under a synthetic actor, and carries no correlation id', async () => {
    const campaignId = await newCampaign('Anonymous');
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(player).send({});
    expect(res.status).toBe(200);
    expect(res.body.anonymous).toBe(true);
    expect(res.body.activatedByName).toBeNull();

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.campaignId, campaignId), eq(auditLog.action, 'safety.hold.activated')));
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('table-safety:anonymous');
    expect(rows[0].detail).not.toContain('safety-player');
    // requestId is a DM-QUERYABLE filter on the audit list. Leaving it on an "anonymous" row
    // means the row is one join away from being attributed the moment anything else is ever
    // written under the same request.
    expect(rows[0].requestId).toBeNull();
  });

  it('notifies every member while retaining only attributed actor ids', async () => {
    const campaignId = await newCampaign('Notify All');
    const notifications = ctx.app.get(NotificationsService);
    const anonymousSpy = jest.spyOn(notifications, 'notifyCampaign');
    const attributedSpy = jest.spyOn(notifications, 'notifyCampaignIncludingActor');
    try {
      await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(player).send({});
      const call = anonymousSpy.mock.calls.find(
        (c) => c[0] === campaignId && (c[2] as { type?: string })?.type === 'safety_hold',
      );
      expect(call).toBeDefined();
      // THE ASSERTION THAT MATTERS. `notifyCampaign` EXCLUDES its actor from the recipient
      // list — correct for "Ana updated the quest", catastrophic here: the one member with no
      // ping would be the member who raised the hold. Attribution by conspicuous absence,
      // computed by the table over lunch. Anonymous holds pass null and retain no id at all.
      expect(call?.[1]).toBeNull();
      expect(call?.[2]).toMatchObject({ type: 'safety_hold' });

      const attributed = await newCampaign('Notify All Attributed');
      attributedSpy.mockClear();
      await request(server)
        .post(`/api/v1/campaigns/${attributed}/safety/hold`)
        .set(player)
        .send({ anonymous: false });
      const attributedCall = attributedSpy.mock.calls.find(
        (c) => c[0] === attributed && (c[2] as { type?: string })?.type === 'safety_hold',
      );
      expect(attributedCall).toBeDefined();
      expect(attributedCall?.[1]).toBe('dev:safety-player');
      expect(attributedCall?.[3]).toEqual({ bypassBlockFilter: true });
    } finally {
      anonymousSpy.mockRestore();
      attributedSpy.mockRestore();
    }
  });

  it('an attributed hold records the name the participant chose to attach', async () => {
    const campaignId = await newCampaign('Attributed');
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/safety/hold`)
      .set(player)
      .send({ anonymous: false });
    expect(res.status).toBe(200);
    expect(res.body.anonymous).toBe(false);
    expect(res.body.activatedByName).toBeTruthy();
  });

  it('the broadcast frame carries `active` and nothing else', async () => {
    const campaignId = await newCampaign('Broadcast');
    const events = ctx.app.get(CampaignEventsService);
    const seen: CampaignEvent[] = [];
    const sub = events.streamFor(campaignId).subscribe((e) => seen.push(e));
    await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(player).send({ anonymous: false });
    sub.unsubscribe();

    const frame = seen.find((e) => e.type === 'safety.hold');
    expect(frame).toBeDefined();
    // Even for an ATTRIBUTED hold the frame is actor-free, so the two cases are byte-identical
    // on the wire and the frame itself can never be the thing that de-anonymises a stop.
    expect(Object.keys(frame ?? {}).sort()).toEqual(['active', 'at', 'campaignId', 'type']);
  });

  // -------------------------------------------------------------------------
  // Freezing play.
  // -------------------------------------------------------------------------

  it('freezes encounter advancement: start, next-turn, end-turn and undo-turn all 409', async () => {
    const campaignId = await newCampaign('Freeze Advancement');
    const encounterId = await runningEncounter(campaignId);
    await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(player).send({});

    const next = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm).send({});
    expect(next.status).toBe(409);
    expect(next.body.code).toBe('TABLE_SAFETY_HOLD');
    // The refusal names no participant and gives no reason — there is neither to name.
    expect(next.body.message).not.toContain('safety-player');

    const endTurn = await request(server).post(`/api/v1/encounters/${encounterId}/end-turn`).set(dm).send({});
    expect(endTurn.status).toBe(409);
    const undo = await request(server).post(`/api/v1/encounters/${encounterId}/undo-turn`).set(dm);
    expect(undo.status).toBe(409);

    const fresh = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/encounters`)
      .set(dm)
      .send({ name: 'Second Fight' });
    await request(server)
      .post(`/api/v1/encounters/${fresh.body.id}/combatants`)
      .set(dm)
      .send({ name: 'Wolf', kind: 'monster', hpMax: 5 });
    await request(server).post(`/api/v1/encounters/${fresh.body.id}/roll-initiative`).set(dm);
    const start = await request(server).post(`/api/v1/encounters/${fresh.body.id}/start`).set(dm);
    expect(start.status).toBe(409);
    expect(start.body.code).toBe('TABLE_SAFETY_HOLD');
  });

  it('leaves ENDING an encounter available — it is one of the facilitator recoveries', async () => {
    const campaignId = await newCampaign('End Is Recovery');
    const encounterId = await runningEncounter(campaignId);
    await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(player).send({});

    // A safety hold that trapped the table inside a running fight would be worse than no hold.
    const ended = await request(server).post(`/api/v1/encounters/${encounterId}/end`).set(dm);
    expect(ended.status).toBe(201);
  });

  // -------------------------------------------------------------------------
  // Recovery: facilitator-only, and the five dispositions.
  // -------------------------------------------------------------------------

  it('a participant cannot release; a facilitator can', async () => {
    const campaignId = await newCampaign('Asymmetric');
    await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(player).send({});

    const byPlayer = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/safety/release`)
      .set(player)
      .send({ recovery: 'resume' });
    expect(byPlayer.status).toBe(403);

    const byViewer = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/safety/release`)
      .set(viewer)
      .send({ recovery: 'resume' });
    expect(byViewer.status).toBe(403);

    const byDm = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/safety/release`)
      .set(dm)
      .send({ recovery: 'resume', note: 'checked in, everyone good' });
    expect(byDm.status).toBe(200);
    expect(byDm.body.active).toBe(false);
    expect(byDm.body.recovery).toBe('resume');
    expect(byDm.body.releasedByName).toBeTruthy();
    // The activating participant's name is cleared on release: an attributed hold was
    // attributed for the DURATION of the stop, not recorded forever.
    expect(byDm.body.activatedByName).toBeNull();
  });

  it('releasing un-gates encounter advancement again', async () => {
    const campaignId = await newCampaign('Ungate');
    const encounterId = await runningEncounter(campaignId);
    await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(player).send({});
    expect((await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm).send({})).status).toBe(409);

    await request(server).post(`/api/v1/campaigns/${campaignId}/safety/release`).set(dm).send({ recovery: 'resume' });
    const next = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm).send({});
    expect(next.status).toBe(201);
  });

  it("recovery 'veil' appends the veil to the session-zero charter", async () => {
    const campaignId = await newCampaign('Veil Recovery');
    await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(player).send({});
    const released = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/safety/release`)
      .set(dm)
      .send({ recovery: 'veil', veil: 'on-screen torture' });
    expect(released.status).toBe(200);
    expect(released.body.recovery).toBe('veil');

    // The stop actually changed what the table plays going forward — including for the AI,
    // which reads this same charter into every system prompt. A banner nobody revisits would not.
    const charter = await request(server).get(`/api/v1/campaigns/${campaignId}/session-zero`).set(player);
    expect(charter.body.veils).toContain('on-screen torture');

    const rows = await db.select().from(sessionZeroTable).where(eq(sessionZeroTable.campaignId, campaignId));
    expect(rows).toHaveLength(1);
  });

  it('releasing an already-released table is a no-op that succeeds', async () => {
    const campaignId = await newCampaign('Double Release');
    await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(player).send({});
    await request(server).post(`/api/v1/campaigns/${campaignId}/safety/release`).set(dm).send({ recovery: 'resume' });
    const again = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/safety/release`)
      .set(dm)
      .send({ recovery: 'resume' });
    expect(again.status).toBe(200);
    expect(again.body.active).toBe(false);
  });

  it('a hold raised after a release is a fresh hold, and the counter climbs', async () => {
    const campaignId = await newCampaign('Second Hold');
    await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(player).send({});
    await request(server).post(`/api/v1/campaigns/${campaignId}/safety/release`).set(dm).send({ recovery: 'rewind' });
    const second = await request(server).post(`/api/v1/campaigns/${campaignId}/safety/hold`).set(otherPlayer).send({});
    expect(second.status).toBe(200);
    expect(second.body.active).toBe(true);
    // A count is not attributable, and it is what makes "we keep stopping in this arc"
    // visible to a facilitator without naming anyone.
    expect(second.body.activationCount).toBe(2);
    expect(second.body.recovery).toBeNull();
  });

});
