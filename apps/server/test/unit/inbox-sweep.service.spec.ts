import { describe, expect, it } from '@jest/globals';
import {
  freshOutcome,
  tallyOutcome,
  type SweepCounts,
  type SweepOutcome,
} from '../../src/modules/inbox-sweep/inbox-sweep.service';

describe('InboxSweepService outcome accounting (issues #1717/#1724)', () => {
  function emptyCounts(): SweepCounts {
    return {
      proposed: 0,
      skipped: 0,
      errored: 0,
      newlyProposed: 0,
      newlySkipped: 0,
      newlyErrored: 0,
    };
  }

  it('fresh outcomes increment total AND newly counts', () => {
    const counts = emptyCounts();

    const prop = freshOutcome({
      noteId: 1,
      outcome: 'proposed',
      entityType: 'quest',
      entityId: null,
      proposalId: 10,
      reason: 'fresh create',
      body: 'note 1',
    });
    tallyOutcome(counts, prop);

    const skip = freshOutcome({
      noteId: 2,
      outcome: 'skipped',
      entityType: null,
      entityId: null,
      proposalId: null,
      reason: 'no canon change',
      body: 'note 2',
    });
    tallyOutcome(counts, skip);

    const err = freshOutcome({
      noteId: 3,
      outcome: 'errored',
      entityType: null,
      entityId: null,
      proposalId: null,
      reason: 'validation error',
      body: 'note 3',
    });
    tallyOutcome(counts, err);

    expect(counts).toEqual({
      proposed: 1,
      skipped: 1,
      errored: 1,
      newlyProposed: 1,
      newlySkipped: 1,
      newlyErrored: 1,
    });
  });

  it('recovered outcomes (race recoveries and prior ledger rows) increment totals but NOT newly counts', () => {
    const counts = emptyCounts();

    const recoveredProposed: SweepOutcome = {
      result: {
        noteId: 1,
        outcome: 'proposed',
        entityType: 'npc',
        entityId: 5,
        proposalId: 12,
        reason: 'recovered from ledger',
        body: 'note 1',
      },
      recovered: true,
    };
    tallyOutcome(counts, recoveredProposed);

    const recoveredSkipped: SweepOutcome = {
      result: {
        noteId: 2,
        outcome: 'skipped',
        entityType: null,
        entityId: null,
        proposalId: null,
        reason: 'recovered skip',
        body: 'note 2',
      },
      recovered: true,
    };
    tallyOutcome(counts, recoveredSkipped);

    const recoveredErrored: SweepOutcome = {
      result: {
        noteId: 3,
        outcome: 'errored',
        entityType: null,
        entityId: null,
        proposalId: null,
        reason: 'recovered error',
        body: 'note 3',
      },
      recovered: true,
    };
    tallyOutcome(counts, recoveredErrored);

    expect(counts.proposed).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(counts.errored).toBe(1);
    expect(counts.newlyProposed).toBe(0);
    expect(counts.newlySkipped).toBe(0);
    expect(counts.newlyErrored).toBe(0);
  });

  it('correctly handles mixed fresh and recovered outcomes in a single sweep', () => {
    const counts = emptyCounts();

    tallyOutcome(
      counts,
      freshOutcome({
        noteId: 10,
        outcome: 'proposed',
        entityType: 'quest',
        entityId: null,
        proposalId: 100,
        reason: 'fresh proposal',
        body: 'note 10',
      }),
    );

    tallyOutcome(counts, {
      result: {
        noteId: 11,
        outcome: 'proposed',
        entityType: 'npc',
        entityId: null,
        proposalId: 101,
        reason: 'concurrent race recovery',
        body: 'note 11',
      },
      recovered: true,
    });

    expect(counts.proposed).toBe(2);
    expect(counts.newlyProposed).toBe(1);
  });
});
