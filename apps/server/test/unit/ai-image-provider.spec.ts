import { describe, it, expect } from '@jest/globals';
import { OpenAiImageProvider } from '../../src/modules/ai-dm/providers/openai-image-provider';
import { MockImageProvider } from '../../src/modules/ai-dm/providers/mock-image-provider';
import { AiProviderError } from '../../src/modules/ai-dm/providers/errors';
import { jsonResponse, errorResponse, fakeFetch } from './ai-provider-fixtures';

/** A 1×1 PNG the fake image endpoint returns as base64. */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function sentBody(init: { body?: string }): Record<string, unknown> {
  return init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
}

/**
 * OpenAI-compatible IMAGE adapter (#410). Driven against recorded fixtures via an injected
 * fake fetch — never the network. Covers request mapping (prompt/size/n/model + auth),
 * base64 decoding to real bytes, and error classification.
 */
describe('OpenAiImageProvider (#410)', () => {
  it('POSTs /images/generations with prompt, size, n, and configured auth/endpoint', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse({ data: [{ b64_json: TINY_PNG_B64 }], usage: { total_tokens: 3 } }));
    const p = new OpenAiImageProvider({ apiKey: 'sk-img', baseUrl: 'https://proxy.local/v1', model: 'gpt-image-1', fetchImpl });
    const res = await p.generateImage({ prompt: 'a dungeon', n: 1, width: 512, height: 512, model: 'gpt-image-1' });

    expect(calls[0].url).toBe('https://proxy.local/v1/images/generations');
    expect(calls[0].init.headers.authorization).toBe('Bearer sk-img');
    const body = sentBody(calls[0].init);
    expect(body.prompt).toBe('a dungeon');
    expect(body.size).toBe('512x512');
    expect(body.n).toBe(1);
    expect(body.response_format).toBe('b64_json');

    expect(res.images).toHaveLength(1);
    expect(res.images[0].mime).toBe('image/png');
    expect(res.images[0].bytes.length).toBeGreaterThan(0);
    expect(res.usage.imageCount).toBe(1);
    expect(res.usage.tokensUsed).toBe(3);
  });

  it('throws when the provider returns no image data', async () => {
    const { fetchImpl } = fakeFetch(jsonResponse({ data: [] }));
    const p = new OpenAiImageProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await expect(p.generateImage({ prompt: 'x', n: 1, width: 256, height: 256, model: 'm' })).rejects.toBeInstanceOf(
      AiProviderError,
    );
  });

  it('classifies a 401 as an auth error', async () => {
    const { fetchImpl } = fakeFetch(errorResponse(401, 'unauthorized'));
    const p = new OpenAiImageProvider({ apiKey: 'bad', model: 'm', fetchImpl });
    await expect(p.generateImage({ prompt: 'x', n: 1, width: 256, height: 256, model: 'm' })).rejects.toMatchObject({
      kind: 'auth',
    });
  });
});

describe('MockImageProvider (#410)', () => {
  it('returns n real PNG images and records the request', async () => {
    const mock = new MockImageProvider();
    const res = await mock.generateImage({ prompt: 'brief', n: 3, width: 640, height: 480, model: 'x' });
    expect(res.images).toHaveLength(3);
    expect(res.images.every((i) => i.mime === 'image/png' && i.bytes.length > 0)).toBe(true);
    expect(mock.received[0]).toMatchObject({ prompt: 'brief', n: 3, width: 640, height: 480 });
  });

  it('throws the configured error to drive fallback tests', async () => {
    const mock = new MockImageProvider({ throwError: new Error('boom') });
    await expect(mock.generateImage({ prompt: 'x', n: 1, width: 256, height: 256, model: 'x' })).rejects.toThrow('boom');
  });
});
