import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

/**
 * Experimental server-side AI Dungeon Master (issue #28).
 *
 * Covers the double gate (server experimental flag + per-campaign enabled), the
 * per-campaign token budget metering + exhaustion, role gating, audit, and that
 * the shipped no-op provider produces a scaffold response with NO vendor call.
 */
const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'aidm-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'aidm-player' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'aidm-viewer' };

describe('ai-dm (e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'AI DM Campaign' });
    campaignId = campRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function setExperimental(on: boolean) {
    const res = await request(server).patch('/api/v1/settings').set(dm).send({ experimentalAiDm: on });
    expect(res.status).toBe(200);
    expect(res.body.experimentalAiDm).toBe(on);
  }

  it('GET seat returns an un-configured default (members, no experimental gate)', async () => {
    const res = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-dm`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe(campaignId);
    expect(res.body.mode).toBe('off'); // operating mode defaults to Off (issue #311)
    expect(res.body.enabled).toBe(false);
    expect(res.body.tokenBudget).toBe(0);
    expect(res.body.tokensUsed).toBe(0);
    expect(res.body.turnCount).toBe(0);
  });

  it('configure/turn are 403 while the server experimental flag is off', async () => {
    const configRes = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(dm)
      .send({ enabled: true, tokenBudget: 1000 });
    expect(configRes.status).toBe(403);

    const turnRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'The party enters the crypt.' });
    expect(turnRes.status).toBe(403);
  });

  it('a server admin enables the experimental flag', async () => {
    await setExperimental(true);
  });

  it('selecting an operating mode drives the enabled turn-gate (the UI sends only {mode})', async () => {
    // Regression: the settings UI's mode picker PUTs just {mode} — it never sends {enabled}.
    // enabled must therefore be derived from mode, or co-DM/Driver would be unreachable from
    // the UI (every turn refused for !enabled) even after a DM picks an active mode.
    const toCoDm = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(dm)
      .send({ mode: 'co_dm' });
    expect(toCoDm.status).toBe(200);
    expect(toCoDm.body.mode).toBe('co_dm');
    expect(toCoDm.body.enabled).toBe(true); // derived, though {enabled} was never sent

    const toOff = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(dm)
      .send({ mode: 'off' });
    expect(toOff.status).toBe(200);
    expect(toOff.body.mode).toBe('off');
    expect(toOff.body.enabled).toBe(false); // 'off' disables the seat again

    // An explicit {enabled} still wins over the mode-derived value (back-compat with the
    // existing configure path, which sets enabled directly).
    const explicit = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(dm)
      .send({ enabled: false, mode: 'co_dm' });
    expect(explicit.status).toBe(200);
    expect(explicit.body.mode).toBe('co_dm');
    expect(explicit.body.enabled).toBe(false);

    // Reset to the pristine default so later cases start from off/disabled.
    await request(server).put(`/api/v1/campaigns/${campaignId}/ai-dm`).set(dm).send({ mode: 'off' });
  });

  it('dm configures the seat (200), non-dm is forbidden (403)', async () => {
    const denied = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(player)
      .send({ enabled: true });
    expect(denied.status).toBe(403);

    const res = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(dm)
      .send({ enabled: true, model: 'connected-agent', instructions: 'Be terse and grim.', tokenBudget: 100_000 });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.model).toBe('connected-agent');
    expect(res.body.instructions).toBe('Be terse and grim.');
    expect(res.body.tokenBudget).toBe(100_000);
  });

  it('GET seat redacts the DM instructions (plot secrets) for non-DM members (issue #261)', async () => {
    // The DM sees the private steering prompt in full.
    const dmView = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-dm`).set(dm);
    expect(dmView.status).toBe(200);
    expect(dmView.body.instructions).toBe('Be terse and grim.');

    // A player member gets the seat WITHOUT instructions — the DM-authored prompt
    // is where plot secrets live and must not leak (mirrors dmSecret/hidden).
    const playerView = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-dm`).set(player);
    expect(playerView.status).toBe(200);
    expect(playerView.body).not.toHaveProperty('instructions');
    // Non-secret config is still visible to members.
    expect(playerView.body.enabled).toBe(true);
    expect(playerView.body.model).toBe('connected-agent');
    expect(playerView.body.tokenBudget).toBe(100_000);
    expect(playerView.body.campaignId).toBe(campaignId);

    // Same redaction for a viewer.
    const viewerView = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-dm`).set(viewer);
    expect(viewerView.status).toBe(200);
    expect(viewerView.body).not.toHaveProperty('instructions');
  });

  it('AI DM takes a turn (201): no-op scaffold narration, budget metered, audited', async () => {
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'The rogue picks the lock.', kind: 'narrate' });
    expect(res.status).toBe(201); // Nest POST default
    expect(res.body.provider).toBe('noop');
    expect(res.body.kind).toBe('narrate');
    // The shipped default makes NO vendor call — it returns a clearly-labelled scaffold.
    expect(res.body.narration).toContain('[ai-dm:noop]');
    expect(res.body.tokensUsed).toBeGreaterThan(0);
    expect(res.body.tokenBudget).toBe(100_000);
    expect(res.body.budgetRemaining).toBe(100_000 - res.body.tokensUsed);
    expect(res.body.seat.turnCount).toBe(1);
    expect(res.body.seat.tokensUsed).toBe(res.body.tokensUsed);
    expect(res.body.seat.lastTurnAt).not.toBeNull();

    // Metering is persisted.
    const seatRes = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-dm`).set(dm);
    expect(seatRes.body.tokensUsed).toBe(res.body.tokensUsed);
    expect(seatRes.body.turnCount).toBe(1);

    // Audited as ai-dm.
    const auditRes = await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
    expect(auditRes.status).toBe(200);
    const actions = auditRes.body.map((a: { action: string }) => a.action);
    expect(actions).toContain('ai-dm.turn');
    expect(actions).toContain('ai-dm.configure');
  });

  it('metering accumulates across turns (atomic in-SQL increment, issue #272)', async () => {
    // Start from a known, non-exhausted state: clear counters, generous budget.
    await request(server).post(`/api/v1/campaigns/${campaignId}/ai-dm/reset`).set(dm).send({});
    await request(server).put(`/api/v1/campaigns/${campaignId}/ai-dm`).set(dm).send({ enabled: true, tokenBudget: 100_000 });

    const first = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'Turn one.', kind: 'narrate' });
    expect(first.status).toBe(201);
    const afterFirst = first.body.seat.tokensUsed;
    expect(afterFirst).toBeGreaterThan(0);
    expect(first.body.seat.turnCount).toBe(1);

    const second = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'Turn two.', kind: 'narrate' });
    expect(second.status).toBe(201);
    // tokens_used = tokens_used + n must have COMPOSED, not clobbered: the second turn's
    // persisted total is the first turn's total plus this turn's cost, and turnCount is 2.
    expect(second.body.seat.tokensUsed).toBe(afterFirst + second.body.tokensUsed);
    expect(second.body.seat.turnCount).toBe(2);
    expect(second.body.budgetRemaining).toBe(100_000 - second.body.seat.tokensUsed);

    // Persisted read agrees with the accumulated total.
    const seatRes = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-dm`).set(dm);
    expect(seatRes.body.tokensUsed).toBe(second.body.seat.tokensUsed);
    expect(seatRes.body.turnCount).toBe(2);
  });

  it('usage-history returns newest-first items + summary after metered turns (#1060)', async () => {
    await request(server).post(`/api/v1/campaigns/${campaignId}/ai-dm/reset`).set(dm).send({});
    await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(dm)
      .send({ enabled: true, tokenBudget: 100_000 });

    const first = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'History turn one.', kind: 'narrate' });
    expect(first.status).toBe(201);
    const second = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'History turn two.', kind: 'narrate' });
    expect(second.status).toBe(201);

    const history = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/ai-dm/usage-history`)
      .set(dm);
    expect(history.status).toBe(200);
    expect(history.body.count).toBeGreaterThanOrEqual(2);
    expect(history.body.items).toHaveLength(history.body.count);
    expect(history.body.totalTokens).toBe(
      history.body.items.reduce((sum: number, row: { tokensUsed: number }) => sum + row.tokensUsed, 0),
    );
    // Newest-first: first item is at/after the second item's createdAt.
    expect(history.body.items[0].createdAt >= history.body.items[1].createdAt).toBe(true);
    expect(history.body.items[0].action).toBe('ai-dm.turn');
    expect(history.body.items[0].tokensUsed).toBeGreaterThan(0);

    // Whitespace-only since is ignored (treated as unset).
    const blankSince = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/ai-dm/usage-history?since=%20%20%20`)
      .set(dm);
    expect(blankSince.status).toBe(200);
    expect(blankSince.body.count).toBe(history.body.count);

    const badSince = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/ai-dm/usage-history?since=not-a-date`)
      .set(dm);
    expect(badSince.status).toBe(400);

    // Players cannot read DM-only metering history.
    const playerDenied = await request(server)
      .get(`/api/v1/campaigns/${campaignId}/ai-dm/usage-history`)
      .set(player);
    expect(playerDenied.status).toBe(403);
  });

  it('turn is 403 when the seat is disabled even with the flag on', async () => {
    await request(server).put(`/api/v1/campaigns/${campaignId}/ai-dm`).set(dm).send({ enabled: false });
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'Nothing happens.' });
    expect(res.status).toBe(403);
    // Re-enable for the budget test below.
    await request(server).put(`/api/v1/campaigns/${campaignId}/ai-dm`).set(dm).send({ enabled: true });
  });

  it('token budget is enforced: a turn runs, then the exhausted budget 403s', async () => {
    // Reset metering, then set a budget of exactly 1 token so one turn exhausts it.
    await request(server).post(`/api/v1/campaigns/${campaignId}/ai-dm/reset`).set(dm).send({});
    await request(server).put(`/api/v1/campaigns/${campaignId}/ai-dm`).set(dm).send({ tokenBudget: 1 });

    const first = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'One last swing.' });
    expect(first.status).toBe(201);
    expect(first.body.budgetRemaining).toBe(0); // usage clamped to the cap

    const second = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`)
      .set(dm)
      .send({ prompt: 'And another.' });
    expect(second.status).toBe(403);
    expect(second.text).toContain('budget exhausted');
  });

  it('reset clears usage counters (dm only)', async () => {
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/ai-dm/reset`).set(dm).send({});
    expect(res.status).toBe(201);
    expect(res.body.tokensUsed).toBe(0);
    expect(res.body.turnCount).toBe(0);
    expect(res.body.lastTurnAt).toBeNull();
  });

  it('unknown keys are rejected by the strict DTO (400)', async () => {
    const res = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(dm)
      .send({ enabled: true, bogusField: 'nope' });
    expect(res.status).toBe(400);
  });
});

/**
 * Operating modes: off / co_dm / driver (issue #311).
 *
 * The mode is a first-class seat field, round-trips through configure/read, and is
 * NON-secret (players see it — the honest indicator of whether an AI is co-DMing or
 * driving). Driver carries hard preconditions (positive budget + configured provider)
 * enforced with a 409; Off and Co-DM do not.
 */
describe('ai-dm operating modes (e2e)', () => {
  const modeDm = { 'x-dev-role': 'dm', 'x-dev-user': 'aidm-mode-dm' };
  const modePlayer = { 'x-dev-role': 'player', 'x-dev-user': 'aidm-mode-player' };
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(modeDm).send({ name: 'AI Mode Campaign' });
    campaignId = campRes.body.id;
    // The whole feature (configure) needs the server experimental flag on.
    await request(server).patch('/api/v1/settings').set(modeDm).send({ experimentalAiDm: true });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('mode round-trips through configure/read (off -> co_dm)', async () => {
    const res = await request(server).put(`/api/v1/campaigns/${campaignId}/ai-dm`).set(modeDm).send({ mode: 'co_dm' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('co_dm');

    const seat = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-dm`).set(modeDm);
    expect(seat.body.mode).toBe('co_dm');
  });

  it('the mode is visible to players — the honest co-DM/driver indicator (not redacted)', async () => {
    const playerView = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-dm`).set(modePlayer);
    expect(playerView.status).toBe(200);
    expect(playerView.body.mode).toBe('co_dm');
    // ...while the DM-authored steering prompt stays redacted (issue #261).
    expect(playerView.body).not.toHaveProperty('instructions');
  });

  it('an unknown mode value is rejected (400)', async () => {
    const res = await request(server).put(`/api/v1/campaigns/${campaignId}/ai-dm`).set(modeDm).send({ mode: 'autopilot' });
    expect(res.status).toBe(400);
  });

  it('Driver is 409 without a budget or provider, with a clear reason', async () => {
    // No budget yet.
    const noBudget = await request(server).put(`/api/v1/campaigns/${campaignId}/ai-dm`).set(modeDm).send({ mode: 'driver' });
    expect(noBudget.status).toBe(409);
    expect(noBudget.text).toContain('budget');

    // Budget set, but still no provider configured.
    const noProvider = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(modeDm)
      .send({ mode: 'driver', tokenBudget: 50_000 });
    expect(noProvider.status).toBe(409);
    expect(noProvider.text).toContain('provider');

    // The failed writes did not flip the mode.
    const seat = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-dm`).set(modeDm);
    expect(seat.body.mode).toBe('co_dm');
  });

  it('Driver succeeds once a provider is configured and a budget is set', async () => {
    // Configure a per-campaign provider (mock type needs no real network at test time).
    const provRes = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(modeDm)
      .send({ providerType: 'mock', model: 'mock-1', apiKey: 'sk-test-key-1234' });
    expect(provRes.status).toBe(200);

    const res = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(modeDm)
      .send({ mode: 'driver', tokenBudget: 50_000 });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('driver');
    expect(res.body.tokenBudget).toBe(50_000);
  });

  it('switching back to Off / Co-DM is always allowed (no preconditions)', async () => {
    const off = await request(server).put(`/api/v1/campaigns/${campaignId}/ai-dm`).set(modeDm).send({ mode: 'off' });
    expect(off.status).toBe(200);
    expect(off.body.mode).toBe('off');
  });
});
