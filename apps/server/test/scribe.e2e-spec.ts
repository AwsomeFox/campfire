/**
 * Automatic AI scribe (issue #316) — deterministic e2e on the #318 mock-provider harness.
 *
 * The harness overrides AI_DM_PROVIDER with a scripted MockAiProvider (wrapped by the
 * ProviderBackedAiDmProvider bridge). The scribe resolves the configured provider first
 * (#310) and, when none is stored, falls back to that injected seam — so scripting a turn
 * here scripts the recap the scribe writes, entirely offline and reproducible.
 *
 * Covers the acceptance criteria: with the seat configured, an on-demand run sweeps the
 * campaign material, files a recap PROPOSAL (never direct canon), meters the budget, and
 * is gated by the experimental flag + seat; re-runs are idempotent; a dry run previews
 * without filing; and approving the proposal is what finally publishes the recap.
 */

import request from 'supertest';
import { createAiEvalHarness, dm, type AiEvalHarness } from './ai-eval-harness';
import { AiDmService } from '../src/modules/ai-dm/ai-dm.service';
import { AiDriverService } from '../src/modules/ai-driver/ai-driver.service';
import { ScribeService } from '../src/modules/scribe/scribe.service';

const API = '/api/v1';

/**
 * The campaign owner these specs author source material as.
 *
 * Issue #501 gates member-authored inbox notes on per-member consent, and consent lives on
 * the `campaign_members` row keyed by `users.id`. DEV_AUTH principals (`dev:<name>`) have no
 * `users` row and are deliberately skipped by `MembersService.addCreatorAsDm`, so they can
 * neither hold a membership nor record consent. These specs therefore author notes as a REAL
 * persisted account over a cookie session (SessionAuthGuard resolves the session cookie
 * before the dev headers), which is the identity path a deployed install uses.
 *
 * Everything that only needs DM AUTHORITY — seat config, scribe runs — keeps using the `dm`
 * headers, whose devRole short-circuits the role check on any campaign.
 */
type PersistedOwner = { agent: ReturnType<typeof request.agent>; userId: number };
let owner: PersistedOwner;

/** Claim first-run setup as a real user; returns the cookie agent + persisted users.id. */
async function createPersistedOwner(harness: AiEvalHarness, username: string): Promise<PersistedOwner> {
  const agent = request.agent(harness.server);
  const setup = await agent.post(`${API}/auth/setup`).send({ username, password: `${username}-password` });
  if (setup.status !== 201) throw new Error(`setup failed: ${setup.status} ${setup.text}`);
  return { agent, userId: setup.body.user.id as number };
}

/**
 * Create a campaign OWNED by the persisted account (so a real `campaign_members` row exists)
 * and record that owner's external-AI consent.
 *
 * Consent is an explicit precondition here, not a workaround: these specs assert what the
 * scribe does with material it is ALLOWED to send. The fail-closed default, revocation, and
 * the campaign-policy override are asserted on their own in the "external AI consent,
 * persisted account" block at the bottom of this file.
 */
async function ownedCampaign(name: string): Promise<number> {
  const created = await owner.agent.post(`${API}/campaigns`).send({ name });
  if (created.status !== 201) throw new Error(`createCampaign failed: ${created.status} ${created.text}`);
  const campaignId = created.body.id as number;
  const consent = await owner.agent
    .patch(`${API}/campaigns/${campaignId}/members/me/ai-consent`)
    .send({ aiExternalUseConsent: true });
  if (consent.status !== 200) throw new Error(`ai-consent grant failed: ${consent.status} ${consent.text}`);
  return campaignId;
}

/** Seed resolvable source material: submit an inbox item and resolve it, as the owner. */
async function seedResolvedInbox(harness: AiEvalHarness, campaignId: number, body: string): Promise<void> {
  const submitted = await owner.agent.post(`${API}/campaigns/${campaignId}/inbox`).send({ body });
  if (submitted.status !== 201) throw new Error(`inbox submit failed: ${submitted.status} ${submitted.text}`);
  const noteId = submitted.body.id as number;
  const resolved = await owner.agent.post(`${API}/notes/${noteId}/resolve`).send({ resolvedNote: 'handled in play' });
  if (resolved.status !== 201) throw new Error(`inbox resolve failed: ${resolved.status} ${resolved.text}`);
}

