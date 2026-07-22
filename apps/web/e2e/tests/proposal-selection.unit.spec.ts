import { expect, test } from '@playwright/test';
import type { Proposal } from '@campfire/schema';
import {
  deriveProposalSelectionScope,
  retainPendingSelection,
  summarizeProposalBatch,
} from '../../src/features/proposals/proposalSelection';

function proposal(
  id: number,
  options: Partial<Proposal> & Pick<Proposal, 'action' | 'entityType'>,
): Proposal {
  return {
    id,
    campaignId: 1,
    entityId: id,
    payload: { title: `Proposal ${id}` },
    snapshot: null,
    proposer: 'Player',
    proposerUserId: '7',
    proposerToken: null,
    status: 'pending',
    resolvedBy: '',
    note: '',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    ...options,
  };
}

test.describe('proposal visible-selection model', () => {
  test('derives rows, counts, ids, select-all, and indeterminate from one visible scope', () => {
    const pending = [
      proposal(1, { action: 'create', entityType: 'quest' }),
      proposal(2, { action: 'update', entityType: 'npc', proposerUserId: 'ai-dm:1' }),
      proposal(3, { action: 'delete', entityType: 'location', proposerUserId: 'ai-dm:1' }),
    ];

    const allRows = deriveProposalSelectionScope(pending, new Set([1, 3]), false);
    expect(allRows).toMatchObject({
      total: 3,
      selectedCount: 2,
      selectedIds: [1, 3],
      hiddenSelectedIds: [],
      allSelected: false,
      indeterminate: true,
    });

    const aiRows = deriveProposalSelectionScope(pending, new Set([1, 3]), true);
    expect(aiRows.visible.map(({ id }) => id)).toEqual([2, 3]);
    expect(aiRows).toMatchObject({
      total: 2,
      selectedCount: 1,
      selectedIds: [3],
      hiddenSelectedIds: [1],
      allSelected: false,
      indeterminate: true,
    });

    const empty = deriveProposalSelectionScope([pending[0]], new Set([1]), true);
    expect(empty).toMatchObject({
      total: 0,
      selectedCount: 0,
      selectedIds: [],
      hiddenSelectedIds: [1],
      allSelected: false,
      indeterminate: false,
    });
  });

  test('drops concurrently resolved ids while retaining pending failures', () => {
    const failed = proposal(12, { action: 'update', entityType: 'quest' });
    expect(retainPendingSelection([failed], new Set([11, 12, 13]))).toEqual(new Set([12]));
  });

  test('summarizes the exact selected action and destructive types', () => {
    const summary = summarizeProposalBatch([
      proposal(21, { action: 'create', entityType: 'quest' }),
      proposal(22, { action: 'update', entityType: 'npc' }),
      proposal(23, { action: 'delete', entityType: 'location' }),
      proposal(24, { action: 'delete', entityType: 'npc' }),
    ]);

    expect(summary).toEqual({
      total: 4,
      destructiveCount: 2,
      actions: [
        { action: 'create', count: 1, entityCounts: [{ entityType: 'quest', count: 1 }] },
        { action: 'update', count: 1, entityCounts: [{ entityType: 'npc', count: 1 }] },
        {
          action: 'delete',
          count: 2,
          entityCounts: [
            { entityType: 'location', count: 1 },
            { entityType: 'npc', count: 1 },
          ],
        },
      ],
    });
  });
});
