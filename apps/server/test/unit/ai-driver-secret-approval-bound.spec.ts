import { AiDriverService } from '../../src/modules/ai-driver/ai-driver.service';

/**
 * #1059 — secret-read approvals must not accumulate unboundedly in the in-memory session map.
 * Two guarantees: (1) a consumed approval is removed (not just flagged), and (2) the active set
 * is bounded per campaign, evicting the oldest when a DM stacks too many distinct pending grants.
 *
 * The service is driven directly with inert stubs (grant/list/revoke/consume touch only the audit
 * log, the SSE stream, and the in-memory session map — no DB / provider), so no Nest bootstrap.
 */
describe('AiDriverService — secret-read approvals are bounded (#1059)', () => {
  const CAMPAIGN = 1;
  const dmUser = { id: 'dm-1' } as never;

  function makeService() {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const stream = { emit: jest.fn() };
    const aiDm = { registerDriverSessionTeardown: jest.fn() };
    const svc = new AiDriverService(
      aiDm as never, // aiDm
      undefined as never, // mcpTools
      audit as never,
      stream as never,
      undefined as never, // notifications
      undefined as never, // supportPreferences
      undefined as never, // resolver
      undefined as never, // campaigns
      undefined as never, // rules
    );
    return { svc, audit, stream };
  }

  it('grants an approval and lists it as active/unconsumed', async () => {
    const { svc, stream } = makeService();
    const a = await svc.grantSecretReadApproval(CAMPAIGN, dmUser, 'get_npc', 42, 'name the villain');
    expect(a).toMatchObject({ tool: 'get_npc', entityId: 42, consumed: false });
    expect(svc.listSecretReadApprovals(CAMPAIGN)).toHaveLength(1);
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({ action: 'granted', tool: 'get_npc', entityId: 42 }));
  });

  it('re-granting the same {tool, entityId} replaces in place (no growth)', async () => {
    const { svc } = makeService();
    await svc.grantSecretReadApproval(CAMPAIGN, dmUser, 'get_npc', 7);
    await svc.grantSecretReadApproval(CAMPAIGN, dmUser, 'get_npc', 7, 'updated note');
    const list = svc.listSecretReadApprovals(CAMPAIGN);
    expect(list).toHaveLength(1);
    expect(list[0].note).toBe('updated note');
  });

  it('caps the active set at 50, evicting the oldest when distinct grants exceed the cap', async () => {
    const { svc } = makeService();
    // 60 distinct {tool, entityId} grants → the set must never exceed the 50 cap.
    for (let id = 1; id <= 60; id++) {
      await svc.grantSecretReadApproval(CAMPAIGN, dmUser, 'get_npc', id);
    }
    const list = svc.listSecretReadApprovals(CAMPAIGN);
    expect(list).toHaveLength(50);
    // FIFO: the earliest grant (npc 1) is evicted; the most recent (npc 60) survives.
    expect(list.some((a) => a.entityId === 1)).toBe(false);
    expect(list.some((a) => a.entityId === 60)).toBe(true);
  });

  it('revoke removes an unconsumed approval and is idempotent', async () => {
    const { svc } = makeService();
    await svc.grantSecretReadApproval(CAMPAIGN, dmUser, 'get_location', 9);
    await svc.revokeSecretReadApproval(CAMPAIGN, dmUser, 'get_location', 9);
    expect(svc.listSecretReadApprovals(CAMPAIGN)).toHaveLength(0);
    // Revoking again is a no-op (no throw).
    await expect(svc.revokeSecretReadApproval(CAMPAIGN, dmUser, 'get_location', 9)).resolves.toBeDefined();
  });

  it('consuming an approval deletes it from the session map (not merely flags it)', async () => {
    const { svc } = makeService();
    const approval = await svc.grantSecretReadApproval(CAMPAIGN, dmUser, 'get_npc', 3);
    // Reach into the private consume path the runtime uses on a successful DM-scoped read.
    const session = (svc as unknown as { ensureSession(id: number): unknown }).ensureSession(CAMPAIGN);
    (svc as unknown as { consumeApproval(s: unknown, a: unknown): void }).consumeApproval(session, approval);

    expect(approval.consumed).toBe(true);
    expect(svc.listSecretReadApprovals(CAMPAIGN)).toHaveLength(0);
    // The key is gone from the map, so it can't be replayed or linger as dead state.
    const map = (session as { secretReadApprovals: Record<string, unknown> }).secretReadApprovals;
    expect(Object.keys(map)).toHaveLength(0);
  });
});
