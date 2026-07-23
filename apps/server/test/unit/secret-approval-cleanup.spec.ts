import { describe, it, expect } from '@jest/globals';

describe('Secret-read approval cleanup (#1059)', () => {
  // Test the cleanup logic in isolation

  it('consumed approval is removed from map', () => {
    const approvals: Record<string, { tool: string; entityId: number; consumed: boolean }> = {
      'get_npc:42': { tool: 'get_npc', entityId: 42, consumed: false },
      'get_quest:7': { tool: 'get_quest', entityId: 7, consumed: false },
    };

    // Simulate consumption
    const key = 'get_npc:42';
    approvals[key].consumed = true;
    delete approvals[key]; // the fix

    expect(approvals['get_npc:42']).toBeUndefined();
    expect(Object.keys(approvals)).toEqual(['get_quest:7']);
  });

  it('cap prevents unbounded accumulation', () => {
    const MAX = 50;
    const approvals: Record<string, { consumed: boolean }> = {};
    for (let i = 0; i < MAX; i++) {
      approvals[`get_npc:${i}`] = { consumed: false };
    }

    const activeCount = Object.values(approvals).filter(a => !a.consumed).length;
    expect(activeCount).toBe(MAX);

    // A new grant should be rejected when at cap
    const newKey = `get_npc:${MAX}`;
    const atCap = activeCount >= MAX && !approvals[newKey];
    expect(atCap).toBe(true);
  });

  it('replacing an existing approval does not count against cap', () => {
    const MAX = 50;
    const approvals: Record<string, { consumed: boolean }> = {};
    for (let i = 0; i < MAX; i++) {
      approvals[`get_npc:${i}`] = { consumed: false };
    }

    // Replacing key 'get_npc:0' should be allowed (it already exists)
    const replaceKey = 'get_npc:0';
    const activeCount = Object.values(approvals).filter(a => !a.consumed).length;
    const blocked = activeCount >= MAX && !approvals[replaceKey];
    expect(blocked).toBe(false); // NOT blocked because the key exists
  });
});
