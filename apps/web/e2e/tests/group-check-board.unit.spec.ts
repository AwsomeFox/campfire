import { expect, test } from '@playwright/test';
import type { CheckRequest, DiceRoll } from '@campfire/schema';
import { buildGroupCheckSummaries, groupCheckMajoritySucceeds, shouldShowPassedTally } from '../../src/features/encounters/groupCheckBoard';
import { queryKeys } from '../../src/lib/query';

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

  // --- Review finding #2 (Devin): an older group whose roll(s) aged out of the fetched dice
  // window must never render "0 of N passed" — that reads as a confident total failure when the
  // truth is "unknown". unknownOutcomeCount + shouldShowPassedTally are the guard.
  test('unknownOutcomeCount counts resolved members whose roll fell out of the fetched window', () => {
    const requests = [
      mkReq({ id: 1, characterId: 10, groupId: 'g1', status: 'resolved', rollId: 100 }), // roll present
      mkReq({ id: 2, characterId: 11, groupId: 'g1', status: 'resolved', rollId: 999 }), // roll NOT in the fetched page
      mkReq({ id: 3, characterId: 12, groupId: 'g1', status: 'pending' }),
    ];
    const rolls = [mkRoll({ id: 100, success: true })];
    const summary = buildGroupCheckSummaries(requests, rolls)[0];
    expect(summary.resolvedCount).toBe(2);
    expect(summary.passCount).toBe(1);
    expect(summary.unknownOutcomeCount).toBe(1);
  });

  test('shouldShowPassedTally is false whenever any resolved member has an unknown outcome, even with a dc set — falls back to the resolved-count tally instead of confidently reporting "0 of N passed"', () => {
    const requests = [
      mkReq({ id: 1, characterId: 10, groupId: 'g1', dc: 12, status: 'resolved', rollId: 999 }), // roll aged out
    ];
    const summary = buildGroupCheckSummaries(requests, [] /* the roll is NOT in this page */)[0];
    expect(summary.dc).toBe(12);
    expect(summary.passCount).toBe(0); // the naive count a stale implementation would show
    expect(summary.unknownOutcomeCount).toBe(1);
    expect(shouldShowPassedTally(summary)).toBe(false);
  });

  test('shouldShowPassedTally is true once every resolved member has a known outcome and a dc was set', () => {
    const requests = [mkReq({ id: 1, characterId: 10, groupId: 'g1', dc: 12, status: 'resolved', rollId: 100 })];
    const summary = buildGroupCheckSummaries(requests, [mkRoll({ id: 100, success: true })])[0];
    expect(shouldShowPassedTally(summary)).toBe(true);
  });

  test('shouldShowPassedTally is false with no dc set (no member ever has a success to tally)', () => {
    const requests = [mkReq({ id: 1, characterId: 10, groupId: 'g1', dc: null, status: 'pending' })];
    const summary = buildGroupCheckSummaries(requests, [])[0];
    expect(shouldShowPassedTally(summary)).toBe(false);
  });

  test('majority advisory never renders when a resolved member has an unknown outcome, even if every OTHER member passed and the adapter opts in', () => {
    const requests = [
      mkReq({ id: 1, characterId: 10, groupId: 'g1', status: 'resolved', rollId: 100 }),
      mkReq({ id: 2, characterId: 11, groupId: 'g1', status: 'resolved', rollId: 999 }), // unknown outcome
    ];
    const summary = buildGroupCheckSummaries(requests, [mkRoll({ id: 100, success: true })])[0];
    expect(summary.resolvedCount).toBe(summary.totalCount); // fully "resolved" by status
    expect(summary.unknownOutcomeCount).toBe(1);
    expect(groupCheckMajoritySucceeds(summary, true)).toBe(false);
  });
});

// --- Review finding #1 (Devin + Copilot): GroupCheckBoard and CheckRequestPrompts must never
// share a React Query cache key with different queryFns — see query.ts's doc comment on
// `campaignCheckRequestsAll` for the full incident. This pins the key SHAPE so a future edit
// that re-collapses them back onto the same key fails here first.
test.describe('check-request query key isolation (#1943 review)', () => {
  test('campaignCheckRequestsAll is a DISTINCT key from campaignCheckRequests, not equal to it', () => {
    const base = queryKeys.campaignCheckRequests(7);
    const all = queryKeys.campaignCheckRequestsAll(7);
    expect(all).not.toEqual(base);
  });

  test('campaignCheckRequestsAll extends campaignCheckRequests as a prefix, so invalidating the base key also busts it (React Query default partial match)', () => {
    const base = queryKeys.campaignCheckRequests(7);
    const all = queryKeys.campaignCheckRequestsAll(7);
    expect(all.slice(0, base.length)).toEqual(base);
    expect(all.length).toBeGreaterThan(base.length);
  });
});

