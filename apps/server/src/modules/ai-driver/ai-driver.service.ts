import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { RequestUser } from '../../common/user.types';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { AiDmService } from '../ai-dm/ai-dm.service';
import { McpToolsService, type DriverToolset } from '../mcp/mcp-tools';
import type { AiDmSeat } from '@campfire/schema';
import type {
  AiProvider,
  AiMessage,
  AiToolCall,
  AiToolSchema,
  AiGenerateResult,
} from '../ai-dm/providers/ai-provider';
import { AI_PROVIDER_RESOLVER, type AiProviderResolver } from './ai-provider-resolver';
import { AiDmStreamService } from './ai-driver-stream.service';

/** Default per-provider-call output cap for a driver step; clamped to remaining budget. */
const DEFAULT_STEP_MAX_TOKENS = 1024;
/** Default / hard ceiling on tool-loop iterations in one turn (stop-condition backstop). */
const DEFAULT_MAX_STEPS = 6;
const HARD_MAX_STEPS = 12;

/** Why a driver turn stopped — surfaced on the result + the turn.end SSE event. */
export type AiDmStopReason =
  | 'complete' // the model produced narration with no further tool calls
  | 'budget_exhausted' // the per-campaign token budget hit its hard cap
  | 'tool_error' // a tool call returned an error (hand-off point for the stuck ladder, #314)
  | 'max_steps'; // the tool loop hit its iteration ceiling

/** One tool the AI executed this turn (id-only; details are audited, not returned raw). */
export interface AiDmExecutedTool {
  name: string;
  isError: boolean;
  /** True when the call was routed to the proposal queue (a canon write the seat can't make directly). */
  proposed: boolean;
}

export interface AiDmTurnRunResult {
  narration: string;
  stopReason: AiDmStopReason;
  steps: number;
  toolCalls: AiDmExecutedTool[];
  tokensUsed: number;
  tokenBudget: number;
  budgetRemaining: number;
  seat: AiDmSeat;
}

export type AiDmSessionStatus = 'idle' | 'running' | 'paused';

export interface AiDmSessionState {
  campaignId: number;
  status: AiDmSessionStatus;
  scene: string | null;
  lastNarration: string | null;
  lastTurnAt: string | null;
  turnCount: number;
}

export interface RunTurnOptions {
  scene?: string;
  maxSteps?: number;
  maxTokens?: number;
}

/**
 * Grounding / anti-hallucination preamble prepended to every driver system prompt.
 * The runtime must not invent canon: rules come from the compendium (lookup_rule),
 * NPC/quest/location facts from campaign reads, and any NEW canon is created via a
 * tool (which the runtime forces down the proposal path), never asserted only in prose.
 */
const GROUNDING_PREAMBLE = [
  'You are the AI Dungeon Master running a live tabletop scene. Narrate vividly but stay grounded:',
  '- Never invent rules — call lookup_rule / get_rule_entry and cite the rule you used.',
  '- Never invent NPCs, quests, locations, or party facts — read them (get_campaign_summary, get_npc, …) and cite the entity.',
  '- To change the world (a new NPC/quest/location, edits to canon), call the matching tool. Those are submitted as PROPOSALS for the human DM to approve — do not claim a canon change happened until it is applied.',
  '- You MAY resolve live play directly: roll dice, apply HP/conditions, advance turns, reveal map regions.',
  '- Respect the session-zero charter (lines/veils/safety tools) below at all times.',
].join('\n');

