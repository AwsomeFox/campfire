import request from 'supertest';
import { createAiEvalHarness, dm, player, viewer, type AiEvalHarness } from './ai-eval-harness';
import type { CampaignEvent } from '@campfire/schema';
import { AiDmStreamService } from '../src/modules/ai-driver/ai-driver-stream.service';
import {
  GROUNDING_BLOCK_END,
  GROUNDING_BLOCK_START,
} from '../src/modules/ai-driver/driver-grounding';

/**
 * #577 — AI Driver grounding, end to end.
 *
 * The bug being closed: "Never invent rules/canon" was prompt text and nothing else. An uncited
 * free-form model response with no retrieval completed the turn as `complete` and was styled and
 * broadcast to the whole table as authoritative DM narration.
 *
 * These cases drive the REAL HTTP surface with a scripted model, so they cover the part unit
 * tests cannot: that the ledger is seeded from the actual system-prompt context reads, that the
 * verdict rides the real turn result / SSE channel / review endpoint, that an unverified ruling
 * parks the seat on the stuck ladder, and that a DM's correction genuinely reaches the next
 * turn's prompt.
 */

/** Wrap a claim payload in the fence the model is instructed to emit. */
function groundingBlock(claims: unknown[]): string {
  return `\n${GROUNDING_BLOCK_START}\n${JSON.stringify({ claims })}\n${GROUNDING_BLOCK_END}`;
}

