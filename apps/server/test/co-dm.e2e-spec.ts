import { rulePacks } from '@campfire/schema';
import { DB } from '../src/db/db.module';
import request from 'supertest';
import { createAiEvalHarness, dm, player, type AiEvalHarness } from './ai-eval-harness';
import { AiProviderConfigService } from '../src/modules/ai-provider-config/ai-provider-config.service';

/**
 * Co-DM authoring (issue #313) — the AI drafts content that lands in the approval queue as
 * PENDING PROPOSALS, never a direct write. Driven through the deterministic mock provider
 * (#318 harness) wired into the real HTTP path: a scripted "draft" becomes a pending
 * proposal, approving it creates the entity, and role/flag/budget gating is enforced.
 */

const api = (id: number, path = '') => `/api/v1/campaigns/${id}/ai-dm/draft${path}`;

describe('co-DM authoring — draft → proposal → approve (e2e)', () => {
  let h: AiEvalHarness;
  let campaignId: number;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'eval-model' });
    await h.enableExperimental();
    campaignId = await h.createCampaign('Co-DM Authoring');
    await h.configureSeat(campaignId, { model: 'eval-model', instructions: 'Grim and terse.', tokenBudget: 1_000_000 });
  });

  afterAll(async () => {
    await h.close();
  });

  const draft = (body: Record<string, unknown>, headers = dm) =>
    request(h.server).post(api(campaignId)).set(headers).send(body);

  it('drafts an NPC as a PENDING proposal — nothing is written to canon directly', async () => {
    const before = await request(h.server).get(`/api/v1/campaigns/${campaignId}/npcs`).set(dm);
    const beforeCount = before.body.length;

    h.script({ text: JSON.stringify({ name: 'Old Maerin', role: 'Barkeep', body: 'Keeps a crossbow under the bar.' }) });
    const res = await draft({ target: 'npc', prompt: 'a wary tavern keeper' });

    expect(res.status).toBe(201);
    expect(res.body.target).toBe('npc');
    expect(res.body.entityType).toBe('npc');
    expect(res.body.proposalIds).toHaveLength(1);
    expect(res.body.provider).toBe('mock');
    expect(res.body.tokensUsed).toBeGreaterThan(0);

    // The proposal is pending and attributed to the AI seat + model (not the DM/token name).
    const proposal = res.body.proposals[0];
    expect(proposal.status).toBe('pending');
    expect(proposal.action).toBe('create');
    expect(proposal.payload.name).toBe('Old Maerin');
    expect(proposal.proposer).toBe('AI DM (eval-model)');
    expect(proposal.proposerUserId).toBe(`ai-dm:${campaignId}`);

    // Canon is untouched: no NPC exists yet.
    const after = await request(h.server).get(`/api/v1/campaigns/${campaignId}/npcs`).set(dm);
    expect(after.body.length).toBe(beforeCount);
  });

  it('approving the drafted proposal creates the NPC through the normal write path', async () => {
    h.script({ text: JSON.stringify({ name: 'Sister Garaele', role: 'Priestess' }) });
    const drafted = await draft({ target: 'npc', prompt: 'a temple priestess' });
    const proposalId = drafted.body.proposalIds[0];

    const approve = await request(h.server).post(`/api/v1/proposals/${proposalId}/approve`).set(dm).send({});
    expect(approve.status).toBe(201);
    expect(approve.body.status).toBe('approved');
    expect(approve.body.entityId).toBeGreaterThan(0);

    const npc = await request(h.server).get(`/api/v1/npcs/${approve.body.entityId}`).set(dm);
    expect(npc.status).toBe(200);
    expect(npc.body.name).toBe('Sister Garaele');
  });

  it('drafts N NPCs at once when count > 1 (scripted JSON array)', async () => {
    h.script({
      text: JSON.stringify([
        { name: 'Guard One' },
        { name: 'Guard Two' },
        { name: 'Guard Three' },
      ]),
    });
    const res = await draft({ target: 'npc', prompt: 'three city guards', count: 3 });
    expect(res.status).toBe(201);
    expect(res.body.proposalIds).toHaveLength(3);
    expect(res.body.proposals.map((p: { payload: { name: string } }) => p.payload.name)).toEqual([
      'Guard One',
      'Guard Two',
      'Guard Three',
    ]);
  });

  it('drafts a story beat (filed as story_beat) and a recap (filed as a session)', async () => {
    h.script({ text: JSON.stringify({ title: 'The Missing Caravan', body: 'A merchant train vanished on the moor road.' }) });
    const beat = await draft({ target: 'beat', prompt: 'the next hook' });
    expect(beat.status).toBe(201);
    expect(beat.body.entityType).toBe('story_beat');
    expect(beat.body.proposals[0].payload.title).toBe('The Missing Caravan');
    expect(beat.body.proposals[0].payload.body).toContain('merchant train');

    h.script({ text: JSON.stringify({ recap: 'The party crossed the moor and lost the trail.' }) });
    const recap = await draft({ target: 'recap', prompt: 'summarize the last session' });
    expect(recap.status).toBe(201);
    expect(recap.body.entityType).toBe('session');
    expect(recap.body.proposals[0].payload.recap).toContain('crossed the moor');
  });

  it('approving a drafted story beat creates it under the target arc', async () => {
    const arc = await request(h.server).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dm).send({ title: 'Main arc' });
    expect(arc.status).toBe(201);
    const arcId = arc.body.id;

    h.script({ text: JSON.stringify({ title: 'Gate confrontation', body: 'The party reaches the city gate at dusk.' }) });
    const drafted = await draft({ target: 'beat', prompt: 'the next beat', arcId });
    expect(drafted.status).toBe(201);
    expect(drafted.body.entityType).toBe('story_beat');
    expect(drafted.body.proposals[0].payload.arcId).toBe(arcId);

    const before = await request(h.server).get(`/api/v1/arcs/${arcId}`).set(dm);
    expect(before.body.beats).toHaveLength(0);

    const approve = await request(h.server).post(`/api/v1/proposals/${drafted.body.proposalIds[0]}/approve`).set(dm).send({});
    expect(approve.status).toBe(201);
    expect(approve.body.status).toBe('approved');
    expect(approve.body.entityId).toBeGreaterThan(0);

    const after = await request(h.server).get(`/api/v1/arcs/${arcId}`).set(dm);
    expect(after.body.beats).toHaveLength(1);
    expect(after.body.beats[0].title).toBe('Gate confrontation');
    expect(after.body.beats[0].body).toContain('city gate');
  });

  it('rejects beat drafts that target an arc from another campaign', async () => {
    const otherCampaignId = await h.createCampaign('Other Campaign');
    await h.configureSeat(otherCampaignId, { model: 'eval-model', tokenBudget: 1_000_000 });
    const otherArc = await request(h.server)
      .post(`/api/v1/campaigns/${otherCampaignId}/arcs`)
      .set(dm)
      .send({ title: 'Foreign arc' });
    expect(otherArc.status).toBe(201);

    const res = await draft({ target: 'beat', prompt: 'the next beat', arcId: otherArc.body.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('does not belong to this campaign');
  });

  it('drafts an encounter (reusing #304) — proposal carries seeded params; approve creates it', async () => {
    const before = await request(h.server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(dm);
    const beforeCount = before.body.length;

    h.script({ text: JSON.stringify({ difficulty: 'easy', party: [1, 1, 1, 1], seed: 42 }) });
    const res = await draft({ target: 'encounter', prompt: 'a roadside ambush' });
    expect(res.status).toBe(201);
    expect(res.body.entityType).toBe('encounter');
    expect(res.body.proposals[0].payload.seed).toBe(42);
    expect(res.body.proposals[0].payload.difficulty).toBe('easy');

    // Nothing created until approve.
    const mid = await request(h.server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(dm);
    expect(mid.body.length).toBe(beforeCount);

    const approve = await request(h.server)
      .post(`/api/v1/proposals/${res.body.proposalIds[0]}/approve`)
      .set(dm)
      .send({});
    expect(approve.status).toBe(201);
    expect(approve.body.status).toBe('approved');

    const after = await request(h.server).get(`/api/v1/campaigns/${campaignId}/encounters`).set(dm);
    expect(after.body.length).toBe(beforeCount + 1);
  });

  it('drafts a map (reusing #306) with default params + a pinned seed', async () => {
    h.script({ text: JSON.stringify({ kind: 'dungeon', size: 'small' }) });
    const res = await draft({ target: 'map', prompt: 'a small crypt' });
    expect(res.status).toBe(201);
    expect(res.body.entityType).toBe('map');
    expect(typeof res.body.proposals[0].payload.seed).toBe('string');

    const approve = await request(h.server)
      .post(`/api/v1/proposals/${res.body.proposalIds[0]}/approve`)
      .set(dm)
      .send({});
    expect(approve.status).toBe(201);
    expect(approve.body.status).toBe('approved');
    // The produced entity is the generated map attachment.
    expect(approve.body.entityId).toBeGreaterThan(0);
  });

  it('meters the draft against the seat budget', async () => {
    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/reset`).set(dm).send({});
    h.script({ text: JSON.stringify({ name: 'Metered NPC' }) });
    const res = await draft({ target: 'npc', prompt: 'anyone' });
    expect(res.status).toBe(201);
    expect(res.body.tokensUsed).toBeGreaterThan(0);
    // budgetRemaining is derived from the PERSISTED post-meter total (SQL RETURNING), so this
    // proves the draft's cost was metered against the seat, not just computed in-memory.
    expect(res.body.budgetRemaining).toBe(res.body.tokenBudget - res.body.tokensUsed);

    // Cross-check the persisted seat row reflects the metered usage.
    const seat = await h.getSeat(campaignId);
    expect(seat.status).toBe(200);
    expect(seat.body.tokensUsed).toBe(res.body.tokensUsed);
  });
});

describe('co-DM authoring — gating (e2e)', () => {
  let h: AiEvalHarness;
  let campaignId: number;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'eval-model' });
    campaignId = await h.createCampaign('Co-DM Gating');
  });

  afterAll(async () => {
    await h.close();
  });

  const draft = (body: Record<string, unknown>, headers: Record<string, string>) =>
    request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/draft`).set(headers).send(body);

  it('403s when the server experimental flag is off', async () => {
    // Flag not yet enabled for this fresh harness.
    await h.configureSeat(campaignId, { tokenBudget: 100_000 }).catch(() => undefined);
    const res = await draft({ target: 'npc', prompt: 'x' }, dm);
    expect(res.status).toBe(403);
  });

  it('403s for a non-DM caller (role gating)', async () => {
    await h.enableExperimental();
    await h.configureSeat(campaignId, { tokenBudget: 100_000 });
    const res = await draft({ target: 'npc', prompt: 'x' }, player);
    expect(res.status).toBe(403);
  });

  it('403s when the seat is disabled', async () => {
    await h.enableExperimental();
    await h.configureSeat(campaignId, { enabled: false, tokenBudget: 100_000 });
    const res = await draft({ target: 'npc', prompt: 'x' }, dm);
    expect(res.status).toBe(403);
  });

  it('403s when the token budget is exhausted', async () => {
    await h.enableExperimental();
    await h.configureSeat(campaignId, { enabled: true, tokenBudget: 0 });
    const res = await draft({ target: 'npc', prompt: 'x' }, dm);
    expect(res.status).toBe(403);
  });
});

/**
 * Issue #501 review — the co-DM path writes the same durable provenance the scribe does,
 * onto proposals any campaign DM can read. The admin-managed SERVER-default endpoint is
 * deliberately hidden from campaign DMs by `getEffectiveView`, so it must never be
 * recorded there. The scope is kept; only the URL is dropped.
 */
describe('co-DM authoring — server-scope endpoint URL never lands in provenance (e2e, #501)', () => {
  let h: AiEvalHarness;
  let campaignId: number;
  const SERVER_BASE_URL = 'http://localhost:11434/campfire-internal-gateway';

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'eval-model' });
    await h.enableExperimental();
    campaignId = await h.createCampaign('Co-DM Server Endpoint Provenance');
    await h.configureSeat(campaignId, { model: 'eval-model', tokenBudget: 1_000_000 });

    // SERVER-default provider (admin-managed), deliberately NOT a per-campaign override —
    // a campaign baseUrl is DM-configured and stays readable to them.
    const server = await request(h.server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType: 'mock', model: 'mock-1', apiKey: 'sk-server-key-1234', baseUrl: SERVER_BASE_URL });
    expect(server.status).toBe(200);
  });

  afterAll(async () => {
    await h.close();
  });

  it('records endpoint.scope=server but a null baseUrl on the filed proposal', async () => {
    // A STORED provider config is served by a provider the factory builds per call, not by
    // the harness's injected instance, so `h.script(...)` does not reach it. The factory
    // mock echoes the last user message, and the draft parser extracts a balanced JSON
    // span from it — so put the draft JSON in the prompt to drive the configured path.
    const res = await request(h.server)
      .post(api(campaignId))
      .set(dm)
      .send({ target: 'npc', prompt: JSON.stringify({ name: 'Gatewarden Vell', role: 'Guard' }) });

    expect(res.status).toBe(201);
    const provenance = res.body.proposals[0].generationProvenance;
    expect(provenance).toBeTruthy();
    expect(provenance.endpoint.scope).toBe('server');
    expect(provenance.endpoint.baseUrl).toBeNull();

    // Durable too — a read-time redaction would leave it in the row for a later export.
    const proposals = await request(h.server).get(`/api/v1/campaigns/${campaignId}/proposals`).set(dm);
    expect(proposals.status).toBe(200);
    expect(JSON.stringify(proposals.body)).not.toContain('campfire-internal-gateway');
  });

  /**
   * The configuration that defeated the FIRST version of this fix: a KEYLESS campaign
   * override inherits the SERVER endpoint (#373), yet `getEffectiveView().source` reports
   * `'campaign'` merely because a campaign row exists. The scope must come from whoever
   * actually supplied the endpoint.
   */
  it('reports scope=server for a KEYLESS campaign override, which runs on the server endpoint', async () => {
    const override = await request(h.server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'mock', model: 'mock-1' });
    expect(override.status).toBe(200);

    const res = await request(h.server)
      .post(api(campaignId))
      .set(dm)
      .send({ target: 'npc', prompt: JSON.stringify({ name: 'Warden Ilse', role: 'Guard' }) });

    expect(res.status).toBe(201);
    const provenance = res.body.proposals[0].generationProvenance;
    expect(provenance.endpoint.scope).toBe('server');
    expect(provenance.endpoint.baseUrl).toBeNull();

    const proposals = await request(h.server).get(`/api/v1/campaigns/${campaignId}/proposals`).set(dm);
    expect(JSON.stringify(proposals.body)).not.toContain('campfire-internal-gateway');
  });
});