describe('AI scribe — on-demand run files a recap proposal (e2e)', () => {
  let harness: AiEvalHarness;
  beforeAll(async () => {
    harness = await createAiEvalHarness();
    owner = await createPersistedOwner(harness, 'scribe-on-demand-owner');
  });
  afterAll(async () => {
    await harness.close();
  });

  it('returns default config, updates an existing config, and lists jobs with limit', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Config And Jobs');

    const defaults = await request(harness.server).get(`${API}/campaigns/${campaignId}/scribe`).set(dm);
    expect(defaults.status).toBe(200);
    expect(defaults.body.postSession).toBe(false);
    expect(defaults.body.cron).toBe(false);
    expect(defaults.body.budgetPerRun).toBe(2000);

    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await seedResolvedInbox(harness, campaignId, 'The party rested at the inn.');
    harness.script({ text: 'A quiet night at the inn.' });
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);
    expect(Array.isArray(run.body.proposalIds)).toBe(true);
    expect(run.body.proposalIds.length).toBeGreaterThan(0);
    const proposalId = run.body.proposalIds[0] as number;
    expect((await request(harness.server).post(`${API}/proposals/${proposalId}/approve`).set(dm).send({})).status).toBe(201);

    await seedResolvedInbox(harness, campaignId, 'The party broke camp at dawn.');
    harness.script({ text: 'Dawn march toward the pass.' });
    const secondRun = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(secondRun.status).toBe(201);
    expect(secondRun.body.job.status).toBe('succeeded');

    const jobs = await request(harness.server).get(`${API}/campaigns/${campaignId}/scribe/jobs?limit=1`).set(dm);
    expect(jobs.status).toBe(200);
    expect(jobs.body).toHaveLength(1);
    expect(jobs.body[0].trigger).toBe('on_demand');
    expect(jobs.body[0].id).toBe(secondRun.body.job.id);

    const created = await request(harness.server)
      .put(`${API}/campaigns/${campaignId}/scribe`)
      .set(dm)
      .send({ cron: true, budgetPerRun: 1500 });
    expect(created.status).toBe(200);
    expect(created.body.cron).toBe(true);

    const updated = await request(harness.server)
      .put(`${API}/campaigns/${campaignId}/scribe`)
      .set(dm)
      .send({ postSession: true, budgetPerRun: 1200 });
    expect(updated.status).toBe(200);
    expect(updated.body.postSession).toBe(true);
    expect(updated.body.budgetPerRun).toBe(1200);
    expect(updated.body.cron).toBe(true);
  });

  it('uses the configured per-campaign provider when one is stored (#310)', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Configured Provider');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await harness.configureProvider(campaignId);
    await seedResolvedInbox(harness, campaignId, 'The bard negotiated safe passage.');

    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('succeeded');
    expect(run.body.job.provider).toBe('mock');
  });

  it('#877 sends only AI-consented support to the provider and drops it after revocation', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Support Consent');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await seedResolvedInbox(harness, campaignId, 'The party completed the first scene.');
    const route = `${API}/campaigns/${campaignId}/session-zero/support-preferences/me`;
    const supportText = 'SCRIBE_SUPPORT_SENTINEL_877';

    await request(harness.server).put(route).set(dm).send({
      supportText,
      visibility: 'facilitator',
      aiUseConsent: true,
    });
    harness.script({ text: 'First recap.' });
    const first = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(first.status).toBe(201);
    expect(harness.mock.received.at(-1)?.system ?? '').toContain(supportText);

    const proposalId = first.body.proposalIds[0] as number;
    expect((await request(harness.server).post(`${API}/proposals/${proposalId}/approve`).set(dm).send({})).status).toBe(201);
    await seedResolvedInbox(harness, campaignId, 'The party completed a second scene.');
    await request(harness.server).put(route).set(dm).send({
      supportText,
      visibility: 'facilitator',
      aiUseConsent: false,
    });
    harness.script({ text: 'Second recap.' });
    const second = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(second.status).toBe(201);
    expect(second.body.job.status).toBe('succeeded');
    expect(harness.mock.received.at(-1)?.system ?? '').not.toContain(supportText);
  });

  it('drafts a recap from real material, files it as a pending proposal, meters the seat, and never touches canon', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe On-Demand');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000, instructions: 'Terse chronicler.' });
    await seedResolvedInbox(harness, campaignId, 'The rogue disarmed the vault trap.');

    harness.script({ text: 'The heroes cracked the vault, the rogue defusing its trap at the last breath.' });

    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('succeeded');
    expect(run.body.job.trigger).toBe('on_demand');
    expect(run.body.proposalIds).toHaveLength(1);
    expect(run.body.job.tokensUsed).toBeGreaterThan(0);

    // The recap is a PENDING session-create proposal carrying the scripted prose — not canon.
    const proposals = await request(harness.server).get(`${API}/campaigns/${campaignId}/proposals`).set(dm);
    expect(proposals.status).toBe(200);
    expect(proposals.body).toHaveLength(1);
    const proposal = proposals.body[0];
    expect(proposal.entityType).toBe('session');
    expect(proposal.action).toBe('create');
    expect(proposal.status).toBe('pending');
    const payload = typeof proposal.payload === 'string' ? JSON.parse(proposal.payload) : proposal.payload;
    expect(payload.recap).toContain('cracked the vault');

    // #383: an AI-written recap is attributed to the AI scribe (the `ai-dm:` prefix the review-queue
    // badge/filter keys on) — NOT the human DM who triggered the on-demand run. Previously an
    // on-demand run recorded the DM's own id + display name as proposer, misattributing the AI draft.
    expect(proposal.proposerUserId).toBe(`ai-dm:${campaignId}`);
    expect(proposal.proposer).toContain('AI Scribe');
    expect(proposal.proposerUserId).not.toBe('dev:ai-eval-dm');

    // Nothing was published to canon — no session row yet.
    const sessions = await request(harness.server).get(`${API}/campaigns/${campaignId}/sessions`).set(dm);
    expect(sessions.body).toHaveLength(0);

    // Budget was metered against the seat (#1055: scribe runs bump activity counters too).
    const seat = await harness.getSeat(campaignId);
    expect(seat.body.tokensUsed).toBeGreaterThan(0);
    expect(seat.body.turnCount).toBe(1);
    expect(seat.body.lastTurnAt).not.toBeNull();

    // Config + job log reads (covers controller getConfig/jobs + service.listJobs).
    const cfg = await request(harness.server).get(`${API}/campaigns/${campaignId}/scribe`).set(dm);
    expect(cfg.status).toBe(200);
    expect(cfg.body.budgetPerRun).toBeGreaterThan(0);
    const jobs = await request(harness.server).get(`${API}/campaigns/${campaignId}/scribe/jobs`).set(dm);
    expect(jobs.status).toBe(200);
    expect(jobs.body.some((j: { status: string; trigger: string }) => j.status === 'succeeded' && j.trigger === 'on_demand')).toBe(
      true,
    );

    // Approving the proposal is what finally publishes the recap (co-DM discipline).
    const approve = await request(harness.server).post(`${API}/proposals/${proposal.id}/approve`).set(dm).send({});
    expect(approve.status).toBe(201);
    const after = await request(harness.server).get(`${API}/campaigns/${campaignId}/sessions`).set(dm);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].recapExcerpt).toContain('cracked the vault');
  });

  it('records a failed job when seat metering throws (#1055)', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Meter Fail');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await seedResolvedInbox(harness, campaignId, 'The wizard sealed the rift.');

    const { AiDmService } = await import('../src/modules/ai-dm/ai-dm.service');
    const aiDm = harness.ctx.app.get(AiDmService);
    const spy = jest.spyOn(aiDm, 'meterTurn').mockRejectedValueOnce(new Error('injected metering failure'));

    harness.script({ text: 'The rift closed with a whisper of spent magic.' });
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('failed');
    expect(run.body.job.detail).toMatch(/metering error: injected metering failure/);
    expect(run.body.proposalIds).toHaveLength(0);

    // Metering threw after provider contact. The reservation is consumed as
    // unknown spend rather than refunded, so future budget gates stay conservative.
    const seat = await harness.getSeat(campaignId);
    expect(seat.body.tokensUsed).toBe(0);
    expect(seat.body.tokensReserved).toBe(0);
    expect(seat.body.tokensUnknown).toBeGreaterThan(0);
    expect(seat.body.turnCount).toBe(1);
    expect(seat.body.lastTurnAt).not.toBeNull();

    spy.mockRestore();
  });

  it('is idempotent: a re-run while a recap proposal is pending is a no-op that returns the same proposal', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Idempotent');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await seedResolvedInbox(harness, campaignId, 'The party parleyed with the goblins.');

    harness.script({ text: 'A fragile truce with the goblin warren was struck.' });
    const first = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(first.body.job.status).toBe('succeeded');
    const proposalId = first.body.proposalIds[0];

    const second = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(second.body.job.status).toBe('skipped');
    expect(second.body.proposalIds).toEqual([proposalId]);

    // Still exactly one proposal — no duplicate recap.
    const proposals = await request(harness.server).get(`${API}/campaigns/${campaignId}/proposals`).set(dm);
    expect(proposals.body).toHaveLength(1);
  });

  it('dry run previews the recap without filing a proposal, but still meters the seat (#1055)', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Dry Run');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await seedResolvedInbox(harness, campaignId, 'The cleric consecrated the ruined shrine.');

    harness.script({ text: 'Light returned to the shrine as the cleric spoke the old words.' });
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({ dryRun: true });
    expect(run.status).toBe(201);
    expect(run.body.preview).toContain('Light returned to the shrine');
    expect(run.body.proposalIds).toHaveLength(0);

    const proposals = await request(harness.server).get(`${API}/campaigns/${campaignId}/proposals`).set(dm);
    expect(proposals.body).toHaveLength(0);

    // Dry-run still burned provider tokens — meterTurn must bump turnCount/lastTurnAt.
    const seat = await harness.getSeat(campaignId);
    expect(seat.body.tokensUsed).toBeGreaterThan(0);
    expect(seat.body.turnCount).toBe(1);
    expect(seat.body.lastTurnAt).not.toBeNull();
  });

  it('keeps an earlier pending proposal blocked after a newer successful dry run (#1491)', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Pending Before Dry Run');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await seedResolvedInbox(harness, campaignId, 'The party found the sealed observatory.');

    harness.script({ text: 'The party found the sealed observatory.' });
    const first = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(first.body.job.status).toBe('succeeded');
    const proposalId = first.body.proposalIds[0] as number;

    await seedResolvedInbox(harness, campaignId, 'The party mapped the observatory dome.');
    harness.script({ text: 'A dry-run preview of the observatory dome.' });
    const preview = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({ dryRun: true, force: true });
    expect(preview.body.job.status).toBe('succeeded');
    expect(preview.body.job.proposalId).toBeNull();

    await seedResolvedInbox(harness, campaignId, 'The party heard machinery beneath the floor.');
    harness.script({ text: 'A forced draft about the machinery beneath the floor.' });
    const forced = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({ force: true });
    const forcedProposalId = forced.body.proposalIds[0] as number;
    expect((await request(harness.server).post(`${API}/proposals/${forcedProposalId}/reject`).set(dm).send({})).status).toBe(201);

    await seedResolvedInbox(harness, campaignId, 'The party found a hidden stair below the observatory.');
    const blocked = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(blocked.body.job.status).toBe('skipped');
    expect(blocked.body.proposalIds).toEqual([proposalId]);
  });

  it('is gated: with the experimental flag off, a run is disabled and files nothing', async () => {
    // Flag off for this campaign's run: disable it server-wide first.
    await request(harness.server).patch(`${API}/settings`).set(dm).send({ experimentalAiDm: false });
    const campaignId = await ownedCampaign('Scribe Gated');
    await seedResolvedInbox(harness, campaignId, 'irrelevant');

    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('disabled');
    expect(run.body.proposalIds).toHaveLength(0);

    // Re-enable so this suite leaves the flag on for any later assertions.
    await harness.enableExperimental();
  });

  it('meters reported usage when the provider returns an empty recap', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Empty Provider Response');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 100 });
    await seedResolvedInbox(harness, campaignId, 'The party waited for the chronicler.');

    harness.script({
      text: '',
      usage: { promptTokens: 7, completionTokens: 0, totalTokens: 7 },
    });
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('failed');
    expect(run.body.job.detail).toContain('empty recap');
    expect(run.body.job.tokensUsed).toBe(7);
    expect(run.body.proposalIds).toHaveLength(0);

    const seat = await harness.getSeat(campaignId);
    expect(seat.body.tokensUsed).toBe(7);
    expect(seat.body.turnCount).toBe(1);
  });

  it('reports no_material when there is nothing to recap', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Empty');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.body.job.status).toBe('no_material');
    expect(run.body.proposalIds).toHaveLength(0);
  });
});

