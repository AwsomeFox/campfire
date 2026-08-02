import request from 'supertest';
import { createAiEvalHarness, dm, player, type AiEvalHarness } from './ai-eval-harness';
import type { CampaignEvent } from '@campfire/schema';
import { AiDmStreamService } from '../src/modules/ai-driver/ai-driver-stream.service';
import { NARRATION_QUARANTINE_CHARS } from '../src/modules/ai-driver/driver-safety';
import { AiDmService } from '../src/modules/ai-dm/ai-dm.service';
import { AiDriverService } from '../src/modules/ai-driver/ai-driver.service';

/**
 * #598 — a provider content filter / refusal is a WITHHELD TURN, not successful narration.
 *
 * The bug: both adapters already normalized `content_filter` onto the result, and the driver
 * ignored it. A refused response with no tool calls took the `complete` exit — broadcast,
 * committed to the #572 transcript, seat left healthy. On a mixed-age table that is unreviewed
 * partial prose delivered as an ordinary DM turn.
 *
 * These cases drive the REAL HTTP surface with a scripted model, because the interesting part
 * is not the boolean — it is everything the turn loop does AROUND it: what reaches the SSE
 * channel, what reaches the durable transcript, whether tool calls that arrived in the same
 * response are dispatched, where the ladder lands, and what the incident record does and does
 * not contain.
 */

/** Collect the driver's SSE frames for a campaign while `fn` runs. */
async function withStream<T>(
  h: AiEvalHarness,
  campaignId: number,
  fn: () => Promise<T>,
): Promise<{ result: T; events: CampaignEvent[] }> {
  const streamSvc = h.ctx.app.get(AiDmStreamService);
  const events: CampaignEvent[] = [];
  const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));
  try {
    return { result: await fn(), events };
  } finally {
    sub.unsubscribe();
  }
}

const UNSAFE = 'THIS_PROSE_MUST_NEVER_REACH_THE_TABLE';

