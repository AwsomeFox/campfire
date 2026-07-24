import type { Proposal, Role } from '@campfire/schema';

/**
 * Proposal snapshot / payload projection (issue #817).
 *
 * The DB persists a full DM-review snapshot (including `dmSecret` and hidden-prep
 * fields) so approve-time diffs stay honest. Non-DM proposers must NEVER receive
 * that raw row through create responses, self-view list, revise/withdraw, MCP, or
 * member export — they get this redacted/omitted projection instead.
 */

/** Strip `dmSecret` from a free-form record (payload or snapshot). */
export function redactProposalRecord(record: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(record, 'dmSecret')) return { ...record };
  const { dmSecret: _dmSecret, ...rest } = record;
  return { ...rest, dmSecret: '' };
}

/**
 * Whether a stored snapshot describes an entity the non-DM must not see at all
 * (hidden quest/NPC, or unexplored location). Such snapshots are omitted entirely
 * rather than partially redacted — even a title would confirm hidden prep.
 */
export function isSnapshotHiddenFromNonDm(
  snapshot: Record<string, unknown>,
  entityType: string,
): boolean {
  if (snapshot.hidden === true) return true;
  if (entityType === 'location' && snapshot.status === 'unexplored') return true;
  return false;
}

/**
 * Proposer-facing snapshot: omit unrevealed entities wholesale; otherwise strip
 * DM-only fields. DM callers never use this — they receive the persisted snapshot.
 */
export function projectProposalSnapshot(
  snapshot: Record<string, unknown> | null,
  entityType: string,
  role: Role,
): Record<string, unknown> | null {
  if (snapshot == null) return null;
  if (role === 'dm') return snapshot;
  if (isSnapshotHiddenFromNonDm(snapshot, entityType)) return null;
  return redactProposalRecord(snapshot);
}

/** Role-aware Proposal projection for every non-DM egress path. */
export function projectProposal(proposal: Proposal, role: Role): Proposal {
  if (role === 'dm') return proposal;
  return {
    ...proposal,
    payload: redactProposalRecord(proposal.payload),
    snapshot: projectProposalSnapshot(proposal.snapshot, proposal.entityType, role),
  };
}

export function projectProposals(proposals: Proposal[], role: Role): Proposal[] {
  if (role === 'dm') return proposals;
  return proposals.map((p) => projectProposal(p, role));
}
