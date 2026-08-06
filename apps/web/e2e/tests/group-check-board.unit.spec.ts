import { expect, test } from '@playwright/test';
import type { CheckRequest, DiceRoll } from '@campfire/schema';
import { buildGroupCheckSummaries, groupCheckMajoritySucceeds } from '../../src/features/encounters/groupCheckBoard';

/** Minimal-but-complete CheckRequest fixture — only the fields the reducer reads vary per call. */
function mkReq(overrides: Partial<CheckRequest> & { id: number; characterId: number }): CheckRequest {
  return {
    campaignId: 1,
    characterName: `Character ${overrides.characterId}`,
    encounterId: null,
    checkId: 'save:DEX',
    checkLabel: 'DEX save',
    mode: 'normal',
    dc: 12,
    consequence: null,
    status: 'pending',
    requestedByUserId: 'dev:dm-1',
    requestedByName: 'DM',
    rollId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    groupId: null,
    ...overrides,
  };
}

/** Minimal-but-complete DiceRoll fixture. */
function mkRoll(overrides: Partial<DiceRoll> & { id: number }): DiceRoll {
  return {
    campaignId: 1,
    rollerUserId: 'dev:player-1',
    rollerName: 'Player',
    createdAt: '2026-01-01T00:00:01.000Z',
    expr: '1d20+3',
    rolls: [15],
    total: 18,
    dc: 12,
    success: true,
    ...overrides,
  };
}

test.describe('group check board reducer (#1943)', () => {
  test('groups rows sharing a groupId; rows with a null groupId (pre-existing history) are excluded', () => {
    const requests = [
      mkReq({ id: 1, characterId: 10, groupId: 'g1', status: 'resolved', rollId: 100 }),
      mkReq({ id: 2, characterId: 11, groupId: 'g1', status: 'pending' }),
      mkReq({ id: 3, characterId: 12, groupId: null }), // pre-#1943 legacy row
    ];
    const rolls = [mkRoll({ id: 100, success: true })];

    const summaries = buildGroupCheckSummaries(requests, rolls);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].groupId).toBe('g1');
    expect(summaries[0].totalCount).toBe(2);
    expect(summaries[0].members.map((m) => m.characterId)).toEqual([10, 11]);
  });

  test('distinct submits produce distinct groups, most recently created first', () => {
    const requests = [
      mkReq({ id: 1, characterId: 10, groupId: 'g-old' }),
      mkReq({ id: 2, characterId: 11, groupId: 'g-old' }),
      mkReq({ id: 3, characterId: 10, groupId: 'g-new' }),
    ];
    const summaries = buildGroupCheckSummaries(requests, []);
    expect(summaries.map((s) => s.groupId)).toEqual(['g-new', 'g-old']);
  });

  test('single-target submit still produces a (size-1) group', () => {
    const requests = [mkReq({ id: 1, characterId: 10, groupId: 'g1' })];
    const summaries = buildGroupCheckSummaries(requests, []);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].totalCount).toBe(1);
  });

  test('pending -> resolved transition updates status and, once a matching roll is present, success', () => {
    const pendingReq = mkReq({ id: 1, characterId: 10, groupId: 'g1', status: 'pending' });
    const before = buildGroupCheckSummaries([pendingReq], []);
    expect(before[0].members[0].status).toBe('pending');
    expect(before[0].members[0].success).toBeNull();
    expect(before[0].resolvedCount).toBe(0);

    const resolvedReq = { ...pendingReq, status: 'resolved' as const, rollId: 200 };
    const roll = mkRoll({ id: 200, success: false });
    const after = buildGroupCheckSummaries([resolvedReq], [roll]);
    expect(after[0].members[0].status).toBe('resolved');
    expect(after[0].members[0].success).toBe(false);
    expect(after[0].resolvedCount).toBe(1);
    expect(after[0].passCount).toBe(0);
  });

  test('a resolved row whose roll fell out of the fetched window reports success: null, not a guess', () => {
    const req = mkReq({ id: 1, characterId: 10, groupId: 'g1', status: 'resolved', rollId: 999 });
    const summaries = buildGroupCheckSummaries([req], [] /* roll not in this page */);
    expect(summaries[0].members[0].status).toBe('resolved');
    expect(summaries[0].members[0].success).toBeNull();
  });

  test('X/N math: passCount counts only successful resolved rows, resolvedCount counts all resolved rows', () => {
    const requests = [
      mkReq({ id: 1, characterId: 10, groupId: 'g1', status: 'resolved', rollId: 100 }),
      mkReq({ id: 2, characterId: 11, groupId: 'g1', status: 'resolved', rollId: 101 }),
      mkReq({ id: 3, characterId: 12, groupId: 'g1', status: 'resolved', rollId: 102 }),
      mkReq({ id: 4, characterId: 13, groupId: 'g1', status: 'pending' }),
      mkReq({ id: 5, characterId: 14, groupId: 'g1', status: 'pending' }),
    ];
    const rolls = [
      mkRoll({ id: 100, success: true }),
      mkRoll({ id: 101, success: true }),
      mkRoll({ id: 102, success: false }),
    ];
    const summaries = buildGroupCheckSummaries(requests, rolls);
    expect(summaries[0].totalCount).toBe(5);
    expect(summaries[0].resolvedCount).toBe(3);
    expect(summaries[0].passCount).toBe(2);
  });

  test('majority advisory: renders only once fully resolved, at least half passed, AND the adapter opts in', () => {
    const requests = [
      mkReq({ id: 1, characterId: 10, groupId: 'g1', status: 'resolved', rollId: 100 }),
      mkReq({ id: 2, characterId: 11, groupId: 'g1', status: 'resolved', rollId: 101 }),
      mkReq({ id: 3, characterId: 12, groupId: 'g1', status: 'resolved', rollId: 102 }),
    ];
    const rolls = [
      mkRoll({ id: 100, success: true }),
      mkRoll({ id: 101, success: true }),
      mkRoll({ id: 102, success: false }),
    ];
    const summary = buildGroupCheckSummaries(requests, rolls)[0];

    // 2 of 3 passed (>= half) but the adapter does not declare the convention (e.g. PF2e/OSR).
    expect(groupCheckMajoritySucceeds(summary, false)).toBe(false);
    // Same tally, adapter opts in (5e).
    expect(groupCheckMajoritySucceeds(summary, true)).toBe(true);
  });

  test('majority advisory never renders before every member has resolved, even with adapter opt-in', () => {
    const requests = [
      mkReq({ id: 1, characterId: 10, groupId: 'g1', status: 'resolved', rollId: 100 }),
      mkReq({ id: 2, characterId: 11, groupId: 'g1', status: 'pending' }),
    ];
    const summary = buildGroupCheckSummaries(requests, [mkRoll({ id: 100, success: true })])[0];
    expect(groupCheckMajoritySucceeds(summary, true)).toBe(false);
  });

  test('majority advisory is false when fewer than half passed', () => {
    const requests = [
      mkReq({ id: 1, characterId: 10, groupId: 'g1', status: 'resolved', rollId: 100 }),
      mkReq({ id: 2, characterId: 11, groupId: 'g1', status: 'resolved', rollId: 101 }),
      mkReq({ id: 3, characterId: 12, groupId: 'g1', status: 'resolved', rollId: 102 }),
    ];
    const rolls = [
      mkRoll({ id: 100, success: false }),
      mkRoll({ id: 101, success: false }),
      mkRoll({ id: 102, success: true }),
    ];
    const summary = buildGroupCheckSummaries(requests, rolls)[0];
    expect(groupCheckMajoritySucceeds(summary, true)).toBe(false);
  });
});
