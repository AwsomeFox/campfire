import request from 'supertest';
import { ConflictException } from '@nestjs/common';
import { createAiEvalHarness, dm, player, viewer, type AiEvalHarness } from './ai-eval-harness';
import { AiDriverService } from '../src/modules/ai-driver/ai-driver.service';
import { AiDmStreamService, type AiDmStreamEvent } from '../src/modules/ai-driver/ai-driver-stream.service';

/**
 * Driver-runtime SECURITY + correctness regressions (post-merge review of the AI-DM program).
 * Each test pins one of the issues #375–#387 against the deterministic offline harness (#318):
 *
 *  #377  a model-supplied `propose:false` can NOT write canon directly — the runtime forces propose.
 *  #378  administrative / economy direct-write tools (update_campaign, adjust_treasury, approve_proposal)
 *        are blocked server-side (default-deny allow-list), not just the old hand-picked denylist.
 *  #384  the seat is scoped to ONE campaign (entity-keyed writes to another campaign 403), and the
 *        server-wide token cap bounds the driver.
 *  #375  a player can neither un-freeze a DM pause nor revoke a takeover held by someone else.
 *  #376  Co-DM mode (the propose-only mode) does NOT arm the autonomous driver loop.
 *  #381  a pause landing mid-turn is preserved (not reverted); concurrent turns are serialized.
 *  #382  a table vote can FAIL (no majority) instead of deadlocking every future vote.
 *  #383  autonomous driver proposals are attributed to the AI (`ai-dm:` prefix), not the seat's raw id.
 *  #387  DM-only secrets never enter the model context that feeds narration to every player + viewer.
 */