describe('AI driver + scribe — shared spend lock (#1058)', () => {
  let harness: AiEvalHarness;

  beforeAll(async () => {
    harness = await createAiEvalHarness({ model: 'shared-budget-model' });
    owner = await createPersistedOwner(harness, 'scribe-spend-lock-owner');
    await harness.enableExperimental();
  });
  afterAll(async () => {
    await harness.close();
  });

  it('admits only one provider operation when both queued spenders see the final token', async () => {
    const campaignId = await ownedCampaign('Driver Scribe Budget Race');
    await harness.configureSeat(campaignId, { mode: 'driver', tokenBudget: 1 });
    await seedResolvedInbox(harness, campaignId, 'The party escaped with the final ember.');

    const aiDm = harness.ctx.app.get(AiDmService);
    const driver = harness.ctx.app.get(AiDriverService);
    const scribe = harness.ctx.app.get(ScribeService);
    const user = { id: 'dev:ai-eval-dm', name: 'ai-eval-dm', serverRole: 'user' as const, devRole: 'dm' as const };

    // Hold the shared mutex until both real consumers have passed their cheap
    // pre-checks and joined its queue with the same one-token snapshot.
    let releaseHolder!: () => void;
    let holderStarted!: () => void;
    const holderReady = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = aiDm.withSpendLock(campaignId, async () => {
      holderStarted();
      await holderGate;
    });
    await holderReady;

    const lockSpy = jest.spyOn(aiDm, 'withSpendLock');
    harness.script({
      text: 'The final ember gutters out.',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const driverRun = driver.runTurn(campaignId, user, 'Guard the ember.');
    const scribeRun = scribe.run(campaignId, 'on_demand', user);

    let bothQueued = false;
    try {
      const deadline = Date.now() + 2_000;
      while (lockSpy.mock.calls.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      bothQueued = lockSpy.mock.calls.length >= 2;
    } finally {
      releaseHolder();
    }

    const [driverResult, scribeResult] = await Promise.all([driverRun, scribeRun]);
    await holder;
    lockSpy.mockRestore();

    expect(bothQueued).toBe(true);
    const admitted = Number(driverResult.steps === 1) + Number(scribeResult.job.status === 'succeeded');
    expect(admitted).toBe(1);
    if (driverResult.steps === 1) {
      expect(scribeResult.job.status).toBe('over_budget');
    } else {
      expect(driverResult.stopReason).toBe('budget_exhausted');
      expect(scribeResult.job.status).toBe('succeeded');
    }

    const seat = await harness.getSeat(campaignId);
    expect(seat.body.tokensReserved).toBe(0);
    expect(seat.body.tokensUsed).toBeGreaterThan(1);
    expect(seat.body.tokensOverage).toBe(seat.body.tokensUsed - 1);
    expect(seat.body.turnCount).toBe(1);
  });
});

describe('AI scribe — post-session sweep (e2e)', () => {
  let harness: AiEvalHarness;
  beforeAll(async () => {
    harness = await createAiEvalHarness();
    owner = await createPersistedOwner(harness, 'scribe-sweep-owner');
  });
  afterAll(async () => {
    await harness.close();
  });

  it('sweep() drafts a recap for a campaign whose scheduled game night has ended and postSession is on', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Sweep');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await seedResolvedInbox(harness, campaignId, 'The dragon was driven from its lair.');

    const cfg = await request(harness.server).put(`${API}/campaigns/${campaignId}/scribe`).set(dm).send({ postSession: true });
    expect(cfg.status).toBe(200);
    expect(cfg.body.postSession).toBe(true);

    const past = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const sched = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: past, durationMinutes: 60, title: 'Session 12' });
    expect(sched.status).toBe(201);
    const scheduledSessionId = sched.body.id as number;

    harness.script({ text: 'With fire and steel the wyrm was routed from the mountain.' });

    const svc = harness.ctx.app.get(ScribeService);
    const results = await svc.sweep();
    const mine = results.find((r) => r.job.campaignId === campaignId);
    expect(mine?.job.status).toBe('succeeded');
    expect(mine?.job.trigger).toBe('post_session');
    expect(mine?.job.scheduledSessionId).toBe(scheduledSessionId);
    expect(mine?.sourcePreview?.resolvedInbox).toBe(1);

    const proposals = await request(harness.server).get(`${API}/campaigns/${campaignId}/proposals`).set(dm);
    expect(proposals.body).toHaveLength(1);
    expect(proposals.body[0].entityType).toBe('session');

    // Exactly-once per scheduled session: no pending session means sweep skips this campaign.
    const again = await svc.sweep();
    const retry = again.find((r) => r.job.campaignId === campaignId);
    expect(retry).toBeUndefined();
    expect(proposals.body).toHaveLength(1);
  });

  it('retries a failed post-session run for the same night and only marks success complete', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe failed post-session retry');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await seedResolvedInbox(harness, campaignId, 'The party found the missing map.');
    await request(harness.server).put(`${API}/campaigns/${campaignId}/scribe`).set(dm).send({ postSession: true });
    const scheduled = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), durationMinutes: 60, title: 'Retry night' });

    const svc = harness.ctx.app.get(ScribeService);
    harness.script({ text: '' });
    const failed = (await svc.sweep()).find((result) => result.job.campaignId === campaignId);
    expect(failed?.job).toMatchObject({ status: 'failed', scheduledSessionId: scheduled.body.id });

    harness.script({ text: 'The recovered map showed a safe path through the marsh.' });
    const retried = (await svc.sweep()).find((result) => result.job.campaignId === campaignId);
    expect(retried?.job).toMatchObject({ status: 'succeeded', scheduledSessionId: scheduled.body.id });

    expect((await svc.sweep()).some((result) => result.job.campaignId === campaignId)).toBe(false);
  });

  it('advances past a terminal identical-source post-session skip without stamping the schedule id (#1491)', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe terminal duplicate skip');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await request(harness.server).put(`${API}/campaigns/${campaignId}/scribe`).set(dm).send({ postSession: true });
    const first = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(), durationMinutes: 60, title: 'First night' });
    await seedResolvedInbox(harness, campaignId, 'The party found a cipher in the ruins.');

    harness.script({ text: 'The party found a cipher in the ruins.' });
    const manual = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/scribe/run`)
      .set(dm)
      .send({ scheduledSessionId: first.body.id });
    expect(manual.body.job.status).toBe('succeeded');
    expect((await request(harness.server).post(`${API}/proposals/${manual.body.proposalIds[0]}/reject`).set(dm).send({})).status).toBe(201);

    const svc = harness.ctx.app.get(ScribeService);
    const duplicate = (await svc.sweep()).find((result) => result.job.campaignId === campaignId);
    expect(duplicate?.job).toMatchObject({ status: 'skipped', scheduledSessionId: null });
    expect(duplicate?.job.sourceStats?.scheduledSessionId).toBe(first.body.id);

    const second = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), durationMinutes: 60, title: 'Second night' });
    await seedResolvedInbox(harness, campaignId, 'The cipher revealed a route to the observatory.');
    harness.script({ text: 'The cipher revealed a route to the observatory.' });
    const next = (await svc.sweep()).find((result) => result.job.campaignId === campaignId);
    expect(next?.job.scheduledSessionId).toBe(second.body.id);
  });

  it('scopes post-session material to one scheduled game night (#499)', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Session Scope');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await request(harness.server).put(`${API}/campaigns/${campaignId}/scribe`).set(dm).send({ postSession: true });

    const svc = harness.ctx.app.get(ScribeService);

    // First ended session — no material yet; records no_material and marks session processed.
    const firstPast = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    const first = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: firstPast, durationMinutes: 60, title: 'Session A' });
    const firstSweep = await svc.sweep();
    const firstRun = firstSweep.find((r) => r.job.campaignId === campaignId);
    expect(firstRun?.job.status).toBe('no_material');
    expect(firstRun?.job.scheduledSessionId).toBe(first.body.id);

    // Second ended session — only this night's inbox should be assembled.
    const secondPast = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const second = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: secondPast, durationMinutes: 60, title: 'Session B' });
    const scheduledSessionId = second.body.id as number;
    await seedResolvedInbox(harness, campaignId, 'Tonight the vault trap was disarmed.');

    harness.script({ text: 'The rogue disarmed the vault trap under torchlight.' });
    const results = await svc.sweep();
    const mine = results.find((r) => r.job.campaignId === campaignId);
    expect(mine?.job.status).toBe('succeeded');
    expect(mine?.job.scheduledSessionId).toBe(scheduledSessionId);
    expect(mine?.sourcePreview?.resolvedInbox).toBe(1);

    const proposals = await request(harness.server).get(`${API}/campaigns/${campaignId}/proposals`).set(dm);
    expect(proposals.body).toHaveLength(1);
    const payload = typeof proposals.body[0].payload === 'string' ? JSON.parse(proposals.body[0].payload) : proposals.body[0].payload;
    expect(payload.recap).toContain('vault trap');

    harness.script({ text: 'A forced second draft of the vault night.' });
    const forced = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/scribe/run`)
      .set(dm)
      .send({ force: true, scheduledSessionId });
    expect(forced.status).toBe(201);
    expect(forced.body.job.status).toBe('succeeded');
    expect(forced.body.sourcePreview?.scheduledSessionId).toBe(scheduledSessionId);
  });

  it('rejects a manual run pointed at a schedule that is not draftable (#504)', async () => {
    // The draftable filter (effectively-'scheduled' rows only) used to make an
    // explicitly-requested cancelled/completed/unknown id resolve to NO scope at all,
    // so the run silently drafted over the wrong window and reported success.
    await harness.enableExperimental();
    const campaignId = await harness.createCampaign('Scribe Scope Errors');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });

    const past = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const sched = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: past, durationMinutes: 60, title: 'Called off' });
    expect(sched.status).toBe(201);
    await request(harness.server).delete(`${API}/schedule/${sched.body.id}`).set(dm).send({}).expect(200);

    const cancelled = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/scribe/run`)
      .set(dm)
      .send({ scheduledSessionId: sched.body.id });
    expect(cancelled.status).toBe(400);
    expect(cancelled.body.message).toContain('cancelled');

    const unknown = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/scribe/run`)
      .set(dm)
      .send({ scheduledSessionId: 999999 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toContain('not found');
  });

  it('sweep() runs cron-enabled campaigns with cursor-scoped material', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Cron Sweep');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await seedResolvedInbox(harness, campaignId, 'The watch reported movement on the ridge.');

    const cfg = await request(harness.server).put(`${API}/campaigns/${campaignId}/scribe`).set(dm).send({ cron: true });
    expect(cfg.status).toBe(200);

    harness.script({ text: 'Patrols doubled along the ridge road.' });

    const svc = harness.ctx.app.get(ScribeService);
    const results = await svc.sweep();
    const mine = results.find((r) => r.job.campaignId === campaignId);
    expect(mine?.job.status).toBe('succeeded');
    expect(mine?.job.trigger).toBe('cron');
  });
});

