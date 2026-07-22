import { createAiProvider } from '../../src/modules/ai-dm/providers/factory';
import { OpenAiProvider } from '../../src/modules/ai-dm/providers/openai-provider';
import { AnthropicProvider } from '../../src/modules/ai-dm/providers/anthropic-provider';
import { MockAiProvider } from '../../src/modules/ai-dm/providers/mock-provider';
import { AiProviderError, classifyHttpStatus, getHttpStatusText, parseRetryAfterMs } from '../../src/modules/ai-dm/providers/errors';
import { parseSse, backoffDelayMs, DEFAULT_RETRY } from '../../src/modules/ai-dm/providers/http';
import {
  mcpToolsToAiSchemas,
  aiToolCallsToMcpInvocations,
  aiToolCallToMcpInvocation,
} from '../../src/modules/ai-dm/providers/tool-registry';
import { ProviderBackedAiDmProvider } from '../../src/modules/ai-dm/providers/ai-dm-bridge';
import { sseStream } from './ai-provider-fixtures';

/**
 * Cross-cutting provider-layer tests (#309): the config-driven factory, the error taxonomy,
 * backoff/SSE plumbing, MCP tool normalization (one registry → neutral schemas → MCP
 * invocations), and the bridge onto the existing AiDmProvider seam (real usage replaces the
 * old estimate).
 */

describe('createAiProvider — config-driven selection', () => {
  it('builds an OpenAiProvider for providerType openai', () => {
    const p = createAiProvider({ providerType: 'openai', model: 'gpt-4o-mini', apiKey: 'k', baseUrl: 'https://x/v1' });
    expect(p).toBeInstanceOf(OpenAiProvider);
    expect(p.providerType).toBe('openai');
  });

  it('builds an AnthropicProvider for providerType anthropic', () => {
    const p = createAiProvider({ providerType: 'anthropic', model: 'claude-3-5-sonnet', apiKey: 'k' });
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  it('builds a MockAiProvider for providerType mock (no key needed)', () => {
    const p = createAiProvider({ providerType: 'mock', model: 'm' });
    expect(p).toBeInstanceOf(MockAiProvider);
  });

  it('throws a typed auth error when a real provider has no API key', () => {
    expect(() => createAiProvider({ providerType: 'openai', model: 'm' })).toThrow(AiProviderError);
    try {
      createAiProvider({ providerType: 'anthropic', model: 'm' });
    } catch (e) {
      expect((e as AiProviderError).kind).toBe('auth');
    }
  });

  it('refuses to build noop/custom (they bind via the DI seam)', () => {
    expect(() => createAiProvider({ providerType: 'custom', model: 'm' })).toThrow(/AI_DM_PROVIDER/);
    expect(() => createAiProvider({ providerType: 'noop', model: 'm' })).toThrow(AiProviderError);
  });
});

describe('error taxonomy', () => {
  it('classifies HTTP statuses into kinds', () => {
    expect(classifyHttpStatus(401)).toBe('auth');
    expect(classifyHttpStatus(403)).toBe('auth');
    expect(classifyHttpStatus(429)).toBe('rate_limit');
    expect(classifyHttpStatus(500)).toBe('server');
    expect(classifyHttpStatus(400, 'invalid model')).toBe('invalid_request');
    expect(classifyHttpStatus(400, 'maximum context length exceeded')).toBe('context_length');
    expect(classifyHttpStatus(400, 'prompt is too long')).toBe('context_length');
  });

  it('maps HTTP status codes to standard human-readable descriptions', () => {
    expect(getHttpStatusText(401)).toBe('unauthorized');
    expect(getHttpStatusText(500)).toBe('internal server error');
    expect(getHttpStatusText(403)).toBe('forbidden');
    expect(getHttpStatusText(429)).toBe('too many requests');
    expect(getHttpStatusText(400)).toBe('bad request');
  });

  it('defaults retryable from the kind and supports rawBody', () => {
    const err = new AiProviderError('rate_limit', 'x', { rawBody: 'raw error' });
    expect(err.retryable).toBe(true);
    expect(err.rawBody).toBe('raw error');
    expect(new AiProviderError('server', 'x').retryable).toBe(true);
    expect(new AiProviderError('auth', 'x').retryable).toBe(false);
    expect(new AiProviderError('context_length', 'x').retryable).toBe(false);
  });

  it('parses Retry-After seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('garbage')).toBeUndefined();
  });
});

describe('backoff', () => {
  it('grows exponentially and respects the retry-after hint / max ceiling', () => {
    const cfg = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 };
    const noJitter = () => 1; // pin jitter to the top of the range
    expect(backoffDelayMs(0, cfg, undefined, noJitter)).toBe(100);
    expect(backoffDelayMs(1, cfg, undefined, noJitter)).toBe(200);
    expect(backoffDelayMs(4, cfg, undefined, noJitter)).toBe(1000); // capped
    expect(backoffDelayMs(0, cfg, 250)).toBe(250); // retry-after wins
    expect(backoffDelayMs(0, cfg, 5000)).toBe(1000); // retry-after still capped
  });
});

