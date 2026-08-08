import { ConflictException } from '@nestjs/common';
import type { Role } from '@campfire/schema';
import { ProposalsService } from '../../src/modules/proposals/proposals.service';
import type { ProposalRecordsService } from '../../src/modules/proposals/proposal-records.service';

describe('ProposalsService.approve (issue #681)', () => {
  const user = { id: '1', name: 'dm', serverRole: 'user' as const };
  const role: Role = 'dm';

  function makeService(overrides: {
    existing?: Record<string, unknown>;
    currentSnapshot?: Record<string, unknown> | null;
    markResolved?: jest.Mock;
    revertToPending?: jest.Mock;
    finalizeApproved?: jest.Mock;
    createThrows?: boolean;
    finalizeThrows?: boolean;
  }) {
    const existing = {
      id: 9,
      campaignId: 1,
      entityType: 'quest',
      entityId: 42,
      action: 'create',
      payload: '{"title":"New Quest"}',
      snapshot: null,
      baseUpdatedAt: null,
      baseSnapshotHash: null,
      status: 'pending',
      ...overrides.existing,
    };

    const records = {
      getRowOrThrow: jest.fn(async (id: number) => {
        if (id !== existing.id) throw new Error('not found');
        return existing;
      }),
      getCurrentAuthorizedSnapshot: jest.fn(async () => overrides.currentSnapshot ?? null),
      markResolved: overrides.markResolved ?? jest.fn(async () => ({ id: existing.id, status: 'approved' })),
      revertToPending: overrides.revertToPending ?? jest.fn(async () => undefined),
      finalizeApproved:
        overrides.finalizeApproved ??
        (overrides.finalizeThrows
          ? jest.fn(() => {
              throw new Error('simulated finalize failure');
            })
          : jest.fn()),
    };

    const quests = {
      create: overrides.createThrows
        ? jest.fn(async () => {
            throw new Error('simulated write failure');
          })
        : jest.fn(async () => ({ id: 100 })),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const audit = { log: jest.fn() };
    const storylines = {
      createArc: jest.fn(),
      updateArc: jest.fn(),
      removeArc: jest.fn(),
      addBeat: jest.fn(),
      updateBeat: jest.fn(),
      removeBeat: jest.fn(),
      getArcRowOrThrow: jest.fn(),
    };

    const service = new ProposalsService(
      records as unknown as ProposalRecordsService,
      audit as never,
      { notifyUser: jest.fn() } as never,
      quests as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      storylines as never,
    );

    return { service, records, quests, storylines, audit, existing };
  }

  it('rejects stale update targets with STALE_PROPOSAL_TARGET before claiming', async () => {
    const base = { id: 42, title: 'Before', updatedAt: '2026-01-01T00:00:00.000Z' };
    const markResolved = jest.fn();
    const { service, records } = makeService({
      existing: {
        action: 'update',
        entityId: 42,
        snapshot: JSON.stringify(base),
        baseUpdatedAt: base.updatedAt,
        baseSnapshotHash: 'abc',
        payload: '{"title":"After"}',
      },
      currentSnapshot: { ...base, title: 'Changed', updatedAt: '2026-01-02T00:00:00.000Z' },
      markResolved,
    });

    await expect(service.approve(9, {}, user, role)).rejects.toBeInstanceOf(ConflictException);
    expect(markResolved).not.toHaveBeenCalled();
    expect(records.getCurrentAuthorizedSnapshot).toHaveBeenCalled();
  });

  it('reverts to pending and skips finalize when the entity write throws after claim', async () => {
    const { service, records, quests } = makeService({ createThrows: true });

    await expect(service.approve(9, {}, user, role)).rejects.toThrow('simulated write failure');
    expect(records.markResolved).toHaveBeenCalled();
    expect(quests.create).toHaveBeenCalled();
    expect(records.revertToPending).toHaveBeenCalledWith(9);
    expect(records.finalizeApproved).not.toHaveBeenCalled();
  });

  it('finalizes backfill + audit atomically after a successful create write', async () => {
    const { service, records } = makeService({});

    const result = await service.approve(9, {}, user, role);
    expect(result.entityId).toBe(100);
    expect(records.finalizeApproved).toHaveBeenCalledWith(9, user, role, { entityId: 100 });
  });

  it('does not revert to pending when finalize fails after a successful entity write', async () => {
    const { service, records, audit } = makeService({ finalizeThrows: true });

    const result = await service.approve(9, {}, user, role);
    expect(result.entityId).toBe(100);
    expect(records.revertToPending).not.toHaveBeenCalled();
    expect(records.finalizeApproved).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'proposal.approve.finalize_failed', entityId: 9 }),
    );
  });

  it('passes the storyline base token through compare-and-set and credits an unamended AI rewrite', async () => {
    const base = {
      id: 42,
      campaignId: 1,
      title: 'Before',
      summary: 'Old summary',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { service, storylines } = makeService({
      existing: {
        entityType: 'story_arc',
        action: 'update',
        snapshot: JSON.stringify(base),
        baseUpdatedAt: base.updatedAt,
        baseSnapshotHash: null,
        payload: '{"title":"After","summary":"AI summary"}',
        proposer: 'AI DM (eval-model)',
        proposerUserId: 'ai-dm:1',
        proposerToken: null,
      },
      currentSnapshot: base,
    });

    await service.approve(9, {}, user, role);

    expect(storylines.updateArc).toHaveBeenCalledWith(
      42,
      { title: 'After', summary: 'AI summary' },
      user,
      role,
      {
        expectedUpdatedAt: base.updatedAt,
        revisionUser: expect.objectContaining({
          id: 'ai-dm:1',
          proposalAttribution: expect.objectContaining({ proposerUserId: 'ai-dm:1' }),
        }),
      },
    );
  });
});
