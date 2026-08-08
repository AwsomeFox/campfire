import { NotFoundException } from '@nestjs/common';
import {
  assertProposalTargetFresh,
  hashProposalSnapshot,
  stableStringify,
  staleProposalTarget,
} from '../../src/modules/proposals/proposal-snapshot';

describe('proposal-snapshot (issue #681)', () => {
  const base = { id: 5, title: 'Original', updatedAt: '2026-01-01T00:00:00.000Z' };

  it('stableStringify sorts object keys deterministically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('stableStringify omits undefined object values', () => {
    expect(stableStringify({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
  });

  it('hashProposalSnapshot is stable for equivalent objects', () => {
    const a = hashProposalSnapshot({ title: 'A', id: 1, updatedAt: 't' });
    const b = hashProposalSnapshot({ id: 1, updatedAt: 't', title: 'A' });
    expect(a).toBe(b);
  });

  it('assertProposalTargetFresh is a no-op for create proposals', () => {
    expect(() =>
      assertProposalTargetFresh({
        action: 'create',
        baseSnapshot: null,
        baseSnapshotHash: null,
        currentSnapshot: null,
        proposed: { title: 'New' },
      }),
    ).not.toThrow();
  });

  it('assertProposalTargetFresh passes when the current snapshot matches the base hash', () => {
    const hash = hashProposalSnapshot(base);
    expect(() =>
      assertProposalTargetFresh({
        action: 'update',
        baseSnapshot: base,
        baseSnapshotHash: hash,
        currentSnapshot: { ...base },
        proposed: { title: 'Changed' },
      }),
    ).not.toThrow();
  });

  it('assertProposalTargetFresh rejects changed rewrite context when the target row still matches', () => {
    expect(() =>
      assertProposalTargetFresh({
        action: 'update',
        baseSnapshot: base,
        baseSnapshotHash: hashProposalSnapshot(base),
        currentSnapshot: { ...base },
        proposed: { title: 'Changed' },
        baseContextHash: 'original-context',
        currentContextHash: 'changed-context',
      }),
    ).toThrow('source context changed');
  });

  it('assertProposalTargetFresh throws STALE_PROPOSAL_TARGET with a three-way diff when stale', () => {
    const hash = hashProposalSnapshot(base);
    const current = { ...base, title: 'DM edited', updatedAt: '2026-01-02T00:00:00.000Z' };
    try {
      assertProposalTargetFresh({
        action: 'update',
        baseSnapshot: base,
        baseSnapshotHash: hash,
        currentSnapshot: current,
        proposed: { title: 'Proposed' },
      });
      throw new Error('expected stale conflict');
    } catch (err) {
      const body = (err as { getResponse: () => Record<string, unknown> }).getResponse();
      expect(body.code).toBe('STALE_PROPOSAL_TARGET');
      expect(body.baseUpdatedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(body.currentUpdatedAt).toBe('2026-01-02T00:00:00.000Z');
      const diff = body.diff as { base: typeof base; current: typeof current; proposed: { title: string } };
      expect(diff.base.title).toBe('Original');
      expect(diff.current.title).toBe('DM edited');
      expect(diff.proposed.title).toBe('Proposed');
    }
  });

  it('assertProposalTargetFresh throws 404 when the target no longer exists', () => {
    expect(() =>
      assertProposalTargetFresh({
        action: 'delete',
        baseSnapshot: base,
        baseSnapshotHash: hashProposalSnapshot(base),
        currentSnapshot: null,
        proposed: null,
      }),
    ).toThrow(NotFoundException);
  });

  it('staleProposalTarget uses null proposed for delete proposals', () => {
    const err = staleProposalTarget({ base, current: { ...base, title: 'gone' }, proposed: null });
    const body = err.getResponse() as { diff: { proposed: unknown } };
    expect(body.diff.proposed).toBeNull();
  });
});
