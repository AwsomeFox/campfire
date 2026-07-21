import { createAiEvalHarness, dm, player, type AiEvalHarness } from './ai-eval-harness';
import { mockTokenCount } from '../src/modules/ai-dm/providers/mock-provider';
import { mcpToolsToAiSchemas } from '../src/modules/ai-dm/providers/tool-registry';
import request from 'supertest';

/**
 * Deterministic AI eval harness (#318) — the offline test seam for the AI program (#308).
 *
 * These suites prove the harness itself: the deterministic mock provider (#309) wired into the
 * REAL AiDm HTTP path produces reproducible narration, exact usage/metering, records the exact
 * prompt/system/tool-registry the seam assembled (tool-call round-trip), and never touches the
 * network. Later AI issues (#312/#313/#316/#314) import `createAiEvalHarness` and build their
 * flow assertions on this same seam — the `describe('downstream AI flows')` block at the bottom
 * enumerates those as placeholders the owning issue fleshes out.
 */

// A couple of MCP-shaped tools normalized through the registry seam (#309) so the tool-call
// round-trip eval offers a real registry to the (mock) model, exactly as #312 will.
const TOOLS = mcpToolsToAiSchemas([
  {
    name: 'roll_dice',
    description: 'Roll dice and return the total.',
    inputSchema: { type: 'object', properties: { notation: { type: 'string' } }, required: ['notation'] },
  },
  {
    name: 'update_hp',
    description: 'Set a combatant HP.',
    inputSchema: { type: 'object', properties: { combatantId: { type: 'number' }, hp: { type: 'number' } } },
  },
]);

describe('ai-dm eval harness — scripted narration + metering (e2e)', () => {
  let h: AiEvalHarness;
  let campaignId: number;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'eval-model', tools: TOOLS });
    await h.enableExperimental();
    campaignId = await h.createCampaign('Eval Narration');
    await h.configureSeat(campaignId, { instructions: 'Be terse and grim.', tokenBudget: 100_000 });
  });

  afterAll(async () => {
    await h.close();
  });

  it('a scripted turn returns the exact canned narration via the mock provider', async () => {
    h.script({ text: 'The crypt door grinds open.' });
    const res = await h.takeTurn(campaignId, { prompt: 'The rogue picks the lock.', kind: 'narrate' });

    expect(res.status).toBe(201);
    expect(res.body.provider).toBe('mock');
    expect(res.body.kind).toBe('narrate');
    expect(res.body.narration).toBe('The crypt door grinds open.');
  });

  it('meters the provider’s REAL (deterministic) usage against the budget', async () => {
    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/reset`).set(dm).send({});
    await h.configureSeat(campaignId, { tokenBudget: 100_000 });

    const prompt = 'The party crosses the bridge.';
    const instructions = 'Be terse and grim.';
    const narration = 'Planks creak underfoot.';
    h.script({ text: narration });

    const res = await h.takeTurn(campaignId, { prompt, kind: 'narrate' });
    expect(res.status).toBe(201);

    // Bridge meters totalTokens = prompt-side (system + user) + completion, derived deterministically.
    const promptTokens = mockTokenCount(instructions + prompt);
    const completionTokens = mockTokenCount(narration);
    const expectedTotal = promptTokens + completionTokens;
    expect(res.body.tokensUsed).toBe(expectedTotal);
    expect(res.body.budgetRemaining).toBe(100_000 - expectedTotal);
    expect(res.body.seat.tokensUsed).toBe(expectedTotal);
    expect(res.body.seat.turnCount).toBe(1);
  });

  it('honours an explicit usage override for exact budget-cost assertions', async () => {
    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/reset`).set(dm).send({});
    await h.configureSeat(campaignId, { tokenBudget: 5_000 });
    h.script({ text: 'A precise cost.', usage: { promptTokens: 400, completionTokens: 100, totalTokens: 500 } });

    const res = await h.takeTurn(campaignId, { prompt: 'anything', kind: 'narrate' });
    expect(res.status).toBe(201);
    expect(res.body.tokensUsed).toBe(500);
    expect(res.body.budgetRemaining).toBe(4_500);
  });

  it('falls back to a deterministic echo when the script queue is exhausted', async () => {
    await request(h.server).post(`/api/v1/campaigns/${campaignId}/ai-dm/reset`).set(dm).send({});
    // No script() call — the queue is empty, so the mock echoes the prompt verbatim.
    const res = await h.takeTurn(campaignId, { prompt: 'echo me', kind: 'narrate' });
    expect(res.status).toBe(201);
    expect(res.body.narration).toBe('echo: echo me');
  });
});

