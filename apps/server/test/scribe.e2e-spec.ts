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

const API = '/api/v1';

/** Seed resolvable source material: submit an inbox item and resolve it. */
async function seedResolvedInbox(harness: AiEvalHarness, campaignId: number, body: string): Promise<void> {
  const submitted = await request(harness.server).post(`${API}/campaigns/${campaignId}/inbox`).set(dm).send({ body });
  if (submitted.status !== 201) throw new Error(`inbox submit failed: ${submitted.status} ${submitted.text}`);
  const noteId = submitted.body.id as number;
  const resolved = await request(harness.server).post(`${API}/notes/${noteId}/resolve`).set(dm).send({ resolvedNote: 'handled in play' });
  if (resolved.status !== 201) throw new Error(`inbox resolve failed: ${resolved.status} ${resolved.text}`);
}

describe('AI scribe — on-demand run files a recap proposal (e2e)', () => {
  let harness: AiEvalHarness;
  beforeAll(async () => {
    harness = await createAiEvalHarness();
  });
  afterAll(async () => {
    await harness.close();
  });

  it('#877 sends only AI-consented support to the provider and drops it after revocation', async () => {
    await harness.enableExperimental();
    const campaignId = await harness.createCampaign('Scribe Support Consent');
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
    const campaignId = await harness.createCampaign('Scribe On-Demand');
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

    // Budget was metered against the seat.
    const seat = await harness.getSeat(campaignId);
    expect(seat.body.tokensUsed).toBeGreaterThan(0);

    // Approving the proposal is what finally publishes the recap (co-DM discipline).
    const approve = await request(harness.server).post(`${API}/proposals/${proposal.id}/approve`).set(dm).send({});
    expect(approve.status).toBe(201);
    const after = await request(harness.server).get(`${API}/campaigns/${campaignId}/sessions`).set(dm);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].recapExcerpt).toContain('cracked the vault');
  });

  it('is idempotent: a re-run while a recap proposal is pending is a no-op that returns the same proposal', async () => {
    await harness.enableExperimental();
    const campaignId = await harness.createCampaign('Scribe Idempotent');
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

  it('dry run previews the recap without filing a proposal', async () => {
    await harness.enableExperimental();
    const campaignId = await harness.createCampaign('Scribe Dry Run');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await seedResolvedInbox(harness, campaignId, 'The cleric consecrated the ruined shrine.');

    harness.script({ text: 'Light returned to the shrine as the cleric spoke the old words.' });
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({ dryRun: true });
    expect(run.status).toBe(201);
    expect(run.body.preview).toContain('Light returned to the shrine');
    expect(run.body.proposalIds).toHaveLength(0);

    const proposals = await request(harness.server).get(`${API}/campaigns/${campaignId}/proposals`).set(dm);
    expect(proposals.body).toHaveLength(0);
  });

  it('is gated: with the experimental flag off, a run is disabled and files nothing', async () => {
    // Flag off for this campaign's run: disable it server-wide first.
    await request(harness.server).patch(`${API}/settings`).set(dm).send({ experimentalAiDm: false });
    const campaignId = await harness.createCampaign('Scribe Gated');
    await seedResolvedInbox(harness, campaignId, 'irrelevant');

    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);
    expect(run.body.job.status).toBe('disabled');
    expect(run.body.proposalIds).toHaveLength(0);

    // Re-enable so this suite leaves the flag on for any later assertions.
    await harness.enableExperimental();
  });

  it('reports no_material when there is nothing to recap', async () => {
    await harness.enableExperimental();
    const campaignId = await harness.createCampaign('Scribe Empty');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    const run = await request(harness.server).post(`${API}/campaigns/${campaignId}/scribe/run`).set(dm).send({});
    expect(run.body.job.status).toBe('no_material');
    expect(run.body.proposalIds).toHaveLength(0);
  });
});

describe('AI scribe — post-session sweep (e2e)', () => {
  let harness: AiEvalHarness;
  beforeAll(async () => {
    harness = await createAiEvalHarness();
  });
  afterAll(async () => {
    await harness.close();
  });

  it('sweep() drafts a recap for a campaign whose scheduled game night has ended and postSession is on', async () => {
    await harness.enableExperimental();
    const campaignId = await harness.createCampaign('Scribe Sweep');
    await harness.configureSeat(campaignId, { enabled: true, tokenBudget: 5000 });
    await seedResolvedInbox(harness, campaignId, 'The dragon was driven from its lair.');

    // Opt this campaign into the post-session trigger.
    const cfg = await request(harness.server).put(`${API}/campaigns/${campaignId}/scribe`).set(dm).send({ postSession: true });
    expect(cfg.status).toBe(200);
    expect(cfg.body.postSession).toBe(true);

    // A scheduled game night in the past (its end time already elapsed).
    const past = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const sched = await request(harness.server)
      .post(`${API}/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: past, durationMinutes: 60, title: 'Session 12' });
    expect(sched.status).toBe(201);

    harness.script({ text: 'With fire and steel the wyrm was routed from the mountain.' });

    // Drive the sweep directly (the interval calls this; here we call it deterministically).
    const svc = harness.ctx.app.get(
      (await import('../src/modules/scribe/scribe.service')).ScribeService,
    );
    const results = await svc.sweep();
    const mine = results.find((r) => r.job.campaignId === campaignId);
    expect(mine?.job.status).toBe('succeeded');
    expect(mine?.job.trigger).toBe('post_session');

    const proposals = await request(harness.server).get(`${API}/campaigns/${campaignId}/proposals`).set(dm);
    expect(proposals.body).toHaveLength(1);
    expect(proposals.body[0].entityType).toBe('session');
  });
});