/**
 * Driver AI-DM runtime (#312) — the KEYSTONE of the AI program (#308).
 *
 * Turns the single request→response scaffold (AiDmService.takeTurn) into a real
 * session loop: it (a) takes player input, (b) assembles the model context, (c)
 * STREAMS narration from the provider (#309) token-by-token to every player over SSE,
 * (d) executes the model's tool calls against Campfire through the FULL MCP tool
 * registry — under the identical role + write-mode + proposal enforcement a remote MCP
 * client hits — feeding each result back for the next step, and (e) meters every step's
 * REAL token usage against the per-campaign budget as a hard stop, auditing each step.
 *
 * It wires the three foundations end-to-end: AiProviderResolver (resolveEffectiveConfig
 * #310 → createAiProvider #309) supplies the streaming provider; McpToolsService.buildToolset
 * reuses the whole tool layer; AiDmService owns the seat gating + atomic budget metering.
 *
 * PRINCIPAL & GUARDRAILS — the AI acts as a campaign-scoped DM seat, NOT as the player
 * who sent the message. That seat may resolve live play (dice/HP/turns/reveals) but can
 * never write canon directly: the runtime forces `propose:true` on every proposal-capable
 * tool (so canon edits become pending proposals a human DM reviews) and rejects any tool
 * call whose `campaignId` argument points at a different campaign than this seat.
 */
@Injectable()
export class AiDriverService {
  private readonly logger = new Logger(AiDriverService.name);
  /** In-memory per-campaign session state (single-instance deploy, like CampaignEventsService). */
  private readonly sessions = new Map<number, AiDmSessionState>();

  constructor(
    private readonly aiDm: AiDmService,
    private readonly mcpTools: McpToolsService,
    private readonly audit: AuditService,
    private readonly stream: AiDmStreamService,
    @Inject(AI_PROVIDER_RESOLVER) private readonly resolver: AiProviderResolver,
  ) {}

  getSession(campaignId: number): AiDmSessionState {
    return this.sessions.get(campaignId) ?? this.freshSession(campaignId);
  }

  /** Pause/resume the seat — a paused seat rejects new turns until resumed (explicit stop condition). */
  setPaused(campaignId: number, paused: boolean): AiDmSessionState {
    const session = this.ensureSession(campaignId);
    session.status = paused ? 'paused' : 'idle';
    return session;
  }

  private freshSession(campaignId: number): AiDmSessionState {
    return { campaignId, status: 'idle', scene: null, lastNarration: null, lastTurnAt: null, turnCount: 0 };
  }

  private ensureSession(campaignId: number): AiDmSessionState {
    let s = this.sessions.get(campaignId);
    if (!s) {
      s = this.freshSession(campaignId);
      this.sessions.set(campaignId, s);
    }
    return s;
  }