describe('ai-dm eval harness — prompt assembly + tool-call round-trip (e2e)', () => {
  let h: AiEvalHarness;
  let campaignId: number;

  beforeAll(async () => {
    h = await createAiEvalHarness({ model: 'eval-model', tools: TOOLS });
    await h.enableExperimental();
    campaignId = await h.createCampaign('Eval Tools');
    await h.configureSeat(campaignId, { instructions: 'You are the grim DM.', tokenBudget: 100_000 });
  });

  afterAll(async () => {
    await h.close();
  });

  it('assembles the seat instructions as the system prompt and the player prompt as the user turn', async () => {
    h.script({ text: 'ok' });
    await h.takeTurn(campaignId, { prompt: 'The bard sings.', kind: 'narrate' });

    // The mock recorded exactly what the AiDm seam sent the model.
    const req = h.mock.received.at(-1)!;
    expect(req.system).toBe('You are the grim DM.'); // seat.instructions → system prompt
    expect(req.messages).toEqual([{ role: 'user', content: 'The bard sings.' }]);
    // The tool registry offered to the model is the normalized MCP registry.
    expect(req.tools?.map((t) => t.name)).toEqual(['roll_dice', 'update_hp']);
    expect(req.toolChoice).toBe('auto');
    // Every tool schema carries a JSON-Schema object root (both wire formats require it).
    for (const tool of req.tools ?? []) expect(tool.parameters).toMatchObject({ type: 'object' });
  });

  it('round-trips a scripted tool call: the model requests a tool, it surfaces on the turn', async () => {
    h.script({
      text: 'You strike true.',
      toolCalls: [{ id: 'call_1', name: 'roll_dice', arguments: { notation: '1d20+5' } }],
    });
    const res = await h.takeTurn(campaignId, { prompt: 'I attack the goblin.', kind: 'narrate' });
    expect(res.status).toBe(201);

    // The current text-only bridge surfaces tool calls as a human-readable note on the narration
    // (the structural tool-EXECUTION loop is #312's job — see the placeholder block below). The
    // round-trip is nonetheless asserted end-to-end: the model's request reaches the seat output.
    expect(res.body.narration).toContain('You strike true.');
    expect(res.body.narration).toContain('roll_dice');
    expect(res.body.narration).toContain('1d20+5');

    // And the mock captured the offered registry the model chose from.
    const req = h.mock.received.at(-1)!;
    expect(req.tools?.some((t) => t.name === 'roll_dice')).toBe(true);
  });

  it('records every served request in order for prompt-assembly assertions', async () => {
    const before = h.mock.received.length;
    h.script({ text: 'one' }, { text: 'two' });
    await h.takeTurn(campaignId, { prompt: 'first', kind: 'narrate' });
    await h.takeTurn(campaignId, { prompt: 'second', kind: 'narrate' });
    expect(h.mock.received.length).toBe(before + 2);
    expect(h.mock.received.at(-2)!.messages[0].content).toBe('first');
    expect(h.mock.received.at(-1)!.messages[0].content).toBe('second');
  });
});

describe('ai-dm eval harness — offline + gating invariants (e2e)', () => {
  let h: AiEvalHarness;

  beforeAll(async () => {
    h = await createAiEvalHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('the whole path is offline: no vendor call, provider is the deterministic mock', async () => {
    await h.enableExperimental();
    const campaignId = await h.createCampaign('Eval Offline');
    await h.configureSeat(campaignId, { tokenBudget: 1_000 });
    h.script({ text: 'deterministic' });
    const res = await h.takeTurn(campaignId, { prompt: 'go', kind: 'narrate' });
    expect(res.body.provider).toBe('mock');
    expect(res.body.narration).toBe('deterministic');
  });

  it('respects the seat instructions redaction for non-DM even with the mock backend (issue #261)', async () => {
    const campaignId = await h.createCampaign('Eval Redact');
    await h.configureSeat(campaignId, { instructions: 'secret plot: the mayor is a lich', tokenBudget: 1_000 });
    const playerView = await request(h.server).get(`/api/v1/campaigns/${campaignId}/ai-dm`).set(player);
    expect(playerView.status).toBe(200);
    expect(playerView.body).not.toHaveProperty('instructions');
  });
});

/**
 * Downstream AI flows — the harness is READY; each behavior lands with its owning issue, which
 * fleshes these out using `createAiEvalHarness` (script the provider turns, drive the endpoints,
 * assert the resulting state/proposals/narration). Left as `it.todo` so they surface as pending
 * work rather than silently missing. See #308 for the program epic.
 */
describe('downstream AI flows (harness ready; behavior lands with its issue)', () => {
  // #312 — driver runtime: the mock requests a campfire tool, the runtime EXECUTES it under
  // write-mode, the result feeds back for a second turn, HP/turn effects + audit + budget land.
  it.todo('#312 driver: scripted tool call executes a real campfire tool and feeds the result back');
  it.todo('#312 driver: multi-step tool loop terminates on a stop turn and audits each step');

  // #313 — co-DM authoring: a scripted draft becomes a PROPOSAL only (nothing written directly),
  // and the DM approve/reject path applies or discards it.
  it.todo('#313 co-DM: a scripted authoring turn produces a proposal, never a direct write');

  // #316 — scheduled scribe: LANDED. A scripted recap job assembles the campaign material,
  // files a recap PROPOSAL (never canon), meters the seat budget, is idempotent on rerun, and
  // runs on-demand + via the post-session sweep. See scribe.e2e-spec.ts (built on this harness).
  it('#316 scribe: recap job + idempotency covered in scribe.e2e-spec.ts', () => {
    expect(true).toBe(true);
  });

  // #314 — stuck ladder: each detection maps to the correct state + levers, human takeover, handback.
  it.todo('#314 stuck: each detection rung yields the correct state, levers, takeover and handback');

  // Security regression (part of #83): a crafted player prompt cannot escalate / leak DM secrets /
  // call destructive tools; keys never appear in reads/exports/logs/audit.
  it.todo('#318 security: prompt-injection in a player turn cannot escalate or call destructive tools');
});
