import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { rulePacks, ruleEntries } from '../src/db/schema';

/**
 * Issue #414 — structured action resolver at the HTTP API layer (real Nest app + SQLite).
 * Exercises the four controller routes end-to-end over HTTP with dev-role auth headers:
 *   GET  /encounters/:id/combatants/:cid/actions   — list usable actions (+ resolvable flag)
 *   POST /encounters/:id/actions/resolve            — resolve (+ optional atomic commit)
 *   POST /encounters/:id/actions/undo               — reverse an applied resolution
 * plus the authorization boundary (a player may not resolve another player's character) and
 * the "unsupported shape → 400, never silent math" contract. Damage is pinned deterministically
 * with a save spell at DC 21 (a monster with no stated saves rolls at +0, so a d20 tops out at
 * 20 → always fails → full damage), so the assertions never depend on the RNG.
 */
const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };
const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'p-2' };
// Issue #1450: the SAME account as `player` (owns actorId), but with the campaign's
// read-only role. `requireMember(..., { write: true })` used to return this role
// unchanged (it only asserts the CAMPAIGN is writable, not caller authority), and
// ownership alone let the request through downstream — this is the exploited seat.
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'p-1' };

// A DEX-save spell that always fails vs a +0 monster (DC 21), dealing flat 6 fire on a failure
// (a formula-free DamagePart so the total is deterministic without a roller). Its freeform
// notes must survive the round-trip (issue #414: preserve AND surface notes).
const scorchingRay = {
  name: 'Scorching Ray',
  kind: 'spell',
  toHit: '',
  damage: '6 fire',
  notes: 'Three rays of fire.',
  spec: {
    mode: 'save',
    save: { ability: 'DEX', dc: { kind: 'fixed', dc: 21 } },
    cost: { slot: 'action', count: 1 },
    targets: { count: 1, allow: 'enemy' },
    outcomes: { failure: { damage: [{ flat: 6, type: 'fire' }] }, success: { halfDamage: true } },
  },
};

