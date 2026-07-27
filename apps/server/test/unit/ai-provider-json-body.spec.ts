import { describe, it, expect } from '@jest/globals';
import { readJsonBody, postAndReadJson, DEFAULT_RETRY } from '../../src/modules/ai-dm/providers/http';
import { AiProviderError } from '../../src/modules/ai-dm/providers/errors';
import { OpenAiProvider } from '../../src/modules/ai-dm/providers/openai-provider';
import { AnthropicProvider } from '../../src/modules/ai-dm/providers/anthropic-provider';
import { GeminiProvider } from '../../src/modules/ai-dm/providers/gemini-provider';
import { OpenAiImageProvider } from '../../src/modules/ai-dm/providers/openai-image-provider';
import type { AiGenerateRequest } from '../../src/modules/ai-dm/providers/ai-provider';
import { jsonResponse, nonJsonResponse, bodyReadFailureResponse, fakeFetch, sequenceFetch } from './ai-provider-fixtures';

/**
 * Issue #1602 — no native error escapes an adapter through a response body read.
 *
 * Before this fix every non-streaming adapter path called `await res.json()` bare, so an
 * upstream that answered 200 with an HTML error page (a proxy's interception page, an
 * empty body, a truncated payload) raised a native `SyntaxError` that flew straight past
 * the taxonomy. Downstream it was re-wrapped as `unknown` — the give-up bucket — so the
 * turn died with "Unexpected token '<'" instead of a classified provider failure.
 *
 * The fix routes every body read through `readJsonBody`, which splits the two failures
 * `res.json()` conflates:
 *   - the body never finished arriving  → `transport`, retryable;
 *   - the body arrived and is not JSON  → `invalid_response`, deliberately NOT retryable,
 *     because re-requesting bytes that cannot parse just burns the table's token budget.
 *
 * These tests fail against the unfixed code by rejecting with a bare `SyntaxError`.
 */

const req: AiGenerateRequest = {
  messages: [{ role: 'user', content: 'The party opens the door.' }],
  model: 'test-model',
};

/** The shape a reverse proxy or captive gateway substitutes for the real body. */
const HTML_BODY = '<!doctype html>\n<html><head><title>502 Bad Gateway</title></head><body><h1>502</h1></body></html>';

/** Assert a rejection is the typed, deterministic classification — never a native error. */
async function expectInvalidResponse(p: Promise<unknown>): Promise<AiProviderError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AiProviderError);
  const typed = err as AiProviderError;
  expect(typed.kind).toBe('invalid_response');
  expect(typed.retryable).toBe(false);
  return typed;
}

describe('readJsonBody — unparseable bodies are deterministic (#1602)', () => {
  it('classifies an HTML error page served with a 200 as invalid_response', async () => {
    const typed = await expectInvalidResponse(readJsonBody(nonJsonResponse(HTML_BODY, 200, { 'content-type': 'text/html' }), 'openai'));
    expect(typed.provider).toBe('openai');
    expect(typed.status).toBe(200);
    expect(typed.cause).toBeInstanceOf(SyntaxError);
  });

  it('classifies an empty body as invalid_response rather than letting JSON.parse("") escape', async () => {
    const typed = await expectInvalidResponse(readJsonBody(nonJsonResponse(''), 'anthropic'));
    expect(typed.message).toContain('0 bytes');
  });

  it('classifies a truncated JSON payload as invalid_response', async () => {
    const typed = await expectInvalidResponse(readJsonBody(nonJsonResponse('{"choices":[{"message":{"content":"half a se'), 'openai'));
    expect(typed.message).toContain('not valid JSON');
  });

  it('keeps the upstream body OUT of the message and BOUNDED in rawBody', async () => {
    // The message reaches the whole table verbatim as `turn.error.message`, and the log
    // line is written per failure — neither may carry an unbounded upstream body.
    const huge = `<html>${'x'.repeat(50_000)}</html>`;
    const typed = await expectInvalidResponse(readJsonBody(nonJsonResponse(huge), 'openai'));
    expect(typed.message).not.toContain('xxxx');
    expect(typed.rawBody?.length).toBeLessThanOrEqual(1001); // 1000 chars + the ellipsis
    expect(typed.rawBody?.endsWith('…')).toBe(true);
  });
});

