import { Injectable } from '@nestjs/common';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import { createAiProvider } from '../ai-dm/providers';
import type { AiProvider } from '../ai-dm/providers/ai-provider';

/**
 * DI seam that hands the driver runtime (#312) a live, streaming `AiProvider`
 * (#309) for a campaign. This is the single wire that joins the three AI
 * foundations end-to-end:
 *
 *   resolveEffectiveConfig(campaignId)   (#310, decrypts the stored key in-process)
 *        → createAiProvider(config)      (#309, vendor-neutral factory)
 *        → provider.stream(...)          (#309, token-by-token + tool calls)
 *
 * It is a separate token from the legacy `AI_DM_PROVIDER` (text-in/text-out) seam
 * because the driver needs the STREAMING + structured-tool-call shape that the old
 * bridge deliberately flattens. Tests override this token with a resolver that
 * returns the deterministic MockAiProvider so the whole loop runs offline (#318).
 */
export const AI_PROVIDER_RESOLVER = Symbol('AI_PROVIDER_RESOLVER');

export interface AiProviderResolver {
  /** The provider for this campaign, or null when no provider is configured (server or campaign scope). */
  resolve(campaignId: number): Promise<AiProvider | null>;
  /**
   * Resolve the provider AND the executable model for a turn, revalidating the model
   * against the server admin's allowlist at EXECUTION time (issue #564). The returned
   * `model` is what the caller MUST send to the provider — it derives ONLY from the
   * effective provider config, never from the legacy `seat.model`. Throws
   * `BadRequestException` when the resolved model is not on the (non-empty) allowlist.
   * Returns `null` when no provider is configured.
   */
  resolveForExecution(campaignId: number): Promise<{ provider: AiProvider; model: string } | null>;
}

/**
 * Default resolver: pull the effective (decrypted) provider config for the campaign
 * from #310's store and build the provider through #309's factory. Never caches the
 * decrypted key — resolveEffectiveConfig materializes it per call and it lives only
 * as long as the returned provider instance.
 */
@Injectable()
export class ConfigAiProviderResolver implements AiProviderResolver {
  constructor(private readonly config: AiProviderConfigService) {}

  async resolve(campaignId: number): Promise<AiProvider | null> {
    const effective = await this.config.resolveEffectiveConfig(campaignId);
    if (!effective) return null;
    return createAiProvider(effective);
  }

  async resolveForExecution(campaignId: number): Promise<{ provider: AiProvider; model: string } | null> {
    // resolveExecutionModel is the single execution-time choke point: it revalidates the
    // resolved model against the admin allowlist (issue #564) and returns the SAME
    // decrypted config the model was validated against, so the provider we build here
    // cannot diverge from the policy decision.
    const resolved = await this.config.resolveExecutionModel(campaignId);
    if (!resolved) return null;
    return { provider: createAiProvider(resolved.config), model: resolved.model };
  }
}

/** A resolver result used by tests that override AI_PROVIDER_RESOLVER with a canned provider. */
export type ResolvedExecution = { provider: AiProvider; model: string };

/**
 * Test helper: invoke whichever resolve method a (possibly test-overridden) resolver
 * exposes. Production resolvers implement `resolveForExecution`; the offline eval
 * harness binds a plain `{ resolve }` shim, so fall back to `resolve` + the mock's own
 * model label when the execution-aware method is absent (the mock already echoes a
 * deterministic model and there is no real allowlist in evals).
 */
export async function resolveProviderForExecution(
  resolver: AiProviderResolver,
  campaignId: number,
): Promise<ResolvedExecution | null> {
  if (resolver.resolveForExecution) {
    return resolver.resolveForExecution(campaignId);
  }
  const provider = await resolver.resolve(campaignId);
  if (!provider) return null;
  // Mock/test providers carry their own informational model label; real resolvers go
  // through resolveForExecution above, so this branch only runs in the offline harness.
  const model = (provider as { model?: string }).model ?? '';
  return { provider, model };
}
