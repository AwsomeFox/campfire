import request from 'supertest';
import { createAiEvalHarness, dm, player, type AiEvalHarness } from './ai-eval-harness';
import type { CampaignEvent } from '@campfire/schema';
import { AiDmStreamService } from '../src/modules/ai-driver/ai-driver-stream.service';

/**
 * Stuck ladder (#314) — detection + player levers + human hand-off, tested end-to-end and
 * OFFLINE via the #318 harness. The deterministic mock provider (#309) is scripted to produce
 * each stuck condition (tool error, budget exhaustion, empty narration, a verbatim loop) and we
 * assert that (a) detection moves the session to the right state and surfaces the right levers,
 * and (b) a player lever recovers the table or hands the seat to a human — everything audited.
 *
 * Fills the `#314 stuck` placeholder the harness spec left as `it.todo`.
 */

const seat = { mode: 'driver' as const, instructions: 'Be terse.', tokenBudget: 100_000 };

/**
 * The LIVE prompt of a captured request — the final user message.
 *
 * Since #1038 a driver turn is prepended with bounded conversation history, so `messages[0]`
 * is the replayed earlier action rather than the thing this turn is asking about. These lever
 * assertions are about what the lever injected into the CURRENT turn, so they read the last
 * user message; that is what they always meant, and it stays true however much history is
 * replayed in front of it.
 */
function lastUserMessage(req: { messages: { role: string; content?: string }[] }): string {
  const user = req.messages.filter((m) => m.role === 'user');
  return user[user.length - 1]?.content ?? '';
}

/** A scripted turn whose (unknown-)tool call errors → the driver stops with `tool_error`. */
const TOOL_ERROR_TURN = {
  text: 'I reach for the dice…',
  toolCalls: [{ id: 'boom', name: 'no_such_tool', arguments: {} }],
};

describe('ai-dm stuck ladder — detection (e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'stuck-model' });
    await h.enableExperimental();
  });
  beforeEach(() => {
    h.resetMock();
  });
  afterAll(async () => {
    await h.close();
  });

  it('#314 tool error → awaiting_players with the full recovery lever set + a `stuck` stream signal', async () => {
    const campaignId = await h.createCampaign('Stuck ToolError');
    await h.configureSeat(campaignId, seat);

    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: CampaignEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    h.script(TOOL_ERROR_TURN);
    const res = await h.sendMessage(campaignId, { input: 'I pick the lock.' });
    sub.unsubscribe();

    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('tool_error');

    const session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('awaiting_players');
    expect(session.body.stuck.reason).toBe('tool_error');
    expect(session.body.levers).toEqual(
      expect.arrayContaining(['retry', 'nudge', 'flag', 'vote', 'rules_lookup', 'request_takeover', 'pause']),
    );

    // The table was signalled over the SSE channel.
    const stuck = events.find((e) => e.type === 'stuck');
    expect(stuck).toBeDefined();
    expect(stuck && stuck.type === 'stuck' && stuck.reason).toBe('tool_error');

    // …and a table notification + audit row were written.
    const audit = await h.getAudit(campaignId);
    expect(audit.body.some((e: { action: string }) => e.action === 'ai-dm.driver.stuck')).toBe(true);
  });

  it('#314 budget exhaustion → awaiting_players (retry is off the table; takeover/pause remain)', async () => {
    const campaignId = await h.createCampaign('Stuck Budget');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 200 });

    // Step 0 overruns the whole budget AND asks for another tool → the loop halts before step 1
    // (never consuming a 2nd scripted turn — so we script exactly one to keep the shared queue aligned).
    h.script({
      text: 'burning tokens',
      toolCalls: [{ id: 'b1', name: 'roll_dice', arguments: { campaignId, expr: '2d6' } }],
      usage: { promptTokens: 300, completionTokens: 0, totalTokens: 300 },
    });
    const res = await h.sendMessage(campaignId, { input: 'go' });
    expect(res.body.stopReason).toBe('budget_exhausted');

    const session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('awaiting_players');
    expect(session.body.stuck.reason).toBe('budget_exhausted');
    expect(session.body.levers).toEqual(expect.arrayContaining(['request_takeover', 'pause']));

    // A retry is genuinely blocked — the budget is a hard stop.
    const retry = await h.lever(campaignId, 'nudge', {}, player);
    expect(retry.status).toBe(403);
  });

  it('#314 empty narration → no_narration; a verbatim repeat → loop', async () => {
    const campaignId = await h.createCampaign('Stuck Loop');
    await h.configureSeat(campaignId, seat);

    // Empty narration, no tool calls → the turn produced nothing.
    h.script({ text: '' });
    await h.sendMessage(campaignId, { input: 'look around' });
    let session = await h.getDriverSession(campaignId);
    expect(session.body.stuck.reason).toBe('no_narration');

    // Recover with a real line, then repeat it verbatim → loop detection.
    h.script({ text: 'The torch sputters.' });
    await h.lever(campaignId, 'nudge', {}, player);
    session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('running');

    h.script({ text: 'The torch sputters.' });
    await h.sendMessage(campaignId, { input: 'again' });
    session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('awaiting_players');
    expect(session.body.stuck.reason).toBe('loop');
  });
});

