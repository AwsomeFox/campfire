import fs from 'node:fs';
import { describe, expect, it, jest, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import { openDatabase, dbFilePath, type DrizzleDb } from '../../src/db/db.module';
import { campaigns } from '../../src/db/schema';
import { AiDriverService } from '../../src/modules/ai-driver/ai-driver.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #559 — AI Driver control state must survive a restart.
 *
 * This is deliberately a REAL-SQLITE spec, not a mocked-drizzle one. The whole point of the
 * feature is that state written by one process is readable by the next, so the "restart" here
 * closes the SQLite handle and calls `openDatabase` again on the SAME data dir, then builds a
 * brand-new AiDriverService over the reopened connection. That exercises the actual
 * `ai_driver_control_state` DDL (BOOTSTRAP_SQL + the 0111 migration), the actual drizzle
 * upsert/select SQL, and the actual column names — none of which a hand-rolled mock can catch.
 * Reopening also proves the migration is idempotent against an already-migrated file.
 *
 * No Nest bootstrap: a real DB file plus the service constructed by hand, matching the shape of
 * the other integration specs (encounter-combatant-identity-concurrency.spec.ts).
 */

type Ctor = ConstructorParameters<typeof AiDriverService>;

interface Harness {
  service: AiDriverService;
  audit: { log: jest.Mock };
  stream: { emit: jest.Mock };
  notifications: { memberRoles: jest.Mock; notifyCampaign: jest.Mock };
}

/**
 * Build an AiDriverService over `orm`. Only the collaborators the control-state paths actually
 * touch are stubbed (audit / stream / notifications); everything else is a turn-execution
 * dependency that these levers never reach.
 */
function makeService(orm: DrizzleDb): Harness {
  const aiDm = { registerDriverSessionTeardown: jest.fn() };
  const audit = { log: jest.fn(async () => undefined) };
  const stream = { emit: jest.fn() };
  const notifications = {
    // Two vote-eligible players → threshold 2.
    memberRoles: jest.fn(async () => new Map<number, string>([[1, 'player'], [2, 'player']])),
    notifyCampaign: jest.fn(async () => undefined),
  };
  const service = new AiDriverService(
    aiDm as unknown as Ctor[0],
    undefined as unknown as Ctor[1],
    audit as unknown as Ctor[2],
    stream as unknown as Ctor[3],
    notifications as unknown as Ctor[4],
    undefined as unknown as Ctor[5],
    undefined as unknown as Ctor[6],
    undefined as unknown as Ctor[7],
    undefined as unknown as Ctor[8],
    undefined as unknown as Ctor[9],
    undefined as unknown as Ctor[10],
    undefined as unknown as Ctor[11],
    orm as Ctor[12],
  );
  return { service, audit, stream, notifications } as Harness;
}

/** Audit actions recorded by a harness, in order. */
function auditActions(h: Harness): string[] {
  return h.audit.log.mock.calls.map((c) => (c[0] as { action: string }).action);
}

describe('AI driver control state persistence across restart (#559, real SQLite)', () => {
  let dataDir: string;
  let open: { sqlite: Database.Database; orm: DrizzleDb } | null = null;
  const campaignId = 1;

  const player: RequestUser = { id: '1', name: 'Player One', serverRole: 'user' };
  const other: RequestUser = { id: '2', name: 'Player Two', serverRole: 'user' };
  const dm: RequestUser = { id: '9', name: 'DM One', serverRole: 'user' };

  afterEach(() => {
    open?.sqlite.close();
    open = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Boot a "process": open the real DB on `dataDir` and hand back a fresh service over it. */
  function boot(): Harness {
    open?.sqlite.close();
    const { sqlite, orm } = openDatabase(dataDir);
    open = { sqlite, orm };
    return makeService(orm);
  }

  /** First boot, with a campaign row so the control-state FK to campaigns(id) is satisfiable. */
  function firstBoot(): Harness {
    dataDir = makeTempDataDir();
    const h = boot();
    const ts = '2026-07-26T00:00:00.000Z';
    open!.orm.insert(campaigns).values({ name: 'Restart Table', createdAt: ts, updatedAt: ts }).run();
    return h;
  }

  /** The raw persisted row, read through a plain better-sqlite3 handle (no drizzle in the way). */
  function rawRow(): Record<string, unknown> | undefined {
    const db = new Database(dbFilePath(dataDir), { readonly: true });
    try {
      return db
        .prepare('SELECT * FROM ai_driver_control_state WHERE campaign_id = ?')
        .get(campaignId) as Record<string, unknown> | undefined;
    } finally {
      db.close();
    }
  }

  it('creates the ai_driver_control_state table with the expected columns and reopens idempotently', () => {
    firstBoot();
    const cols = (open!.sqlite.prepare('PRAGMA table_info(ai_driver_control_state)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'campaign_id', 'status', 'state', 'scene', 'last_narration', 'last_turn_at',
        'turn_count', 'stuck', 'acting_dm', 'vote', 'takeover_requested_by', 'last_input',
        'announced_recovery', 'updated_at',
      ]),
    );
    // Reopening the already-migrated file must not throw (migrations re-run on every boot).
    expect(() => boot()).not.toThrow();
  });

  it('restores a deliberate pause after a restart', () => {
    const first = firstBoot();
    first.service.setPaused(campaignId, true);
    expect(rawRow()).toMatchObject({ status: 'paused', state: 'paused' });

    const restarted = boot();
    const session = restarted.service.getSession(campaignId);
    expect(session.status).toBe('paused');
    expect(session.state).toBe('paused');
    expect(session.levers).toContain('resume');
    // The table is told what came back (#559: "notify the table of recovered state").
    expect(auditActions(restarted)).toContain('ai-dm.driver.control_state.recovered');
    expect(restarted.notifications.notifyCampaign).toHaveBeenCalled();

    // Recovery still requires an explicit resume — it is not auto-cleared.
    restarted.service.setPaused(campaignId, false);
    expect(boot().service.getSession(campaignId).state).toBe('running');
  });

  it('restores a human takeover grant, and a post-restart handback releases the seat', async () => {
    const first = firstBoot();
    await first.service.requestTakeover(campaignId, player, 'player');
    await first.service.grantTakeover(campaignId, dm, undefined, 'take it from here', 'dm');

    const restarted = boot();
    const held = restarted.service.getSession(campaignId);
    expect(held.state).toBe('human_control');
    expect(held.status).toBe('paused');
    expect(held.actingDm?.memberId).toBe(player.id);
    expect(held.actingDm?.grantedBy).toBe(dm.id);
    expect(held.levers).toEqual(['handback']);

    await restarted.service.handback(campaignId, player, 'resolved by the table', 'player');
    const after = boot().service.getSession(campaignId);
    expect(after.state).toBe('running');
    expect(after.status).toBe('idle');
    expect(after.actingDm).toBeNull();
  });

  it('restores an open vote with its ballots, expiry, and eligible-member snapshot', async () => {
    const first = firstBoot();
    await first.service.openVote(campaignId, player, 'pause', 'player');
    await first.service.castVote(campaignId, player, true, 'player');
    const before = first.service.getSession(campaignId).vote!;

    const restarted = boot();
    const vote = restarted.service.getSession(campaignId).vote!;
    expect(vote.resolved).toBe(false);
    expect(vote.ballots).toEqual({ '1': true });
    expect(vote.threshold).toBe(2);
    expect(vote.eligibleVoters).toBe(2);
    expect(vote.expiresAt).toBe(before.expiresAt); // TTL is preserved, not restarted
    expect(vote.openedBy).toBe(player.id);

    // The restored vote is still live: the second ballot carries it and pauses the seat.
    await restarted.service.castVote(campaignId, other, true, 'player');
    const resolved = boot().service.getSession(campaignId);
    expect(resolved.vote?.resolved).toBe(true);
    expect(resolved.vote?.outcome).toBe('passed');
    expect(resolved.state).toBe('paused');
  });

  it('fails a vote whose TTL lapsed while the server was down instead of resurrecting it', async () => {
    const first = firstBoot();
    await first.service.openVote(campaignId, player, 'override', 'player');

    // Rewrite only expires_at to the past — exactly what a long outage looks like on disk.
    const live = first.service.getSession(campaignId).vote!;
    const expired = JSON.stringify({ ...live, expiresAt: '2020-01-01T00:00:00.000Z' });
    open!.sqlite.prepare('UPDATE ai_driver_control_state SET vote = ? WHERE campaign_id = ?').run(expired, campaignId);

    const restarted = boot();
    const vote = restarted.service.getSession(campaignId).vote!;
    expect(vote.resolved).toBe(true);
    expect(vote.outcome).toBe('failed');
    // ...and the expiry is durable, so it does not block the next vote.
    expect(rawRow()).toMatchObject({ vote: expect.stringContaining('"outcome":"failed"') });
    await expect(restarted.service.openVote(campaignId, other, 'pause', 'player')).resolves.toBeDefined();
  });

  it('restores stuck state together with the replay input the retry lever needs', () => {
    const first = firstBoot();
    const session = first.service.getSession(campaignId);
    session.state = 'awaiting_players';
    session.stuck = { reason: 'provider_error', detail: 'provider failed', since: '2026-07-26T00:00:01.000Z', turn: 3 };
    session.turnCount = 3;
    session.lastNarration = 'The ruling stalled.';
    (first.service as unknown as { lastInputs: Map<number, string> }).lastInputs.set(campaignId, 'I open the crypt door.');
    (first.service as unknown as { persistControlState: (s: unknown) => void }).persistControlState(session);

    const restarted = boot();
    const recovered = restarted.service.getSession(campaignId);
    expect(recovered.state).toBe('awaiting_players');
    expect(recovered.stuck?.reason).toBe('provider_error');
    expect(recovered.turnCount).toBe(3);
    expect(recovered.lastNarration).toBe('The ruling stalled.');
    expect(recovered.levers).toContain('retry');
    expect(
      (restarted.service as unknown as { requireReplayInput: (id: number) => string }).requireReplayInput(campaignId),
    ).toBe('I open the crypt door.');
  });

  it('parks a turn that was generating when the process died into an audited pause', () => {
    const first = firstBoot();
    // Write side: a reserved turn slot is recorded as `running` — the only durable crash marker.
    const session = first.service.getSession(campaignId);
    session.status = 'running';
    (first.service as unknown as { persistControlState: (s: unknown) => void }).persistControlState(session);
    expect(rawRow()).toMatchObject({ status: 'running' });

    // Read side: the next process must NOT come back idle/running and accept a fresh turn.
    const restarted = boot();
    const recovered = restarted.service.getSession(campaignId);
    expect(recovered.status).toBe('paused');
    expect(recovered.state).toBe('paused');
    expect(recovered.levers).toContain('resume');
    const recoveryAudit = restarted.audit.log.mock.calls
      .map((c) => c[0] as { action: string; detail: string })
      .find((a) => a.action === 'ai-dm.driver.control_state.recovered');
    expect(recoveryAudit?.detail).toContain('interrupted_turn');
    expect(restarted.notifications.notifyCampaign).toHaveBeenCalled();

    // The frozen state is itself durable: a second restart before anyone resumes stays paused.
    const third = boot();
    expect(third.service.getSession(campaignId).state).toBe('paused');
    // ...and is SILENT. The seat settles into `paused`, which is what was recorded, so the table
    // is not told a second time about a freeze it was just told about.
    expect(third.notifications.notifyCampaign).not.toHaveBeenCalled();
  });

  /**
   * The interrupted-turn path is the one case where the announced shape and the persisted status
   * deliberately disagree: the crash announces `interrupted_turn`, but the row is reconciled to
   * `status='paused'`, so a later boot recomputes `paused`. Recording the ANNOUNCED shape rather
   * than the SETTLED one made that later boot look like a fresh transition and fire a redundant
   * "came back paused" notice — the bug the marker exists to prevent, moved one boot along.
   */
  it('crash → one notice → untouched restart → silence → human action → one notice again', () => {
    const first = firstBoot();
    const session = first.service.getSession(campaignId);
    session.status = 'running';
    (first.service as unknown as { persistControlState: (s: unknown) => void }).persistControlState(session);

    // 1. First boot after the crash: exactly one announcement, and it names the interrupted turn.
    const crashBoot = boot();
    expect(crashBoot.service.getSession(campaignId).state).toBe('paused');
    expect(crashBoot.notifications.notifyCampaign).toHaveBeenCalledTimes(1);
    expect(
      crashBoot.audit.log.mock.calls
        .map((c) => c[0] as { action: string; detail: string })
        .filter((a) => a.action === 'ai-dm.driver.control_state.recovered'),
    ).toHaveLength(1);
    // The marker records the SETTLED shape (`paused`), not the announced reason.
    expect(rawRow()).toMatchObject({ status: 'paused', announced_recovery: 'paused' });

    // 2. Restart again with nothing changed: ZERO announcements, and no audit row either.
    for (const _restart of [1, 2]) {
      const quiet = boot();
      expect(quiet.service.getSession(campaignId).state).toBe('paused');
      expect(quiet.notifications.notifyCampaign).not.toHaveBeenCalled();
      expect(auditActions(quiet)).not.toContain('ai-dm.driver.control_state.recovered');
    }

    // 3. A human resumes, a fresh turn is reserved, and the process dies again. That is a new
    //    interrupted turn, so it must announce — the earlier suppression must not be sticky.
    const resumed = boot();
    resumed.service.setPaused(campaignId, false);
    expect(rawRow()).toMatchObject({ announced_recovery: null });
    const live = resumed.service.getSession(campaignId);
    live.status = 'running';
    (resumed.service as unknown as { persistControlState: (s: unknown) => void }).persistControlState(live);

    const secondCrash = boot();
    expect(secondCrash.service.getSession(campaignId).state).toBe('paused');
    expect(secondCrash.notifications.notifyCampaign).toHaveBeenCalledTimes(1);
    expect(
      secondCrash.audit.log.mock.calls
        .map((c) => c[0] as { action: string; detail: string })
        .find((a) => a.action === 'ai-dm.driver.control_state.recovered')?.detail,
    ).toContain('interrupted_turn');
  });

  it('an interrupted turn that was also stuck drops back to the stuck ladder on explicit resume', () => {
    const first = firstBoot();
    const session = first.service.getSession(campaignId);
    session.status = 'running';
    session.state = 'awaiting_players';
    session.stuck = { reason: 'tool_error', detail: 'a tool blew up', since: '2026-07-26T00:00:01.000Z', turn: 1 };
    (first.service as unknown as { persistControlState: (s: unknown) => void }).persistControlState(session);

    const restarted = boot();
    expect(restarted.service.getSession(campaignId).state).toBe('paused'); // freeze wins
    restarted.service.setPaused(campaignId, false);
    const resumed = boot().service.getSession(campaignId);
    expect(resumed.state).toBe('awaiting_players'); // ...but the ladder was not lost
    expect(resumed.stuck?.reason).toBe('tool_error');
  });

  it('a mode-switch teardown clears the persisted row so a later re-select starts clean', () => {
    const first = firstBoot();
    first.service.setPaused(campaignId, true);
    expect(rawRow()).toBeDefined();

    first.service.teardownSession(campaignId);
    expect(rawRow()).toBeUndefined();

    const restarted = boot();
    const session = restarted.service.getSession(campaignId);
    expect(session.state).toBe('running');
    expect(session.status).toBe('idle');
    // Nothing was recovered, so the table is not spammed with a recovery notice.
    expect(auditActions(restarted)).not.toContain('ai-dm.driver.control_state.recovered');
  });

  it('announces a steady paused seat exactly once, no matter how many restarts follow', () => {
    const first = firstBoot();
    first.service.setPaused(campaignId, true);

    // Boot 2: the pause is news — the table is told, and the announcement is recorded on disk.
    const second = boot();
    expect(second.service.getSession(campaignId).state).toBe('paused');
    expect(second.notifications.notifyCampaign).toHaveBeenCalledTimes(1);
    expect(auditActions(second)).toContain('ai-dm.driver.control_state.recovered');
    expect(rawRow()).toMatchObject({ announced_recovery: 'paused' });

    // Boots 3-5: same steady state, already announced. Silence — no notice, no audit row.
    for (const _boot of [3, 4, 5]) {
      const later = boot();
      expect(later.service.getSession(campaignId).state).toBe('paused');
      expect(later.notifications.notifyCampaign).not.toHaveBeenCalled();
      expect(auditActions(later)).not.toContain('ai-dm.driver.control_state.recovered');
    }
  });

  it('re-announces after a resume and a fresh pause — the marker tracks transitions, not shapes', () => {
    const first = firstBoot();
    first.service.setPaused(campaignId, true);
    // Hydration is lazy — `getSession` loads and announces, not `boot()` on its own.
    const second = boot();
    second.service.getSession(campaignId);
    expect(second.notifications.notifyCampaign).toHaveBeenCalledTimes(1); // announced once
    const third = boot();
    third.service.getSession(campaignId);
    expect(third.notifications.notifyCampaign).not.toHaveBeenCalled(); // steady state, silent

    // A DM resumes and later re-pauses: the lever write clears the marker, so the NEXT restart
    // is a genuine transition again and the table is told.
    const acting = boot();
    acting.service.setPaused(campaignId, false);
    expect(rawRow()).toMatchObject({ announced_recovery: null });
    acting.service.setPaused(campaignId, true);

    const restarted = boot();
    expect(restarted.service.getSession(campaignId).state).toBe('paused');
    expect(restarted.notifications.notifyCampaign).toHaveBeenCalledTimes(1);
  });

  it('announces an interrupted turn even when the seat was already announced as stuck', () => {
    const first = firstBoot();
    const session = first.service.getSession(campaignId);
    session.state = 'awaiting_players';
    session.stuck = { reason: 'loop', detail: 'repeated itself', since: '2026-07-26T00:00:01.000Z', turn: 2 };
    (first.service as unknown as { persistControlState: (s: unknown) => void }).persistControlState(session);

    // Boot 2 announces `stuck` and records it; boot 3 is silent — still stuck, already told.
    const second = boot();
    expect(second.service.getSession(campaignId).state).toBe('awaiting_players');
    expect(second.notifications.notifyCampaign).toHaveBeenCalledTimes(1);
    expect(rawRow()).toMatchObject({ announced_recovery: 'stuck' });
    const third = boot();
    third.service.getSession(campaignId);
    expect(third.notifications.notifyCampaign).not.toHaveBeenCalled();

    // Now a turn is reserved and the process dies mid-generation. That is a DIFFERENT shape, so
    // the interrupted-turn notice is NOT suppressed by the earlier `stuck` announcement.
    const running = boot();
    const live = running.service.getSession(campaignId);
    live.status = 'running';
    (running.service as unknown as { persistControlState: (s: unknown) => void }).persistControlState(live);

    const restarted = boot();
    expect(restarted.service.getSession(campaignId).state).toBe('paused');
    expect(restarted.notifications.notifyCampaign).toHaveBeenCalledTimes(1);
    const recoveryAudit = restarted.audit.log.mock.calls
      .map((c) => c[0] as { action: string; detail: string })
      .find((a) => a.action === 'ai-dm.driver.control_state.recovered');
    expect(recoveryAudit?.detail).toContain('interrupted_turn');
  });

  it('two concurrent open-vote requests cannot clobber (and persist over) each other', async () => {
    const first = firstBoot();
    // `memberRoles` is the only await inside openVote, so hold it open to interleave both calls
    // exactly the way two simultaneous POST /vote {action:open} requests would.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    first.notifications.memberRoles.mockImplementation(async () => {
      await gate;
      return new Map<number, string>([[1, 'player'], [2, 'player']]);
    });

    const a = first.service.openVote(campaignId, player, 'pause', 'player');
    const b = first.service.openVote(campaignId, other, 'override', 'player');
    release();
    const settled = await Promise.allSettled([a, b]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
    // Exactly one vote exists, and the row on disk agrees with the in-memory winner.
    const live = first.service.getSession(campaignId).vote!;
    expect(live.resolved).toBe(false);
    expect(rawRow()).toMatchObject({ vote: expect.stringContaining(`"id":"${live.id}"`) });
  });

  it('a persistence failure never propagates out of a control lever', () => {
    const first = firstBoot();
    open!.sqlite.exec('DROP TABLE ai_driver_control_state');
    // Durability is best-effort: losing the write must not fail the pause the DM just asked for.
    expect(() => first.service.setPaused(campaignId, true)).not.toThrow();
    expect(first.service.getSession(campaignId).state).toBe('paused');
  });
});
