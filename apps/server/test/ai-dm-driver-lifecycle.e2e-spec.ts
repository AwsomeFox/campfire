import request from 'supertest';
import { createAiEvalHarness, dm, player, type AiEvalHarness } from './ai-eval-harness';
import { AiDmStreamService, type AiDmStreamEvent } from '../src/modules/ai-driver/ai-driver-stream.service';
import { AiDriverService } from '../src/modules/ai-driver/ai-driver.service';

/**
 * Issue #1043 — AI Driver session lifecycle phases.
 *
 * The phase only earns its place if it is more than a label, so the assertions here are about
 * what it actually changes: which prompt the model gets, what input is refused, who may drive a
 * transition, and — the part that matters most — that a lifecycle turn can never strand the
 * table in a transient phase no matter how it fails.
 */
describe('ai-dm driver — session lifecycle phases (#1043)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'lifecycle-model' });
    await h.enableExperimental();
  });

  beforeEach(() => {
    h.resetMock();
  });

  afterAll(async () => {
    await h.close();
  });

  const armed = async (name: string): Promise<number> => {
    const campaignId = await h.createCampaign(name);
    await h.configureSeat(campaignId, { mode: 'driver', tokenBudget: 100_000 });
    return campaignId;
  };

  const start = (campaignId: number, headers = player) =>
    request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/start-session`).set(headers).send({});
  const wrapUp = (campaignId: number, headers = dm) =>
    request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/wrap-up`).set(headers).send({});
  const phaseOf = async (campaignId: number): Promise<string> =>
    (await h.getDriverSession(campaignId)).body.phase;

  /** The system prompt the mock last received. */
  const lastSystem = (): string => {
    const received = h.mock.received;
    return String(received[received.length - 1]?.system ?? '');
  };

  it('defaults to `active`, so a campaign that never opts in behaves exactly as before', async () => {
    const campaignId = await armed('Default Phase');
    expect(await phaseOf(campaignId)).toBe('active');

    // And an ordinary player action still works with no lifecycle call at all — the whole point
    // of defaulting to `active` rather than making start-session a precondition for play.
    h.script({ text: 'The road forks.', usage: { promptTokens: 4, completionTokens: 4, totalTokens: 8 } });
    const res = await h.sendMessage(campaignId, { input: 'we travel' });
    expect(res.status).toBe(201);
    expect(await phaseOf(campaignId)).toBe('active');
  });

  it('a PLAYER can start a session, and the greeting lands back in `active`', async () => {
    const campaignId = await armed('Player Starts');
    h.script({ text: 'Welcome back, everyone.', usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 } });

    // Player+, not DM-only: a table waiting on one person to say "we've started" is the friction
    // this removes.
    const res = await start(campaignId, player);
    expect(res.status).toBe(201);
    expect(res.body.narration).toContain('Welcome back');
    // Transient: the phase is gone by the time the turn returns.
    expect(await phaseOf(campaignId)).toBe('active');
    expect(lastSystem()).toContain('Session phase: OPENING');
  });

  it('feeds the greeting the DM-approved recap instead of asking the model to invent one', async () => {
    const campaignId = await armed('Recap Consumed');
    await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({ title: 'Session 1', recap: 'The party burned the smugglers’ barge and fled downriver.' });

    h.script({ text: 'Last time, the barge burned.', usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 } });
    expect((await start(campaignId)).status).toBe(201);

    // The AI Scribe (#316) already owns recap prose and files it through the DM's proposal
    // queue. Generating a second, unreviewed account here would contradict the one the DM
    // approved, at the exact moment the table is calibrating what is true.
    const system = lastSystem();
    expect(system).toContain('Previous session recap');
    expect(system).toContain('smugglers');
  });

  it('tells the model to admit there is no recap rather than confabulate one', async () => {
    const campaignId = await armed('No Recap');
    h.script({ text: 'A fresh start.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    expect((await start(campaignId)).status).toBe(201);
    const system = lastSystem();
    expect(system).toContain('Previous session recap');
    expect(system).toContain('None on record');
  });

  it('wrap-up is DM-only and lands the session in `ended`', async () => {
    const campaignId = await armed('Wrap Up');
    expect((await wrapUp(campaignId, player)).status).toBe(403);

    h.script({ text: 'You make camp. Until next time.', usage: { promptTokens: 6, completionTokens: 5, totalTokens: 11 } });
    const res = await wrapUp(campaignId, dm);
    expect(res.status).toBe(201);
    expect(await phaseOf(campaignId)).toBe('ended');
    expect(lastSystem()).toContain('Session phase: WRAPPING UP');
  });

  it('an ended session refuses player input, and any player can reopen it in one request', async () => {
    const campaignId = await armed('Ended Blocks');
    h.script({ text: 'Goodnight.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    await wrapUp(campaignId, dm);
    expect(await phaseOf(campaignId)).toBe('ended');

    const blocked = await h.sendMessage(campaignId, { input: 'I keep walking' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('AI_DM_SESSION_ENDED');
    // The refusal names its own cure. This is the only place the lifecycle blocks anything, and
    // a closed session must be a speed bump rather than a lockout that needs a DM to clear.
    expect(String(blocked.body.message)).toContain('start-session');

    h.script({ text: 'Welcome back.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    expect((await start(campaignId, player)).status).toBe(201);
    expect(await phaseOf(campaignId)).toBe('active');

    h.script({ text: 'You walk on.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    expect((await h.sendMessage(campaignId, { input: 'I keep walking' })).status).toBe(201);
  });

  it('wrapping up twice is refused rather than re-running the summary', async () => {
    const campaignId = await armed('Double Wrap');
    h.script({ text: 'Goodnight.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    await wrapUp(campaignId, dm);
    const again = await wrapUp(campaignId, dm);
    expect(again.status).toBe(409);
  });

  it('a refused lifecycle turn leaves the phase exactly where it was', async () => {
    const campaignId = await armed('Paused Start');
    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/pause`).set(dm).send({ paused: true });

    // THE ROLLBACK THAT MATTERS. The phase is set before the turn (the prompt assembly reads it),
    // so a turn the pause gate refuses must put it back — otherwise a start request that bounced
    // would strand the table in `greeting` with nothing having greeted them. And there is no
    // privileged path around the pause gate: a greeting is just a turn.
    const res = await start(campaignId, player);
    expect(res.status).toBe(503);
    expect(await phaseOf(campaignId)).toBe('active');

    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/resume`).set(dm);
    h.script({ text: 'Welcome.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    expect((await start(campaignId, player)).status).toBe(201);
  });

  it('a greeting that FAILS still opens the session — a flubbed hello must not block play', async () => {
    const campaignId = await armed('Failed Greeting');
    h.script({ throwError: new Error('provider exploded'), text: '' });

    const res = await start(campaignId, player);
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('provider_error');

    // The transient phase is bounded by its TURN, not by that turn succeeding. Otherwise a
    // provider hiccup at 7pm leaves the table unable to start playing at all.
    expect(await phaseOf(campaignId)).toBe('active');

    // The failure still surfaces where failures belong — the stuck ladder — and the two are
    // independent: `phase: active` + `state: awaiting_players` reads correctly as "the session
    // is open, and the AI needs help", not as "the session never opened".
    const session = (await h.getDriverSession(campaignId)).body;
    expect(session.state).toBe('awaiting_players');
    expect(session.stuck?.reason).toBe('provider_error');
    expect(session.phase).toBe('active');
  });

  it('leaves the recovery levers replaying the GREETING after a failed opening', async () => {
    const campaignId = await armed('Stuck Greeting Levers');
    h.script({ throwError: new Error('provider exploded'), text: '' });
    await start(campaignId, player);

    // "Stuck during greeting" does not persist as a distinct state, because the transient phase
    // is bounded by its turn — by the time anyone can see `stuck`, the phase is already `active`.
    // What makes that acceptable is that the ladder still points at the right thing: `lastInput`
    // is the greeting prompt, so a nudge re-runs the opening rather than replaying some earlier
    // player action from before the session started.
    h.script({ text: 'Welcome back, everyone.', usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 } });
    const nudged = await h.lever(campaignId, 'nudge', {}, player);
    expect(nudged.status).toBe(201);
    expect(nudged.body.narration).toContain('Welcome back');

    const session = (await h.getDriverSession(campaignId)).body;
    expect(session.stuck).toBeNull();
    expect(session.phase).toBe('active');
  });

  it('broadcasts a thin phase frame the table can follow', async () => {
    const campaignId = await armed('Phase Frames');
    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const seen: AiDmStreamEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => seen.push(e));

    h.script({ text: 'Hello.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    await start(campaignId, player);
    sub.unsubscribe();

    const phases = seen
      .filter((e): e is Extract<AiDmStreamEvent, { type: 'phase' }> => e.type === 'phase')
      .map((e) => e.phase);
    expect(phases).toEqual(['greeting', 'active']);
  });

  it('does not attribute the greeting to a player as a table action', async () => {
    const campaignId = await armed('No Player Action');
    h.script({ text: 'Hello all.', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
    await start(campaignId, player);

    // The greeting prompt is server-authored. Recording it as a `player.action` would publish
    // machinery to the shared transcript and credit it to whoever pressed the button.
    const page = await request(h.server)
      .get(`/api/v1/campaigns/${campaignId}/ai-dm/transcript`)
      .set(dm);
    const kinds = (page.body.items as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).not.toContain('player.action');
    // ...but the phase change IS in the durable log, so a player who reloads mid-session still
    // sees that the table formally opened.
    const controls = (page.body.items as Array<{ kind: string; payload: Record<string, unknown> }>)
      .filter((e) => e.kind === 'control' && e.payload.control === 'phase')
      .map((e) => e.payload.phase);
    expect(controls).toContain('greeting');
  });

  it('refuses a lifecycle turn while the table is mid-turn, rather than queueing it behind play', async () => {
    const campaignId = await armed('Lifecycle Concurrency');
    const driver = h.ctx.app.get(AiDriverService);
    const user = {
      id: 'dev:ai-eval-player',
      name: 'ai-eval-player',
      serverRole: 'user' as const,
      devRole: 'player' as const,
    };

    // A DM-approved recap exists, so the retry at the end proves the greeting still gets its
    // recap once the table is quiet. NOTE the recap TEXT is not a usable contamination marker:
    // `get_campaign_summary` mentions sessions on every turn regardless of phase. The greeting's
    // own '## Previous session recap' heading is the thing only a lifecycle prompt produces.
    await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({ title: 'Session 1', recap: 'The party burned the smugglers’ barge.' });

    // TWO scripted turns although only one may legitimately run: the second exists so the
    // pre-fix behaviour (the greeting queued behind the action, then executed) fails these
    // assertions on SUBSTANCE rather than stalling on a starved mock.
    h.script(
      { text: 'You find a loose flagstone.', streamChunks: 6 },
      { text: 'Welcome back to the table.', streamChunks: 6 },
    );

    // An ordinary player action, driven through the service because supertest's per-request
    // connection lifecycle cannot be raced. It reserves the turn slot synchronously.
    const action = driver.runTurn(campaignId, user, 'I search the room');
    // ...and NOW someone presses Start Session, while that turn is still narrating.
    const greeting = driver.startSession(campaignId, user, 'player');

    const [ordinary, lifecycle] = await Promise.allSettled([action, greeting]);
    expect(ordinary.status).toBe('fulfilled');

    // WHY REFUSED AND NOT DEFERRED. The phase is campaign-wide and is applied synchronously,
    // before `runTurn` reaches its queue branch — but a turn's system prompt is assembled several
    // awaits later. So pressing Start Session mid-turn rewrites the prompt of the action ALREADY
    // STREAMING, and of everything queued behind it: they reach `assembleSystemPrompt` while it
    // observes `greeting`, and an ordinary "I search the room" comes back with recap-and-welcome
    // instructions aimed at a table that has not sat down.
    //
    // Deferring the phase until the queue entry executes would fix the contamination and still
    // leave the greeting wrong: "the table has just sat down", spoken after a turn of play has
    // already resolved, recapping a session that already resumed. A lifecycle turn's meaning is
    // fixed when it is REQUESTED, unlike a player action, which is why sharing the action FIFO is
    // the category error. Refusing is also the only option that keeps `phase` the single source
    // of truth for "a transition is in progress", rather than splitting that across the queue.
    expect(lifecycle.status).toBe('rejected');
    expect(((lifecycle as PromiseRejectedResult).reason as { status?: number }).status).toBe(409);

    // The refusal is a speed bump, not a lockout: nothing about the table changed.
    expect(await phaseOf(campaignId)).toBe('active');

    // THE CONTAMINATION ASSERTION. Exactly one turn ran, and it was an ordinary player action
    // that saw no lifecycle prompt. Pre-fix this system carried 'Session phase: OPENING' and the
    // previous session's recap.
    const systems = h.mock.received.map((r) => String(r?.system ?? ''));
    expect(systems).toHaveLength(1);
    expect(systems[0]).not.toContain('Session phase');
    expect(systems[0]).not.toContain('Previous session recap');

    // And it is immediately retryable once the table is quiet — the whole point of refusing.
    h.resetMock(); // drop the unconsumed second turn so the retry reads its own script
    h.script({ text: 'Welcome back, everyone.', usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 } });
    const retried = await start(campaignId, player);
    expect(retried.status).toBe(201);
    // The greeting the refusal deferred is the same greeting, unharmed: opening block + recap.
    expect(lastSystem()).toContain('Session phase: OPENING');
    expect(lastSystem()).toContain('smugglers');
    expect(await phaseOf(campaignId)).toBe('active');
  });

  it('the phase block is absent from an ordinary turn', async () => {
    const campaignId = await armed('Active Prompt Unchanged');
    h.script({ text: 'The door creaks.', usage: { promptTokens: 4, completionTokens: 4, totalTokens: 8 } });
    await h.sendMessage(campaignId, { input: 'open the door' });

    // `active` deliberately has no prompt entry: adding one would silently change how every
    // existing campaign is narrated, including the ones that never touch this feature.
    const system = lastSystem();
    expect(system).not.toContain('Session phase');
    expect(system).not.toContain('Previous session recap');
  });
});