describe('ai-dm stuck ladder — player levers recover or hand off (e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'stuck-model' });
    await h.enableExperimental();
  });
  beforeEach(() => {
    h.resetMock();
  });
  afterAll(async () => {
    await h.close();
  });

  it('#314 retry/nudge recovers a stuck turn → running + a `recovered` signal', async () => {
    const campaignId = await h.createCampaign('Lever Nudge');
    await h.configureSeat(campaignId, seat);

    h.script(TOOL_ERROR_TURN);
    await h.sendMessage(campaignId, { input: 'I pick the lock.' });
    expect((await h.getDriverSession(campaignId)).body.state).toBe('awaiting_players');

    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: CampaignEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    // A player nudges with a hint; the replayed turn narrates cleanly and clears the stuck state.
    h.script({ text: 'The tumblers give — the lock clicks open.' });
    const nudge = await h.lever(campaignId, 'nudge', { hint: 'keep it moving' }, player);
    sub.unsubscribe();

    expect(nudge.status).toBe(201);
    expect(nudge.body.stopReason).toBe('complete');
    expect(nudge.body.narration).toBe('The tumblers give — the lock clicks open.');
    expect(events.some((e) => e.type === 'recovered')).toBe(true);

    const session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('running');
    expect(session.body.stuck).toBeNull();

    // The hint reached the model (injected into the replayed input) and the nudge is audited.
    expect(lastUserMessage(h.mock.received.at(-1)!)).toContain('keep it moving');
    const audit = await h.getAudit(campaignId);
    expect(audit.body.some((e: { action: string }) => e.action === 'ai-dm.driver.nudge')).toBe(true);
  });

  it('#314 flag forces a re-decision with the objection in context', async () => {
    const campaignId = await h.createCampaign('Lever Flag');
    await h.configureSeat(campaignId, seat);

    h.script({ text: 'The trap deals 20 damage. No save.' });
    await h.sendMessage(campaignId, { input: 'I step on the plate.' });

    h.script({ text: 'On review, a DC 12 Dex save halves it.' });
    const flag = await h.lever(campaignId, 'flag', { objection: 'that trap allows a saving throw' }, player);

    expect(flag.status).toBe(201);
    expect(flag.body.narration).toBe('On review, a DC 12 Dex save halves it.');

    // The dispute was injected into the re-run's user turn, and audited.
    const reReq = lastUserMessage(h.mock.received.at(-1)!);
    expect(reReq).toContain('DISPUTES');
    expect(reReq).toContain('saving throw');
    const audit = await h.getAudit(campaignId);
    expect(audit.body.some((e: { action: string }) => e.action === 'ai-dm.driver.flag')).toBe(true);
  });

  it('#314 a majority vote pauses the seat; a majority vote overrides a disputed ruling', async () => {
    // Vote-to-pause.
    const c1 = await h.createCampaign('Lever VotePause');
    await h.configureSeat(c1, seat);
    h.script({ text: 'A quiet moment.' });
    await h.sendMessage(c1, { input: 'we rest' });

    const open = await h.lever(c1, 'vote', { action: 'open', kind: 'pause' }, player);
    expect(open.status).toBe(201);
    expect(open.body.vote.kind).toBe('pause');
    const cast = await h.lever(c1, 'vote', { action: 'cast', choice: true }, player);
    expect(cast.body.vote.outcome).toBe('passed');
    expect(cast.body.state).toBe('paused');

    // The paused seat refuses new input.
    const blocked = await h.sendMessage(c1, { input: 'push on' });
    expect(blocked.status).toBe(503);
    const auditPause = await h.getAudit(c1);
    expect(auditPause.body.some((e: { action: string }) => e.action === 'ai-dm.driver.vote.resolve')).toBe(true);

    // Vote-to-override on a stuck seat clears the stuck state.
    const c2 = await h.createCampaign('Lever VoteOverride');
    await h.configureSeat(c2, seat);
    h.script(TOOL_ERROR_TURN);
    await h.sendMessage(c2, { input: 'I pick the lock.' });
    expect((await h.getDriverSession(c2)).body.state).toBe('awaiting_players');

    await h.lever(c2, 'vote', { action: 'open', kind: 'override' }, player);
    const overrideCast = await h.lever(c2, 'vote', { action: 'cast', choice: true }, player);
    expect(overrideCast.body.vote.outcome).toBe('passed');
    expect(overrideCast.body.state).toBe('running');
    expect(overrideCast.body.stuck).toBeNull();
  });

  it('#314 human takeover freezes the AI, then handback restores it — all audited', async () => {
    const campaignId = await h.createCampaign('Lever Takeover');
    await h.configureSeat(campaignId, seat);

    h.script(TOOL_ERROR_TURN);
    await h.sendMessage(campaignId, { input: 'I pick the lock.' });

    // A player asks for a takeover; the DM grants the acting-DM seat to that player.
    await h.lever(campaignId, 'request-takeover', {}, player);
    const grant = await h.lever(campaignId, 'grant-takeover', { memberId: 'dev:ai-eval-player', note: 'I got this' }, dm);
    expect(grant.status).toBe(201);
    expect(grant.body.state).toBe('human_control');
    expect(grant.body.actingDm.memberId).toBe('dev:ai-eval-player');

    // The AI seat is frozen — no AI turn can run while a human holds it.
    const frozen = await h.sendMessage(campaignId, { input: 'AI, narrate' });
    expect(frozen.status).toBe(503);
    expect(frozen.body.message).toContain('human');

    // The acting human hands the seat back with the call they made.
    const back = await h.lever(campaignId, 'handback', { note: 'the door was already open' }, player);
    expect(back.status).toBe(201);
    expect(back.body.state).toBe('running');
    expect(back.body.actingDm).toBeNull();

    // The AI can take turns again.
    h.script({ text: 'The story continues.' });
    const resumed = await h.sendMessage(campaignId, { input: 'onward' });
    expect(resumed.status).toBe(201);
    expect(resumed.body.narration).toBe('The story continues.');

    const audit = await h.getAudit(campaignId);
    const actions = audit.body.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['ai-dm.driver.takeover.request', 'ai-dm.driver.takeover.grant', 'ai-dm.driver.handback']));
  });

  it('#314 rules-lookup routes to the compendium instead of the model (no rule system → human note, not raw JSON)', async () => {
    const campaignId = await h.createCampaign('Lever Rules');
    await h.configureSeat(campaignId, seat);

    const before = h.mock.received.length;
    const res = await h.lever(campaignId, 'rules-lookup', { query: 'grappling rules' }, player);
    expect(res.status).toBe(201);
    expect(res.body.query).toBe('grappling rules');
    // #717: with no rule system configured the answer is a human-readable note, not raw
    // tool JSON. It must say no authoritative source is configured and point at settings.
    expect(typeof res.body.result).toBe('string');
    expect(res.body.result).not.toContain('{');
    expect(res.body.result).toMatch(/no rule system/i);
    expect(res.body.result).toMatch(/campaign settings/i);
    // No generative call was made — the model queue is untouched.
    expect(h.mock.received.length).toBe(before);
    const audit = await h.getAudit(campaignId);
    expect(audit.body.some((e: { action: string }) => e.action === 'ai-dm.driver.rules_lookup')).toBe(true);
  });
});