describe('ai-dm driver — provider content filters / refusals are withheld turns (#598)', () => {
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

  function transcript(campaignId: number) {
    return request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/transcript`).set(dm);
  }

  function incidents(campaignId: number) {
    return request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/withheld-turns`).set(dm);
  }

  it('a filtered reply is never delivered, never committed, and never persisted as narration', async () => {
    const campaignId = await armedCampaign('Withheld basic');
    // Shorter than the quarantine window, so the delay line alone keeps ALL of it off the wire.
    h.script({ text: `${UNSAFE} the alley narrows.`, finishReason: 'content_filter' });

    const { result: res, events } = await withStream(h, campaignId, () =>
      h.sendMessage(campaignId, { input: 'I follow him into the alley.' }),
    );

    expect(res.status).toBe(201);
    // Not `complete` — that is the defect this issue names.
    expect(res.body.stopReason).toBe('content_withheld');
    expect(res.body.narration).toBe('');

    // Nothing on the live channel carries the prose: no deltas escaped the window, and the
    // aggregated commit frame was never emitted at all.
    const wire = JSON.stringify(events);
    expect(wire).not.toContain(UNSAFE);
    expect(events.some((e) => e.type === 'narration.message')).toBe(false);

    // The neutral retraction fired, and says nothing about what was withheld.
    const withheld = events.find((e) => e.type === 'narration.withheld');
    expect(withheld).toBeDefined();
    if (withheld?.type === 'narration.withheld') {
      expect(withheld.reason).toBe('content_filter');
      expect(withheld.message).toMatch(/withheld/i);
      expect(withheld.message).not.toContain(UNSAFE);
    }

    // #572: the durable transcript must not gain a narration row for a turn nobody may read.
    const log = await transcript(campaignId);
    expect(log.status).toBe(200);
    expect(JSON.stringify(log.body)).not.toContain(UNSAFE);
    expect(log.body.items.some((e: { kind: string }) => e.kind === 'narration')).toBe(false);
    const ended = log.body.items.find((e: { kind: string }) => e.kind === 'turn.ended');
    expect(ended?.payload?.stopReason).toBe('content_withheld');
  });

  it('parks the seat on the EXISTING stuck ladder with the human recovery levers', async () => {
    const campaignId = await armedCampaign('Withheld ladder');
    h.script({ text: 'refused', finishReason: 'refusal' });
    await h.sendMessage(campaignId, { input: 'go' });

    const session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('awaiting_players');
    expect(session.body.stuck).toMatchObject({ reason: 'content_withheld' });
    // Retry / edit-the-framing (nudge) / continue without AI — the three moves the acceptance
    // criteria name, all already implemented by the ladder rather than duplicated.
    expect(session.body.levers).toEqual(
      expect.arrayContaining(['retry', 'nudge', 'continue_without_ai', 'request_takeover']),
    );
    expect(session.body.stuck.detail).not.toMatch(/provider failed/i);
  });

  it('dispatches NO tool call that arrived in the same response as the refusal', async () => {
    const campaignId = await armedCampaign('Withheld tool mixture');
    // The dangerous shape: the model asks to mutate live state in the very response the
    // provider refused. The guard must precede dispatch, not follow it.
    h.script({
      text: `${UNSAFE} you strike him down.`,
      finishReason: 'content_filter',
      toolCalls: [{ id: 'call_1', name: 'roll_dice', arguments: { campaignId, expr: '1d20' } }],
    });

    const { result: res, events } = await withStream(h, campaignId, () =>
      h.sendMessage(campaignId, { input: 'I attack.' }),
    );

    expect(res.body.stopReason).toBe('content_withheld');
    expect(res.body.toolCalls).toEqual([]);
    expect(events.some((e) => e.type === 'tool')).toBe(false);

    // The incident says how many calls were stopped, which is the number an operator wants.
    const list = await incidents(campaignId);
    expect(list.body[0]).toMatchObject({ finishReason: 'content_filter', suppressedToolCalls: 1 });
  });

  it('records privacy-minimized incident metadata — counts and provenance, never the prose', async () => {
    const campaignId = await armedCampaign('Withheld incident');
    h.script({ text: `${UNSAFE} more text`, finishReason: 'refusal' });
    await h.sendMessage(campaignId, { input: 'go' });

    const list = await incidents(campaignId);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    const row = list.body[0];
    expect(row).toMatchObject({
      campaignId,
      finishReason: 'refusal',
      provider: 'mock',
      withheldChars: expect.any(Number),
      releasedChars: expect.any(Number),
      suppressedToolCalls: 0,
    });
    expect(row.withheldChars).toBeGreaterThan(0);
    // The whole point: the record is actionable without recreating the exposure. No field on
    // the row — and no digest, which would be the same content with extra steps — carries it.
    expect(JSON.stringify(row)).not.toContain(UNSAFE);
    // Enough to act on: which member's action provoked it.
    expect(row.triggeredByUserId).toBeTruthy();
  });

  it('is DM-only — a player cannot read the table’s withheld-turn incidents', async () => {
    const campaignId = await armedCampaign('Withheld incident acl');
    const res = await request(h.server)
      .get(`/api/v1/campaigns/${campaignId}/ai-dm/withheld-turns`)
      .set(player);
    expect(res.status).toBe(403);
  });

  it('the quarantine window bounds the residual: only text that aged out of it was ever sent', async () => {
    const campaignId = await armedCampaign('Withheld quarantine');
    // Deliberately longer than the window so SOME prose legitimately escapes — the mitigation
    // is bounded, not a proof, and the test says so rather than pretending otherwise.
    const safeHead = 'A. '.repeat(Math.ceil((NARRATION_QUARANTINE_CHARS * 1.5) / 3));
    h.script({ text: `${safeHead}${UNSAFE}`, finishReason: 'content_filter', streamChunks: 30 });

    const { result: res, events } = await withStream(h, campaignId, () =>
      h.sendMessage(campaignId, { input: 'go' }),
    );
    expect(res.body.stopReason).toBe('content_withheld');

    const delivered = events
      .filter((e): e is Extract<CampaignEvent, { type: 'narration.delta' }> => e.type === 'narration.delta')
      .map((e) => e.text)
      .join('');

    // The tail — where a provider's classifier fires — never left the server.
    expect(delivered).not.toContain(UNSAFE);
    expect(delivered.length).toBeGreaterThan(0); // honest: some prose DID reach the table
    expect(delivered.length).toBeLessThanOrEqual(safeHead.length);
    // ...and exactly that much is what the incident reports as the residual.
    const row = (await incidents(campaignId)).body[0];
    expect(row.releasedChars).toBe(delivered.length);
    expect(row.withheldChars).toBeGreaterThanOrEqual(UNSAFE.length);
  });

  it('a LOCAL unfiltered model is not covered — a plain `stop` still completes normally', async () => {
    const campaignId = await armedCampaign('Withheld local model');
    // Ollama / llama.cpp / LM Studio report `stop` for everything they generate. This feature
    // relays a provider signal; it does not classify content. Asserting the non-protection
    // keeps the docs honest — a filter believed to cover something it does not is worse than
    // no filter at all.
    h.script({ text: 'The alley narrows and the lamp gutters.', finishReason: 'stop' });

    const { result: res, events } = await withStream(h, campaignId, () =>
      h.sendMessage(campaignId, { input: 'go' }),
    );
    expect(res.body.stopReason).toBe('complete');
    expect(res.body.narration).toBe('The alley narrows and the lamp gutters.');
    expect(events.some((e) => e.type === 'narration.withheld')).toBe(false);
    expect(events.some((e) => e.type === 'narration.message')).toBe(true);
    expect((await incidents(campaignId)).body).toHaveLength(0);

    const session = await h.getDriverSession(campaignId);
    expect(session.body.state).toBe('running');
  });

  it('an earlier step’s legitimate narration survives; only the refused step is withheld', async () => {
    const campaignId = await armedCampaign('Withheld multi step');
    h.script(
      // Step 1: a clean narration plus a tool call, so the loop continues.
      { text: 'You roll for it.', toolCalls: [{ id: 'c1', name: 'roll_dice', arguments: { campaignId, expr: '1d20' } }] },
      // Step 2: the provider refuses.
      { text: `${UNSAFE} the result is grim.`, finishReason: 'content_filter' },
    );

    const { result: res, events } = await withStream(h, campaignId, () =>
      h.sendMessage(campaignId, { input: 'I roll.' }),
    );

    expect(res.body.stopReason).toBe('content_withheld');
    // Step 1 is real history: it was delivered and committed before the refusal existed, and
    // retroactively deleting it would be a worse lie than leaving it.
    expect(res.body.narration).toBe('You roll for it.');
    expect(JSON.stringify(events)).not.toContain(UNSAFE);

    const log = await transcript(campaignId);
    const narrations = log.body.items.filter((e: { kind: string }) => e.kind === 'narration');
    expect(narrations).toHaveLength(1);
    expect(narrations[0].payload.text).toBe('You roll for it.');
    expect((await incidents(campaignId)).body[0].step).toBe(2);
  });

  it('a meterTurn REJECTION on a withheld turn still retracts, and still commits nothing', async () => {
    // The fail-open this guards. `meterTurn` writes an audit row and a usage-history row; either
    // can fail. It used to run BEFORE the withheld branch, so its rejection unwound past every
    // withheld path into runTurn's catch-all, the turn was reclassified `provider_error`, and no
    // `narration.withheld` was ever sent — at which point the web reducer commits the deltas that
    // had already been released into the table's permanent transcript on the terminal frame.
    //
    // In other words: a bookkeeping error could publish text a provider refused. That is the exact
    // outcome this whole issue exists to prevent, reached through the ledger. This case is the
    // point of the fix — the path is invisible in normal operation and silently regresses.
    const campaignId = await armedCampaign('Withheld meter failure');
    // Longer than the window, so some prose is genuinely already on the wire when it fails.
    const safeHead = 'A. '.repeat(Math.ceil((NARRATION_QUARANTINE_CHARS * 1.5) / 3));
    h.script({ text: `${safeHead}${UNSAFE}`, finishReason: 'content_filter', streamChunks: 30 });

    const aiDm = h.ctx.app.get(AiDmService);
    const meterSpy = jest
      .spyOn(aiDm, 'meterTurn')
      .mockRejectedValueOnce(new Error('usage-history write failed'));

    try {
      const { result: res, events } = await withStream(h, campaignId, () =>
        h.sendMessage(campaignId, { input: 'go' }),
      );
      expect(meterSpy).toHaveBeenCalled();

      // The retraction went out ANYWAY: it is published inside streamStep, in the same
      // statement that drops the prose, with nothing fallible between the two.
      const withheld = events.find((e) => e.type === 'narration.withheld');
      expect(withheld).toBeDefined();
      expect(withheld?.type === 'narration.withheld' && withheld.reason).toBe('content_filter');

      // The turn is still classified as withheld, not as a provider failure — so the table gets
      // the right sentence and the right levers, and the incident is still recorded.
      expect(res.body.stopReason).toBe('content_withheld');
      expect(res.body.narration).toBe('');
      expect((await incidents(campaignId)).body).toHaveLength(1);

      // And nothing carrying the refused prose reached the wire or the durable transcript.
      expect(JSON.stringify(events)).not.toContain(UNSAFE);
      expect(events.some((e) => e.type === 'narration.message')).toBe(false);
      const log = await transcript(campaignId);
      expect(JSON.stringify(log.body)).not.toContain(UNSAFE);
      expect(log.body.items.some((e: { kind: string }) => e.kind === 'narration')).toBe(false);
    } finally {
      meterSpy.mockRestore();
    }
  });

  it('a refusal-only turn on a usage-omitting provider still SPENDS budget', async () => {
    // The accounting hole the refusal fix opened. Refusal prose is discarded by the adapters
    // so it can never be broadcast — correct — but the #1076 fallback for providers that omit
    // streaming usage estimates cost from OUTPUT LENGTH, and with the prose gone there was no
    // length left to read. Every refusal booked as zero tokens.
    //
    // The consequence is a budget gate that never advances against a provider that IS billing:
    // a model stuck refusing would burn real money forever behind a budget that never moves.
    // "Safely refused" and "free" are not the same outcome.
    const campaignId = await armedCampaign('Withheld metering non-zero');
    const before = (await h.getSeat(campaignId)).body;

    h.script({
      // A refusal-only turn: no narration at all, and no usage reported — the exact
      // combination that measured as nothing.
      text: '',
      finishReason: 'refusal',
      refusalChars: 400,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    const res = await h.sendMessage(campaignId, { input: 'go' });

    expect(res.body.stopReason).toBe('content_withheld');
    // The turn cost something, and the seat says so.
    expect(res.body.tokensUsed).toBeGreaterThan(0);
    const after = (await h.getSeat(campaignId)).body;
    expect(after.tokensUsed).toBeGreaterThan(before.tokensUsed);
  });

  /**
   * The PROPERTY, not the case.
   *
   * Three independent reviewers found three different wire shapes that all metered as zero and
   * refunded the reservation: refusal prose discarded before counting, a Gemini prompt block
   * with no `usageMetadata` and nothing to count, and a Responses top-level refusal item
   * counted in one branch but not its sibling. Every one is the same defect — treating ABSENCE
   * OF A MEASUREMENT as A MEASUREMENT OF ZERO — reached by a route nobody enumerated first.
   *
   * So this asserts the invariant rather than the shapes: a turn that produced nothing
   * measurable must consume its reservation as UNKNOWN spend, whatever produced it. A fourth
   * wire shape then fails safe instead of silently free.
   */
  describe('an unmeasurable turn is never free (#598)', () => {
    it.each([
      // A safety terminal state with no prose and no usage — the Gemini prompt-block shape.
      { label: 'prompt-block style refusal', finishReason: 'content_filter' as const },
      // A refusal whose prose the adapter discarded, on a provider that reports no usage.
      { label: 'refusal with no countable output', finishReason: 'refusal' as const },
      // Not a safety state at all: an ordinary empty completion with no usage. The invariant
      // is about MEASUREMENT, not about refusals, so it must hold here too.
      { label: 'empty completion', finishReason: 'stop' as const },
    ])('$label consumes the reservation instead of refunding it', async ({ label, finishReason }) => {
      const campaignId = await armedCampaign(`Unmeasurable ${label}`);
      const before = (await h.getSeat(campaignId)).body;

      h.script({
        text: '',
        finishReason,
        // Nothing to count anywhere: no narration, no refusal characters, no tool calls…
        refusalChars: 0,
        toolCalls: [],
        // …and a provider that reports no usage at all.
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });
      await h.sendMessage(campaignId, { input: 'go' });

      const after = (await h.getSeat(campaignId)).body;
      // The reservation must NOT come back. Metering zero refunds it, which is what let a
      // stream of billable provider calls run behind a budget gate that never advanced.
      expect(after.tokensReserved ?? 0).toBe(0);
      expect(after.budgetRemaining).toBeLessThan(before.budgetRemaining);
      // And the spend is recorded as an ESTIMATE, not presented as an exact figure.
      expect(after.tokensUnknown ?? 0).toBeGreaterThan(0);
    });
  });

  it('a mode switch racing the terminal frame still reports content_withheld, not aborted', async () => {
    // THE TEARDOWN RACE. Driver mode is switched off AFTER the terminal safety frame has
    // populated `result` but BEFORE streamStep's `finally` runs. `teardownSession` marks the
    // session detached, which correctly suppresses `narration.withheld` (emitting onto a
    // replaced session's channel would splice a frame into a table that moved on) — and the
    // detached exit then reported `aborted`, which the web reducer is ALLOWED to commit live
    // text for. Provider-filtered prose landed permanently in the transcript because a mode
    // switch happened to fall in a few-millisecond window.
    //
    // `commitsLiveText()` was not wrong; it was handed a stop reason that lied. The turn really
    // did end because content was withheld, so that is what it must say.
    //
    // The race is made deterministic by `stallAfterDone`, which holds the stream open at
    // exactly that instant. A test that merely LOOKED like this race — tearing down before the
    // terminal frame — would exercise the ordinary aborted path and prove nothing.
    const campaignId = await armedCampaign('Withheld teardown race');
    const safeHead = 'A. '.repeat(Math.ceil((NARRATION_QUARANTINE_CHARS * 1.5) / 3));
    h.script({
      text: `${safeHead}${UNSAFE}`,
      finishReason: 'content_filter',
      streamChunks: 30,
      stallAfterDone: true,
    });

    const reachedTerminalFrame = new Promise<void>((resolve) => {
      h.mock.onStall = () => resolve();
    });

    const { result: res, events } = await withStream(h, campaignId, async () => {
      // `.then()` rather than a bare call: a supertest `Test` does not dispatch until it is
      // subscribed to, so holding it unawaited would deadlock against `reachedTerminalFrame`.
      const turn = h.sendMessage(campaignId, { input: 'go' }).then((r) => r);
      // Wait until the provider has emitted its terminal safety frame and is holding there.
      await reachedTerminalFrame;
      // Now tear the session down, inside the window. Driven directly rather than through the
      // mode-switch endpoint: the stalled step still HOLDS the campaign spend lock, so an HTTP
      // mode switch would block on that mutex and never reach teardown inside the window. This
      // calls the same `teardownSession` the mode switch does (detach + cancelGeneration), at
      // exactly the instant the race requires.
      h.ctx.app.get(AiDriverService).teardownSession(campaignId);
      return turn;
    });

    // The turn ends as what it WAS, not as what the teardown made it look like.
    expect(res.body.stopReason).toBe('content_withheld');
    expect(res.body.narration).toBe('');
    expect(JSON.stringify(events)).not.toContain(UNSAFE);

    // And the durable record agrees, so a replay cannot promote the prose either — the
    // reducer's `commitsLiveText` guard keys on exactly this value.
    const log = await transcript(campaignId);
    expect(JSON.stringify(log.body)).not.toContain(UNSAFE);
    const ended = log.body.items.find((e: { kind: string }) => e.kind === 'turn.ended');
    expect(ended?.payload?.stopReason).toBe('content_withheld');
  });

  it('reports the SETTLED budget after a metering rejection, not the pre-call snapshot', async () => {
    // `meterTurn` settles its reservation even when it throws (#563): either the spend was
    // already committed and a later audit/history write failed, or the hold is consumed as
    // unknown spend. Either way the database was charged — so falling back to the pre-call
    // snapshot made the response and the turn.ended frame report a budget that no longer
    // existed. A branch that exists to handle a bookkeeping failure must not then report
    // bookkeeping that did not happen.
    const campaignId = await armedCampaign('Withheld metering settled');

    h.script({ text: `${UNSAFE}`, finishReason: 'content_filter' });
    const aiDm = h.ctx.app.get(AiDmService);
    const meterSpy = jest.spyOn(aiDm, 'meterTurn').mockRejectedValueOnce(new Error('usage-history write failed'));

    try {
      const res = await h.sendMessage(campaignId, { input: 'go' });
      expect(meterSpy).toHaveBeenCalled();
      expect(res.body.stopReason).toBe('content_withheld');

      // Whatever the seat actually holds now is what the caller must be told. Read it back and
      // require the response to agree, rather than pinning a specific number — the point is
      // that the report tracks the database, not that settlement took any particular shape.
      const after = (await h.getSeat(campaignId)).body;
      expect(res.body.budgetRemaining).toBe(after.budgetRemaining);
    } finally {
      meterSpy.mockRestore();
    }
  });

  it('the incident’s turn number matches the stuck record for the same turn', async () => {
    // `WithheldTurnIncident.turn` documents that it correlates with the stuck record. It did not:
    // the incident was written from inside the step loop, before the turn's `finally` bumped
    // `session.turnCount`, while the stuck record is written after it — so a DM cross-referencing
    // the two lists could not line up a single row.
    const campaignId = await armedCampaign('Withheld turn correlation');
    h.script({ text: `${UNSAFE}`, finishReason: 'content_filter' });
    await h.sendMessage(campaignId, { input: 'go' });

    const first = (await h.getDriverSession(campaignId)).body;
    expect(first.stuck.reason).toBe('content_withheld');
    expect((await incidents(campaignId)).body[0].turn).toBe(first.stuck.turn);

    // Not an accident of both happening to be 0 on the first turn: run a second withheld turn
    // and assert they still agree, and that the number actually advanced.
    h.script({ text: `${UNSAFE}`, finishReason: 'refusal' });
    await h.sendMessage(campaignId, { input: 'go again' });

    const second = (await h.getDriverSession(campaignId)).body;
    const rows = (await incidents(campaignId)).body; // newest first
    expect(rows).toHaveLength(2);
    expect(rows[0].turn).toBe(second.stuck.turn);
    expect(rows[0].turn).toBeGreaterThan(rows[1].turn);
  });

  it('audits the withhold with counts only, and not as a provider failure', async () => {
    const campaignId = await armedCampaign('Withheld audit');
    h.script({ text: `${UNSAFE}`, finishReason: 'refusal' });
    await h.sendMessage(campaignId, { input: 'go' });

    const audit = await h.getAudit(campaignId);
    const entries = (audit.body.items ?? audit.body) as Array<{ action: string; detail: string }>;
    const withheld = entries.find((e) => e.action === 'ai-dm.driver.content_withheld');
    expect(withheld).toBeDefined();
    expect(withheld!.detail).toContain('refusal');
    expect(withheld!.detail).not.toContain(UNSAFE);
    // A refusal is not plumbing failure; misfiling it would put the wrong lever set and the
    // wrong sentence in front of the table.
    expect(entries.some((e) => e.action === 'ai-dm.driver.provider_error')).toBe(false);
  });
});
