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

  /**
   * `kind: 'recap'` is styled like every other turn kind — a DECISION, questioned in review
   * (Devin) because the scribe also produces "a recap" and deliberately carries no style.
   *
   * Kept, because the two are different products with different SPEAKERS:
   *
   *  - `takeTurn` is the AI DM talking to the table, live, through `POST /ai-dm/turn` or the
   *    MCP `ai_dm_narrate` tool. `kind` steers framing — recap the scene, run the fight,
   *    narrate — not who is speaking. Excluding one kind would give `recap` a different
   *    persona from `narrate` on the SAME endpoint and the same seat, which is a worse and
   *    far more frequently-hit inconsistency than the cross-service one it would resolve.
   *  - the scribe REPLACES the speaker. Its system prompt is "You are the campaign scribe",
   *    and it produces a filed proposal a DM reviews — a record of the session, not a turn in
   *    it. It borrows `seat.instructions` for setting continuity and stops there.
   *
   * The block's own text settles it: it opens "How the DM of this table wants the game
   * narrated", and two of its five axes (`combatStyle`, `npcDepth`) steer how to RUN combat
   * and PLAY NPCs. A post-session summary does neither, so on the scribe path nearly half the
   * block would be instruction with nothing to apply to.
   */
  it('a recap TURN is styled, like every other kind on this endpoint', async () => {
    const res = await h.takeTurn(campaignId, { prompt: 'Where were we?', kind: 'recap' });
    expect(res.status).toBe(201);
    const system = h.mock.received[0].system ?? '';
    expect(system).toContain(TABLE_STYLE_HEADING);
    expect(system).toContain('Persona line.');
  });

  it('an unconfigured seat renders NO table style, though #874 adds its own unconditional baseline', async () => {
    // The #1049 feature itself still costs zero tokens until a DM opts in — that half of this
    // assertion is unchanged. What changed is #874: `## Comprehension`'s baseline (chunking, the
    // "What changed"/"What can you do" ending, Simplify/Recap/Explain support) is the issue's
    // stated DEFAULT and is therefore appended even on a seat that never touched EITHER feature,
    // so this prompt is no longer byte-identical to the one #1049 shipped. See
    // ai-dm-comprehension-profile.e2e-spec.ts for that section's own dedicated coverage.
    const plain = await h.createCampaign('Unstyled');
    await h.configureSeat(plain, { tokenBudget: 100_000 });
    await request(h.server).put(`/api/v1/campaigns/${plain}/ai-dm`).set(dm).send({ enabled: true, instructions: 'Just persona.' });

    const res = await h.takeTurn(plain, { prompt: 'Anything.' });
    expect(res.status).toBe(201);
    const system = h.mock.received[0].system ?? '';
    expect(system).not.toContain(TABLE_STYLE_HEADING);
    expect(system).toContain('Just persona.');
    expect(system).toContain('## Comprehension');
  });

  /**
   * The other half of the recap decision, asserted rather than left implicit.
   *
   * A SCRIBE recap carries the seat's persona and NOT the table style. That difference is the
   * one review asked about, so it is pinned here: whichever way a future change goes, it must
   * go deliberately, with this test failing first. Asserting only the `takeTurn` side would
   * leave the scribe free to drift into style — or out of the persona — unnoticed.
   */
  it('a SCRIBE recap carries the persona but NOT the table style', async () => {
    const ownerAgent = request.agent(h.server);
    const setup = await ownerAgent
      .post('/api/v1/auth/setup')
      .send({ username: 'style-scribe-owner', password: 'style-scribe-password' });
    expect(setup.status).toBe(201);

    const created = await ownerAgent.post('/api/v1/campaigns').send({ name: 'Scribed Table' });
    const scribed = created.body.id as number;
    // The scribe only sends material the owner consented to share externally (#501).
    await ownerAgent.patch(`/api/v1/campaigns/${scribed}/members/me/ai-consent`).send({ aiExternalUseConsent: true });

    await h.configureSeat(scribed, { tokenBudget: 100_000 });
    await request(h.server)
      .put(`/api/v1/campaigns/${scribed}/ai-dm`)
      .set(dm)
      .send({ enabled: true, stylePresets: STYLE, instructions: 'Persona line.' });

    // Resolvable source material, or the run has nothing to recap.
    const note = await ownerAgent.post(`/api/v1/campaigns/${scribed}/inbox`).send({ body: 'The party rested at the inn.' });
    await ownerAgent.post(`/api/v1/notes/${note.body.id}/resolve`).send({ resolvedNote: 'handled in play' });

    h.script({ text: 'A quiet night at the inn.' });
    const run = await request(h.server).post(`/api/v1/campaigns/${scribed}/scribe/run`).set(dm).send({});
    expect(run.status).toBe(201);

    const system = h.mock.received.at(-1)?.system ?? '';
    // It IS the scribe speaking, with the DM's persona for continuity...
    expect(system).toContain('You are the campaign scribe');
    expect(system).toContain('Persona line.');
    // ...and without the table's narration voice, which steers live play rather than a record.
    expect(system).not.toContain(TABLE_STYLE_HEADING);
    // #874 — same exclusion, for the same reason: the scribe's own prompt assembly never calls
    // `withComprehensionProfile`, so its baseline never reaches a filed session record either.
    expect(system).not.toContain('## Comprehension');
  });
});