describe('action resolver (e2e HTTP)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;
  let actorId: number; // the player's PC combatant
  let monsterId: number; // the target monster combatant
  let monsterHp: number; // the monster's resolved starting HP (statblock-derived)

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();

    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Resolver Campaign' });
    campaignId = campRes.body.id;

    // A PC owned by dev:p-1 carrying the structured action.
    const charRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Wizard', stats: { DEX: 10, INT: 18 }, ac: 12, hpCurrent: 20, hpMax: 20, ownerUserId: 'dev:p-1', actions: [scorchingRay] });
    expect(charRes.status).toBe(201);

    // Seed a monster rule entry (with an AC + HP statblock, no fire resistance).
    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = new Date().toISOString();
    const [pack] = await db.insert(rulePacks).values({ slug: 'resolver-pack', name: 'Resolver Pack', installedAt: ts, entryCount: 1 }).returning();
    const [entry] = await db
      .insert(ruleEntries)
      .values({
        packId: pack.id,
        slug: 'straw-dummy',
        name: 'Straw Dummy',
        type: 'monster',
        dataJson: JSON.stringify({ armor_class: 12, hit_points: 30 }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    // Encounter auto-adds the party PC; then add the monster target.
    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Fight', hidden: false });
    expect(encRes.status).toBe(201);
    encounterId = encRes.body.id;
    actorId = encRes.body.combatants[0].id;

    const monRes = await request(server).post(`/api/v1/encounters/${encounterId}/combatants`).set(dm).send({ kind: 'monster', ruleEntryId: entry.id });
    expect(monRes.status).toBe(201);
    monsterId = monRes.body.id;
    monsterHp = monRes.body.hpCurrent; // DM view: exact HP (statblock-derived, not redacted)
    expect(monsterHp).toBeGreaterThan(6);

    // Start through the lifecycle route with the player's PC holding the active turn.
    // The resolver now enforces that player actions belong to this live turn, not merely
    // to an owned character.
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${actorId}`).set(dm).send({ initiative: 20 });
    await request(server).patch(`/api/v1/encounters/${encounterId}/combatants/${monsterId}`).set(dm).send({ initiative: 10 });
    const startRes = await request(server).post(`/api/v1/encounters/${encounterId}/start`).set(dm).send({});
    expect(startRes.status).toBe(201);
    expect(startRes.body.currentCombatantId).toBe(actorId);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('lists a PC’s usable actions with the resolvable flag + preserved freeform notes', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/encounters/${encounterId}/combatants/${actorId}/actions`).set(player);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Scorching Ray');
    expect(res.body[0].mode).toBe('save');
    expect(res.body[0].resolvable).toBe(true);
    expect(res.body[0].notes).toBe('Three rays of fire.'); // freeform preserved
  });

  it('a player may not list another player’s character actions (403)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/encounters/${encounterId}/combatants/${actorId}/actions`).set(otherPlayer);
    expect(res.status).toBe(403);
  });

  it('a player resolves + commits their own PC action against a monster, then undoes it', async () => {
    const server = ctx.app.getHttpServer();
    const resolveRes = await request(server)
      .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
      .set(player)
      .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: true });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.applied).toBe(true);
    expect(resolveRes.body.policy).toBe('automatic');
    const target = resolveRes.body.resolution.targets[0];
    expect(target.outcome).toBe('failure'); // DC 21 always fails vs a +0 save
    expect(target.totalDamage).toBe(6); // flat 6 fire, no resistance
    const undoToken = resolveRes.body.undoToken;
    expect(undoToken).not.toBeNull();

    // The monster's HP dropped by 6 (the DM sees exact HP).
    const afterApply = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const monsterAfter = afterApply.body.combatants.find((c: { id: number }) => c.id === monsterId);
    expect(monsterAfter.hpCurrent).toBe(monsterHp - 6);

    // Undo restores the monster's HP exactly.
    const undoRes = await request(server).post(`/api/v1/encounters/${encounterId}/actions/undo`).set(player).send(undoToken);
    expect(undoRes.status).toBe(200);
    const afterUndo = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const monsterRestored = afterUndo.body.combatants.find((c: { id: number }) => c.id === monsterId);
    expect(monsterRestored.hpCurrent).toBe(monsterHp);
  });

  it('a player may not resolve another player’s character action (403)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
      .set(otherPlayer)
      .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId] });
    expect(res.status).toBe(403);
  });

  it('an unsupported action shape is refused (400) rather than inventing numbers', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
      .set(player)
      .send({ actorCombatantId: actorId, spec: { mode: 'attack' }, targetIds: [monsterId] });
    expect(res.status).toBe(400);
  });

  // Issue #1450 — a read-only viewer (even one who OWNS the acting character, e.g. a
  // player demoted mid-session) must not reach any consequence-writing path. Ownership
  // checks alone (isCharacterOwnedBy) never protected against this: they only gate WHICH
  // character a non-DM may act with, not whether the caller may act at all.
  describe('issue #1450: viewer may not resolve, apply, or undo combat actions', () => {
    it('viewer -> /actions/resolve with commit:true is 403, with no combatant mutation and no combat-log event', async () => {
      const server = ctx.app.getHttpServer();

      const before = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const monsterBefore = before.body.combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent;
      const eventsBefore = await request(server).get(`/api/v1/encounters/${encounterId}/events`).set(dm);
      const eventCountBefore = eventsBefore.body.length;

      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
        .set(viewer)
        .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: true });
      expect(res.status).toBe(403);

      const after = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const monsterAfter = after.body.combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent;
      expect(monsterAfter).toBe(monsterBefore);

      const eventsAfter = await request(server).get(`/api/v1/encounters/${encounterId}/events`).set(dm);
      expect(eventsAfter.body.length).toBe(eventCountBefore);
    });

    it('viewer -> /actions/apply is 403', async () => {
      const server = ctx.app.getHttpServer();
      // A real, valid resolution (preview-only, no commit) so the request body passes DTO
      // validation and the 403 is proven to come from the authorization gate, not a shape error.
      const previewRes = await request(server)
        .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
        .set(player)
        .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: false });
      expect(previewRes.status).toBe(200);

      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/actions/apply`)
        .set(viewer)
        .send({ chainId: previewRes.body.chainId });
      expect(res.status).toBe(403);
    });

    it('viewer -> /actions/undo is 403', async () => {
      const server = ctx.app.getHttpServer();
      // A player resolves+commits for real to mint a genuine undo token, then the SAME
      // owned actor's viewer seat attempts to consume it.
      const resolveRes = await request(server)
        .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
        .set(player)
        .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: true });
      expect(resolveRes.status).toBe(200);
      const undoToken = resolveRes.body.undoToken;

      const before = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const monsterBefore = before.body.combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent;

      const res = await request(server).post(`/api/v1/encounters/${encounterId}/actions/undo`).set(viewer).send(undoToken);
      expect(res.status).toBe(403);

      // Undo never ran — HP stays at the applied (damaged) value, not restored.
      const after = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const monsterAfter = after.body.combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent;
      expect(monsterAfter).toBe(monsterBefore);

      // Clean up via the DM so later tests see a known HP baseline.
      const cleanup = await request(server).post(`/api/v1/encounters/${encounterId}/actions/undo`).set(dm).send(undoToken);
      expect(cleanup.status).toBe(200);
    });

    it('a player demoted to viewer mid-session loses action-resolver access on the very next request', async () => {
      const server = ctx.app.getHttpServer();

      // Same account, same owned character: succeeds as `player`...
      const asPlayer = await request(server)
        .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
        .set(player)
        .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: false });
      expect(asPlayer.status).toBe(200);

      // ...and is refused on the IMMEDIATELY NEXT request once the campaign now reports
      // this account as `viewer` — nothing about the request changed except the role, so a
      // stale/cached authorization decision would incorrectly let this through.
      const demoted = await request(server)
        .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
        .set(viewer)
        .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: false });
      expect(demoted.status).toBe(403);
    });
  });

  // Regression: the fix must not touch the DM or the automatic-policy player path.
  describe('issue #1450 regression: dm and player paths keep working under each policy', () => {
    it('dm previews a player PC action directly (automatic policy)', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
        .set(dm)
        .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: false });
      expect(res.status).toBe(200);
      expect(res.body.canApply).toBe(true);
      expect(res.body.policy).toBe('automatic');
    });

    it('a player under the default automatic policy still resolves + applies + undoes their own PC action', async () => {
      const server = ctx.app.getHttpServer();
      const resolveRes = await request(server)
        .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
        .set(player)
        .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: true });
      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.applied).toBe(true);
      const undo = await request(server)
        .post(`/api/v1/encounters/${encounterId}/actions/undo`)
        .set(player)
        .send(resolveRes.body.undoToken);
      expect(undo.status).toBe(200);
    });
  });

  // Issue #1451 — /actions/apply used to take the FULL ActionResolution from the request
  // body and write its totalDamage/effects verbatim. It now takes { chainId } only and
  // re-reads the resolution the server itself computed and persisted at resolve time, so
  // neither of these forged wire shapes (the exact pre-fix exploit) is even well-formed
  // input anymore — both are refused before any combatant state changes.
  describe('issue #1451: /actions/apply trusts only the chainId, never a client-supplied resolution', () => {
    it('a forged body carrying an inflated totalDamage (the pre-fix exploit shape) is rejected, and the monster HP is untouched', async () => {
      const server = ctx.app.getHttpServer();
      const before = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const monsterBefore = before.body.combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent;

      const previewRes = await request(server)
        .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
        .set(player)
        .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: false });
      expect(previewRes.status).toBe(200);

      // The exact pre-#1451 exploit: re-POST the previewed resolution with totalDamage
      // edited to a one-shot amount. There is no `chainId` field here at all — this is a
      // straight port of what the vulnerable client used to send.
      const forged = {
        ...previewRes.body.resolution,
        targets: previewRes.body.resolution.targets.map((t: Record<string, unknown>) => ({ ...t, totalDamage: 999999 })),
      };
      const res = await request(server).post(`/api/v1/encounters/${encounterId}/actions/apply`).set(player).send(forged);
      expect(res.status).toBe(400);

      const after = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const monsterAfter = after.body.combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent;
      expect(monsterAfter).toBe(monsterBefore);
    });

    it('a forged body injecting a condition/effect never in the action spec is rejected, and the monster gains no condition', async () => {
      const server = ctx.app.getHttpServer();
      const previewRes = await request(server)
        .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
        .set(player)
        .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: false });
      expect(previewRes.status).toBe(200);
      expect(previewRes.body.resolution.targets[0].effects).toEqual([]); // Scorching Ray declares none

      const forged = {
        ...previewRes.body.resolution,
        targets: previewRes.body.resolution.targets.map((t: Record<string, unknown>) => ({
          ...t,
          effects: [{ condition: 'stunned', rounds: null, saveEnds: false, ongoingDamage: 0 }],
        })),
      };
      const res = await request(server).post(`/api/v1/encounters/${encounterId}/actions/apply`).set(player).send(forged);
      expect(res.status).toBe(400);

      const after = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const monster = after.body.combatants.find((c: { id: number }) => c.id === monsterId);
      expect(monster.conditions ?? []).toEqual([]);
    });

    it('applying the real chainId still lands only the honest server-rolled damage', async () => {
      const server = ctx.app.getHttpServer();
      const before = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const monsterBefore = before.body.combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent;

      const previewRes = await request(server)
        .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
        .set(player)
        .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: false });
      expect(previewRes.status).toBe(200);
      const chainId = previewRes.body.chainId;
      expect(chainId).toBeTruthy();
      const honestDamage = previewRes.body.resolution.targets[0].totalDamage;
      expect(honestDamage).toBe(6); // flat 6 fire, no resistance — deterministic (see scorchingRay fixture)

      const applyRes = await request(server).post(`/api/v1/encounters/${encounterId}/actions/apply`).set(player).send({ chainId });
      expect(applyRes.status).toBe(200);

      const after = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
      const monsterAfter = after.body.combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent;
      expect(monsterAfter).toBe(monsterBefore - honestDamage);

      // Clean up via undo so later tests see a known HP baseline.
      const undo = await request(server).post(`/api/v1/encounters/${encounterId}/actions/undo`).set(player).send(applyRes.body.undoToken);
      expect(undo.status).toBe(200);
    });
  });

  // Issue #1451 regression guard: the vulnerability report's own comparison — the ordinary
  // combatant PATCH path already forbids a player from writing an unowned combatant's HP.
  // This must keep holding regardless of anything the action resolver does.
  it('#1451 regression: a player still cannot reach an unowned combatant’s HP via PATCH /combatants/:cid', async () => {
    const server = ctx.app.getHttpServer();
    const before = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const monsterBefore = before.body.combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent;

    const res = await request(server)
      .patch(`/api/v1/encounters/${encounterId}/combatants/${monsterId}`)
      .set(player)
      .send({ hpSet: 0 });
    expect(res.status).toBe(403);

    const after = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const monsterAfter = after.body.combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent;
    expect(monsterAfter).toBe(monsterBefore);
  });

  it('issue #1316: a stale player preview cannot resolve or apply after the DM advances the turn', async () => {
    const server = ctx.app.getHttpServer();
    const previewRes = await request(server)
      .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
      .set(player)
      .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: false });
    expect(previewRes.status).toBe(200);

    const advanceRes = await request(server).post(`/api/v1/encounters/${encounterId}/next-turn`).set(dm).send({});
    expect(advanceRes.status).toBe(201);
    expect(advanceRes.body.currentCombatantId).toBe(monsterId);

    const staleResolve = await request(server)
      .post(`/api/v1/encounters/${encounterId}/actions/resolve`)
      .set(player)
      .send({ actorCombatantId: actorId, actionIndex: 0, targetIds: [monsterId], commit: true });
    expect(staleResolve.status).toBe(403);

    const beforeApply = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    const staleApply = await request(server).post(`/api/v1/encounters/${encounterId}/actions/apply`).set(player).send({ chainId: previewRes.body.chainId });
    expect(staleApply.status).toBe(403);
    const afterApply = await request(server).get(`/api/v1/encounters/${encounterId}`).set(dm);
    expect(afterApply.body.combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent).toBe(
      beforeApply.body.combatants.find((c: { id: number }) => c.id === monsterId).hpCurrent,
    );

    // The same server-owned chain remains available to the DM as an override.
    const dmApply = await request(server).post(`/api/v1/encounters/${encounterId}/actions/apply`).set(dm).send({ chainId: previewRes.body.chainId });
    expect(dmApply.status).toBe(200);
    const undo = await request(server).post(`/api/v1/encounters/${encounterId}/actions/undo`).set(dm).send(dmApply.body.undoToken);
    expect(undo.status).toBe(200);
  });
});