/**
 * Issue #501 — external-AI consent on the PRODUCTION identity path.
 *
 * The rest of this file drives the server with DEV_AUTH headers, whose principals are
 * synthetic `dev:<name>` users with no `users` row and — by design — no membership row
 * (MembersService.addCreatorAsDm: "skipped for dev:* users"). Those principals can never
 * record consent, so they cannot exercise this feature at all.
 *
 * This block therefore logs in a REAL persisted account over a cookie session.
 * SessionAuthGuard resolves the session cookie BEFORE the dev headers, so these requests
 * run the same identity path a deployed install uses: `notes.author_user_id` is
 * `String(users.id)`, and `campaign_members.user_id` is that same `users.id`, which is what
 * the consent join compares.
 */
describe('AI scribe — external AI consent, persisted account (e2e, #501)', () => {
  let harness: AiEvalHarness;
  let agent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let myUserId: number;
  const SENTINEL = 'CONSENT_SENTINEL_501_THE_TAVERN_KEEPER_FLED';

  beforeAll(async () => {
    harness = await createAiEvalHarness();
    // NOTE: deliberately does NOT go through ownedCampaign() — that helper grants consent,
    // and this block exists to assert the fail-closed default before any consent is given.
    const persisted = await createPersistedOwner(harness, 'scribe-consent-dm');
    agent = persisted.agent;
    myUserId = persisted.userId;

    await harness.enableExperimental();
    const created = await agent.post(`${API}/campaigns`).send({ name: 'Scribe Consent Persisted' });
    if (created.status !== 201) throw new Error(`createCampaign failed: ${created.status} ${created.text}`);
    campaignId = created.body.id as number;
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    // A STORED provider config is what makes a run an EXTERNAL send, and external use is
    // the entire scope of #501. Without one the run falls through to the injected seam,
    // where `endpointScope` resolves to 'injected'/'none' and nothing leaves the server —
    // there, external-use consent is not the applicable gate. That path is asserted on its
    // own in the "local generation" block below.
    await harness.configureProvider(campaignId);

    // Author the ONLY source material as the persisted member.
    const submitted = await agent.post(`${API}/campaigns/${campaignId}/inbox`).send({ body: SENTINEL });
    if (submitted.status !== 201) throw new Error(`inbox submit failed: ${submitted.status} ${submitted.text}`);
    const resolved = await agent
      .post(`${API}/notes/${submitted.body.id}/resolve`)
      .send({ resolvedNote: 'handled in play' });
    if (resolved.status !== 201) throw new Error(`inbox resolve failed: ${resolved.status} ${resolved.text}`);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('the creator gets a real membership row keyed on users.id, and their note carries that same id', async () => {
    const members = await agent.get(`${API}/campaigns/${campaignId}/members`);
    expect(members.status).toBe(200);
    const me = members.body.find((m: { userId: number }) => m.userId === myUserId);
    expect(me).toBeDefined();
    // Fail-closed default: a brand-new membership has NOT consented.
    expect(me.aiExternalUseConsent).toBe(false);

    // The note's author id is the stringified form of the very same users.id the
    // membership row is keyed on — this is the join the consent filter performs.
    const inbox = await agent.get(`${API}/campaigns/${campaignId}/inbox?resolved=true`);
    expect(inbox.status).toBe(200);
    const note = inbox.body.items.find((n: { body: string }) => n.body === SENTINEL);
    expect(note).toBeDefined();
    expect(note.authorUserId).toBe(String(myUserId));
    expect(note.visibility).toBe('dm_shared');
  });

  it('withholds the note from the provider entirely while consent is unset (fail closed)', async () => {
    const before = harness.mock.received.length;
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});

    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('no_material');
    // The strongest form of the guarantee: the provider was never called at all.
    expect(harness.mock.received.length).toBe(before);
    expect(run.body.job.sourceStats.excludedInboxByConsent).toBe(1);

    // …and the withheld count reaches the caller as HUMAN-READABLE detail, not a bare
    // "nothing to recap". Silent degradation here is what operators experience as
    // "the scribe broke after upgrading" (#501 review).
    expect(run.body.job.detail).toMatch(/1 note withheld pending author consent/);
  });

  it('lets a persisted member record consent, then includes their note in the prompt', async () => {
    const consent = await agent
      .patch(`${API}/campaigns/${campaignId}/members/me/ai-consent`)
      .send({ aiExternalUseConsent: true });
    // The dev-auth principals used by the rest of this file get 403 here; a persisted
    // account is exactly what the endpoint requires.
    expect(consent.status).toBe(200);
    expect(consent.body.aiExternalUseConsent).toBe(true);

    harness.script({ text: 'The tavern keeper fled into the night.' });
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('succeeded');

    // The note actually made it into the assembled source the prompt is built from.
    //
    // This campaign runs on a STORED provider config (see beforeAll), so the request is
    // served by a provider the factory constructs per run — not the harness's injected
    // instance, whose `.received` log therefore stays empty on this path. The archived
    // source stats and provenance ARE the authoritative record of what was drafted from,
    // and they distinguish this run from the withheld case above unambiguously.
    expect(run.body.job.sourceStats.resolvedInbox).toBe(1);
    expect(run.body.job.provider).toBe('mock');

    // …and the durable provenance names the consenting author.
    const provenance = run.body.job.generationProvenance;
    expect(provenance).toBeTruthy();
    expect(provenance.consent.campaignPolicy).toBe('member_consent');
    expect(provenance.consent.externalSend).toBe(true);
    expect(provenance.consent.includedAuthorUserIds).toEqual([String(myUserId)]);
    expect(provenance.consent.includedInboxCount).toBe(1);
    expect(provenance.consent.excludedInboxByConsent).toBe(0);
    expect(provenance.promptHash).toEqual(expect.any(String));
  });

  it('stops including the note once consent is revoked, and the provenance survives a re-read', async () => {
    const jobsBefore = await request(harness.server).get(`${API}/campaigns/${campaignId}/scribe/jobs`).set(dm);
    expect(jobsBefore.status).toBe(200);
    const succeeded = jobsBefore.body.find((j: { status: string }) => j.status === 'succeeded');
    // Durability: provenance is read back off the row, not rebuilt from memory.
    expect(succeeded.generationProvenance.consent.includedAuthorUserIds).toEqual([String(myUserId)]);

    const revoke = await agent
      .patch(`${API}/campaigns/${campaignId}/members/me/ai-consent`)
      .send({ aiExternalUseConsent: false });
    expect(revoke.status).toBe(200);

    const before = harness.mock.received.length;
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('no_material');
    expect(harness.mock.received.length).toBe(before);
  });

  it('excludes a consenting member\'s note when the campaign policy is disabled', async () => {
    const consent = await agent
      .patch(`${API}/campaigns/${campaignId}/members/me/ai-consent`)
      .send({ aiExternalUseConsent: true });
    expect(consent.status).toBe(200);

    const policy = await agent
      .patch(`${API}/campaigns/${campaignId}`)
      .send({ aiExternalContentPolicy: 'disabled' });
    expect(policy.status).toBe(200);
    expect(policy.body.aiExternalContentPolicy).toBe('disabled');

    // Re-READ rather than trust the PATCH response. If `update()` ever moved from a
    // generic `.set({ ...input })` to a field allow-list that forgot this column, the
    // toggle would silently no-op while the PATCH still echoed the requested value —
    // and this spec would keep passing against a dead control (#501 review).
    const reread = await agent.get(`${API}/campaigns/${campaignId}`);
    expect(reread.status).toBe(200);
    expect(reread.body.aiExternalContentPolicy).toBe('disabled');

    const before = harness.mock.received.length;
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('no_material');
    expect(harness.mock.received.length).toBe(before);

    // The DM must be told the CAUSE, and it is not a missing opt-in: under a disabled
    // policy no amount of member consent changes the outcome, so advising one sends
    // everybody — DM and players alike — to a control that will appear broken when they
    // use it (#501 review).
    expect(run.body.job.detail).toContain('AI content policy');
    expect(run.body.job.detail).not.toContain('pending author consent');
    expect(run.body.job.detail).not.toMatch(/opt in/i);

    // The volume is still reported truthfully whatever the cause, and the archived policy
    // is what lets the DM-facing UI pick the right remedy on a run that, being
    // `no_material`, records no provenance to read the policy from.
    expect(run.body.job.sourceStats.excludedInboxByConsent).toBeGreaterThan(0);
    expect(run.body.job.sourceStats.campaignPolicy).toBe('disabled');
    expect(run.body.job.generationProvenance).toBeNull();
  });
});

