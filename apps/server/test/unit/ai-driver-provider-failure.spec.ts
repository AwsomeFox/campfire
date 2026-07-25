import { resolveProviderStepUsage } from '../../src/modules/ai-driver/ai-driver.service';
import type { AiGenerateResult } from '../../src/modules/ai-dm/providers/ai-provider';

function result(partial: Partial<AiGenerateResult>): AiGenerateResult {
  return {
    text: '',
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: 'unknown',
    model: 'mock',
    ...partial,
  };
}

describe('resolveProviderStepUsage (#560)', () => {
  it('uses reported provider usage when present', () => {
    expect(resolveProviderStepUsage('', result({ usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } }))).toEqual({
      tokens: 30,
      unknown: false,
    });
  });

  it('estimates from partial text when usage is missing', () => {
    const resolved = resolveProviderStepUsage('The mist thickens around you…', undefined);
    expect(resolved.unknown).toBe(false);
    expect(resolved.tokens).toBeGreaterThan(0);
  });

  it('estimates from tool-call fragments when text is empty', () => {
    const resolved = resolveProviderStepUsage(
      '',
      result({ toolCalls: [{ id: 'c1', name: 'roll_dice', arguments: { sides: 20 } }] }),
    );
    expect(resolved.unknown).toBe(false);
    expect(resolved.tokens).toBeGreaterThan(0);
  });

  it('returns unknown instead of assuming zero when there is no output or usage', () => {
    expect(resolveProviderStepUsage('', undefined)).toEqual({ tokens: 0, unknown: true });
  });
});
