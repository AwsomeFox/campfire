import request from 'supertest';
import { createAiEvalHarness, dm, player, viewer, type AiEvalHarness } from './ai-eval-harness';
import { mcpToolsToAiSchemas } from '../src/modules/ai-dm/providers/tool-registry';
import { AiDmStreamService, type AiDmStreamEvent } from '../src/modules/ai-driver/ai-driver-stream.service';

/**
 * Driver AI-DM runtime (#312) — the KEYSTONE flow, tested end-to-end and OFFLINE via the
 * #318 harness. The deterministic mock provider (#309) is wired in as BOTH the streaming
 * AiProvider the driver consumes and the legacy text provider, so we can script the model's
 * turns (narration + tool calls + exact usage) and assert the whole loop:
 *   - player input → streamed narration → REAL Campfire tool execution → result fed back →
 *     next turn → budget metered (hard stop) → every step + tool call audited.
 *
 * These fill the `#312 driver` placeholders the harness spec left as `it.todo`.
 */

// The full tool registry is offered to the model by the runtime itself; here we only need a
// couple of MCP-shaped tools for the prompt-assembly-style checks that also touch this path.
const TOOLS = mcpToolsToAiSchemas([
  { name: 'roll_dice', description: 'Roll dice.', inputSchema: { type: 'object', properties: { expr: { type: 'string' } } } },
]);

describe('ai-dm driver runtime — session loop + streamed narration + tool execution (e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'driver-model', tools: TOOLS });
    await h.enableExperimental();
  });

  afterAll(async () => {
    await h.close();
  });

  it('#312 driver: a scripted tool call executes a real campfire tool and feeds the result back', async () => {
    const campaignId = await h.createCampaign('Driver ToolLoop');
    await h.configureSeat(campaignId, { instructions: 'Be terse.', tokenBudget: 100_000 });

    // Turn 1: the model rolls dice (a REAL direct-write tool). Turn 2: it narrates the outcome.
    h.script(
      {
        text: 'You test your luck…',
        toolCalls: [{ id: 'call_roll', name: 'roll_dice', arguments: { campaignId, expr: '2d6' } }],
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      },
      { text: 'The die shows a 5 — the lock clicks open.', usage: { promptTokens: 150, completionTokens: 30, totalTokens: 180 } },
    );

    const res = await h.sendMessage(campaignId, { input: 'I pick the lock.' });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('complete');
    expect(res.body.steps).toBe(2);
    expect(res.body.narration).toBe('The die shows a 5 — the lock clicks open.');

    // The tool actually ran (no error), and was NOT routed to proposals (live play is direct).
    expect(res.body.toolCalls).toEqual([{ name: 'roll_dice', isError: false, proposed: false }]);

    // The result was fed back: the 2nd provider request carries a `tool` message with the roll total.
    const secondReq = h.mock.received.at(-1)!;
    const toolMsg = secondReq.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.toolName).toBe('roll_dice');
    expect(toolMsg!.content).toContain('"total"'); // the real roll result was fed back

    // Budget metered BOTH steps' real usage (120 + 180 = 300).
    expect(res.body.tokensUsed).toBe(300);
    expect(res.body.budgetRemaining).toBe(100_000 - 300);
    expect(res.body.seat.tokensUsed).toBe(300);
  });

  it('#312 driver: multi-step tool loop terminates on a stop turn and audits each step', async () => {
    const campaignId = await h.createCampaign('Driver Audit');
    await h.configureSeat(campaignId, { tokenBudget: 100_000 });

    h.script(
      { text: 'rolling', toolCalls: [{ id: 'c1', name: 'roll_dice', arguments: { campaignId, expr: '2d6' } }] },
      { text: 'done — no more tools.' },
    );
    const res = await h.sendMessage(campaignId, { input: 'go' });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('complete');

    // Every step + tool call is audited under the seat actor.
    const audit = await h.getAudit(campaignId);
    const actions = audit.body.map((e: { action: string }) => e.action);
    expect(actions.filter((a: string) => a === 'ai-dm.driver.turn')).toHaveLength(2); // two provider steps
    expect(actions.filter((a: string) => a === 'ai-dm.driver.tool')).toHaveLength(1); // one tool call
    const seatActor = audit.body.find((e: { action: string }) => e.action === 'ai-dm.driver.tool');
    expect(seatActor.actor).toBe(`ai-dm-seat:${campaignId}`);
  });

  it('#312 driver: a canon write it cannot make directly becomes a PROPOSAL', async () => {
    const campaignId = await h.createCampaign('Driver Proposals');
    await h.configureSeat(campaignId, { tokenBudget: 100_000 });

    // The model tries to create a quest (canon). The runtime forces it onto the proposal path.
    h.script(
      {
        text: 'A new thread emerges…',
        toolCalls: [{ id: 'q1', name: 'create_quest', arguments: { campaignId, title: 'The Missing Heir' } }],
      },
      { text: 'The rumor spreads through the tavern.' },
    );
    const res = await h.sendMessage(campaignId, { input: 'What quest could we take on?' });
    expect(res.status).toBe(201);
    expect(res.body.toolCalls).toEqual([{ name: 'create_quest', isError: false, proposed: true }]);

    // It landed as a PENDING proposal, not a directly-created quest.
    const proposals = await request(h.server).get(`/api/v1/campaigns/${campaignId}/proposals`).set(dm);
    expect(proposals.status).toBe(200);
    const pending = proposals.body.filter((p: { status: string; entityType: string }) => p.status === 'pending' && p.entityType === 'quest');
    expect(pending).toHaveLength(1);

    // No quest was written directly.
    const quests = await request(h.server).get(`/api/v1/campaigns/${campaignId}/quests`).set(dm);
    expect(quests.body.find((q: { title: string }) => q.title === 'The Missing Heir')).toBeUndefined();
  });

  it('#312 driver: streams narration token-by-token over the SSE channel', async () => {
    const campaignId = await h.createCampaign('Driver Stream');
    await h.configureSeat(campaignId, { tokenBudget: 100_000 });

    // Subscribe to the in-process narration stream (what GET /ai-dm/stream fans out over SSE).
    const streamSvc = h.ctx.app.get(AiDmStreamService);
    const events: AiDmStreamEvent[] = [];
    const sub = streamSvc.streamFor(campaignId).subscribe((e) => events.push(e));

    h.script({ text: 'The torches gutter as the door swings wide.', streamChunks: 4 });
    await h.sendMessage(campaignId, { input: 'We enter the crypt.' });
    sub.unsubscribe();

    const deltas = events.filter((e) => e.type === 'narration.delta');
    expect(deltas.length).toBeGreaterThan(1); // multiple token chunks, not one blob
    const reassembled = deltas.map((e) => (e.type === 'narration.delta' ? e.text : '')).join('');
    expect(reassembled).toBe('The torches gutter as the door swings wide.');
    expect(events.some((e) => e.type === 'turn.start')).toBe(true);
    expect(events.some((e) => e.type === 'turn.end')).toBe(true);
  });

  it('#312 driver: budget is a HARD stop — the loop halts and the next turn 403s', async () => {
    const campaignId = await h.createCampaign('Driver Budget');
    await h.configureSeat(campaignId, { tokenBudget: 200 });

    // Step 1 overruns the whole budget AND asks for another tool → the loop must stop before step 2.
    h.script(
      {
        text: 'burning tokens',
        toolCalls: [{ id: 'b1', name: 'roll_dice', arguments: { campaignId, expr: '2d6' } }],
        usage: { promptTokens: 300, completionTokens: 0, totalTokens: 300 },
      },
      { text: 'should never run' },
    );
    const res = await h.sendMessage(campaignId, { input: 'go' });
    expect(res.status).toBe(201);
    expect(res.body.stopReason).toBe('budget_exhausted');
    expect(res.body.budgetRemaining).toBe(0);
    expect(res.body.steps).toBe(1); // step 2 never streamed

    // The next turn is refused outright — budget exhausted.
    const again = await h.sendMessage(campaignId, { input: 'again' });
    expect(again.status).toBe(403);
    expect(again.text).toContain('budget exhausted');
  });
});