// --- Review finding #5 (Devin): the board's own bounded request page (GROUP_CHECK_BOARD_
// REQUEST_LIMIT rows) can split a single group across the fetch boundary exactly the way the
// 50-roll dice window could split a group's outcomes — fixed the same way: the aggregate must
// never claim more certainty than the data supports.
test.describe('possiblyIncomplete — a truncated request page can split a group (#1943 review finding #5)', () => {
  test('constructs the actual split-group case: a 3-member group where the truncated page only fetched 2 of its 3 rows', () => {
    // Realistic scenario: 'party-save' is really a 3-character group (ids 1,2,3 all share it),
    // but the DM's group send happened long enough ago that id=1 has aged out of the board's
    // fetched page — 5 unrelated single-target sends landed after it. The page below (ids
    // 2..6, length 5) is exactly what a `?limit=5` fetch would return: it never saw row id=1 at
    // all, so from buildGroupCheckSummaries's point of view 'party-save' looks like a complete
    // 2-member group unless it's told the page was truncated.
    const requests = [
      mkReq({ id: 2, characterId: 20, groupId: 'party-save', status: 'resolved', rollId: 100 }),
      mkReq({ id: 3, characterId: 30, groupId: 'party-save', status: 'resolved', rollId: 101 }),
      mkReq({ id: 4, characterId: 40, groupId: 'solo-1', status: 'resolved', rollId: 102 }),
      mkReq({ id: 5, characterId: 50, groupId: 'solo-2', status: 'resolved', rollId: 103 }),
      mkReq({ id: 6, characterId: 60, groupId: 'solo-3', status: 'resolved', rollId: 104 }),
    ];
    const rolls = [
      mkRoll({ id: 100, success: true }),
      mkRoll({ id: 101, success: true }),
      mkRoll({ id: 102, success: true }),
      mkRoll({ id: 103, success: true }),
      mkRoll({ id: 104, success: true }),
    ];

    // hasMoreOlderRows = true: the caller fetched exactly its page limit (5), so row id=1 (and
    // anything older) may exist beyond what was fetched.
    const summaries = buildGroupCheckSummaries(requests, rolls, true);
    const partySave = summaries.find((s) => s.groupId === 'party-save')!;
    const solo1 = summaries.find((s) => s.groupId === 'solo-1')!;

    // The split group IS flagged — it holds the page's oldest fetched row (id=2).
    expect(partySave.possiblyIncomplete).toBe(true);
    // A group entirely clear of the truncation boundary is NOT flagged, even on the same
    // truncated page — only the group actually at risk is suppressed.
    expect(solo1.possiblyIncomplete).toBe(false);

    // The dramatic failure this pins: without the fix, 'party-save' would render "2 of 2
    // passed — Group succeeds" for what is REALLY an (at least) 3-member group missing a
    // member entirely — full confidence in a number that is flatly wrong.
    expect(partySave.totalCount).toBe(2); // the undercount itself — a symptom, not what we assert on
    expect(shouldShowPassedTally(partySave)).toBe(false);
    expect(groupCheckMajoritySucceeds(partySave, true)).toBe(false);
    // The unaffected group's tally is untouched by its neighbor's truncation.
    expect(shouldShowPassedTally(solo1)).toBe(true);
  });

  test('the same page, NOT truncated (hasMoreOlderRows omitted/false), flags nothing — a fully-fetched page is trustworthy', () => {
    const requests = [
      mkReq({ id: 2, characterId: 20, groupId: 'party-save', status: 'resolved', rollId: 100 }),
      mkReq({ id: 3, characterId: 30, groupId: 'party-save', status: 'resolved', rollId: 101 }),
    ];
    const rolls = [mkRoll({ id: 100, success: true }), mkRoll({ id: 101, success: true })];

    const summaries = buildGroupCheckSummaries(requests, rolls); // hasMoreOlderRows defaults false
    const partySave = summaries.find((s) => s.groupId === 'party-save')!;
    expect(partySave.possiblyIncomplete).toBe(false);
    expect(shouldShowPassedTally(partySave)).toBe(true);
    expect(groupCheckMajoritySucceeds(partySave, true)).toBe(true);
  });

  test('a truncated page with only ONE group present: that group holds the oldest row and is flagged', () => {
    const requests = [
      mkReq({ id: 5, characterId: 1, groupId: 'solo-group', status: 'resolved', rollId: 100 }),
    ];
    const rolls = [mkRoll({ id: 100, success: true })];
    const summaries = buildGroupCheckSummaries(requests, rolls, true);
    expect(summaries[0].possiblyIncomplete).toBe(true);
  });
});
