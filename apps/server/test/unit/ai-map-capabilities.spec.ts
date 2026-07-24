import { describe, it, expect } from '@jest/globals';
import { providerCapabilities, supportsImageGeneration } from '../../src/modules/ai-dm/providers/capabilities';
import { createAiImageProvider } from '../../src/modules/ai-dm/providers/factory';
import { OpenAiImageProvider } from '../../src/modules/ai-dm/providers/openai-image-provider';
import { AiProviderError } from '../../src/modules/ai-dm/providers/errors';

/**
 * Provider CAPABILITIES model (issue #410). Pins the honest routing contract: only the
 * OpenAI-compatible family advertises image generation, so a text-only provider (Anthropic)
 * is never asked to draw — it degrades to the procedural-blueprint fallback.
 */
describe('providerCapabilities (#410)', () => {
  it('declares OpenAI as text + toolCalling + imageGeneration + imageEditing', () => {
    expect(providerCapabilities('openai')).toEqual({
      text: true,
      toolCalling: true,
      imageGeneration: true,
      imageEditing: true,
    });
  });

  it('declares Anthropic as text-only for images (no imageGeneration)', () => {
    const caps = providerCapabilities('anthropic');
    expect(caps.text).toBe(true);
    expect(caps.toolCalling).toBe(true);
    expect(caps.imageGeneration).toBe(false);
  });

  it('declares gemini and mock without image generation', () => {
    expect(supportsImageGeneration('gemini')).toBe(false);
    expect(supportsImageGeneration('mock')).toBe(false);
  });

  it('supportsImageGeneration is true only for openai', () => {
    expect(supportsImageGeneration('openai')).toBe(true);
    expect(supportsImageGeneration('anthropic')).toBe(false);
    expect(supportsImageGeneration('custom')).toBe(false);
  });
});

describe('createAiImageProvider (#410)', () => {
  it('builds an OpenAI image provider for an image-capable config', () => {
    const provider = createAiImageProvider(
      { providerType: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test', fetchImpl: async () => ({} as never) },
      'gpt-image-1',
    );
    expect(provider).toBeInstanceOf(OpenAiImageProvider);
    expect(provider.providerType).toBe('openai');
  });

  it('refuses to build an image provider for a text-only provider (routes to fallback)', () => {
    expect(() =>
      createAiImageProvider({ providerType: 'anthropic', model: 'claude', apiKey: 'sk' }),
    ).toThrow(AiProviderError);
  });

  it('requires an API key for the openai image provider', () => {
    expect(() => createAiImageProvider({ providerType: 'openai', model: 'gpt-image-1' })).toThrow(AiProviderError);
  });
});
