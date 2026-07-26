import { AiDriverService } from '../../src/modules/ai-driver/ai-driver.service';
import { AiDmTranscriptService } from '../../src/modules/ai-driver/ai-driver-transcript.service';
import type { DrizzleDb } from '../../src/db/db.module';

/**
 * #1059 — secret-read approvals must not accumulate unboundedly in the in-memory session map.
 * Two guarantees: (1) a consumed approval is removed (not just flagged), and (2) the active set
 * is bounded per campaign, evicting the oldest when a DM stacks too many distinct pending grants.
 *
 * The service is driven directly with inert stubs (grant/list/revoke/consume touch only the audit
 * log, the SSE stream, the transcript, and the in-memory session map — no provider), so no Nest
 * bootstrap.
 *
 * The transcript dependency is the REAL {@link AiDmTranscriptService} over an in-memory row store
 * rather than a spy, because a secret-read approval NAMES a hidden entity and #572 makes it a
 * DM-only transcript row. Running the real write path is what proves the row is actually written
 * with `visibility: 'dm'` — a `jest.fn()` would happily accept any visibility, including none.
 */

/**
 * Minimal stand-in for the drizzle/better-sqlite3 handle AiDmTranscriptService.record() uses:
 * a synchronous `transaction`, a chainable `select(...).from(...).where(...).all()` returning the
 * current MAX(seq), and chainable `insert(...).values(...).run()` / `delete(...).where(...).run()`.
 * Deliberately not a mock of the service itself — the point is to exercise its real seq assignment
 * and visibility handling. Note that record() swallows its own errors by design, so a db double
 * that threw would make this spec silently vacuous; this one must actually work.
 */
function makeInMemoryDb(): { db: DrizzleDb; rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  const chain = (terminal: () => unknown): any => {
    const node: any = {
      from: () => node,
      where: () => node,
      values: (v: Record<string, unknown>) => {
        rows.push(v);
        return node;
      },
      all: () => terminal(),
      run: () => terminal(),
      get: () => terminal(),
    };
    return node;
  };
  const tx = {
    select: () => chain(() => [{ value: rows.length === 0 ? null : Math.max(...rows.map((r) => Number(r.seq))) }]),
    insert: () => chain(() => undefined),
    delete: () => chain(() => undefined),
  };
  const db = {
    transaction: <T>(fn: (t: typeof tx) => T): T => fn(tx),
    delete: () => chain(() => ({ changes: 0 })),
  };
  return { db: db as unknown as DrizzleDb, rows };
}
// Cast helpers tied to the real signatures so stubs can't silently drift from the source shapes.
type Ctor = ConstructorParameters<typeof AiDriverService>;
type Granter = Parameters<AiDriverService['grantSecretReadApproval']>[1];

describe('AiDriverService — secret-read approvals are bounded (#1059)', () => {
  const CAMPAIGN = 1;
  const dmUser = { id: 'dm-1' } as unknown as Granter;

  function makeService() {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const stream = { emit: jest.fn() };
    const aiDm = { registerDriverSessionTeardown: jest.fn() };
    const { db, rows } = makeInMemoryDb();
    const transcript = new AiDmTranscriptService(db, stream as unknown as ConstructorParameters<typeof AiDmTranscriptService>[1]);
    // Only aiDm (constructor teardown hook), audit, and stream are touched by the approval
    // lifecycle; the remaining deps are unused here. Casts are pinned to ConstructorParameters
    // so a signature change surfaces as a compile error rather than a silent `never`.
    const svc = new AiDriverService(
      aiDm as unknown as Ctor[0],
      undefined as unknown as Ctor[1], // mcpTools
      audit as unknown as Ctor[2],
      stream as unknown as Ctor[3],
      undefined as unknown as Ctor[4], // notifications
      undefined as unknown as Ctor[5], // supportPreferences
      undefined as unknown as Ctor[6], // resolver
      undefined as unknown as Ctor[7], // campaigns
      undefined as unknown as Ctor[8], // rules
      undefined as unknown as Ctor[9], // encounters
      undefined as unknown as Ctor[10], // members (#1045)
      undefined as unknown as Ctor[11], // characters (#1045)
      transcript as unknown as Ctor[12], // transcript (#572) — real service, in-memory rows
    );
    return { svc, audit, stream, transcriptRows: rows };
  }

  it('grants an approval and lists it as active/unconsumed', async () => {
    const { svc, stream } = makeService();
    const a = await svc.grantSecretReadApproval(CAMPAIGN, dmUser, 'get_npc', 42, 'name the villain');
    expect(a).toMatchObject({ tool: 'get_npc', entityId: 42, consumed: false });
    expect(svc.listSecretReadApprovals(CAMPAIGN)).toHaveLength(1);
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({ action: 'granted', tool: 'get_npc', entityId: 42 }));
  });

  it('records the grant as a DM-ONLY transcript row (#572)', async () => {
    const { svc, transcriptRows } = makeService();
    await svc.grantSecretReadApproval(CAMPAIGN, dmUser, 'get_npc', 42, 'name the villain');

    // The approval names a hidden entity, so the table log must not carry it to players.
    const written = transcriptRows.filter((r) => r.kind === 'control');
    expect(written).toHaveLength(1);
    expect(written[0].visibility).toBe('dm');
    expect(written[0].seq).toBe(1);
    expect(JSON.parse(String(written[0].payload))).toMatchObject({
      control: 'secret-approval',
      action: 'granted',
      tool: 'get_npc',
      entityId: 42,
    });

    // A revoke is equally DM-only, and takes the next per-campaign sequence number.
    await svc.revokeSecretReadApproval(CAMPAIGN, dmUser, 'get_npc', 42);
    const all = transcriptRows.filter((r) => r.kind === 'control');
    expect(all).toHaveLength(2);
    expect(all[1].visibility).toBe('dm');
    expect(all[1].seq).toBe(2);
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
