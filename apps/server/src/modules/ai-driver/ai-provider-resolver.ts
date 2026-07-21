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
}
