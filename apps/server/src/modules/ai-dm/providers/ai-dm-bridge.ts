/**
 * Bridge from the generic `AiProvider` (#309) to the existing `AiDmProvider` DI seam
 * (ai-dm.provider.ts). This is the plug point for #312: bind an `AiDmProvider` that wraps
 * a real `AiProvider` (built by `createAiProvider`) and the whole metering/gating/audit
 * path in `AiDmService` runs unchanged — no reshaping of either interface.
 *
 * The mapping is deliberately minimal (it does NOT run a tool loop — that's the driver
 * runtime's job in #312): it assembles a single system+user turn, forwards it, and reports
 * the provider's REAL total-token usage in place of the old `estimateTokens`. Tool calls,
 * if the model issues any, are appended to the narration as a human-readable note so the
 * existing text-only `AiDmProviderResult` stays honest until the driver runtime consumes
 * them structurally.
 */

import type { AiDmProvider, AiDmProviderResult, AiDmTurnContext } from '../ai-dm.provider';
import type { AiProvider, AiToolSchema } from './ai-provider';

export interface ProviderBackedAiDmOptions {
  /** Tools to offer the model each turn (from the MCP registry, mapped via tool-registry.ts). */
  tools?: AiToolSchema[];
  /** Sampling temperature applied to every turn. */
  temperature?: number;
}

export class ProviderBackedAiDmProvider implements AiDmProvider {
  readonly name: string;

  constructor(
    private readonly provider: AiProvider,
    private readonly options: ProviderBackedAiDmOptions = {},
  ) {
    this.name = provider.name;
  }

  async generate(ctx: AiDmTurnContext): Promise<AiDmProviderResult> {
    const result = await this.provider.generate({
      system: ctx.instructions || undefined,
      messages: [{ role: 'user', content: ctx.prompt }],
      model: ctx.model,
      maxTokens: ctx.maxTokens,
      temperature: this.options.temperature,
      tools: this.options.tools,
      toolChoice: this.options.tools && this.options.tools.length > 0 ? 'auto' : undefined,
    });

    let narration = result.text;
    if (result.toolCalls.length > 0) {
      const note = result.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`).join(', ');
      narration = narration ? `${narration}\n\n[tool calls: ${note}]` : `[tool calls: ${note}]`;
    }
    // Real usage from the provider replaces the old estimate. `totalTokens` is what the
    // per-campaign budget meters against.
    return { narration, tokensUsed: result.usage.totalTokens };
  }
}
