import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import { createAiProvider } from '../ai-dm/providers/factory';
import { SessionZeroService } from './session-zero.service';

const SafetyClassificationSchema = z.object({
  violates: z.boolean(),
  reason: z.string().max(1000).optional(),
});

@Injectable()
export class SafetyCharterValidator {
  constructor(
    @Inject(AiProviderConfigService) private readonly providerConfig: AiProviderConfigService,
    private readonly sessionZero: SessionZeroService,
  ) {}

  async validateContent(campaignId: number, text: string): Promise<{ violates: boolean; reason?: string }> {
    if (!text || text.trim().length === 0) return { violates: false };

    const charter = await this.sessionZero.get(campaignId);
    if (charter.lines.length === 0 && charter.veils.length === 0) {
      return { violates: false };
    }

    const { config } = await this.providerConfig.resolveEffectiveConfigWithEndpointScope(campaignId);
    if (!config) {
      // If no AI is configured, we cannot programmatically evaluate safety boundaries.
      // We fail open so the table can still play, relying on human moderation.
      return { violates: false };
    }

    const provider = createAiProvider(config);
    const systemPrompt = 
      'You are a safety moderator for a tabletop roleplaying game. ' +
      "Your job is to determine if the provided text violates the table's agreed upon \"lines\" (hard limits) " +
      'or "veils" (soft limits that must fade to black).\n\n' +
      'Lines: ' + JSON.stringify(charter.lines) + '\n' +
      'Veils: ' + JSON.stringify(charter.veils) + '\n\n' +
      "Evaluate the user's text and respond with ONLY a single JSON object matching exactly:\n" +
      '{"violates": boolean, "reason": "short explanation if true"}\n\n' +
      'Return violates: true ONLY if the text clearly depicts or describes content forbidden by the lines or veils.';

    try {
      const result = await provider.generate({
        system: systemPrompt,
        messages: [{ role: 'user', content: text }],
        model: config.model,
        maxTokens: 200,
      });

      const start = result.text.indexOf('{');
      const end = result.text.lastIndexOf('}');
      if (start === -1 || end === -1 || end < start) {
        return { violates: false };
      }
      const parsed = JSON.parse(result.text.slice(start, end + 1));
      return SafetyClassificationSchema.parse(parsed);
    } catch (err) {
      // Fail open on provider errors to not block gameplay during network blips
      return { violates: false };
    }
  }
}
