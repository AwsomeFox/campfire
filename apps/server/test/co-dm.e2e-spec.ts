import request from 'supertest';
import { createAiEvalHarness, dm, player, type AiEvalHarness } from './ai-eval-harness';

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

  it('drafts a story beat (filed as a quest) and a recap (filed as a session)', async () => {
    h.script({ text: JSON.stringify({ title: 'The Missing Caravan', summary: 'A merchant train vanished on the moor road.' }) });
    const beat = await draft({ target: 'beat', prompt: 'the next hook' });
    expect(beat.status).toBe(201);
    expect(beat.body.entityType).toBe('quest');
    expect(beat.body.proposals[0].payload.title).toBe('The Missing Caravan');
    expect(beat.body.proposals[0].payload.body).toContain('merchant train');

    h.script({ text: JSON.stringify({ recap: 'The party crossed the moor and lost the trail.' }) });
    const recap = await draft({ target: 'recap', prompt: 'summarize the last session' });
    expect(recap.status).toBe(201);
    expect(recap.body.entityType).toBe('session');
    expect(recap.body.proposals[0].payload.recap).toContain('crossed the moor');
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