/**
 * Issue #501 review — the SERVER-scope endpoint URL must not reach provenance.
 *
 * `getEffectiveView` deliberately withholds the admin-managed server-default provider
 * config from campaign DMs: it returns type/model/source/readiness and NOT `baseUrl`.
 * Generation provenance is persisted on scribe jobs and filed proposals, both readable by
 * any campaign DM and rendered verbatim in the proposals UI — so writing the server row's
 * `baseUrl` there would reach around that boundary and disclose internal topology.
 *
 * The scope IS kept: "this ran against the server default" is the provenance-bearing part.
 */
describe('AI scribe — server-scope endpoint URL never lands in provenance (e2e, #501)', () => {
  let harness: AiEvalHarness;
  const SERVER_BASE_URL = 'http://localhost:11434/campfire-internal-gateway';

  beforeAll(async () => {
    harness = await createAiEvalHarness();
    owner = await createPersistedOwner(harness, 'scribe-server-endpoint-owner');
    await harness.enableExperimental();

    // SERVER-default provider (admin-managed), with an endpoint a DM must not learn.
    // Set here rather than inside a case so each case stands alone under `-t` filtering.
    const server = await request(harness.server)
      .put(`${API}/settings/ai-provider`)
      .set(dm)
      .send({ providerType: 'mock', model: 'mock-1', apiKey: 'sk-server-key-1234', baseUrl: SERVER_BASE_URL });
    expect(server.status).toBe(200);
  });
  afterAll(async () => {
    await harness.close();
  });

  it('records endpoint.scope=server but a null baseUrl', async () => {
    await harness.enableExperimental();
    // No per-campaign override at all — the run inherits the server default outright.
    const campaignId = await ownedCampaign('Scribe Server Endpoint Provenance');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });

    await seedResolvedInbox(harness, campaignId, 'The caravan reached the gate.');
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('succeeded');

    const provenance = run.body.job.generationProvenance;
    expect(provenance).toBeTruthy();
    expect(provenance.endpoint.scope).toBe('server');
    // The whole point: scope survives, the URL does not.
    expect(provenance.endpoint.baseUrl).toBeNull();

    // And it is absent from the DURABLE row too, not merely from this response — a
    // read-time redaction would leave it in the DB for exports/backups to leak later.
    const jobs = await request(harness.server).get(`${API}/campaigns/${campaignId}/scribe/jobs`).set(dm);
    expect(jobs.status).toBe(200);
    expect(JSON.stringify(jobs.body)).not.toContain('campfire-internal-gateway');
  });

  /**
   * The configuration that defeated the FIRST version of this fix.
   *
   * A KEYLESS campaign override inherits the SERVER row's baseUrl + providerType (the #373
   * invariant binding the endpoint to whoever owns the key) — but `getEffectiveView().source`
   * still reports `'campaign'`, because it answers "does a campaign row exist?" rather than
   * "whose endpoint is this?". Keying the redaction off that kept the server URL.
   *
   * The DM cannot obtain this URL any other way: the campaign provider view shows only the
   * campaign row's own baseUrl, never the inherited server one.
   */
  it('reports scope=server for a KEYLESS campaign override, which runs on the server endpoint', async () => {
    await harness.enableExperimental();
    const campaignId = await ownedCampaign('Scribe Keyless Override Provenance');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });

    // The server default (key + internal endpoint) comes from beforeAll. Add a campaign
    // override carrying a model but NO key of its own.
    const override = await request(harness.server)
      .put(`${API}/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'mock', model: 'mock-1' });
    expect(override.status).toBe(200);

    await seedResolvedInbox(harness, campaignId, 'The gatehouse keys went missing.');
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('succeeded');

    const provenance = run.body.job.generationProvenance;
    // Truthful as well as safe: the draft really did execute against the SERVER endpoint.
    expect(provenance.endpoint.scope).toBe('server');
    expect(provenance.endpoint.baseUrl).toBeNull();

    const jobs = await request(harness.server).get(`${API}/campaigns/${campaignId}/scribe/jobs`).set(dm);
    expect(JSON.stringify(jobs.body)).not.toContain('campfire-internal-gateway');
  });
});

/**
 * Issue #501 — the LOCAL generation path.
 *
 * #501 is scoped to external use: "Scribing can send player-authored notes to EXTERNAL
 * providers without member-level consent." When no provider config is stored, the run
 * falls through to the injected/no-op seam — `endpointScope` resolves to 'injected'/'none'
 * and no bytes leave the server. Enforcing external-use consent there is over-broad, and
 * because consent defaults to false it would silently empty every recap on an upgraded
 * install and on the default self-hosted deployment.
 *
 * This block is the inverse of the one above: SAME fail-closed member state (no consent
 * ever granted), NO stored provider — and the note must be retained.
 */
describe('AI scribe — local generation retains notes without external consent (e2e, #501)', () => {
  let harness: AiEvalHarness;
  let agent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let myUserId: number;
  const SENTINEL = 'LOCAL_SENTINEL_501_THE_MILLER_KEPT_A_LEDGER';

  beforeAll(async () => {
    harness = await createAiEvalHarness();
    const persisted = await createPersistedOwner(harness, 'scribe-local-dm');
    agent = persisted.agent;
    myUserId = persisted.userId;

    await harness.enableExperimental();
    const created = await agent.post(`${API}/campaigns`).send({ name: 'Scribe Local Generation' });
    if (created.status !== 201) throw new Error(`createCampaign failed: ${created.status} ${created.text}`);
    campaignId = created.body.id as number;
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    // Deliberately NO configureProvider() — this is the injected/no-op seam.

    const submitted = await agent.post(`${API}/campaigns/${campaignId}/inbox`).send({ body: SENTINEL });
    if (submitted.status !== 201) throw new Error(`inbox submit failed: ${submitted.status} ${submitted.text}`);
    const resolved = await agent
      .post(`${API}/notes/${submitted.body.id}/resolve`)
      .send({ resolvedNote: 'handled in play' });
    if (resolved.status !== 201) throw new Error(`inbox resolve failed: ${resolved.status} ${resolved.text}`);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('drafts a recap from a non-consenting member\'s note when nothing leaves the server', async () => {
    // Precondition: the author has NOT consented — the fail-closed default.
    const members = await agent.get(`${API}/campaigns/${campaignId}/members`);
    expect(members.status).toBe(200);
    expect(members.body.find((m: { userId: number }) => m.userId === myUserId).aiExternalUseConsent).toBe(false);

    harness.script({ text: 'The miller kept a careful ledger.' });
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});

    expect(run.status).toBe(201);
    // Before the fix this was `no_material`: the note was stripped on a path that sends nothing.
    expect(run.body.job.status).toBe('succeeded');
    expect(run.body.job.sourceStats.resolvedInbox).toBe(1);
    expect(run.body.job.sourceStats.excludedInboxByConsent).toBe(0);
  });

  it('reports externalSend=false on the config so the DM-facing confirmation cannot overstate', async () => {
    const cfg = await request(harness.server).get(`${API}/campaigns/${campaignId}/scribe`).set(dm);
    expect(cfg.status).toBe(200);
    // No provider row for this campaign, so a run cannot reach an external endpoint. The
    // panel keys its external-send warning off this — warning about a vendor call that
    // will not happen trains DMs to ignore the dialog before it matters (#501 review).
    expect(cfg.body.externalSend).toBe(false);
  });

  it('records provenance that is explicit about NOT having been an external send', async () => {
    const jobs = await request(harness.server).get(`${API}/campaigns/${campaignId}/scribe/jobs`).set(dm);
    expect(jobs.status).toBe(200);
    const succeeded = jobs.body.find((j: { status: string }) => j.status === 'succeeded');
    expect(succeeded).toBeDefined();

    const provenance = succeeded.generationProvenance;
    expect(provenance).toBeTruthy();
    // The endpoint really is the no-send seam…
    expect(['injected', 'none']).toContain(provenance.endpoint.scope);
    // …and the consent block says so, so `excludedInboxByConsent: 0` cannot be misread as
    // "every author consented".
    expect(provenance.consent.externalSend).toBe(false);
    expect(provenance.consent.excludedInboxByConsent).toBe(0);
    expect(provenance.consent.includedAuthorUserIds).toEqual([String(myUserId)]);
  });

  it('starts withholding the same note as soon as an external provider is configured', async () => {
    // Same campaign, same non-consenting member, same note — only the destination changes.
    await harness.configureProvider(campaignId);

    // The config now reports an external send, so the DM-facing warning flips on too.
    const cfg = await request(harness.server).get(`${API}/campaigns/${campaignId}/scribe`).set(dm);
    expect(cfg.status).toBe(200);
    expect(cfg.body.externalSend).toBe(true);

    const before = harness.mock.received.length;
    const run = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/scribe/run`)
      .set(dm)
      .send({ force: true });

    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('no_material');
    expect(harness.mock.received.length).toBe(before);
    expect(run.body.job.sourceStats.excludedInboxByConsent).toBe(1);
    expect(run.body.job.detail).toMatch(/1 note withheld pending author consent/);
  });
});