describe('ai-dm driver — security + correctness regressions (#375–#387, e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'sec-model' });
    await h.enableExperimental();
  });
  afterAll(async () => {
    await h.close();
  });

  // ── #377 ────────────────────────────────────────────────────────────────────
  it('#377 a model-emitted propose:false on a canon tool is coerced to a PROPOSAL, never a direct write', async () => {
    const campaignId = await h.createCampaign('Sec Propose False');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // The model tries to bypass review by explicitly setting propose:false on a proposal-capable tool.
    h.script(
      {
        text: 'Rewriting canon…',
        toolCalls: [{ id: 'q1', name: 'create_quest', arguments: { campaignId, title: 'Backdoored Quest', propose: false } }],
      },
      { text: 'The rumor spreads.' },
    );
    const res = await h.sendMessage(campaignId, { input: 'make a quest' });
    expect(res.status).toBe(201);
    // Still routed to the proposal queue despite propose:false.
    expect(res.body.toolCalls).toEqual([{ name: 'create_quest', isError: false, proposed: true }]);

    // It exists ONLY as a pending proposal — no quest was written to canon directly.
    const proposals = await request(h.server).get(`/api/v1/campaigns/${campaignId}/proposals`).set(dm);
    expect(proposals.body.filter((p: { status: string; entityType: string }) => p.status === 'pending' && p.entityType === 'quest')).toHaveLength(1);
    const quests = await request(h.server).get(`/api/v1/campaigns/${campaignId}/quests`).set(dm);
    expect(quests.body.find((q: { title: string }) => q.title === 'Backdoored Quest')).toBeUndefined();
  });

  // ── #378 ────────────────────────────────────────────────────────────────────
  it('#378 update_campaign / adjust_treasury / approve_proposal are blocked (and never offered)', async () => {
    const campaignId = await h.createCampaign('Sec Denylist');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    for (const name of ['update_campaign', 'adjust_treasury', 'approve_proposal']) {
      // A blocked tool stops the turn after step 1 (tool_error), so script exactly ONE turn —
      // scripting a follow-up narration would leave it unconsumed and bleed into the next test.
      h.script({ text: 'Trying…', toolCalls: [{ id: `x-${name}`, name, arguments: { campaignId } }] });
      const res = await h.sendMessage(campaignId, { input: `call ${name}` });
      expect(res.status).toBe(201);
      expect(res.body.toolCalls).toEqual([{ name, isError: true, proposed: false }]);
      expect(res.body.stopReason).toBe('tool_error');
    }

    // None were even OFFERED to the model (schema withholding), while live-play + propose tools are.
    const firstReq = h.mock.received.find((r) => (r.tools ?? []).length > 0)!;
    const offered = (firstReq.tools ?? []).map((t) => t.name);
    expect(offered).not.toContain('update_campaign');
    expect(offered).not.toContain('adjust_treasury');
    expect(offered).not.toContain('approve_proposal');
    expect(offered).toContain('roll_dice'); // live play
    expect(offered).toContain('create_quest'); // proposal-capable canon
  });

  // ── #384 part 1 ───────────────────────────────────────────────────────────────
  it('#384 the seat is scoped to its campaign — an entity-keyed write to ANOTHER campaign 403s', async () => {
    const campA = await h.createCampaign('Sec Scope A');
    const campB = await h.createCampaign('Sec Scope B');
    await h.configureSeat(campA, { mode: 'driver', tokenBudget: 100_000 });

    // A character living in campaign B — the driver seat runs for campaign A.
    const charB = await request(h.server).post(`/api/v1/campaigns/${campB}/characters`).set(dm).send({ name: 'Bystander', hpMax: 20, hpCurrent: 20 });
    expect(charB.status).toBe(201);
    const charBId = charB.body.id as number;

    // update_character_hp is entity-keyed (characterId, no campaignId) — exactly the class that
    // slipped past the campaignId-arg guard. The seat is a DM on every campaign by devRole, so only
    // the tokenContext campaign binding stops this cross-campaign write.
    // Cross-campaign write is blocked → the turn stops after step 1; script exactly one turn.
    h.script({ text: 'Reaching across tables…', toolCalls: [{ id: 'hp', name: 'update_character_hp', arguments: { characterId: charBId, set: 1 } }] });
    const res = await h.sendMessage(campA, { input: 'hurt the other table' });
    expect(res.status).toBe(201);
    expect(res.body.toolCalls).toEqual([{ name: 'update_character_hp', isError: true, proposed: false }]);

    // Campaign B's character is untouched (character reads are the top-level /characters/:id route).
    const check = await request(h.server).get(`/api/v1/characters/${charBId}`).set(dm);
    expect(check.status).toBe(200);
    expect(check.body.hpCurrent).toBe(20);
  });

  // ── #384 part 2 ───────────────────────────────────────────────────────────────
  it('#384 the server-wide token cap bounds the driver (not just per-campaign budget)', async () => {
    const campaignId = await h.createCampaign('Sec Cap');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 1_000_000 });

    h.script({ text: 'A first turn to spend some tokens.' });
    const first = await h.sendMessage(campaignId, { input: 'go' });
    expect(first.status).toBe(201);
    expect(first.body.tokensUsed).toBeGreaterThan(0);

    // Set the server-wide cap BELOW what's already been metered across all seats.
    const caps = await request(h.server).put('/api/v1/settings/ai/caps').set(dm).send({ serverTokenCap: 1 });
    expect(caps.status).toBe(200);

    // Rejected at the cap BEFORE any provider call, so nothing is scripted/consumed here.
    const blocked = await h.sendMessage(campaignId, { input: 'again' });
    expect(blocked.status).toBe(403);
    expect(blocked.text).toContain('cap');

    // Reset the cap so it doesn't bleed into later tests on this app.
    await request(h.server).put('/api/v1/settings/ai/caps').set(dm).send({ serverTokenCap: 0 });
  });

  // ── #376 ────────────────────────────────────────────────────────────────────
  it('#376 Co-DM mode does NOT arm the driver loop — a turn is refused with a mode reason', async () => {
    const campaignId = await h.createCampaign('Sec CoDm Mode');
    // enabled=true + Co-DM (the propose-only mode). Under the old gate this armed the driver.
    await h.configureSeat(campaignId, { mode: 'co_dm', tokenBudget: 100_000 });

    const res = await h.sendMessage(campaignId, { input: 'drive the table' });
    expect(res.status).toBe(403);
    expect(res.text).toContain('Driver mode');
  });

  // ── #382 ────────────────────────────────────────────────────────────────────
  it('#382 a table vote can FAIL (no majority) and then a fresh vote can open — no permanent deadlock', async () => {
    const campaignId = await h.createCampaign('Sec Vote Fail');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    h.script({ text: 'A quiet moment.' });
    await h.sendMessage(campaignId, { input: 'we rest' });

    const open = await h.lever(campaignId, 'vote', { action: 'open', kind: 'pause' }, player);
    expect(open.status).toBe(201);
    // Everyone votes NO → the vote resolves as FAILED instead of hanging open forever.
    const cast = await h.lever(campaignId, 'vote', { action: 'cast', choice: false }, player);
    expect(cast.status).toBe(201);
    expect(cast.body.vote.resolved).toBe(true);
    expect(cast.body.vote.outcome).toBe('failed');
    // The seat was NOT paused by a failed pause-vote.
    expect(cast.body.status).not.toBe('paused');

    // A new vote can be opened — the failed one no longer blocks (the old code 409'd forever).
    const reopen = await h.lever(campaignId, 'vote', { action: 'open', kind: 'override' }, player);
    expect(reopen.status).toBe(201);
    expect(reopen.body.vote.resolved).toBe(false);
  });

  // ── #383 ────────────────────────────────────────────────────────────────────
  it('#383 an autonomous driver proposal is attributed to the AI (ai-dm: prefix), badge-able in review', async () => {
    const campaignId = await h.createCampaign('Sec Attribution');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    h.script(
      { text: 'A thread emerges…', toolCalls: [{ id: 'q', name: 'create_quest', arguments: { campaignId, title: 'AI-authored thread' } }] },
      { text: 'It spreads.' },
    );
    await h.sendMessage(campaignId, { input: 'what quest?' });

    const proposals = await request(h.server).get(`/api/v1/campaigns/${campaignId}/proposals`).set(dm);
    const quest = proposals.body.find((p: { entityType: string }) => p.entityType === 'quest');
    expect(quest).toBeDefined();
    // The review-queue AI badge/filter keys on the `ai-dm:` prefix — the seat's own audit id is
    // `ai-dm-seat:…` (which does NOT match), so without normalization these render unbadged.
    expect(quest.proposerUserId).toBe(`ai-dm:${campaignId}`);
    expect(quest.proposerUserId.startsWith('ai-dm:')).toBe(true);
    expect(quest.proposer).toContain('AI');
  });

  // ── #387 ────────────────────────────────────────────────────────────────────
  it('#387 DM-only secrets never enter the model context that streams narration to every member', async () => {
    const campaignId = await h.createCampaign('Sec Secret Leak');
    await h.configureSeat(campaignId, { mode: 'driver', instructions: 'Be terse.', tokenBudget: 100_000 });

    // A hidden NPC with a DM secret — DM-only material, excluded wholesale from a non-DM view.
    const npc = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'Gravewhisper', hidden: true, dmSecret: 'THE_INNKEEPER_IS_A_LICH' });
    expect(npc.status).toBe(201);

    h.script({ text: 'The room is dim.' });
    await h.sendMessage(campaignId, { input: 'look around' });

    // The assembled system prompt (what the model reasons from, and narrates to players + viewers)
    // must carry NEITHER the secret NOR the hidden NPC's name — the seat's context is player-scoped.
    const system = h.mock.received.at(-1)!.system ?? '';
    expect(system).not.toContain('THE_INNKEEPER_IS_A_LICH');
    expect(system).not.toContain('Gravewhisper');
  });
});