/**
 * Issue #717 — campaign-scoped rules lookups. The AI table's rules help must bind to the
 * campaign's active rule system so a multi-pack server answers a 5e question from the 5e
 * pack, not a Pathfinder pack, and render a concise human answer (system, source, pack,
 * compendium link) instead of injecting the raw serialized tool JSON into the transcript.
 */
describe('ai-dm rules-lookup — campaign rule-system scoping (#717)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'rules-model' });
    await h.enableExperimental();
  });
  afterAll(async () => {
    await h.close();
  });

  /** Upload a small open-licensed pack via the REST upload endpoint and wait for the job. */
  async function uploadPack(body: Record<string, unknown>): Promise<{ packId: number; slug: string }> {
    const res = await request(h.server).post('/api/v1/rules/packs/upload').set(dm).send(body);
    expect(res.status).toBe(202);
    const jobId = res.body.id as string;
    const maxAttempts = 100;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const jobRes = await request(h.server).get(`/api/v1/rules/packs/install-jobs/${jobId}`).set(dm);
      if (jobRes.body.status === 'completed' || jobRes.body.status === 'failed') {
        expect(jobRes.body.status).toBe('completed');
        return { packId: jobRes.body.pack.id, slug: jobRes.body.pack.slug };
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`uploadPack timed out waiting for job ${jobId}`);
  }

  // Two distinct packs that share an entry NAME ("Fireball") but live under different
  // systems — the isolation test proves the campaign's ruleSystem picks the right one.
  const dndPack = {
    source: 'upload' as const,
    pack: { slug: 'dnd-homebrew-srd', name: 'D&D Homebrew SRD', version: '1.0', license: 'OGL 1.0a', sourceUrl: 'https://example.com/dnd' },
    entries: [
      { slug: 'dnd-fireball', name: 'Fireball', type: 'spell', summary: 'A D&D fireball.', body: 'A bright streak flashes to a point you choose, then erupts.' },
      { slug: 'dnd-grappled', name: 'Grappled', type: 'condition', body: 'A grappled creature speed becomes 0.' },
    ],
  };
  const pfPack = {
    source: 'upload' as const,
    pack: { slug: 'pf-homebrew-srd', name: 'Pathfinder Homebrew SRD', version: '1.0', license: 'OGL 1.0a', sourceUrl: 'https://example.com/pf' },
    entries: [
      { slug: 'pf-fireball', name: 'Fireball', type: 'spell', summary: 'A Pathfinder fireball.', body: 'A bead of fire bursts into a roaring blast.' },
      { slug: 'pf-flat-footed', name: 'Flat-Footed', type: 'condition', body: 'You are unable to move freely.' },
    ],
  };

  it('scopes the answer to the campaign\'s configured rule system, never cross-system', async () => {
    const dnd = await uploadPack(dndPack);
    const pf = await uploadPack(pfPack);

    const campaignId = await h.createCampaign('Scoped Rules D&D');
    await h.configureSeat(campaignId, seat);
    // Point the campaign at the D&D pack.
    await request(h.server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ ruleSystem: dnd.slug });

    const res = await h.lever(campaignId, 'rules-lookup', { query: 'fireball' }, player);
    expect(res.status).toBe(201);
    // Human-readable answer: the D&D Fireball, its body, and a compendium link — not raw JSON.
    expect(res.body.result).toContain('Fireball');
    expect(res.body.result).toContain('bright streak');
    expect(res.body.result).toMatch(/Source: D&D Homebrew SRD/);
    expect(res.body.result).toMatch(/compendium/);
    // The Pathfinder Fireball (different body) must NOT leak in.
    expect(res.body.result).not.toContain('bead of fire');

    // Flip the campaign to the Pathfinder pack — the same query now returns the PF entry.
    await request(h.server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ ruleSystem: pf.slug });
    const pfRes = await h.lever(campaignId, 'rules-lookup', { query: 'fireball' }, player);
    expect(pfRes.status).toBe(201);
    expect(pfRes.body.result).toContain('bead of fire');
    expect(pfRes.body.result).not.toContain('bright streak');

    // cleanup so other tests start clean
    await request(h.server).delete(`/api/v1/rules/packs/${dnd.packId}`).set(dm);
    await request(h.server).delete(`/api/v1/rules/packs/${pf.packId}`).set(dm);
  });

  it('distinguishes no-match from failure and suggests refinements', async () => {
    const dnd = await uploadPack(dndPack);
    const campaignId = await h.createCampaign('No Match Rules');
    await h.configureSeat(campaignId, seat);
    await request(h.server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ ruleSystem: dnd.slug });

    const res = await h.lever(campaignId, 'rules-lookup', { query: 'totally-absent-nonsense-query' }, player);
    expect(res.status).toBe(201);
    // A no-match is a clean 201 with a human message — NOT a tool error / raw JSON failure.
    expect(res.body.result).not.toContain('{');
    expect(res.body.result).toMatch(/no entry/i);
    expect(res.body.result).toMatch(/D&D Homebrew SRD/);
    // Issue #1898 review: the search this responds to now also covers the campaign's
    // own homebrew (rulesLookup always passes campaignId once pack resolves), so the
    // wording must not claim the miss was limited to the installed pack.
    expect(res.body.result).toMatch(/homebrew/i);
    expect(res.body.result).toMatch(/broader term|exact name|spelling/i);

    await request(h.server).delete(`/api/v1/rules/packs/${dnd.packId}`).set(dm);
  });

  // Issue #1898 review: rulesLookup() is a fourth internal caller of RulesService.search
  // alongside REST /rules/search, REST /rules/entries/:id, and MCP lookup_rule — all three
  // of which now scope to the campaign's homebrew. This call site had campaignId and user
  // in scope on its own method signature already, so omitting them was the same defect,
  // just not enumerated in the issue's list: a campaign's own homebrew ruling reported as
  // "no entry" instead of being found.
  it('finds a campaign homebrew entry the installed pack alone does not have (#1898)', async () => {
    const dnd = await uploadPack(dndPack);
    const campaignId = await h.createCampaign('Homebrew Rules Lookup');
    await h.configureSeat(campaignId, seat);
    await request(h.server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ ruleSystem: dnd.slug });

    const homebrew = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/homebrew`)
      .set(dm)
      .send({
        slug: 'shadow-grapple',
        name: 'Shadow Grapple',
        type: 'condition',
        summary: '',
        body: 'A shadow-bound creature cannot be moved by anything but its captor.',
        rightsStatus: 'private_original',
      });
    expect(homebrew.status).toBe(201);

    // Not in the installed D&D pack at all — before the fix this reported "no entry".
    const res = await h.lever(campaignId, 'rules-lookup', { query: 'Shadow Grapple' }, player);
    expect(res.status).toBe(201);
    expect(res.body.result).not.toMatch(/no entry/i);
    expect(res.body.result).toContain('Shadow Grapple');
    expect(res.body.result).toContain('shadow-bound creature');
    // Issue #1898 review: the homebrew source line must credit "Campaign homebrew", never
    // the installed D&D pack (whose name/license this private house rule has nothing to
    // do with) — an assertion on the body alone would not have caught the mis-attribution
    // this fix corrects. private_original (no license set) shows no license fragment.
    expect(res.body.result).toContain('*Source: Campaign homebrew*');
    expect(res.body.result).not.toContain('D&D Homebrew SRD');
    expect(res.body.result).not.toContain('OGL 1.0a');
    // The compendium link must be campaign-scoped — the web router only registers
    // /c/:campaignId/compendium/:entryId, never a bare /compendium/:id.
    expect(res.body.result).toMatch(new RegExp(`\\]\\(/c/${campaignId}/compendium/\\d+\\)`));
    expect(res.body.result).not.toMatch(/]\(\/compendium\//);

    await request(h.server).delete(`/api/v1/rules/packs/${dnd.packId}`).set(dm);
  });

  it('credits an open-licensed homebrew entry under its OWN license and author, not the installed pack\'s (#1898)', async () => {
    const dnd = await uploadPack(dndPack);
    const campaignId = await h.createCampaign('Homebrew Attribution Lookup');
    await h.configureSeat(campaignId, seat);
    await request(h.server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ ruleSystem: dnd.slug });

    const homebrew = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/homebrew`)
      .set(dm)
      .send({
        slug: 'sunfire-brand',
        name: 'Sunfire Brand',
        type: 'item',
        summary: '',
        body: 'A blade that sheds daylight in a 20-foot radius.',
        rightsStatus: 'open_licensed',
        license: 'CC-BY-4.0',
        author: 'Table 7',
        sourceUrl: 'https://example.invalid/sunfire-brand',
      });
    expect(homebrew.status).toBe(201);

    const res = await h.lever(campaignId, 'rules-lookup', { query: 'Sunfire Brand' }, player);
    expect(res.status).toBe(201);
    expect(res.body.result).toContain('*Source: Campaign homebrew · Table 7 · CC-BY-4.0*');
    expect(res.body.result).not.toContain('D&D Homebrew SRD');
    expect(res.body.result).not.toContain('OGL 1.0a');

    await request(h.server).delete(`/api/v1/rules/packs/${dnd.packId}`).set(dm);
  });

  it('finds a campaign homebrew entry when the campaign has no rule system configured (#1967)', async () => {
    const campaignId = await h.createCampaign('Pure Homebrew Campaign');
    await h.configureSeat(campaignId, seat);

    const homebrew = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/homebrew`)
      .set(dm)
      .send({
        slug: 'homebrew-curse',
        name: 'Homebrew Curse',
        type: 'condition',
        summary: '',
        body: 'Target creature suffers disadvantage on all checks.',
        rightsStatus: 'private_original',
      });
    expect(homebrew.status).toBe(201);

    const res = await h.lever(campaignId, 'rules-lookup', { query: 'Homebrew Curse' }, player);
    expect(res.status).toBe(201);
    expect(res.body.result).not.toContain('no rule system configured');
    expect(res.body.result).toContain('Homebrew Curse');
    expect(res.body.result).toContain('disadvantage on all checks');
    expect(res.body.result).toContain('*Source: Campaign homebrew*');
  });
});
