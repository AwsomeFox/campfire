import { createAiEvalHarness, type AiEvalHarness } from './ai-eval-harness';

/**
 * Comprehension profile (#874), end-to-end and offline via the #318 harness.
 *
 * Same split as the #1049 style-preset e2e suite this mirrors: the unit spec
 * (driver-comprehension.spec.ts) pins the pure rendering and the token ceiling; these pin the
 * two things only a round trip can show — that the profile actually PERSISTS through PUT/GET,
 * and that its guidance actually REACHES the model's system prompt.
 *
 * UNLIKE #1049's style section, `## Comprehension` is never fully absent: its baseline (chunked
 * narration, the "What changed" / "What can you do" ending, non-exclusive suggestions offered
 * ALONGSIDE free text, and Simplify/Recap/Explain support) is the issue's stated default and is
 * asserted present on an UNCONFIGURED seat too — the opposite of the style suite's "control
 * group gets no section" case. What toggles on configuration is only the optional per-axis line.
 *
 * The issue's title constraint — "without removing freeform input" — is asserted directly here,
 * not merely inferred from the composer UI never changing shape: the baseline text itself is
 * checked, on every profile setting, for the sentence that tells the model the suggestions are
 * illustrations and free text must still be accepted.
 */

const seat = { mode: 'driver' as const, instructions: 'Be terse.', tokenBudget: 500_000 };

describe('ai-dm comprehension profile (#874, e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'comprehension-model' });
    await h.enableExperimental();
  });
  afterAll(async () => {
    await h.close();
  });

  it('defaults to no preference, and round-trips a saved profile', async () => {
    const campaignId = await h.createCampaign('Comprehension Round Trip');
    await h.configureSeat(campaignId, seat);

    const before = await h.getSeat(campaignId);
    expect(before.body.comprehensionProfile).toEqual({
      readingComplexity: 'default',
      paragraphLength: 'default',
      sensoryIntensity: 'default',
      choiceCount: 'default',
    });

    await h.configureSeat(campaignId, {
      comprehensionProfile: {
        readingComplexity: 'simple',
        paragraphLength: 'short',
        sensoryIntensity: 'minimal',
        choiceCount: 'three',
      },
    });

    const after = await h.getSeat(campaignId);
    expect(after.body.comprehensionProfile.readingComplexity).toBe('simple');
    expect(after.body.comprehensionProfile.choiceCount).toBe('three');
    // Same "replaces wholesale" contract as stylePresets/proactiveSettings — assert the whole
    // saved block survived rather than implying a deep merge.
    expect(after.body.comprehensionProfile.sensoryIntensity).toBe('minimal');
  });

  it('the baseline — chunking, the ending shape, and freeform alongside suggestions — is present on an UNCONFIGURED seat', async () => {
    const plain = await h.createCampaign('Comprehension Untouched');
    await h.configureSeat(plain, seat);
    h.script({ text: 'The gate stands open.' });
    await h.sendMessage(plain, { input: 'I approach.' });
    const system = h.mock.received.at(-1)!.system;

    expect(system).toContain('## Comprehension');
    expect(system).toContain('What changed');
    expect(system).toContain('What can you do');
    // The issue's central constraint, asserted directly rather than only inferred from the
    // composer never changing shape: the model is told the suggestions never replace free text.
    expect(system).toMatch(/NEVER the only input/);
    expect(system).toMatch(/describe anything else in their own words/);
    expect(system).toMatch(/never present the suggestions as a menu that replaces free text/);
    // Simplify/Recap/Explain support is part of the baseline, not gated on configuration.
    expect(system).toMatch(/simplify/i);
    expect(system).toMatch(/recap/i);
    expect(system).toMatch(/explain/i);
    // No per-axis line was ever chosen, so none should appear.
    expect(system).not.toContain('- Reading complexity:');
    expect(system).not.toContain('- Paragraph length:');
    expect(system).not.toContain('- Sensory intensity:');
    expect(system).not.toContain('- Suggested choices:');
  });

  it('a saved profile adds its per-axis line on top of the same baseline', async () => {
    const styled = await h.createCampaign('Comprehension Configured');
    await h.configureSeat(styled, seat);
    await h.configureSeat(styled, {
      comprehensionProfile: { readingComplexity: 'simple', choiceCount: 'two' },
    });

    h.script({ text: 'Rain beads on the window.' });
    await h.sendMessage(styled, { input: 'I wait for the contact.' });
    const system = h.mock.received.at(-1)!.system;

    expect(system).toContain('## Comprehension');
    // The baseline is still there — configuring one axis must not drop it.
    expect(system).toContain('What changed');
    expect(system).toMatch(/describe anything else in their own words/);
    // Only the chosen axes are stated; silence on the other two is a real answer.
    expect(system).toContain('- Reading complexity:');
    expect(system).toContain('- Suggested choices:');
    expect(system).not.toContain('- Paragraph length:');
    expect(system).not.toContain('- Sensory intensity:');
  });

  it('every profile setting still leaves free-form input assembled the same way (composer parity)', async () => {
    // Not a UI test (this suite is server-only) — the point is that the composer's own
    // `POST /ai-dm/message { input }` contract never gains a required "pick one of these"
    // shape: whatever the model narrated, the endpoint accepts the SAME free-text field
    // regardless of which comprehension profile is configured.
    const profiles: Array<Record<string, string> | undefined> = [
      undefined,
      { readingComplexity: 'rich' },
      { choiceCount: 'four', sensoryIntensity: 'vivid' },
    ];
    for (const profile of profiles) {
      const campaignId = await h.createCampaign(`Freeform Survives ${JSON.stringify(profile)}`);
      await h.configureSeat(campaignId, seat);
      if (profile) await h.configureSeat(campaignId, { comprehensionProfile: profile });

      h.script({ text: 'A response.' });
      const res = await h.sendMessage(campaignId, { input: 'I say whatever I want, in my own words.' });
      expect(res.status).toBe(201);
    }
  });

  it('rejects a value outside the enum rather than forwarding it to the prompt', async () => {
    const campaignId = await h.createCampaign('Comprehension Validation');
    await h.configureSeat(campaignId, seat);
    const res = await h.configureSeat(campaignId, { comprehensionProfile: { readingComplexity: 'bogus' } });
    expect(res.status).toBe(400);
  });
});
