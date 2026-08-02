import { expect, test } from '@playwright/test';
import { queryKeys } from '../../src/lib/query';

test.describe('Check requests query and filtering invariants (#1471)', () => {
  test('campaignCheckRequests query key is campaign-scoped', () => {
    const key = queryKeys.campaignCheckRequests(42);
    expect(key).toEqual(['campaign', 42, 'check-requests']);
  });

  test('filters pending requests to owned character IDs', () => {
    const requests = [
      { id: 101, characterId: 1, status: 'pending' },
      { id: 102, characterId: 2, status: 'pending' },
      { id: 103, characterId: 1, status: 'resolved' },
    ];
    const ownedIds = new Set([1]);

    const mine = requests.filter((r) => ownedIds.has(r.characterId) && r.status === 'pending');
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(101);
  });
});