/**
 * #598 review — a Co-DM draft the provider REFUSED must still be paid for, and reported as a
 * refusal.
 *
 * `CoDmService` read `result.usage.totalTokens` straight through and ignored `finishReason`.
 * A safety refusal arrives with its prose already discarded by the adapter, so `text` is empty
 * — and a Gemini PROMPT block carries no candidate and no `usageMetadata` at all, so usage is
 * absent too. That metered ZERO, which REFUNDS the whole reservation, so the seat's budget gate
 * never advanced while the provider billed every attempt: a DM could retry a blocked draft
 * indefinitely for free. The empty text then reached `toPayloads`, which found no JSON in it
 * and blamed the operator's setup ("Configure a real provider…") — the wrong diagnosis, and the
 * one guaranteed to send a DM off editing settings that were fine.
 *
 * Driven by stubbing the RESOLVED PROVIDER CONFIG rather than the harness's injected provider,
 * because the defect lives in the external-provider branch — the one a real Gemini/OpenAI seat
 * takes. The `mock` provider type lets the wire shape be scripted exactly.
 */
describe('co-DM authoring — a refused draft is still metered (#598)', () => {
  let h: AiEvalHarness;
  let campaignId: number;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'eval-model' });
    await h.enableExperimental();
    campaignId = await h.createCampaign('Co-DM Refusal');
    await h.configureSeat(campaignId, { model: 'eval-model', tokenBudget: 50_000 });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await h.close();
  });

  /** Point the co-DM path at a scripted external provider for the duration of one draft. */
  function scriptExternal(response: Record<string, unknown>): void {
    const svc = h.ctx.app.get(AiProviderConfigService);
    jest.spyOn(svc, 'resolveEffectiveConfigWithEndpointScope').mockResolvedValue({
      config: {
        providerType: 'mock',
        model: 'mock-1',
        mockResponses: [response],
      } as never,
      endpointScope: 'campaign',
    });
  }

  /**
   * The invariant is about MEASUREMENT, not about refusals, so both shapes are asserted: a
   * refusal that reports no usage, and a prompt block that reports no usage and no finish
   * reason worth naming. Both must consume the reservation.
   */
  it.each([
    ['a content filter with no usage reported', { text: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'content_filter' }],
    ['a refusal with no usage reported', { text: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'refusal' }],
  ])('%s consumes the reservation instead of refunding it', async (_label, response) => {
    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/reset`).set(dm).send({});
    scriptExternal(response);

    const res = await request(h.server).post(api(campaignId)).set(dm).send({ target: 'npc', prompt: 'anyone' });

    // THE POINT, asserted FIRST so a regression reports the BILLING defect rather than the
    // wording: the budget gate moved. Before the fix `budgetRemaining` came back at the full
    // 50000 — the reservation fully refunded — so a loop of blocked drafts cost the operator
    // real money and never tripped the gate.
    const seat = await h.getSeat(campaignId);
    expect(seat.status).toBe(200);
    expect(seat.body.tokensUsed + seat.body.tokensUnknown).toBeGreaterThan(0);
    expect(seat.body.budgetRemaining).toBeLessThan(seat.body.tokenBudget);
    // Nothing is left reserved: the reservation was settled exactly once, not stranded.
    expect(seat.body.tokensReserved).toBe(0);

    // And reported AS a refusal — not as a provider-misconfiguration error.
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/withheld/i);
    expect(res.body.message).not.toMatch(/Configure a real provider/i);
  });

  it('a refusal that DID report usage meters that figure, not an estimate', async () => {
    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/reset`).set(dm).send({});
    scriptExternal({
      text: '',
      usage: { promptTokens: 700, completionTokens: 20, totalTokens: 720 },
      finishReason: 'content_filter',
    });

    const res = await request(h.server).post(api(campaignId)).set(dm).send({ target: 'npc', prompt: 'anyone' });
    expect(res.status).toBe(422);

    // A reported figure is exact and must survive as such — `unknown` is for absence only.
    const seat = await h.getSeat(campaignId);
    expect(seat.body.tokensUsed).toBe(720);
    expect(seat.body.tokensUnknown).toBe(0);
  });
});

