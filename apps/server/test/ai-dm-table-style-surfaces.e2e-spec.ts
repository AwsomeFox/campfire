import request from 'supertest';
import { createAiEvalHarness, dm, type AiEvalHarness } from './ai-eval-harness';
import { TABLE_STYLE_HEADING } from '../src/modules/ai-driver/driver-style';

/**
 * #1049 — which narration surfaces the table style actually reaches.
 *
 * `renderTableStyleSection` was spliced only into `AiDriverService.assembleSystemPrompt`. Two
 * reviewers independently read that as a gap, and they were right about the closest sibling:
 * `AiDmService.takeTurn` is the SAME narration through a different entry point
 * (`POST /campaigns/:id/ai-dm/turn`, and the MCP `ai_dm_narrate` tool), and it forwarded only
 * `seat.instructions`. A DM configured a style, saw it saved, and that surface silently ignored
 * it — the same failure signature as the clone/import bug this PR set out to fix: a setting that
 * reports success and has no effect.
 *
 * This suite pins where style DOES apply, so the scope is a decision on the record rather than
 * an omission. The exclusions are asserted too, for the same reason the portability suite
 * asserts its dropped fields: an absence that is asserted is a decision.
 */
describe('table style reaches the narration surfaces it should (#1049)', () => {
  let h: AiEvalHarness;
  let campaignId: number;

  const STYLE = {
    tone: 'noir',
    pacing: 'deliberate',
    verbosity: 'concise',
    combatStyle: 'lethal',
    npcDepth: 'deep',
  } as const;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'style-model' });
    await h.enableExperimental();
    campaignId = await h.createCampaign('Styled Narration');
    await h.configureSeat(campaignId, { tokenBudget: 100_000 });
    const seat = await request(h.server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(dm)
      .send({ enabled: true, stylePresets: STYLE, instructions: 'Persona line.' });
    expect(seat.status).toBe(200);
  });

  beforeEach(() => h.resetMock());

  afterAll(async () => {
    await h.close();
  });

  it('takeTurn sends the table style to the provider', async () => {
    // The bridge maps `instructions` onto the request's `system`, so this asserts what the
    // model actually receives rather than what the seat stores.
    const res = await h.takeTurn(campaignId, { prompt: 'The party enters the alley.' });
    expect(res.status).toBe(201);

    expect(h.mock.received).toHaveLength(1);
    const system = h.mock.received[0].system ?? '';
    expect(system).toContain(TABLE_STYLE_HEADING);
    // ...and the DM's freeform persona is still there — style AUGMENTS instructions, never
    // replaces them.
    expect(system).toContain('Persona line.');
  });

  it('an unconfigured seat sends a byte-identical prompt to the pre-#1049 one', async () => {
    // The feature costs zero tokens until a DM opts in; a default seat must render NOTHING.
    const plain = await h.createCampaign('Unstyled');
    await h.configureSeat(plain, { tokenBudget: 100_000 });
    await request(h.server).put(`/api/v1/campaigns/${plain}/ai-dm`).set(dm).send({ enabled: true, instructions: 'Just persona.' });

    const res = await h.takeTurn(plain, { prompt: 'Anything.' });
    expect(res.status).toBe(201);
    const system = h.mock.received[0].system ?? '';
    expect(system).not.toContain(TABLE_STYLE_HEADING);
    expect(system).toBe('Just persona.');
  });
});