describe('ai-dm driver runtime — gating + access (e2e)', () => {
  let h: AiEvalHarness;
  let campaignId: number;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'driver-model' });
    campaignId = await h.createCampaign('Driver Gating');
  });

  afterAll(async () => {
    await h.close();
  });

  it('rejects input when the server experimental flag is off (403)', async () => {
    const res = await h.sendMessage(campaignId, { input: 'go' });
    expect(res.status).toBe(403);
  });

  it('rejects input when the seat is not enabled (403), even with the flag on', async () => {
    await h.enableExperimental();
    const res = await h.sendMessage(campaignId, { input: 'go' });
    expect(res.status).toBe(403);
  });

  it('a viewer cannot drive the seat but can watch the session state', async () => {
    await h.configureSeat(campaignId, { tokenBudget: 10_000 });
    const drive = await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/message`).set(viewer).send({ input: 'go' });
    expect(drive.status).toBe(403);
    const session = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm/session`).set(viewer);
    expect(session.status).toBe(200);
    expect(session.body.status).toBeDefined();
  });

  it('a paused seat refuses new input until resumed', async () => {
    // Pausing rejects BEFORE the provider is called, so no script is consumed here.
    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/pause`).set(dm).send({ paused: true });
    const paused = await h.sendMessage(campaignId, { input: 'go' });
    expect(paused.status).toBe(503);

    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/pause`).set(dm).send({ paused: false });
    h.script({ text: 'we are back' });
    const resumed = await h.sendMessage(campaignId, { input: 'go' });
    expect(resumed.status).toBe(201);
    expect(resumed.body.narration).toBe('we are back');
  });

  it('a player (not just the DM) can submit input — the AI still acts as the seat, not the player', async () => {
    h.script({ text: 'the player speaks and the world answers' });
    const res = await request(h.server)
      .post(`/api/v1/campaigns/${campaignId}/ai-dm/message`)
      .set(player)
      .send({ input: 'I look around the tavern' });
    expect(res.status).toBe(201);
    expect(res.body.narration).toBe('the player speaks and the world answers');
  });
});