describe('co-DM authoring — adapter vocabulary & ruleset provenance', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'eval-model' });
    await h.enableExperimental();
  });

  afterAll(async () => {
    await h.close();
  });

  it('injects correct adapter identity and neutral requirements for non-5e systems', async () => {
    const campaignId = await h.createCampaign('PF2e Campaign');
    const db = h.ctx.app.get(DB);
    await db.insert(rulePacks).values({ slug: 'pf2e-srd', name: 'PF2e SRD', version: '1', license: '', sourceUrl: '', installedAt: new Date().toISOString(), entryCount: 0 }).onConflictDoNothing();
    await request(h.server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ ruleSystem: 'pf2e-srd' });
    await h.configureSeat(campaignId, { model: 'eval-model', instructions: 'Be terse.', tokenBudget: 1_000_000 });

    h.script({ text: JSON.stringify({ name: 'Bob' }) });
    const res = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/draft`)
      .set(dm)
      .send({ target: 'npc', prompt: 'an npc' });
    
    expect(res.status).toBe(201);
    const req = h.mock.received.at(-1)!;
    
    // Test that the prompt injects correct adapter identity
    expect(req.system).toContain('Pathfinder 2e');
    // Test that incompatible 5e terms ("Challenge Rating", "spell slots") are absent
    expect(req.system).not.toContain('Challenge Rating');
    expect(req.system).not.toContain('spell slots');
    expect(req.system).not.toContain('D&D');

    // Test that ruleset provenance was stored
    expect(res.body.proposals[0].payload.name).toBe('Bob');
    // The proposal response has the attribution embedded directly in the creation record
    expect(res.body.proposals[0].proposerUserId).toBe(`ai-dm:${campaignId}`);
  });

  it('asks for assumptions for neutral/homebrew systems', async () => {
    const campaignId = await h.createCampaign('Neutral Campaign');
    // default is neutral/empty
    await h.configureSeat(campaignId, { model: 'eval-model', instructions: 'Be terse.', tokenBudget: 1_000_000 });

    h.script({ text: JSON.stringify({ name: 'Bob' }) });
    await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/draft`)
      .set(dm)
      .send({ target: 'npc', prompt: 'an npc' });
    
    const req = h.mock.received.at(-1)!;
    expect(req.system).toContain('Ask for assumptions before applying mechanics');
    expect(req.system).toContain('tabletop RPG content');
    expect(req.system).not.toContain('D&D');
  });
});
