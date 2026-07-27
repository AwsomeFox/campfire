import request from 'supertest';
import { createAiEvalHarness, dm, type AiEvalHarness } from './ai-eval-harness';

/**
 * Server-wide AI seat defaults (#1070), end-to-end.
 *
 * A multi-campaign DM reconfigured the seat from scratch every time: only the PROVIDER
 * inherited server-wide, so mode / steering / budget were blank on every new campaign.
 *
 * INHERITANCE, NOT COPYING. This mirrors the provider's live `campaign ?? server` resolution
 * rather than adding a snapshot mechanism beside it. The tests below pin the three properties
 * that distinguish the two: inheritance is LIVE (change the default, un-configured campaigns
 * move), detaching is WHOLE-SEAT on first save, and the first save is SEEDED so detaching
 * never silently reverts what the DM was already relying on.
 */

const ADMIN_SETTINGS = '/api/v1/settings/ai-seat-defaults';

describe('ai-dm server-wide seat defaults (#1070, e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'inherit-model' });
    await h.enableExperimental();
  });
  afterAll(async () => {
    await h.close();
  });

  async function setDefaults(body: Record<string, unknown>) {
    return request(h.server).put(ADMIN_SETTINGS).set(dm).send(body);
  }

  it('a campaign with no seat inherits the server defaults, and says which fields it inherited', async () => {
    await setDefaults({
      mode: 'off',
      instructions: 'House rule: describe failure as complication, never as nothing happening.',
      tokenBudget: 250_000,
      actionQueueDepth: 4,
    });

    const campaignId = await h.createCampaign('Inheriting');
    const seat = await h.getSeat(campaignId);

    expect(seat.body.instructions).toContain('House rule');
    expect(seat.body.tokenBudget).toBe(250_000);
    expect(seat.body.actionQueueDepth).toBe(4);

    // The DM can see the inherited budget BEFORE the seat is enabled — enabling is the act
    // that lets it start spending, so the effective number has to be visible ahead of it, not
    // discovered afterwards.
    expect(seat.body.enabled).toBe(false);
    expect(seat.body.inheritedFields).toEqual(
      expect.arrayContaining(['instructions', 'tokenBudget', 'actionQueueDepth']),
    );
  });

  it('never inherits the two consent-to-spend fields', async () => {
    // `enabled` and `proactiveSettings` are the fields with a money consequence. Inheriting
    // either would let a brand-new campaign start spending against a number nobody chose for
    // it, which is the one outcome this feature must not produce.
    await setDefaults({ mode: 'driver', instructions: '', tokenBudget: 100_000, actionQueueDepth: 8 });
    const campaignId = await h.createCampaign('No Auto Spend');
    const seat = await h.getSeat(campaignId);

    expect(seat.body.enabled).toBe(false);
    expect(seat.body.proactiveSettings.enabled).toBe(false);
    expect(seat.body.inheritedFields).not.toContain('enabled');
    expect(seat.body.inheritedFields).not.toContain('proactiveSettings');
  });

  it('inheritance is LIVE — changing the default moves an un-configured campaign', async () => {
    // The property a snapshot copy cannot have, and the reason inheritance was chosen: an
    // admin fixing a bad default fixes every campaign that never overrode it.
    const campaignId = await h.createCampaign('Live Inheritance');
    await setDefaults({ mode: 'off', instructions: 'first', tokenBudget: 10_000, actionQueueDepth: 8 });
    expect((await h.getSeat(campaignId)).body.instructions).toBe('first');

    await setDefaults({ mode: 'off', instructions: 'second', tokenBudget: 20_000, actionQueueDepth: 8 });
    const moved = await h.getSeat(campaignId);
    expect(moved.body.instructions).toBe('second');
    expect(moved.body.tokenBudget).toBe(20_000);
  });

  it('the first save DETACHES the campaign, seeded from the defaults it was inheriting', async () => {
    await setDefaults({ mode: 'off', instructions: 'inherited steering', tokenBudget: 75_000, actionQueueDepth: 6 });
    const campaignId = await h.createCampaign('Detaching');

    // Save ONE field, PUT directly rather than through the harness helper (which injects its
    // own enabled/tokenBudget defaults and so would not be a single-field save). Detach is
    // whole-seat, so without seeding the untouched fields would snap back to the built-in
    // zeros — the DM would lose a budget they never edited.
    const saved = await request(h.server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(dm)
      .send({ model: 'my-model' });
    expect(saved.status).toBe(200);

    const detached = await h.getSeat(campaignId);
    expect(detached.body.model).toBe('my-model');
    expect(detached.body.instructions).toBe('inherited steering');
    expect(detached.body.tokenBudget).toBe(75_000);
    expect(detached.body.actionQueueDepth).toBe(6);
    // And it now reports as its own truth rather than as inheriting.
    expect(detached.body.inheritedFields).toEqual([]);

    // Moving the server default no longer moves this campaign — that is what detached means.
    await setDefaults({ mode: 'off', instructions: 'changed after detach', tokenBudget: 1, actionQueueDepth: 8 });
    const after = await h.getSeat(campaignId);
    expect(after.body.instructions).toBe('inherited steering');
    expect(after.body.tokenBudget).toBe(75_000);
  });

  it('an install that sets no defaults behaves exactly as it did before #1070', async () => {
    await setDefaults({ mode: 'off', instructions: '', tokenBudget: 0, actionQueueDepth: 8 });
    const campaignId = await h.createCampaign('Untouched');
    const seat = await h.getSeat(campaignId);

    expect(seat.body.mode).toBe('off');
    expect(seat.body.instructions).toBe('');
    expect(seat.body.tokenBudget).toBe(0);
    // Nothing is reported as inherited when the defaults match the built-in fallbacks —
    // otherwise every untouched install would claim to be inheriting the same zeros it would
    // have produced anyway.
    expect(seat.body.inheritedFields).toEqual([]);
  });

  it('carries no credential in either direction', async () => {
    // The admin gate itself is asserted in admin-token-cap.e2e-spec.ts, which has a genuine
    // non-admin identity; every dev-auth identity in THIS harness is a server admin (it is how
    // `enableExperimental` can PATCH /settings), so a 403 assertion here would prove nothing.
    expect((await setDefaults({ mode: 'off', instructions: '', tokenBudget: 0, actionQueueDepth: 8 })).status).toBe(200);

    const body = (await request(h.server).get(ADMIN_SETTINGS).set(dm)).body;
    // Provider credentials live on the AI provider config and are never part of a seat; assert
    // the payload shape rather than trusting that to stay true by memory.
    expect(Object.keys(body).sort()).toEqual(['actionQueueDepth', 'instructions', 'mode', 'tokenBudget']);
    expect(JSON.stringify(body)).not.toMatch(/apiKey|secret|encrypted|credential/i);
  });

  it('rejects an unknown key and an out-of-range value', async () => {
    expect((await setDefaults({ mode: 'off', instructions: '', tokenBudget: 0, actionQueueDepth: 8, apiKey: 'sk-live' })).status).toBe(400);
    expect((await setDefaults({ mode: 'off', instructions: '', tokenBudget: -5, actionQueueDepth: 8 })).status).toBe(400);
  });
});
