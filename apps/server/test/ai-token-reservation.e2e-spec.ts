import request from 'supertest';
import { createAiEvalHarness, dm, type AiEvalHarness } from './ai-eval-harness';

const API = '/api/v1';

describe('AI token budget reservation (#563)', () => {
  let h: AiEvalHarness;

  beforeEach(async () => {
    h = await createAiEvalHarness({ model: 'reservation-model' });
    await h.enableExperimental();
  });

  afterEach(async () => {
    await h.close();
  });

  it('admits only one same-seat provider call for the final reserved token and records overage', async () => {
    const campaignId = await h.createCampaign('Reservation Same Seat');
    await h.configureSeat(campaignId, { enabled: true, tokenBudget: 1 });
    h.script(
      { text: 'first spend', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      { text: 'second spend', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    );

    const results = await Promise.all([
      h.takeTurn(campaignId, { prompt: 'spend one', maxTokens: 1 }),
      h.takeTurn(campaignId, { prompt: 'spend two', maxTokens: 1 }),
    ]);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 403]);
    expect(h.mock.received).toHaveLength(1);

    const seat = await h.getSeat(campaignId);
    expect(seat.body.tokensReserved).toBe(0);
    expect(seat.body.tokensUsed).toBe(2);
    expect(seat.body.tokensOverage).toBe(1);
    expect(seat.body.tokensRefunded).toBe(0);
    expect(seat.body.budgetRemaining).toBe(0);
  });

  it('reserves against the server-wide cap across campaigns before provider contact', async () => {
    const firstCampaignId = await h.createCampaign('Reservation Global A');
    const secondCampaignId = await h.createCampaign('Reservation Global B');
    await h.configureSeat(firstCampaignId, { enabled: true, tokenBudget: 100 });
    await h.configureSeat(secondCampaignId, { enabled: true, tokenBudget: 100 });
    const caps = await request(h.server).put(`${API}/settings/ai/caps`).set(dm).send({ serverTokenCap: 1 });
    expect(caps.status).toBe(200);

    h.script(
      { text: 'global first', usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 } },
      { text: 'global second', usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 } },
    );
    const results = await Promise.all([
      h.takeTurn(firstCampaignId, { prompt: 'global one', maxTokens: 1 }),
      h.takeTurn(secondCampaignId, { prompt: 'global two', maxTokens: 1 }),
    ]);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 403]);
    expect(h.mock.received).toHaveLength(1);

    const usage = await request(h.server).get(`${API}/settings/ai/usage`).set(dm);
    expect(usage.status).toBe(200);
    expect(usage.body.totalTokensUsed).toBe(1);
    expect(usage.body.totalTokensReserved).toBe(0);
    expect(usage.body.serverBudgetRemaining).toBe(0);
  });
});