describe('ai-dm driver — grounding: creative narration vs. factual claims (#577)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'driver-model' });
    await h.enableExperimental();
  });

  beforeEach(() => {
    h.resetMock();
  });

  afterAll(async () => {
    await h.close();
  });

  async function armedCampaign(name: string): Promise<number> {
    const campaignId = await h.createCampaign(name);
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 50_000 });
    return campaignId;
  }

  it('a fabricated rule citation is published UNVERIFIED, not accepted as a complete turn', async () => {
    const campaignId = await armedCampaign('Grounding fabricated rule');

    h.script({
      text:
        'You feel the arcane words land: a fireball in this edition deals 12d6, no save.' +
        groundingBlock([
          { text: 'A fireball deals 12d6 with no save.', kind: 'rule', cites: [{ type: 'rule', id: 999_001 }] },
        ]),
    });
    const res = await h.sendMessage(campaignId, { input: 'I cast fireball.' });
    expect(res.status).toBe(201);

    // The narration is still delivered — deleting text the DM never saw is worse than labelling it.
    expect(res.body.narration).toContain('fireball in this edition deals 12d6');
    // ...but the protocol framing never reaches the table.
    expect(res.body.narration).not.toContain('GROUNDING');

    expect(res.body.grounding.status).toBe('unverified');
    expect(res.body.grounding.unsupportedCount).toBe(1);
    expect(res.body.grounding.claims[0]).toMatchObject({ kind: 'rule', reason: 'not_retrieved' });

    // Routed to stuck recovery so the table gets the levers rather than a silently confident DM.
    const session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('awaiting_players');
    expect(session.body.stuck).toMatchObject({ reason: 'unsupported_claim' });
    expect(session.body.levers).toEqual(expect.arrayContaining(['flag', 'nudge', 'rules_lookup', 'request_takeover']));
  });

  it('a canon claim citing an entity the turn actually retrieved is accepted as supported', async () => {
    const campaignId = await armedCampaign('Grounding supported canon');
    // A real NPC, created through the normal DM path. The driver's system-prompt assembly reads
    // the campaign summary under a player-scoped principal, which is what makes this id citeable.
    const npc = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      // hidden:false explicitly — NPC creates default to DM-only (#754), and a hidden NPC is
      // (correctly) invisible to the player-scoped context read, so it would not be citeable.
      .send({ name: 'Kaeda', body: 'Keeper of the Rusted Kettle.', hidden: false });
    expect(npc.status).toBe(201);
    const npcId = npc.body.id as number;

    h.script({
      text:
        'Kaeda wipes down the bar and nods at you.' +
        groundingBlock([
          { text: 'Kaeda keeps the Rusted Kettle.', kind: 'canon', cites: [{ type: 'npc', id: npcId }] },
        ]),
    });
    const res = await h.sendMessage(campaignId, { input: 'Who is behind the bar?' });
    expect(res.status).toBe(201);
    expect(res.body.grounding.status).toBe('clean');
    expect(res.body.grounding.unsupportedCount).toBe(0);
    expect(res.body.grounding.claims[0].citations[0]).toMatchObject({
      type: 'npc',
      id: npcId,
      status: 'supported',
      href: `/c/${campaignId}/npcs/${npcId}`,
    });

    const session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('running');
    expect(session.body.stuck).toBeNull();
  });

  it('pure creative narration stays completely ungated — no claims, no card, no stuck', async () => {
    const campaignId = await armedCampaign('Grounding creative');
    h.script({ text: 'Rain hammers the shutters and the fire spits.' + groundingBlock([]) });
    const res = await h.sendMessage(campaignId, { input: 'I listen to the storm.' });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('complete');
    expect(res.body.grounding.status).toBe('clean');
    expect(res.body.grounding.claims).toHaveLength(0);

    const claims = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/grounding`).set(dm);
    expect(claims.status).toBe(200);
    expect(claims.body).toHaveLength(0);
  });

  it('a false "the DM approved it" claim is flagged even with no citation block at all', async () => {
    const campaignId = await armedCampaign('Grounding false approval');
    h.script({ text: 'The DM has approved this, so your new noble title is now canon.' });
    const res = await h.sendMessage(campaignId, { input: 'Can I be a baron?' });
    expect(res.status).toBe(201);
    expect(res.body.grounding.status).toBe('unverified');
    expect(res.body.grounding.claims.some((c: { reason: string }) => c.reason === 'false_application_claim')).toBe(true);
  });

  it('emits a grounding SSE frame carrying provenance, and never streams the citation block', async () => {
    const campaignId = await armedCampaign('Grounding SSE');
    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: CampaignEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    h.script({
      text:
        'The vault door is warded.' +
        groundingBlock([{ text: 'The vault is warded.', kind: 'canon', cites: [{ type: 'location', id: 424_242 }] }]),
      streamChunks: 6,
    });
    await h.sendMessage(campaignId, { input: 'I inspect the door.' });
    sub.unsubscribe();

    const grounding = events.find((e) => e.type === 'grounding');
    expect(grounding).toBeDefined();
    expect(grounding).toMatchObject({ status: 'unverified', unsupportedCount: 1, provider: 'mock' });

    // The provenance badge is provider NAME + model only. No secret ever rides this channel.
    const wire = JSON.stringify(events);
    for (const secret of ['apiKey', 'api_key', 'Authorization', 'baseUrl']) {
      expect(wire).not.toContain(secret);
    }

    // Token-by-token delivery must not show the table raw JSON, even split across chunks.
    const streamed = events
      .filter((e) => e.type === 'narration.delta')
      .map((e) => (e.type === 'narration.delta' ? e.text : ''))
      .join('');
    // Trimmed: the filter suppresses from the fence onward, so the whitespace that separated the
    // prose from the block is legitimately still narration.
    expect(streamed.trim()).toBe('The vault door is warded.');
    expect(streamed).not.toContain('GROUNDING');
    expect(streamed).not.toContain('claims');
    const messages = events.filter((e) => e.type === 'narration.message');
    for (const m of messages) expect(JSON.stringify(m)).not.toContain('GROUNDING');
  });

  it('exposes the claim to the table with its evidence, and lets a DM correct it into later turns', async () => {
    const campaignId = await armedCampaign('Grounding correction loop');

    h.script({
      text:
        'Everyone gets advantage while underwater — that is the rule here.' +
        groundingBlock([
          { text: 'Everyone gets advantage underwater.', kind: 'rule', cites: [{ type: 'rule', id: 777_777 }] },
        ]),
    });
    await h.sendMessage(campaignId, { input: 'I swim down.' });

    // Members — not just the DM — can see what the AI asserted and that it is unverified.
    const asPlayer = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/grounding`).set(player);
    expect(asPlayer.status).toBe(200);
    expect(asPlayer.body).toHaveLength(1);
    expect(asPlayer.body[0]).toMatchObject({
      status: 'unsupported',
      reason: 'not_retrieved',
      kind: 'rule',
      provider: 'mock',
    });
    expect(typeof asPlayer.body[0].model).toBe('string');
    expect(JSON.stringify(asPlayer.body[0])).not.toContain('apiKey');
    const claimId = asPlayer.body[0].id as number;

    // A player may read the card but may not overrule the AI on the table's behalf.
    const playerCorrect = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/grounding/correct`)
      .set(player)
      .send({ claimId, correction: 'nope' });
    expect(playerCorrect.status).toBe(403);

    const corrected = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/grounding/correct`)
      .set(dm)
      .send({ claimId, correction: 'Underwater grants disadvantage on melee attacks, not advantage.' });
    expect(corrected.status).toBe(201);
    expect(corrected.body).toMatchObject({ status: 'corrected', correctedBy: expect.any(String) });
    // The original claim text survives the correction — the table may need to argue about it.
    expect(corrected.body.claimText).toContain('advantage underwater');

    // The correction must reach the NEXT turn's prompt as table-authoritative.
    h.resetMock();
    h.script({ text: 'You push deeper into the dark water.' + groundingBlock([]) });
    await h.sendMessage(campaignId, { input: 'I swim deeper.' });
    const lastSystem = h.mock.received.at(-1)?.system ?? '';
    expect(lastSystem).toContain('Table corrections');
    expect(lastSystem).toContain('disadvantage on melee attacks');
  });

  it('a correction for a claim in another campaign is a 404, not a cross-campaign write', async () => {
    const a = await armedCampaign('Grounding scope A');
    const b = await armedCampaign('Grounding scope B');
    h.script({
      text:
        'A ward flares.' +
        groundingBlock([{ text: 'The ward is ancient.', kind: 'canon', cites: [{ type: 'npc', id: 555_555 }] }]),
    });
    await h.sendMessage(a, { input: 'I look at the ward.' });
    const claims = await request(h.server).get(`/api/v1/campaigns/${a}/ai-dm/grounding`).set(dm);
    const claimId = claims.body[0].id as number;

    const wrongCampaign = await request(h.server)
      .post(`/api/v1/campaigns/${b}/ai-dm/grounding/correct`)
      .set(dm)
      .send({ claimId, correction: 'not yours' });
    expect(wrongCampaign.status).toBe(404);
  });


  /**
   * REVIEW REGRESSION (#577 / #825 / #557).
   *
   * The #557 secret-read approval is the DM deliberately letting the AI read ONE hidden entity
   * so it can reason about it. That read runs under the DM-scoped SEAT principal, so the id it
   * returns is one no player may see. If the model then does the cooperative thing and CITES
   * what it read, the citation is genuinely supported — and before this fix the supported
   * citation (id + a deep link straight to the hidden entity) was published verbatim to every
   * member through GET /ai-dm/grounding and to any player through the turn result.
   *
   * The AI behaving correctly was what leaked the DM's prep.
   */
  /**
   * #1043 — the SAME leak, through a NEW door.
   *
   * `POST /ai-dm/start-session` is player-callable (sitting down to play is a table act) and runs
   * a full driver turn with tools, so its result carries the same `turn.grounding` — including
   * the raw `retrievals` ledger, which lists every id the turn read whether or not the model
   * cited any of them. `POST /ai-dm/message` had projected that for the reading role since #577;
   * the lifecycle endpoint shipped without it.
   *
   * A greeting is the WORST turn to leak from: recapping the last session is exactly the turn
   * most likely to touch a concealed NPC or an unrevealed quest, because that is what a recap is
   * about. This asserts on a player's response BODY, not on whether a projection helper was
   * called — the projection is now applied at the controller boundary rather than per-handler,
   * so a call-site assertion would test the wrong thing.
   */
  it('never leaks a DM-only id through the player-callable start-session greeting (#1043)', async () => {
    const campaignId = await armedCampaign('Grounding lifecycle leak');

    const npc = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'The Patron', body: 'Secretly bankrolling the party.', hidden: true });
    expect(npc.status).toBe(201);
    const npcId = npc.body.id as number;

    const grant = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'grant', tool: 'get_npc', entityId: npcId, note: 'may recap the patron thread' });
    expect(grant.status).toBe(201);

    // The greeting reads the hidden NPC (approved), then cites it in the recap.
    h.script(
      { toolCalls: [{ id: 'c1', name: 'get_npc', arguments: { npcId } }] },
      {
        text:
          'Welcome back. When we left off, your patron had gone quiet.' +
          groundingBlock([
            { text: 'The patron went quiet.', kind: 'canon', cites: [{ type: 'npc', id: npcId }] },
          ]),
      },
    );

    const res = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/start-session`)
      .set(player)
      .send({});
    expect(res.status).toBe(201);

    // The read really happened — we are not passing by failing to retrieve anything.
    const asDm = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/grounding`).set(dm);
    expect(asDm.status).toBe(200);
    expect(JSON.stringify(asDm.body)).toContain(`/npcs/${npcId}`);

    // ...and the PLAYER's copy of that same turn names none of it.
    expect(JSON.stringify(res.body)).not.toContain(`/npcs/${npcId}`);
    expect(res.body.grounding.retrievals.some((r: { id: number }) => r.id === npcId)).toBe(false);
    expect(res.body.grounding.claims[0].citations[0]).toMatchObject({ id: 0, redacted: true });
  });

  it('never publishes a DM-only cited id to a player, on either delivery path', async () => {
    const campaignId = await armedCampaign('Grounding DM-only citation');

    // A HIDDEN NPC: invisible to the player-scoped context principal the prompt is built with.
    const npc = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'The Whisperer', body: 'Secretly the party patron.', hidden: true });
    expect(npc.status).toBe(201);
    const npcId = npc.body.id as number;

    // The DM narrowly approves ONE secret read of that entity.
    const grant = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'grant', tool: 'get_npc', entityId: npcId, note: 'may reason about the patron' });
    expect(grant.status).toBe(201);

    // Turn 1: the model performs the approved read, then cites it.
    h.script(
      { toolCalls: [{ id: 'c1', name: 'get_npc', arguments: { npcId } }] },
      {
        text:
          'A cloaked figure watches from the gallery.' +
          groundingBlock([
            { text: 'The patron is watching.', kind: 'canon', cites: [{ type: 'npc', id: npcId }] },
          ]),
      },
    );
    const res = await h.sendMessage(campaignId, { input: 'Who is watching us?' }, player);
    expect(res.status).toBe(201);

    // The citation IS supported — the model really did read it. We are not crying wolf.
    expect(res.body.grounding.status).toBe('clean');

    // ...but the player's copy of the turn result must not name the hidden entity, and the raw
    // retrieval ledger must not hand them the DM's prep either.
    const playerTurn = JSON.stringify(res.body.grounding);
    expect(playerTurn).not.toContain(`/npcs/${npcId}`);
    expect(res.body.grounding.claims[0].citations[0]).toMatchObject({ status: 'supported', id: 0, redacted: true });
    expect(res.body.grounding.retrievals.some((r: { id: number }) => r.id === npcId)).toBe(false);

    // Same on the member-readable review endpoint.
    const asPlayer = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/grounding`).set(player);
    expect(asPlayer.status).toBe(200);
    expect(asPlayer.body[0].citations[0]).toMatchObject({ status: 'supported', id: 0, redacted: true });
    expect(asPlayer.body[0].citations[0].href).toBeUndefined();
    expect(JSON.stringify(asPlayer.body)).not.toContain(`/npcs/${npcId}`);

    // A viewer is at least as restricted as a player.
    const asViewer = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/grounding`).set(viewer);
    expect(asViewer.status).toBe(200);
    expect(JSON.stringify(asViewer.body)).not.toContain(`/npcs/${npcId}`);

    // The DM — who owns the secret — still gets the id and the evidence link to check the work.
    const asDm = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/grounding`).set(dm);
    expect(asDm.status).toBe(200);
    expect(asDm.body[0].citations[0]).toMatchObject({
      status: 'supported',
      id: npcId,
      href: `/c/${campaignId}/npcs/${npcId}`,
    });
  });

  /**
   * #1591 — `nudge` and `flag` are the other two player-callable routes on this controller
   * that run a full driver turn (via `runTurn`) and so return the identical `AiDmTurnRunResult`
   * shape carrying `grounding`. #1561's security review confirmed both had the SAME unprojected
   * shape as `start-session` on `main`, predating that issue — and confirmed they are closed as
   * a SIDE EFFECT of `GroundingProjectionInterceptor` being applied at the controller boundary
   * rather than per-handler (see the interceptor's own doc comment). Nothing here was broken;
   * this pins that "side effect" down as an explicit, named guarantee for these two routes
   * specifically, so a future narrowing of the interceptor's scope (e.g. moving it onto only the
   * handlers whose author remembers to ask for it — the exact failure mode #1043 already closed
   * once) would fail a test that names the route, not just silently regress.
   */
  it('never leaks a DM-only id through nudge — a replayed turn carries the same grounding shape (#1591)', async () => {
    const campaignId = await armedCampaign('Grounding nudge leak');

    const npc = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'The Cartographer', body: 'Secretly maps the black market.', hidden: true });
    expect(npc.status).toBe(201);
    const npcId = npc.body.id as number;

    const grant = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'grant', tool: 'get_npc', entityId: npcId, note: 'may reason about the cartographer' });
    expect(grant.status).toBe(201);

    // Turn 1 (establishes the replay input nudge will replay) and turn 2 (the nudge's own
    // replayed turn) both perform the approved read and cite it — a nudge is a genuine retry,
    // so the tool call and citation happen again rather than being cached.
    h.script(
      {
        toolCalls: [{ id: 'c1', name: 'get_npc', arguments: { npcId } }],
      },
      {
        text: 'The cartographer\'s ledgers are hidden in plain sight.' + groundingBlock([
          { text: 'The cartographer keeps hidden ledgers.', kind: 'canon', cites: [{ type: 'npc', id: npcId }] },
        ]),
      },
      { toolCalls: [{ id: 'c2', name: 'get_npc', arguments: { npcId } }] },
      {
        text: 'Once more: the cartographer\'s ledgers are hidden in plain sight.' + groundingBlock([
          { text: 'The cartographer keeps hidden ledgers.', kind: 'canon', cites: [{ type: 'npc', id: npcId }] },
        ]),
      },
    );
    const first = await h.sendMessage(campaignId, { input: 'What do you know of the cartographer?' }, player);
    expect(first.status).toBe(201);

    // Approvals are single-use (consumed by the first read); the nudge's replayed turn performs
    // its OWN read and needs its own grant.
    const grant2 = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'grant', tool: 'get_npc', entityId: npcId, note: 'may reason about the cartographer again' });
    expect(grant2.status).toBe(201);

    const nudged = await h.lever(campaignId, 'nudge', {}, player);
    expect(nudged.status).toBe(201);
    expect(nudged.body.grounding.status).toBe('clean');

    // The nudge's OWN result — the thing #1591 is about — must not name the hidden entity.
    expect(JSON.stringify(nudged.body.grounding)).not.toContain(`/npcs/${npcId}`);
    expect(nudged.body.grounding.retrievals.some((r: { id: number }) => r.id === npcId)).toBe(false);
    expect(nudged.body.grounding.claims[0].citations[0]).toMatchObject({ status: 'supported', id: 0, redacted: true });

    // The DM's own copy still resolves the real id — the guarantee redacts, it does not destroy.
    const asDm = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/grounding`).set(dm);
    expect(asDm.status).toBe(200);
    expect(JSON.stringify(asDm.body)).toContain(`/npcs/${npcId}`);
  });

  it('never leaks a DM-only id through flag — a disputed-and-redecided turn carries the same grounding shape (#1591)', async () => {
    const campaignId = await armedCampaign('Grounding flag leak');

    const npc = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/npcs`)
      .set(dm)
      .send({ name: 'The Broker', body: 'Secretly fences stolen goods.', hidden: true });
    expect(npc.status).toBe(201);
    const npcId = npc.body.id as number;

    const grant = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'grant', tool: 'get_npc', entityId: npcId, note: 'may reason about the broker' });
    expect(grant.status).toBe(201);

    h.script(
      { toolCalls: [{ id: 'c1', name: 'get_npc', arguments: { npcId } }] },
      {
        text: 'The broker denies everything.' + groundingBlock([
          { text: 'The broker denies everything.', kind: 'canon', cites: [{ type: 'npc', id: npcId }] },
        ]),
      },
      { toolCalls: [{ id: 'c2', name: 'get_npc', arguments: { npcId } }] },
      {
        text: 'On reconsideration, the broker admits the deal.' + groundingBlock([
          { text: 'The broker admits the deal.', kind: 'canon', cites: [{ type: 'npc', id: npcId }] },
        ]),
      },
    );
    const first = await h.sendMessage(campaignId, { input: 'Press the broker for the truth.' }, player);
    expect(first.status).toBe(201);

    // Approvals are single-use; the re-decided turn performs its own read and needs its own grant.
    const grant2 = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/secret-approval`)
      .set(dm)
      .send({ action: 'grant', tool: 'get_npc', entityId: npcId, note: 'may reason about the broker again' });
    expect(grant2.status).toBe(201);

    const flagged = await h.lever(campaignId, 'flag', { objection: 'That ruling let the broker off too easily.' }, player);
    expect(flagged.status).toBe(201);
    expect(flagged.body.grounding.status).toBe('clean');

    // The re-decided turn's OWN result must not name the hidden entity either.
    expect(JSON.stringify(flagged.body.grounding)).not.toContain(`/npcs/${npcId}`);
    expect(flagged.body.grounding.retrievals.some((r: { id: number }) => r.id === npcId)).toBe(false);
    expect(flagged.body.grounding.claims[0].citations[0]).toMatchObject({ status: 'supported', id: 0, redacted: true });

    const asDm = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/grounding`).set(dm);
    expect(asDm.status).toBe(200);
    expect(JSON.stringify(asDm.body)).toContain(`/npcs/${npcId}`);
  });

  it('the stored narration is exactly the prose the table watched stream by stream', async () => {
    const campaignId = await armedCampaign('Grounding narration parity');
    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: CampaignEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    // A model that emits the fence token inside its prose before the real block. The streaming
    // filter stops at the FIRST fence, so anything after it was never broadcast and must not
    // reappear in the persisted transcript or the turn result.
    h.script({
      text: `The lantern swings. ${GROUNDING_BLOCK_START} was never meant to be prose. Smuggled.` + groundingBlock([]),
      streamChunks: 9,
    });
    const res = await h.sendMessage(campaignId, { input: 'I raise the lantern.' });
    sub.unsubscribe();
    expect(res.status).toBe(201);

    const streamed = events
      .filter((e) => e.type === 'narration.delta')
      .map((e) => (e.type === 'narration.delta' ? e.text : ''))
      .join('')
      .trim();

    expect(streamed).toBe('The lantern swings.');
    expect(res.body.narration).toBe(streamed);
    expect(res.body.narration).not.toContain('Smuggled');
    expect(res.body.narration).not.toContain('GROUNDING');

    // The persisted transcript is the third delivery path and must agree with the other two.
    const transcript = await request(h.server)
      .get(`/api/v1/campaigns/${campaignId}/ai-dm/transcript`)
      .set(dm);
    expect(transcript.status).toBe(200);
    const narrationRows = (transcript.body.items as { kind: string; payload: { text?: string } }[])
      .filter((e) => e.kind === 'narration');
    expect(narrationRows.length).toBeGreaterThan(0);
    for (const row of narrationRows) {
      expect(row.payload.text).not.toContain('GROUNDING');
      expect(row.payload.text).not.toContain('Smuggled');
    }
  });

  it('a markdown-fenced citation block is honoured rather than parked as malformed', async () => {
    const campaignId = await armedCampaign('Grounding fenced block');
    // Models wrap JSON in ```json reflexively. Treating that as malformed would flag an
    // unsupported claim and park the seat on EVERY turn, and a mechanism that fires constantly
    // gets switched off.
    h.script({
      text:
        'Mist rolls off the water.\n' +
        `${GROUNDING_BLOCK_START}\n\`\`\`json\n${JSON.stringify({ claims: [] })}\n\`\`\`\n${GROUNDING_BLOCK_END}`,
    });
    const res = await h.sendMessage(campaignId, { input: 'I watch the river.' });
    expect(res.status).toBe(201);
    expect(res.body.grounding.status).toBe('clean');
    expect(res.body.grounding.claims).toHaveLength(0);
    expect(res.body.narration).toBe('Mist rolls off the water.');

    const session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('running');
    expect(session.body.stuck).toBeNull();
  });

  it('the system prompt states the narration/claim split and the citation contract', async () => {
    const campaignId = await armedCampaign('Grounding contract prompt');
    h.script({ text: 'Nothing happens.' + groundingBlock([]) });
    await h.sendMessage(campaignId, { input: 'I wait.' });
    const system = h.mock.received.at(-1)?.system ?? '';
    expect(system).toContain('Grounding contract');
    expect(system).toContain('CREATIVE NARRATION');
    expect(system).toContain('FACTUAL CLAIMS');
    expect(system).toContain(GROUNDING_BLOCK_START);
  });
});