describe('parseSse', () => {
  it('parses multi-line data and event fields across split byte chunks', async () => {
    const frames = ['event: a\ndata: {"x":1}\n\n', 'data: line1\nda', 'ta: line2\n\n', ': heartbeat\n\ndata: [DONE]\n\n'];
    const out: { event: string | null; data: string }[] = [];
    for await (const rec of parseSse(sseStream(frames))) out.push(rec);
    expect(out[0]).toEqual({ event: 'a', data: '{"x":1}' });
    expect(out[1]).toEqual({ event: null, data: 'line1\nline2' });
    expect(out[2]).toEqual({ event: null, data: '[DONE]' });
  });
});

describe('MCP tool normalization', () => {
  const tools = [
    { name: 'roll_dice', description: 'Roll dice', inputSchema: { type: 'object', properties: { sides: { type: 'number' } } } },
    { name: 'set_scene', description: 'Set the scene', inputSchema: { properties: { text: { type: 'string' } } } },
  ];

  it('maps MCP tools to neutral AiToolSchema and guarantees a type:object root', () => {
    const schemas = mcpToolsToAiSchemas(tools);
    expect(schemas[0]).toEqual({ name: 'roll_dice', description: 'Roll dice', parameters: { type: 'object', properties: { sides: { type: 'number' } } } });
    // set_scene's schema lacked a root `type` — normalized in.
    expect(schemas[1].parameters).toEqual({ type: 'object', properties: { text: { type: 'string' } } });
  });

  it('maps tool calls back to MCP invocations, dropping calls outside the registry', () => {
    const calls = [
      { id: 'c1', name: 'roll_dice', arguments: { sides: 20 } },
      { id: 'c2', name: 'hallucinated_tool', arguments: {} },
    ];
    const invocations = aiToolCallsToMcpInvocations(calls, tools);
    expect(invocations).toEqual([{ callId: 'c1', name: 'roll_dice', arguments: { sides: 20 } }]);
  });

  it('single-call mapping validates against an allow-set', () => {
    expect(aiToolCallToMcpInvocation({ id: 'c', name: 'x', arguments: {} }, new Set(['x']))).toEqual({ callId: 'c', name: 'x', arguments: {} });
    expect(aiToolCallToMcpInvocation({ id: 'c', name: 'y', arguments: {} }, new Set(['x']))).toBeUndefined();
  });
});

describe('ProviderBackedAiDmProvider — bridge onto the existing seam', () => {
  it('forwards instructions as system + prompt as a user message and reports REAL total usage', async () => {
    const mock = new MockAiProvider({ responses: [{ text: 'Narration.', usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 } }] });
    const bridge = new ProviderBackedAiDmProvider(mock);
    const result = await bridge.generate({ campaignId: 1, kind: 'narrate', prompt: 'players act', instructions: 'be terse', model: 'm', maxTokens: 100 });

    expect(result.narration).toBe('Narration.');
    expect(result.tokensUsed).toBe(50); // real usage, not an estimate
    expect(bridge.name).toBe('mock');
    expect(mock.received[0].system).toBe('be terse');
    expect(mock.received[0].messages).toEqual([{ role: 'user', content: 'players act' }]);
    expect(mock.received[0].maxTokens).toBe(100);
  });

  it('appends a readable note when the model issues tool calls', async () => {
    const mock = new MockAiProvider({ responses: [{ text: 'Rolling.', toolCalls: [{ id: 'c1', name: 'roll_dice', arguments: { sides: 20 } }] }] });
    const bridge = new ProviderBackedAiDmProvider(mock);
    const result = await bridge.generate({ campaignId: 1, kind: 'combat', prompt: 'attack', instructions: '', model: 'm', maxTokens: 50 });
    expect(result.narration).toContain('Rolling.');
    expect(result.narration).toContain('[tool calls: roll_dice({"sides":20})]');
  });
});

describe('DEFAULT_RETRY sanity', () => {
  it('exposes a bounded default retry policy', () => {
    expect(DEFAULT_RETRY.maxRetries).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_RETRY.maxDelayMs).toBeGreaterThan(DEFAULT_RETRY.baseDelayMs);
  });
});