describe('readJsonBody — an incomplete transfer stays retryable (#1602)', () => {
  it('classifies a body read that rejects as transport, not as a parse failure', async () => {
    // undici raises a TypeError here; other runtimes raise something else. We classify on
    // WHERE the failure happened (the socket read), never on the native error's type.
    const err = await readJsonBody(bodyReadFailureResponse(new TypeError('terminated')), 'openai').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).kind).toBe('transport');
    expect((err as AiProviderError).retryable).toBe(true);
  });

  it('propagates a typed error raised by the guarded fetch layer without re-wrapping it', async () => {
    const guard = new AiProviderError('auth', 'ai: outbound URL blocked by server policy', { retryable: false });
    await expect(readJsonBody(bodyReadFailureResponse(guard), 'openai')).rejects.toBe(guard);
  });
});

describe('postAndReadJson — the retry gate sorts the two failures (#1602)', () => {
  const opts = { provider: 'openai', timeoutMs: 1000, retry: DEFAULT_RETRY, sleep: async () => {}, rand: () => 0 };

  it('retries a body that died mid-read and succeeds on a later attempt', async () => {
    const { fetchImpl, calls } = sequenceFetch([bodyReadFailureResponse(), jsonResponse({ ok: true })]);
    await expect(postAndReadJson(fetchImpl, 'https://api.test/v1/chat', {}, {}, opts)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a well-formed HTTP response whose body is not JSON', async () => {
    const { fetchImpl, calls } = fakeFetch(nonJsonResponse(HTML_BODY));
    await expectInvalidResponse(postAndReadJson(fetchImpl, 'https://api.test/v1/chat', {}, {}, opts));
    expect(calls).toHaveLength(1); // re-requesting garbage would just spend the token budget
  });
});

describe('adapters surface invalid_response instead of a native SyntaxError (#1602)', () => {
  it('OpenAiProvider.generate', async () => {
    const { fetchImpl } = fakeFetch(nonJsonResponse(HTML_BODY));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl, retry: { ...DEFAULT_RETRY, maxRetries: 0 } });
    await expectInvalidResponse(p.generate(req));
  });

  it('OpenAiProvider.listModels', async () => {
    const { fetchImpl } = fakeFetch(nonJsonResponse(''));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await expectInvalidResponse(p.listModels());
  });

  it('AnthropicProvider.generate', async () => {
    const { fetchImpl } = fakeFetch(nonJsonResponse(HTML_BODY));
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl, retry: { ...DEFAULT_RETRY, maxRetries: 0 } });
    await expectInvalidResponse(p.generate(req));
  });

  it('GeminiProvider.generate', async () => {
    const { fetchImpl } = fakeFetch(nonJsonResponse('{"candidates":[{"content":'));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl, retry: { ...DEFAULT_RETRY, maxRetries: 0 } });
    await expectInvalidResponse(p.generate(req));
  });

  it('GeminiProvider.listModels', async () => {
    const { fetchImpl } = fakeFetch(nonJsonResponse(HTML_BODY));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await expectInvalidResponse(p.listModels());
  });

  it('OpenAiImageProvider.generateImage', async () => {
    const { fetchImpl } = fakeFetch(nonJsonResponse(HTML_BODY));
    const p = new OpenAiImageProvider({ apiKey: 'k', model: 'm', fetchImpl, retry: { ...DEFAULT_RETRY, maxRetries: 0 } });
    await expectInvalidResponse(p.generateImage({ prompt: 'x', n: 1, width: 256, height: 256, model: 'm' }));
  });
});