// ── #375 (handback authorization) — a fresh harness so takeover state is isolated ──────────────
describe('ai-dm driver — #375 pause/takeover levers are properly authorized (e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'sec-model' });
    await h.enableExperimental();
  });
  afterAll(async () => {
    await h.close();
  });

  it('a player cannot use handback to un-freeze a DM pause (409, and the pause holds)', async () => {
    const campaignId = await h.createCampaign('Sec DM Pause Bypass');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // DM pauses the seat (DM-only lever).
    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/pause`).set(dm).send({ paused: true });

    // A player tries to launder the pause off via handback — there is no human_control grant, so 409.
    const bypass = await h.lever(campaignId, 'handback', {}, player);
    expect(bypass.status).toBe(409);

    // The pause still holds — the AI seat cannot be resumed by the player, and turns stay refused.
    const session = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/session`).set(dm);
    expect(session.body.status).toBe('paused');
    // Rejected at the paused gate BEFORE any provider call — nothing scripted/consumed.
    const stillPaused = await h.sendMessage(campaignId, { input: 'go' });
    expect(stillPaused.status).toBe(503);
  });

  it('only the grant holder or a DM may hand the seat back — a bystander player is refused (403)', async () => {
    const campaignId = await h.createCampaign('Sec Takeover Revoke');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // The intended holder first offers to take over (so their id is a known, pending requester —
    // grantTakeover now validates an explicit memberId against the table, #337).
    const holder = { 'x-dev-role': 'player', 'x-dev-user': 'the-holder' };
    await h.lever(campaignId, 'request-takeover', {}, holder);

    // The DM grants the acting-DM seat to that one specific human.
    const grant = await h.lever(campaignId, 'grant-takeover', { memberId: 'dev:the-holder', note: 'you run it' }, dm);
    expect(grant.body.state).toBe('human_control');

    // A DIFFERENT player (not the grant holder, not a DM) cannot revoke the takeover.
    const bystander = { 'x-dev-role': 'player', 'x-dev-user': 'someone-else' };
    const revoke = await h.lever(campaignId, 'handback', {}, bystander);
    expect(revoke.status).toBe(403);

    // The takeover still stands.
    const session = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/session`).set(dm);
    expect(session.body.state).toBe('human_control');
    expect(session.body.actingDm.memberId).toBe('dev:the-holder');

    // A DM (not the holder) CAN hand it back.
    const dmHandback = await h.lever(campaignId, 'handback', {}, dm);
    expect(dmHandback.status).toBe(201);
    expect(dmHandback.body.state).toBe('running');
  });

  // ── #337 (takeover polish) ────────────────────────────────────────────────────
  it('#337 grant-takeover rejects an explicit memberId that belongs to nobody at the table (400)', async () => {
    const campaignId = await h.createCampaign('Sec Takeover Stranger');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // A stranger who never requested the seat and is no member of the campaign cannot be named.
    const bad = await h.lever(campaignId, 'grant-takeover', { memberId: 'dev:stranger', note: 'run it' }, dm);
    expect(bad.status).toBe(400);

    // The AI seat was NOT frozen by the rejected grant.
    const session = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/session`).set(dm);
    expect(session.body.state).not.toBe('human_control');
    expect(session.body.actingDm).toBeFalsy();

    // The DM may still grant it to THEMSELVES (self-takeover) without naming an outsider.
    const ok = await h.lever(campaignId, 'grant-takeover', { note: 'I will run it' }, dm);
    expect(ok.status).toBe(201);
    expect(ok.body.state).toBe('human_control');
  });

  it('#337 a pause vote passing during human_control does NOT clobber the takeover', async () => {
    const campaignId = await h.createCampaign('Sec Vote Vs Takeover');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // A human takes the seat (defaults the holder to the granting DM) → state human_control.
    const grant = await h.lever(campaignId, 'grant-takeover', {}, dm);
    expect(grant.body.state).toBe('human_control');

    // A table pause vote is opened and passes while the human holds the seat.
    const open = await h.lever(campaignId, 'vote', { action: 'open', kind: 'pause' }, player);
    expect(open.status).toBe(201);
    const cast = await h.lever(campaignId, 'vote', { action: 'cast', choice: true }, player);
    expect(cast.status).toBe(201);
    expect(cast.body.vote.outcome).toBe('passed');

    // The passed pause must not strand the acting-DM grant by flipping state away from human_control.
    expect(cast.body.state).toBe('human_control');
    const session = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/session`).set(dm);
    expect(session.body.state).toBe('human_control');
    expect(session.body.actingDm).toBeTruthy();
  });
});

// ── #381 (mid-turn state preservation + turn serialization) ───────────────────────────────────
describe('ai-dm driver — #381 mid-turn control state is not reverted; turns serialize (e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'sec-model' });
    await h.enableExperimental();
  });
  afterAll(async () => {
    await h.close();
  });

  it('a pause that lands DURING a turn survives the turn end (status stays paused)', async () => {
    const campaignId = await h.createCampaign('Sec Mid-Turn Pause');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    const driver = h.ctx.app.get(AiDriverService);
    const streamSvc = h.ctx.app.get(AiDmStreamService);
    // On the FIRST streamed token, pause the seat — i.e. a pause lands mid-turn.
    let paused = false;
    const sub = streamSvc.streamFor(campaignId).subscribe((e: AiDmStreamEvent) => {
      if (e.type === 'narration.delta' && !paused) {
        paused = true;
        driver.setPaused(campaignId, true);
      }
    });

    h.script({ text: 'The torches gutter as the door swings wide.', streamChunks: 4 });
    const res = await h.sendMessage(campaignId, { input: 'we enter' });
    sub.unsubscribe();
    expect(res.status).toBe(201);
    expect(paused).toBe(true);

    // The turn's finally/detect path must NOT stomp the mid-turn pause back to idle/running.
    const session = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/session`).set(dm);
    expect(session.body.status).toBe('paused');
    expect(session.body.state).toBe('paused');

    // And the freeze is real — a follow-up turn is refused (rejected before any provider call).
    const refused = await h.sendMessage(campaignId, { input: 'onward' });
    expect(refused.status).toBe(503);
  });

  it('a concurrent turn is rejected while one is already in progress (409)', async () => {
    const campaignId = await h.createCampaign('Sec Concurrent');
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });

    // Drive the service directly with two OVERLAPPING turns (calling the controller twice over HTTP
    // races supertest's per-request connection lifecycle). The first reserves the turn slot
    // synchronously; the second must be rejected as already-in-progress (#381).
    const driver = h.ctx.app.get(AiDriverService);
    const user = { id: 'dev:ai-eval-dm', name: 'ai-eval-dm', serverRole: 'user' as const, devRole: 'dm' as const };
    h.script({ text: 'The first turn narrates slowly, token by token.', streamChunks: 6 });
    const results = await Promise.allSettled([
      driver.runTurn(campaignId, user, 'first'),
      driver.runTurn(campaignId, user, 'interrupt'),
    ]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
  });
});
