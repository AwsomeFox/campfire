import { ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/** Stable JSON for hashing — sorted object keys, deterministic arrays. Omits undefined values. */
export function stableStringify(value: unknown): string {
  // Snapshots are always objects; top-level undefined hashes as JSON null.
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** sha256 hex digest of a proposal base snapshot (issue #681). */
export function hashProposalSnapshot(snapshot: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

export type ProposalThreeWayDiff = {
  base: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
  proposed: Record<string, unknown> | null;
};

export type StaleProposalTargetBody = {
  code: 'STALE_PROPOSAL_TARGET';
  message: string;
  baseUpdatedAt: string | null;
  currentUpdatedAt: string | null;
  diff: ProposalThreeWayDiff;
};

/** Machine-readable 409 when the target entity changed since the proposal was filed. */
export function staleProposalTarget(input: {
  base: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
  proposed: Record<string, unknown> | null;
}): ConflictException {
  const baseUpdatedAt = typeof input.base?.updatedAt === 'string' ? input.base.updatedAt : null;
  const currentUpdatedAt = typeof input.current?.updatedAt === 'string' ? input.current.updatedAt : null;
  return new ConflictException({
    code: 'STALE_PROPOSAL_TARGET',
    message:
      'The target entity or its source context changed after this proposal was filed. Reload the proposal queue, ' +
      'review the three-way diff, and approve again (or reject and re-propose).',
    baseUpdatedAt,
    currentUpdatedAt,
    diff: {
      base: input.base,
      current: input.current,
      proposed: input.proposed,
    },
  } satisfies StaleProposalTargetBody);
}

/** Compare stored base hash to the live entity snapshot; throws on mismatch or missing target. */
export function assertProposalTargetFresh(input: {
  action: 'create' | 'update' | 'delete';
  baseSnapshot: Record<string, unknown> | null;
  baseSnapshotHash: string | null;
  currentSnapshot: Record<string, unknown> | null;
  proposed: Record<string, unknown> | null;
  baseContextHash?: string | null;
  currentContextHash?: string | null;
}): void {
  if (input.action === 'create') return;

  if (input.currentSnapshot === null) {
    throw new NotFoundException('Proposal target no longer exists');
  }

  const expectedHash =
    input.baseSnapshotHash ??
    (input.baseSnapshot !== null ? hashProposalSnapshot(input.baseSnapshot) : null);
  // Legacy rows (pre-#681) lack baseSnapshotHash; fall back to hashing the stored
  // baseSnapshot if present. Creates without a snapshot return null here and skip the check.
  if (expectedHash === null) return;

  const currentHash = hashProposalSnapshot(input.currentSnapshot);
  const contextChanged =
    input.baseContextHash != null && input.currentContextHash !== input.baseContextHash;
  if (currentHash !== expectedHash || contextChanged) {
    throw staleProposalTarget({
      base: input.baseSnapshot,
      current: input.currentSnapshot,
      proposed: input.proposed,
    });
  }
}
