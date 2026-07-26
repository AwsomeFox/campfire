import request from 'supertest';
import { createAiEvalHarness, dm, type AiEvalHarness } from './ai-eval-harness';
import { AiDmService } from '../src/modules/ai-dm/ai-dm.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AI_DM_PROVIDER, type AiDmProvider } from '../src/modules/ai-dm/ai-dm.provider';

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

  // A reservation that is never released silently shrinks the campaign's usable budget
  // FOREVER (until an admin resets usage), which is strictly worse than the over-spend
  // #563 set out to fix. These cover every way the reserve→settle path can be interrupted.
  describe('a reservation is always settled exactly once', () => {
    it('consumes the hold as unknown spend when the provider call throws', async () => {
      const campaignId = await h.createCampaign('Reservation Provider Throw');
      await h.configureSeat(campaignId, { enabled: true, tokenBudget: 1_000 });
      const provider = h.ctx.app.get<AiDmProvider>(AI_DM_PROVIDER);
      const spy = jest.spyOn(provider, 'generate').mockRejectedValueOnce(new Error('provider exploded'));

      const res = await h.takeTurn(campaignId, { prompt: 'boom', maxTokens: 100 });
      expect(res.status).toBe(500);

      const seat = await h.getSeat(campaignId);
      expect(seat.body.tokensReserved).toBe(0);
      expect(seat.body.tokensUnknown).toBe(100);
      expect(seat.body.tokensUsed).toBe(0);
      expect(seat.body.budgetRemaining).toBe(900);
      spy.mockRestore();
    });

    it('releases the hold when metering throws BEFORE the release transaction commits', async () => {
      const campaignId = await h.createCampaign('Reservation Meter Presettle');
      await h.configureSeat(campaignId, { enabled: true, tokenBudget: 1_000 });
      const aiDm = h.ctx.app.get(AiDmService);
      const reservation = await aiDm.reserveTokenBudget(campaignId, 250);
      expect((await h.getSeat(campaignId)).body.tokensReserved).toBe(250);

      // meterTurnInner is everything after the reservation-ownership check: making it
      // reject models a transient DB error hitting before `tokens_reserved` is decremented.
      const spy = jest
        .spyOn(aiDm as unknown as { meterTurnInner: () => Promise<never> }, 'meterTurnInner')
        .mockRejectedValueOnce(new Error('transient db error'));
      await expect(aiDm.meterTurn(campaignId, 40, { actor: 'dm' }, reservation)).rejects.toThrow('transient db error');
      spy.mockRestore();

      const seat = await h.getSeat(campaignId);
      expect(seat.body.tokensReserved).toBe(0);
      expect(seat.body.tokensUnknown).toBe(250);
      expect(seat.body.budgetRemaining).toBe(750);
    });

    it('does not double-charge when metering throws AFTER the release transaction commits', async () => {
      const campaignId = await h.createCampaign('Reservation Meter Postsettle');
      await h.configureSeat(campaignId, { enabled: true, tokenBudget: 1_000 });
      const aiDm = h.ctx.app.get(AiDmService);
      const audit = h.ctx.app.get(AuditService);
      const reservation = await aiDm.reserveTokenBudget(campaignId, 250);

      // meterTurn commits its counter update and only then writes the audit row; a throw
      // there must not make the fallback settle charge the same tokens a second time.
      const spy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('audit write failed'));
      await expect(aiDm.meterTurn(campaignId, 40, { actor: 'dm' }, reservation)).rejects.toThrow('audit write failed');
      spy.mockRestore();

      let seat = await h.getSeat(campaignId);
      expect(seat.body.tokensReserved).toBe(0);
      expect(seat.body.tokensUsed).toBe(40);
      expect(seat.body.tokensUnknown).toBe(0);
      expect(seat.body.tokensRefunded).toBe(210);
      expect(seat.body.budgetRemaining).toBe(960);

      // A caller's own belt-and-braces settle (the scribe does exactly this) must no-op.
      await aiDm.markReservationUsageUnknown(reservation, { actor: 'dm' });
      seat = await h.getSeat(campaignId);
      expect(seat.body.tokensUnknown).toBe(0);
      expect(seat.body.tokensUsed).toBe(40);
      expect(seat.body.budgetRemaining).toBe(960);
    });

    it('reclaims a hold stranded by a previous process on bootstrap', async () => {
      const campaignId = await h.createCampaign('Reservation Restart');
      await h.configureSeat(campaignId, { enabled: true, tokenBudget: 1_000 });
      const aiDm = h.ctx.app.get(AiDmService);
      // Reserve and then abandon it, exactly as a crash mid-provider-call would.
      await aiDm.reserveTokenBudget(campaignId, 300);
      expect((await h.getSeat(campaignId)).body.tokensReserved).toBe(300);

      await aiDm.onApplicationBootstrap();

      const seat = await h.getSeat(campaignId);
      expect(seat.body.tokensReserved).toBe(0);
      expect(seat.body.tokensUnknown).toBe(300);
      expect(seat.body.budgetRemaining).toBe(700);
      // Reclaiming must not silently refund spend that may really have happened.
      expect(seat.body.tokensRefunded).toBe(0);
    });
  });

  it('does not book overage for metering without a pre-call reservation', async () => {
    const campaignId = await h.createCampaign('Reservation Legacy Meter');
    await h.configureSeat(campaignId, { enabled: true, tokenBudget: 1_000 });
    const aiDm = h.ctx.app.get(AiDmService);

    await aiDm.meterTurn(campaignId, 120, { actor: 'dm' });

    const seat = await h.getSeat(campaignId);
    expect(seat.body.tokensUsed).toBe(120);
    // No reservation means no baseline to overrun and nothing to refund.
    expect(seat.body.tokensOverage).toBe(0);
    expect(seat.body.tokensRefunded).toBe(0);
    expect(seat.body.tokensReserved).toBe(0);
    expect(seat.body.budgetRemaining).toBe(880);
  });
});
