import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { AiDriverService } from '../../src/modules/ai-driver/ai-driver.service';
import type { RequestUser } from '../../src/common/user.types';

/**
 * Issue #1586 — a read-await-write race on `AiDriverService.actionQueues` silently dropped a
 * queued player action and left its HTTP request hanging forever.
 *
 * ── Why this is a SERVICE-layer test, not an e2e/HTTP one ──────────────────────────────────
 * The race needs two `runTurn` calls to be IN FLIGHT AT THE SAME TIME, with the first one's
 * `await this.getActionQueueDepth(campaignId)` still pending when the second one reads
 * `this.actionQueues.get(campaignId) ?? []`. An HTTP-level test (supertest against a single
 * agent, backed by synchronous better-sqlite3) cannot produce that interleaving — supertest
 * serialises requests on its agent, so a second `.post()` never starts until the first one's
 * response has already been received. A test written that way would pass whether or not the
 * bug exists, which is worse than no test: it would read as coverage for a defect it never
 * actually exercises.
 *
 * So this drives `AiDriverService` directly (same construction pattern as
 * ai-driver-player-modeling.spec.ts — a hand-mocked dependency set, no Nest test module, no
 * DB, no HTTP), forces the session into `status: 'running'` so both calls land on the queue
 * branch, and calls `runTurn` TWICE BACK TO BACK WITHOUT AWAITING EITHER before inspecting the
 * result — the same shape the issue asks for ("kick off both runTurn promises, then await
 * Promise.all" — here inspecting `actionQueues` directly, since the queued promises themselves
 * are deliberately never drained by this test and would hang if awaited).
 */
