import type { Proposal, Role } from '@campfire/schema';
import {
  isSnapshotHiddenFromNonDm,
  projectProposal,
  projectProposalSnapshot,
  projectProposals,
  redactProposalRecord,
} from '../../src/modules/proposals/proposal-projection';

function baseProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    campaignId: 10,
    entityType: 'quest',
    entityId: 5,
    action: 'update',
    payload: { title: 'Suggested', dmSecret: 'payload-secret' },
    snapshot: {
      id: 5,
      title: 'Original',
      dmSecret: 'vault-trap',
      hidden: false,
    },
    proposer: 'Ada',
    proposerUserId: '3',
    proposerToken: null,
    status: 'pending',
    resolvedBy: '',
    note: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('proposal-projection (issue #817)', () => {
  describe('redactProposalRecord', () => {
    it('blanks dmSecret without mutating other fields', () => {
      const src = { title: 'A', dmSecret: 's', reward: '1gp' };
      expect(redactProposalRecord(src)).toEqual({ title: 'A', dmSecret: '', reward: '1gp' });
      expect(src.dmSecret).toBe('s');
    });

    it('leaves records without dmSecret unchanged (copy)', () => {
      const src = { title: 'A' };
      const out = redactProposalRecord(src);
      expect(out).toEqual({ title: 'A' });
      expect(out).not.toBe(src);
    });
  });

  describe('isSnapshotHiddenFromNonDm', () => {
    it('treats hidden:true as hidden', () => {
      expect(isSnapshotHiddenFromNonDm({ hidden: true }, 'quest')).toBe(true);
    });

    it('treats unexplored locations as hidden', () => {
      expect(isSnapshotHiddenFromNonDm({ status: 'unexplored' }, 'location')).toBe(true);
      expect(isSnapshotHiddenFromNonDm({ status: 'unexplored' }, 'quest')).toBe(false);
    });

    it('treats visible entities as not hidden', () => {
      expect(isSnapshotHiddenFromNonDm({ hidden: false }, 'npc')).toBe(false);
      expect(isSnapshotHiddenFromNonDm({ status: 'explored' }, 'location')).toBe(false);
    });
  });

  describe('projectProposalSnapshot', () => {
    it('returns the raw snapshot for a dm', () => {
      const snap = { title: 'X', dmSecret: 's', hidden: false };
      expect(projectProposalSnapshot(snap, 'quest', 'dm')).toBe(snap);
    });

    it.each<Role>(['player', 'viewer'])('strips dmSecret for %s on a visible entity', (role) => {
      const out = projectProposalSnapshot({ title: 'X', dmSecret: 's', hidden: false }, 'quest', role);
      expect(out).toEqual({ title: 'X', dmSecret: '', hidden: false });
    });

    it.each<Role>(['player', 'viewer'])('omits a hidden-entity snapshot entirely for %s', (role) => {
      expect(projectProposalSnapshot({ title: 'Secret Prep', dmSecret: 's', hidden: true }, 'quest', role)).toBeNull();
    });

    it('omits an unexplored location snapshot for non-dm', () => {
      expect(
        projectProposalSnapshot({ name: 'Hidden Cave', status: 'unexplored', dmSecret: 's' }, 'location', 'player'),
      ).toBeNull();
    });
  });

  describe('projectProposal / projectProposals', () => {
    it('is a no-op for dm', () => {
      const p = baseProposal();
      expect(projectProposal(p, 'dm')).toBe(p);
    });

    it.each<Role>(['player', 'viewer'])('redacts payload + snapshot dmSecret for %s', (role) => {
      const out = projectProposal(baseProposal(), role);
      expect(out.payload.dmSecret).toBe('');
      expect(out.payload.title).toBe('Suggested');
      expect(out.snapshot).toEqual({
        id: 5,
        title: 'Original',
        dmSecret: '',
        hidden: false,
      });
    });

    it('projects every element in a list for non-dm', () => {
      const list = projectProposals([baseProposal({ id: 1 }), baseProposal({ id: 2 })], 'player');
      expect(list).toHaveLength(2);
      expect(list.every((p) => p.snapshot && (p.snapshot as { dmSecret: string }).dmSecret === '')).toBe(true);
    });
  });
});
