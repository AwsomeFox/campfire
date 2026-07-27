import {
  AI_COST_BASIS_UNKNOWN,
  estimateUsdRange,
  type AiPricingTable,
} from '@campfire/schema';
import { resolveBasisFrom } from '../../src/modules/ai-pricing/ai-pricing.service';
import { PRICING_REFERENCE, PRICING_REFERENCE_AS_OF, referencePricesFor } from '../../src/modules/ai-pricing/ai-pricing-reference';

/**
 * #1065 — a token budget is not a spending limit, and the money layer that fixes that is only
 * safe if "we cannot tell you" is the DEFAULT rather than a case someone remembered.
 *
 * These pin the direction of every fallback. A wrong dollar figure is worse than no figure —
 * a DM shown "$3.10" and billed $31 was actively misled — so every ambiguous input here must
 * resolve to `unknown`, never to a plausible-looking number.
 */

const now = '2026-07-27T00:00:00.000Z';

function table(entries: AiPricingTable['entries']): AiPricingTable {
  return { version: 1, entries, updatedAt: now, updatedBy: 'admin' };
}

const gpt4o = {
  providerType: 'openai',
  model: 'gpt-4o',
  baseUrl: '',
  inputUsdPerMTok: 2.5,
  outputUsdPerMTok: 10,
  source: 'manual' as const,
  asOf: null,
  updatedAt: now,
};

describe('AI cost basis resolution (#1065)', () => {
  it('resolves an exact provider+model match on the default endpoint', () => {
    const basis = resolveBasisFrom(table([gpt4o]), { providerType: 'openai', model: 'gpt-4o' });
    expect(basis.kind).toBe('priced');
    if (basis.kind !== 'priced') throw new Error('unreachable');
    expect(basis.inputUsdPerMTok).toBe(2.5);
    expect(basis.outputUsdPerMTok).toBe(10);
    // Echoed back so the UI can name WHICH model the figure is for, never a bare "$X".
    expect(basis.providerType).toBe('openai');
    expect(basis.model).toBe('gpt-4o');
  });

  it('is case-insensitive on the model id but never fuzzy', () => {
    expect(resolveBasisFrom(table([gpt4o]), { providerType: 'OpenAI', model: 'GPT-4o' }).kind).toBe('priced');
    // "gpt-4o" and "gpt-4o-mini" differ by ~16x. A near-miss is not a small error, so prefix
    // matching is deliberately absent — this must fall to the disclosure, not to the wrong row.
    const near = resolveBasisFrom(table([gpt4o]), { providerType: 'openai', model: 'gpt-4o-mini' });
    expect(near).toEqual({ kind: 'unknown', reason: 'model_not_priced' });
  });

  it('NEVER applies a default-endpoint price to a custom endpoint', () => {
    // The rule that earns its keep. A model NAME behind a proxy or gateway says nothing about
    // what that proxy charges, and someone pointing at a custom endpoint is MORE likely to be
    // on a negotiated or self-hosted rate. Inheriting the vendor's public price here would be
    // the confident-wrong-number failure in its purest form.
    const basis = resolveBasisFrom(table([gpt4o]), {
      providerType: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://proxy.internal/v1',
    });
    expect(basis).toEqual({ kind: 'unknown', reason: 'custom_endpoint_not_priced' });
  });

  it('prices a custom endpoint only when an entry names that endpoint', () => {
    const proxied = { ...gpt4o, baseUrl: 'https://proxy.internal/v1', inputUsdPerMTok: 0.5, outputUsdPerMTok: 1 };
    const basis = resolveBasisFrom(table([gpt4o, proxied]), {
      providerType: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://proxy.internal/v1',
    });
    expect(basis.kind).toBe('priced');
    if (basis.kind !== 'priced') throw new Error('unreachable');
    // The endpoint-specific rate, not the vendor's.
    expect(basis.inputUsdPerMTok).toBe(0.5);
  });

  it('distinguishes the three ways of not knowing, because each has a different fix', () => {
    expect(resolveBasisFrom(table([]), { providerType: 'openai', model: 'gpt-4o' })).toEqual(AI_COST_BASIS_UNKNOWN);
    expect(resolveBasisFrom(table([gpt4o]), { providerType: 'anthropic', model: 'x' })).toEqual({
      kind: 'unknown',
      reason: 'model_not_priced',
    });
    expect(resolveBasisFrom(table([gpt4o]), { providerType: null, model: null })).toEqual({
      kind: 'unknown',
      reason: 'no_provider',
    });
  });

  it('treats a half-configured provider as unpriceable, not as free', () => {
    // An empty model with a provider set is first-run setup, not a $0 model.
    expect(resolveBasisFrom(table([gpt4o]), { providerType: 'openai', model: '' }).kind).toBe('unknown');
    expect(resolveBasisFrom(table([gpt4o]), { providerType: '  ', model: 'gpt-4o' }).kind).toBe('unknown');
  });
});

describe('turning a basis into money (#1065)', () => {
  const priced = resolveBasisFrom(table([gpt4o]), { providerType: 'openai', model: 'gpt-4o' });

  it('returns null for every unpriced basis — there is no way to get a number out', () => {
    // This is the structural guarantee the whole feature rests on: `estimateUsdRange` is the
    // ONLY supported path from tokens to money, and it has no branch that produces a figure
    // without a matched price. There is deliberately no point-estimate counterpart to it —
    // an entry point taking an assumed split is an entry point for publishing a guess.
    expect(estimateUsdRange(1_000_000, AI_COST_BASIS_UNKNOWN)).toBeNull();
    expect(estimateUsdRange(1_000_000, { kind: 'unknown', reason: 'custom_endpoint_not_priced' })).toBeNull();
  });

  it('gives a budget a RANGE spanning the all-input and all-output cases', () => {
    // Nobody knows in advance how a budget splits between input and output, and on most
    // providers they differ several-fold. The top of the range is the number to budget
    // against, so collapsing this to an average would understate the answer a DM came for.
    const range = estimateUsdRange(1_000_000, priced);
    expect(range).toEqual({ low: 2.5, high: 10 });
  });

  it('orders the range low-to-high even if output were ever cheaper than input', () => {
    const inverted = resolveBasisFrom(
      table([{ ...gpt4o, inputUsdPerMTok: 9, outputUsdPerMTok: 1 }]),
      { providerType: 'openai', model: 'gpt-4o' },
    );
    expect(estimateUsdRange(1_000_000, inverted)).toEqual({ low: 1, high: 9 });
  });

  it('never returns a negative figure for nonsense input', () => {
    expect(estimateUsdRange(-1, priced)).toEqual({ low: 0, high: 0 });
  });
});

describe('the shipped reference list (#1065)', () => {
  it('carries an as-of date, which is its only honesty signal', () => {
    expect(PRICING_REFERENCE_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is not wired into resolution — it is a data-entry aid only', () => {
    // The important negative. A server with no configured pricing must show the disclosure
    // even for a model that appears in the reference list, because nobody has vouched for
    // those figures on this deployment yet.
    const inReference = PRICING_REFERENCE[0];
    const basis = resolveBasisFrom(table([]), {
      providerType: inReference.providerType,
      model: inReference.model,
    });
    expect(basis.kind).toBe('unknown');
  });

  it('quotes no prices for a provider it does not cover', () => {
    expect(referencePricesFor('mock')).toEqual([]);
    expect(referencePricesFor('openai').length).toBeGreaterThan(0);
  });
});
