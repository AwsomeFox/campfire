import type { Proposal } from '@campfire/schema';

export function isAiProposal(proposal: Proposal): boolean {
  return proposal.proposerUserId.startsWith('ai-dm:');
}

/**
 * The pending rows currently on screen are the only selectable rows. Keeping this
 * derivation in one place prevents counts, checkbox state, confirmation copy, and
 * request bodies from drifting onto different selection scopes.
 */
export function deriveProposalSelectionScope(
  pending: Proposal[],
  selectedIds: ReadonlySet<number>,
  aiOnly: boolean,
) {
  const visible = aiOnly ? pending.filter(isAiProposal) : pending;
  const selected = visible.filter((proposal) => selectedIds.has(proposal.id));
  const visibleIds = new Set(visible.map((proposal) => proposal.id));
  const hiddenSelectedIds = pending
    .filter((proposal) => selectedIds.has(proposal.id) && !visibleIds.has(proposal.id))
    .map((proposal) => proposal.id);

  return {
    visible,
    selected,
    selectedIds: selected.map((proposal) => proposal.id),
    hiddenSelectedIds,
    total: visible.length,
    selectedCount: selected.length,
    allSelected: visible.length > 0 && selected.length === visible.length,
    indeterminate: selected.length > 0 && selected.length < visible.length,
  };
}

export function retainPendingSelection(
  pending: Proposal[],
  selectedIds: ReadonlySet<number>,
): Set<number> {
  const pendingIds = new Set(pending.map((proposal) => proposal.id));
  return new Set([...selectedIds].filter((id) => pendingIds.has(id)));
}

export interface ProposalActionSummary {
  action: Proposal['action'];
  count: number;
  entityCounts: Array<{ entityType: string; count: number }>;
}

export interface ProposalBatchSummary {
  total: number;
  destructiveCount: number;
  actions: ProposalActionSummary[];
}

const ACTION_ORDER: Proposal['action'][] = ['create', 'update', 'delete'];

/** Summarize the exact frozen proposal list that a confirmed batch will submit. */
export function summarizeProposalBatch(proposals: Proposal[]): ProposalBatchSummary {
  const actions = ACTION_ORDER.flatMap((action) => {
    const matching = proposals.filter((proposal) => proposal.action === action);
    if (matching.length === 0) return [];

    const counts = new Map<string, number>();
    for (const proposal of matching) {
      const entityType = String(proposal.entityType);
      counts.set(entityType, (counts.get(entityType) ?? 0) + 1);
    }

    return [{
      action,
      count: matching.length,
      entityCounts: [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entityType, count]) => ({ entityType, count })),
    }];
  });

  return {
    total: proposals.length,
    destructiveCount: proposals.filter((proposal) => proposal.action === 'delete').length,
    actions,
  };
}