  /**
   * Run one driver turn for `input` (a player action). Streams narration + executes
   * tool calls in a loop until the model stops, the budget is exhausted, a tool errors,
   * or the step ceiling is hit. `triggeredBy` is the member who submitted the input —
   * recorded in the audit trail; the AI itself acts as the seat principal.
   */
  async runTurn(
    campaignId: number,
    triggeredBy: RequestUser,
    input: string,
    opts: RunTurnOptions = {},
  ): Promise<AiDmTurnRunResult> {
    // Gate: experimental flag on + seat enabled + budget remaining (throws otherwise).
    const seat = await this.aiDm.assertRunnable(campaignId);

    const session = this.ensureSession(campaignId);
    if (session.status === 'paused') {
      throw new ServiceUnavailableException('The AI Dungeon Master seat is paused. Resume it before sending input.');
    }

    const provider = await this.resolver.resolve(campaignId);
    if (!provider) {
      throw new ServiceUnavailableException(
        'No AI provider is configured. A server admin or the DM must set one via the AI provider config (issue #310).',
      );
    }

    // The seat principal: a campaign-scoped DM. devRole grants dm authority for tool
    // access (RoleResolver short-circuit); no tokenContext means direct live-play writes
    // are allowed, while the runtime forces canon writes onto the proposal path below.
    const seatPrincipal: RequestUser = {
      id: `ai-dm-seat:${campaignId}`,
      name: 'AI Dungeon Master',
      serverRole: 'user',
      devRole: 'dm',
    };
    const actor = `ai-dm-seat:${campaignId}`;

    const toolset = this.mcpTools.buildToolset(seatPrincipal);
    const toolSchemas: AiToolSchema[] = toolset.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));

    const system = await this.assembleSystemPrompt(campaignId, seat, toolset);
    const messages: AiMessage[] = [{ role: 'user', content: input }];

    session.status = 'running';
    if (opts.scene !== undefined) session.scene = opts.scene;
    this.stream.emit({ type: 'turn.start', campaignId });

    const maxSteps = clamp(opts.maxSteps ?? DEFAULT_MAX_STEPS, 1, HARD_MAX_STEPS);
    const perStepCap = clamp(opts.maxTokens ?? DEFAULT_STEP_MAX_TOKENS, 1, 4096);

    let totalTokens = 0;
    let budgetRemaining = seat.tokenBudget - seat.tokensUsed;
    let finalNarration = '';
    let latestSeat = seat;
    let stopReason: AiDmStopReason = 'complete';
    const executed: AiDmExecutedTool[] = [];
    let steps = 0;

    try {
      for (let step = 0; step < maxSteps; step++) {
        if (budgetRemaining <= 0) {
          stopReason = 'budget_exhausted';
          break;
        }
        steps = step + 1;

        const maxTokens = Math.min(perStepCap, budgetRemaining);
        const { text, result } = await this.streamStep(campaignId, provider, {
          system,
          messages,
          model: seat.model,
          maxTokens,
          tools: toolSchemas,
        });

        // Meter this step's REAL usage against the budget (atomic; hard cap). Every step
        // is audited via AiDmService.meterTurn (actor = the seat).
        const usage = result?.usage.totalTokens ?? 0;
        const metered = await this.aiDm.meterTurn(campaignId, usage, {
          actor,
          action: 'ai-dm.driver.turn',
          detail: `step ${steps} model=${seat.model || 'default'} +${usage} tokens by ${triggeredBy.id}`,
        });
        totalTokens += metered.tokensUsed;
        budgetRemaining = metered.budgetRemaining;
        latestSeat = metered.seat;

        if (text) {
          finalNarration = text;
          this.stream.emit({ type: 'narration.message', campaignId, text });
        }

        const toolCalls = result?.toolCalls ?? [];
        if (toolCalls.length === 0) {
          stopReason = 'complete';
          break;
        }

        // Feed the assistant's tool-call turn back, then execute each call and append its result.
        messages.push({ role: 'assistant', content: text || undefined, toolCalls });
        const { toolErrored } = await this.executeToolCalls(campaignId, actor, triggeredBy, toolset, toolCalls, messages, executed);
        if (toolErrored) {
          stopReason = 'tool_error';
          break;
        }

        if (step === maxSteps - 1) stopReason = 'max_steps';
      }
    } finally {
      session.status = 'idle';
      session.lastNarration = finalNarration || session.lastNarration;
      session.lastTurnAt = nowIso();
      session.turnCount += 1;
    }

    this.stream.emit({ type: 'turn.end', campaignId, stopReason, steps, tokensUsed: totalTokens, budgetRemaining });

    return {
      narration: finalNarration,
      stopReason,
      steps,
      toolCalls: executed,
      tokensUsed: totalTokens,
      tokenBudget: seat.tokenBudget,
      budgetRemaining,
      seat: latestSeat,
    };
  }

  /** Stream one provider call, forwarding text deltas to the SSE channel; returns the aggregated text + result. */
  private async streamStep(
    campaignId: number,
    provider: AiProvider,
    req: { system: string; messages: AiMessage[]; model: string; maxTokens: number; tools: AiToolSchema[] },
  ): Promise<{ text: string; result: AiGenerateResult | undefined }> {
    let text = '';
    let result: AiGenerateResult | undefined;
    for await (const ev of provider.stream({
      system: req.system,
      messages: req.messages,
      model: req.model,
      maxTokens: req.maxTokens,
      tools: req.tools,
      toolChoice: req.tools.length > 0 ? 'auto' : undefined,
    })) {
      if (ev.type === 'text') {
        text += ev.delta;
        this.stream.emit({ type: 'narration.delta', campaignId, text: ev.delta });
      } else if (ev.type === 'done') {
        result = ev.result;
      }
    }
    // A provider that only streamed deltas (no `done`) still yields its text.
    if (result && !result.text && text) result = { ...result, text };
    return { text, result };
  }

  /**
   * Execute the model's tool calls under the seat's guardrails and append each result
   * as a `tool` message for the next step. Enforces: (1) a campaignId guard — a call
   * naming a different campaign is rejected, not executed; (2) forced `propose:true` on
   * proposal-capable canon tools; (3) per-call audit. Returns whether any call errored.
   */
  private async executeToolCalls(
    campaignId: number,
    actor: string,
    triggeredBy: RequestUser,
    toolset: DriverToolset,
    toolCalls: AiToolCall[],
    messages: AiMessage[],
    executed: AiDmExecutedTool[],
  ): Promise<{ toolErrored: boolean }> {
    let toolErrored = false;
    for (const call of toolCalls) {
      const tool = toolset.get(call.name);
      const args: Record<string, unknown> = { ...(call.arguments ?? {}) };

      // (1) Cross-campaign guard: the seat is scoped to ONE campaign even though its
      // devRole would otherwise grant dm on any campaign.
      if ('campaignId' in args && Number(args.campaignId) !== campaignId) {
        const text = JSON.stringify({
          error: { status: 403, code: 'forbidden', message: `This AI DM seat is scoped to campaign ${campaignId}.` },
        });
        messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: text });
        this.stream.emit({ type: 'tool', campaignId, name: call.name, isError: true, proposed: false });
        executed.push({ name: call.name, isError: true, proposed: false });
        toolErrored = true;
        continue;
      }

      // (2) Guardrail: canon writes can't be made directly — force them to propose.
      const canPropose = tool?.proposalCapable ?? false;
      if (canPropose && args.propose === undefined) args.propose = true;
      const proposed = canPropose && args.propose === true;

      const res = await toolset.call(call.name, args);
      messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: res.text });
      this.stream.emit({ type: 'tool', campaignId, name: call.name, isError: res.isError, proposed });
      executed.push({ name: call.name, isError: res.isError, proposed });

      // (3) Audit every tool call the AI made (actor = the seat, records the triggering user).
      await this.audit.log({
        actor,
        actorRole: 'dm',
        action: 'ai-dm.driver.tool',
        entityType: 'ai-dm',
        campaignId,
        detail: `${call.name}${proposed ? ' (proposed)' : ''}${res.isError ? ' [error]' : ''} by ${triggeredBy.id}`,
      });

      if (res.isError) toolErrored = true;
    }
    return { toolErrored };
  }

  /**
   * Assemble the system prompt: the grounding preamble, the DM's seat steering, and a
   * compact, permission-checked context block (campaign summary + session-zero charter)
   * read through the SAME tool layer the AI uses — so the context can never contain
   * anything the seat principal isn't allowed to see. Reads are best-effort: a failing
   * read is simply omitted rather than aborting the turn.
   */
  private async assembleSystemPrompt(campaignId: number, seat: AiDmSeat, toolset: DriverToolset): Promise<string> {
    const parts: string[] = [GROUNDING_PREAMBLE];
    if (seat.instructions) parts.push(`## DM steering\n${seat.instructions}`);

    const summary = await safeRead(toolset, 'get_campaign_summary', { campaignId });
    if (summary) parts.push(`## Campaign context\n${summary}`);

    const sessionZero = await safeRead(toolset, 'get_session_zero', { campaignId });
    if (sessionZero) parts.push(`## Session-zero charter (safety boundaries — MUST respect)\n${sessionZero}`);

    return parts.join('\n\n');
  }
}

async function safeRead(toolset: DriverToolset, name: string, args: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await toolset.call(name, args);
    return res.isError ? null : res.text;
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
