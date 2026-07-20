import { Injectable } from '@nestjs/common';
import type { AiDmTurnKind } from '@campfire/schema';

/**
 * Dependency-injection seam for what actually produces the AI Dungeon Master's
 * narration (issue #28).
 *
 * Campfire is MCP-first and self-hosted: it ships NO server-side LLM dependency
 * and MUST NOT call any vendor (OpenAI/Anthropic/…). The intended flow is that a
 * connected agent — authenticated with a dm-scoped PAT — drives the existing tool
 * layer over MCP/REST and IS the Dungeon Master. This interface exists so that an
 * operator who explicitly wants server-side generation can swap in their own
 * implementation (bound to the AI_DM_PROVIDER token in their own module) without
 * touching the metering/audit/gating plumbing.
 *
 * The provider is pure text-in/text-out plus a token count — it never reaches into
 * the DB or performs writes; all persistence, budget accounting, gating and
 * auditing happen in AiDmService around it. The shipped default (NoopAiDmProvider)
 * makes no network calls whatsoever.
 */
export const AI_DM_PROVIDER = Symbol('AI_DM_PROVIDER');

export interface AiDmTurnContext {
  campaignId: number;
  kind: AiDmTurnKind;
  /** What the players just did / the situation to respond to. */
  prompt: string;
  /** The DM persona / house rules configured on the seat. */
  instructions: string;
  /** Informational model/agent label configured on the seat. */
  model: string;
  /** Upper bound on this turn's output, already clamped to the remaining budget by the caller. */
  maxTokens: number;
}

export interface AiDmProviderResult {
  /** The DM's response text. */
  narration: string;
  /** Tokens this turn consumed — metered against the per-campaign budget by AiDmService. */
  tokensUsed: number;
}

export interface AiDmProvider {
  /** Short machine-friendly name surfaced in the turn result (e.g. 'noop'). */
  readonly name: string;
  generate(ctx: AiDmTurnContext): Promise<AiDmProviderResult>;
}

/** Rough token estimate — ~4 chars/token, the usual back-of-envelope ratio. Never zero for non-empty text. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Default, dependency-free provider. It performs NO network calls and contacts NO
 * LLM vendor. Instead it returns a clearly-labelled scaffold response telling the
 * operator that no server-side model is wired up and that the seat should be driven
 * by a connected agent over MCP. It still reports a realistic token cost (estimated
 * from the prompt) so the per-campaign budget accounting is fully exercised.
 */
@Injectable()
export class NoopAiDmProvider implements AiDmProvider {
  readonly name = 'noop';

  async generate(ctx: AiDmTurnContext): Promise<AiDmProviderResult> {
    const narration =
      `[ai-dm:noop] No server-side model is configured for this ${ctx.kind} turn. ` +
      `Campfire ships no LLM dependency — connect an agent with a dm-scoped personal ` +
      `access token over MCP (or bind a custom AI_DM_PROVIDER) to have it hold the DM seat. ` +
      `Prompt received: ${JSON.stringify(ctx.prompt)}`;
    // Cost is modelled as prompt tokens plus this scaffold's own output tokens, so a
    // real per-campaign budget is drawn down deterministically for tests/operators.
    const tokensUsed = estimateTokens(ctx.prompt) + estimateTokens(narration);
    return { narration, tokensUsed };
  }
}