describe('AiDriverService action queue — concurrent enqueue race (#1586)', () => {
  let aiDm: any;
  let transcript: any;
  let driver: AiDriverService;

  const CAMPAIGN_ID = 1;

  function user(id: string): RequestUser {
    return { id, name: id, serverRole: 'user' } as RequestUser;
  }

  beforeEach(() => {
    aiDm = {
      assertRunnable: jest.fn<any>().mockResolvedValue({ tokenBudget: 1000, tokensUsed: 0, actionQueueDepth: 5 }),
      assertWithinServerTokenCap: jest.fn<any>().mockResolvedValue(undefined),
      withSpendLock: jest.fn<any>().mockImplementation(async (id: any, fn: any) => fn()),
      // Backs getActionQueueDepth — the await this fix has to survive without losing an entry.
      getSeat: jest.fn<any>().mockResolvedValue({ tokenBudget: 1000, tokensUsed: 0, actionQueueDepth: 5 }),
      meterTurn: jest.fn<any>().mockResolvedValue({ seat: { tokenBudget: 1000, tokensUsed: 100 }, budgetRemaining: 900 }),
      registerDriverSessionTeardown: jest.fn(),
      isExperimentalEnabled: jest.fn<any>().mockResolvedValue(true),
    };
    const mcpTools = { buildToolset: jest.fn().mockReturnValue({ tools: [], get: jest.fn(), call: jest.fn() }) };
    const audit = { log: jest.fn() };
    const stream = { emit: jest.fn(), streamFor: jest.fn() };
    const notifications = {};
    const supportPreferences = { listForPublicAiNarration: jest.fn<any>().mockResolvedValue([]) };
    const resolver = { resolveEffectiveConfig: jest.fn(), resolve: jest.fn<any>().mockResolvedValue({ name: 'mock' }) };
    const campaigns = { getOrThrow: jest.fn<any>().mockResolvedValue({ id: CAMPAIGN_ID, narrationLanguage: 'en' }) };
    const rules = {};
    const encounters = { listForCampaign: jest.fn<any>().mockResolvedValue([]) };
    const members = { listForCampaign: jest.fn<any>().mockResolvedValue([]) };
    const characters = { getOrThrow: jest.fn() };
    // Each queued entry records a player.action row before it is pushed — a distinct seq per
    // call proves BOTH calls actually ran this far, not just that two objects landed in the
    // queue by coincidence.
    let seq = 0;
    transcript = { record: jest.fn<any>().mockImplementation(() => ++seq) };
    driver = new AiDriverService(
      aiDm,
      mcpTools as any,
      audit as any,
      stream as any,
      notifications as any,
      supportPreferences as any,
      resolver as any,
      campaigns as any,
      rules as any,
      encounters as any,
      members as any,
      characters as any,
      transcript,
      { correctionsForPrompt: async () => [] } as any,
    );
  });

  /** Let every microtask AND macrotask chained off the two in-flight calls actually run. */
  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('two callers arriving with no queue yet BOTH survive — neither is silently dropped', async () => {
    // Force the session into `running` so runTurn's queue branch is reached instead of the
    // "no turn in flight" path (which would actually try to execute a turn against unmocked
    // provider machinery). This is the "a turn is already in progress" precondition the bug
    // report describes — the race is between two callers arriving while ANOTHER turn streams.
    const session = (driver as any).ensureSession(CAMPAIGN_ID);
    session.status = 'running';

    // THE LOAD-BEARING PART: both calls are started here, synchronously, back to back, with
    // NEITHER awaited before the second one starts. This is what makes the two `runTurn`
    // invocations genuinely concurrent — each one's `await this.getActionQueueDepth(...)` (a
    // real await on a still-resolving mocked promise) is a yield point the other call's
    // continuation can run inside of. Awaiting the first call before starting the second would
    // serialise them exactly the way the HTTP test trap does, and prove nothing.
    const p1 = driver.runTurn(CAMPAIGN_ID, user('player-1'), 'I open the door', {});
    const p2 = driver.runTurn(CAMPAIGN_ID, user('player-2'), 'I draw my sword', {});
    // Neither promise is awaited (or even attached a .catch here) — on unfixed code the first
    // one's entry is discarded before anything ever resolves or rejects it, so awaiting it
    // would hang this test forever. That hang IS the bug (issue #1586's "request hangs until
    // the client times out"), so the test must not reproduce it on itself.
    void p1;
    void p2;

    await flush();

    const queue = (driver as any).actionQueues.get(CAMPAIGN_ID);
    // On unfixed code this is 1 (the second caller's `?? []` array, with the first caller's
    // array — and its entry — discarded along with it). Confirmed by reverting only the source
    // fix and re-running this spec: it fails here with `queue.length === 1`.
    expect(queue).toBeDefined();
    expect(queue).toHaveLength(2);

    // Both distinct inputs are present — not just two objects, but BOTH callers' entries.
    const inputs = queue!.map((e: { input: string }) => e.input);
    expect(inputs).toEqual(expect.arrayContaining(['I open the door', 'I draw my sword']));

    // Every queued entry's promise-settling callbacks are still live and distinct — the
    // concrete mechanism of the hang was that the discarded entry's resolve/reject were
    // unreachable from anything. Two DIFFERENT function references prove neither was dropped
    // in favour of the other.
    const resolvers = queue!.map((e: { resolve: unknown }) => e.resolve);
    expect(resolvers[0]).not.toBe(resolvers[1]);
  });

  it('a third caller past the seat-configured depth still gets a legible 409, not a silent drop', async () => {
    aiDm.getSeat.mockResolvedValue({ tokenBudget: 1000, tokensUsed: 0, actionQueueDepth: 1 });
    const session = (driver as any).ensureSession(CAMPAIGN_ID);
    session.status = 'running';

    const p1 = driver.runTurn(CAMPAIGN_ID, user('player-1'), 'first', {});
    void p1;
    await flush();

    // The queue is now at its configured depth (1); a second concurrent caller must be
    // refused with the documented ConflictException rather than silently overflowing it.
    await expect(driver.runTurn(CAMPAIGN_ID, user('player-2'), 'second', {})).rejects.toThrow(
      /Action queue is full/,
    );
  });

  it('teardown during getActionQueueDepth yield rejects the caller instead of orphaning the promise (#1497)', async () => {
    // Make getSeat asynchronous so the yield window is wide enough for teardownSession to run.
    let releaseSeat!: () => void;
    const seatGate = new Promise<void>((r) => { releaseSeat = r; });
    aiDm.getSeat.mockImplementation(() => seatGate.then(() => ({ tokenBudget: 1000, tokensUsed: 0, actionQueueDepth: 5 })));

    const session = (driver as any).ensureSession(CAMPAIGN_ID);
    session.status = 'running';

    // Start a runTurn that will yield on getActionQueueDepth.
    const p = driver.runTurn(CAMPAIGN_ID, user('player-1'), 'I search the room', {});
    await flush();

    // The queue array is installed in the map but the entry has NOT been pushed yet — the
    // caller is still awaiting getActionQueueDepth.
    const queueBefore = (driver as any).actionQueues.get(CAMPAIGN_ID);
    expect(queueBefore).toBeDefined();
    expect(queueBefore).toHaveLength(0);

    // Tear down the session while the caller is mid-yield — this deletes the map entry.
    driver.teardownSession(CAMPAIGN_ID);
    expect((driver as any).actionQueues.get(CAMPAIGN_ID)).toBeUndefined();

    // Release the getSeat gate so the caller resumes — with the fix it hits the re-validation
    // check and throws ConflictException. Without the fix it would push onto the orphaned
    // array and the returned promise would never settle.
    releaseSeat();
    await expect(p).rejects.toThrow(/torn down/);
  });

  it('turn completion during getActionQueueDepth yield falls through to run turn directly (#1497)', async () => {
    let releaseSeat!: () => void;
    const seatGate = new Promise<void>((r) => { releaseSeat = r; });
    aiDm.getSeat.mockImplementation(() => seatGate.then(() => ({ tokenBudget: 1000, tokensUsed: 0, actionQueueDepth: 5 })));

    const session = (driver as any).ensureSession(CAMPAIGN_ID);
    session.status = 'running';

    // Start a runTurn that will yield on getActionQueueDepth while session is running.
    const p = driver.runTurn(CAMPAIGN_ID, user('player-1'), 'I search the room', {});
    await flush();

    // While player-1 is yielding on getActionQueueDepth, the running turn completes and sets status to 'idle'.
    session.status = 'idle';

    // Release getSeat gate so player-1 resumes.
    releaseSeat();

    // Since status became idle, player-1 does not queue; it falls through to run the turn directly.
    // Awaiting p confirms the turn runs to completion rather than hanging or queueing.
    const res = await p;
    expect(res).toBeDefined();
    expect((driver as any).actionQueues.get(CAMPAIGN_ID)).toBeUndefined();
    expect(session.status).toBe('idle');
  });
});
