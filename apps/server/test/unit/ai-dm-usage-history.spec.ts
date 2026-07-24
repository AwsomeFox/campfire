import { describe, it, expect } from '@jest/globals';
import { AiDmUsageHistoryEntry, AiDmUsageHistoryResponse } from '@campfire/schema';

/**
 * #1060: Verify the AiDmUsageHistory schema shape used by the new
 * GET /campaigns/:id/ai-dm/usage-history endpoint. The service integration
 * (persistence + query) is covered by ai-dm e2e; this validates the DTO contract.
 */
describe('AiDmUsageHistory schema (#1060)', () => {
  it('parses a valid entry', () => {
    const entry = AiDmUsageHistoryEntry.parse({
      id: 1,
      campaignId: 42,
      tokensUsed: 500,
      action: 'ai-dm.driver.turn',
      model: 'gpt-4',
      actor: 'ai-dm-seat:42',
      createdAt: '2026-07-24T12:00:00.000Z',
    });
    expect(entry.id).toBe(1);
    expect(entry.tokensUsed).toBe(500);
    expect(entry.action).toBe('ai-dm.driver.turn');
  });

  it('rejects negative tokensUsed', () => {
    const result = AiDmUsageHistoryEntry.safeParse({
      id: 1,
      campaignId: 42,
      tokensUsed: -5,
      action: 'ai-dm.driver.turn',
      model: '',
      actor: '',
      createdAt: '2026-07-24T12:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('parses a full response payload with items + totalTokens + count', () => {
    const response = AiDmUsageHistoryResponse.parse({
      items: [
        {
          id: 2,
          campaignId: 42,
          tokensUsed: 300,
          action: 'ai-dm.driver.turn',
          model: 'gpt-4',
          actor: 'ai-dm-seat:42',
          createdAt: '2026-07-24T12:01:00.000Z',
        },
        {
          id: 1,
          campaignId: 42,
          tokensUsed: 500,
          action: 'ai-dm.driver.turn',
          model: 'gpt-4',
          actor: 'ai-dm-seat:42',
          createdAt: '2026-07-24T12:00:00.000Z',
        },
      ],
      totalTokens: 800,
      count: 2,
    });
    expect(response.count).toBe(2);
    expect(response.totalTokens).toBe(800);
    expect(response.items).toHaveLength(2);
  });

  it('handles an empty history (no turns yet)', () => {
    const response = AiDmUsageHistoryResponse.parse({
      items: [],
      totalTokens: 0,
      count: 0,
    });
    expect(response.items).toHaveLength(0);
    expect(response.totalTokens).toBe(0);
  });

  it('rejects malformed actor/model types', () => {
    const bad = AiDmUsageHistoryEntry.safeParse({
      id: 1,
      campaignId: 42,
      tokensUsed: 100,
      action: 'x',
      model: 42, // not a string
      actor: '',
      createdAt: '2026-07-24T12:00:00.000Z',
    });
    expect(bad.success).toBe(false);
  });
});
