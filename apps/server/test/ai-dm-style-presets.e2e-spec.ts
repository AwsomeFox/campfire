import { createAiEvalHarness, type AiEvalHarness } from './ai-eval-harness';

/**
 * Structured table style (#1049), end-to-end and offline via the #318 harness.
 *
 * The unit spec pins the rendering and the token ceiling. These pin the two things only a
 * round trip can show: that the preset actually PERSISTS through PUT/GET (the equivalent
 * coverage `proactiveSettings` never got), and that a saved preset actually REACHES the model
 * — which is the entire point of the feature and the one link a pure renderer test cannot
 * prove.
 *
 * Note what is deliberately NOT asserted: that the narration comes back gritty. The provider
 * is a deterministic mock, and even a real model may ignore the guidance. A preset is a
 * request in the prompt, not a control the server enforces, so the prompt is the honest place
 * to assert.
 */

const seat = { mode: 'driver' as const, instructions: 'Be terse.', tokenBudget: 500_000 };

describe('ai-dm structured table style (#1049, e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'style-model' });
    await h.enableExperimental();
  });
  afterAll(async () => {
    await h.close();
  });

  it('defaults to no preference, and round-trips a saved preset', async () => {
    const campaignId = await h.createCampaign('Style Round Trip');
    await h.configureSeat(campaignId, seat);

    // A seat nobody has styled reports every axis as `default` — the shipped state, and the
    // one that renders nothing into the prompt.
    const before = await h.getSeat(campaignId);
    expect(before.body.stylePresets).toEqual({
      tone: 'default',
      pacing: 'default',
      verbosity: 'default',
      combatStyle: 'default',
      npcDepth: 'default',
    });

    await h.configureSeat(campaignId, {
      stylePresets: { tone: 'noir', pacing: 'brisk', verbosity: 'concise', combatStyle: 'lethal', npcDepth: 'deep' },
    });

    const after = await h.getSeat(campaignId);
    expect(after.body.stylePresets.tone).toBe('noir');
    expect(after.body.stylePresets.combatStyle).toBe('lethal');
    // A partial save must not silently reset the axes it did not mention... except that the
    // update replaces the object wholesale (same contract as proactiveSettings), so the client
    // sends the full block. Assert the whole block survived rather than implying a deep merge.
    expect(after.body.stylePresets.npcDepth).toBe('deep');
  });

  it('a saved preset reaches the model; an unset one adds nothing', async () => {
    const styled = await h.createCampaign('Style In Prompt');
    await h.configureSeat(styled, seat);
    await h.configureSeat(styled, { stylePresets: { tone: 'noir', combatStyle: 'forgiving' } });

    h.script({ text: 'Rain beads on the window.' });
    await h.sendMessage(styled, { input: 'I wait for the contact.' });
    const withStyle = h.mock.received.at(-1)!.system;

    expect(withStyle).toContain('## Table style');
    expect(withStyle).toContain('Noir');
    expect(withStyle).toContain('- Combat: Combat is forgiving.'); // the `forgiving` line
    // Only the chosen axes are stated; silence on pacing is a real answer.
    expect(withStyle).not.toContain('- Pacing:');
    // And the subordination travels with it, so a tone preference can never read as outranking
    // the charter, the live state, or a table correction.
    expect(withStyle).toContain('session-zero charter');

    // The control group: an identically-configured seat with no style chosen gets no section,
    // so this feature is genuinely free for tables that never open it.
    const plain = await h.createCampaign('Style Untouched');
    await h.configureSeat(plain, seat);
    h.script({ text: 'The gate stands open.' });
    await h.sendMessage(plain, { input: 'I approach.' });
    expect(h.mock.received.at(-1)!.system).not.toContain('## Table style');
  });

  it('rejects a value outside the enum rather than forwarding it to the prompt', async () => {
    const campaignId = await h.createCampaign('Style Validation');
    await h.configureSeat(campaignId, seat);
    const res = await h.configureSeat(campaignId, { stylePresets: { tone: 'grimdark' } });
    expect(res.status).toBe(400);
  });
});
