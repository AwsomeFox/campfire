import fs from 'node:fs';
import { describe, expect, it, jest, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import { openDatabase, dbFilePath, type DrizzleDb } from '../../src/db/db.module';
import { campaigns } from '../../src/db/schema';
import {
  AiDriverService,
  GREETING_PROMPT,
  WRAP_UP_PROMPT,
  lifecyclePhaseForInput,
  toPublicAiDmSessionState,
  noteDriverEconomyGrant,
} from '../../src/modules/ai-driver/ai-driver.service';
import { MAX_PENDING_TOOL_CONFIRMATIONS } from '../../src/modules/ai-driver/driver-tool-policy';
import { AiDmTranscriptService } from '../../src/modules/ai-driver/ai-driver-transcript.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #559 — AI Driver control state must survive a restart.
 *
 * This is deliberately a REAL-SQLITE spec, not a mocked-drizzle one. The whole point of the
 * feature is that state written by one process is readable by the next, so the "restart" here
 * closes the SQLite handle and calls `openDatabase` again on the SAME data dir, then builds a
 * brand-new AiDriverService over the reopened connection. That exercises the actual
 * `ai_driver_control_state` DDL (BOOTSTRAP_SQL + the create/backfill migration pair), the drizzle
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
  actionResolver: { releasePendingChainForConfirmation: jest.Mock };
}

/**
 * Build an AiDriverService over `orm`. Only the collaborators the control-state paths actually
 * touch are stubbed (audit / stream / notifications / transcript); everything else is a
 * turn-execution dependency that these levers never reach.
 *
 * The transcript is the REAL AiDmTranscriptService over the same connection rather than a spy:
 * the control-state levers exercised here (open/cast vote, takeover, handback) also record
 * durable transcript rows since #572, and this spec already owns a migrated database, so the
 * true write path runs. A bare `undefined` would throw the moment a lever recorded.
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
  const actionResolver = { releasePendingChainForConfirmation: jest.fn() };
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
    new AiDmTranscriptService(orm, stream as unknown as ConstructorParameters<typeof AiDmTranscriptService>[1]) as Ctor[12],
    // groundingStore (#577) sits between #572's transcript and #559's optional `db`. It must be
    // passed explicitly: `db` is the LAST parameter, so leaving this out would silently slide the
    // orm into the grounding slot and leave control-state persistence disabled — the exact
    // failure this spec exists to catch.
    { correctionsForPrompt: async () => [] } as unknown as Ctor[13],
    orm as Ctor[14],
    undefined as Ctor[15],
    actionResolver as unknown as Ctor[16],
  );
  return { service, audit, stream, notifications, actionResolver } as Harness;
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
        'announced_recovery',
        // #1042 — the two grant maps, added by 0131 as a separate additive migration.
        'secret_read_approvals', 'pending_tool_confirmations',
        'phase', // #1043 — session lifecycle, added by 0133 as a separate additive migration.
        'collaborative', // #1051 — added by 0138 as a separate additive migration.
        'updated_at',
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
    // ...and it is recognisably ORDINARY player text, so its retry stays an ordinary turn.
    expect(lifecyclePhaseForInput('I open the crypt door.')).toBeUndefined();
  });

  it('a failed lifecycle turn is still replayable AS a lifecycle turn after a restart (#1043)', () => {
    // WHAT THIS GUARDS. The retry/nudge lever replays `last_input`, and a lifecycle turn is not
    // reproducible from that string alone — the phase selects the direction block and lifts the
    // `ended` gate. An earlier fix held that phase in a parallel in-memory map, which meant the
    // input survived a restart and its qualifier did not: a retried greeting came back as an
    // ordinary active turn, and a retried wrap-up was refused outright by the `ended` gate.
    //
    // The phase is now DERIVED from the input, so there is no second value that can fail to
    // survive. This asserts the one stateful link that remains: `last_input` round-trips a
    // lifecycle prompt through real SQLite byte-for-byte, so the derivation still answers on the
    // far side of a restart.
    for (const [prompt, expected] of [
      [GREETING_PROMPT, 'greeting'],
      [WRAP_UP_PROMPT, 'wrap_up'],
    ] as const) {
      const first = firstBoot();
      const session = first.service.getSession(campaignId);
      // The shape a failed greeting/wrap-up leaves behind: the transient phase is bounded by its
      // turn, so it has already settled, and only the stuck ladder shows the failure.
      session.state = 'awaiting_players';
      session.stuck = { reason: 'provider_error', detail: 'provider failed', since: '2026-07-26T00:00:01.000Z', turn: 1 };
      session.phase = expected === 'greeting' ? 'active' : 'ended';
      (first.service as unknown as { lastInputs: Map<number, string> }).lastInputs.set(campaignId, prompt);
      (first.service as unknown as { persistControlState: (s: unknown) => void }).persistControlState(session);

      const restarted = boot();
      const recovered = restarted.service.getSession(campaignId);
      expect(recovered.levers).toContain('retry');
      const replay = (
        restarted.service as unknown as { requireReplayInput: (id: number) => string }
      ).requireReplayInput(campaignId);
      expect(replay).toBe(prompt);
      expect(lifecyclePhaseForInput(replay)).toBe(expected);

      open?.sqlite.close();
      open = null;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
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

  // -------------------------------------------------------------------------
  // #1042 — what the restart DESTROYED, told loudly.
  //
  // #559 (above) made the seat's SHAPE survive. These cover the remainder: grants of authority
  // that deliberately do NOT survive, and must therefore be audited and signalled rather than
  // vanishing. "Silently revoked" is the bug; a loud revocation is a correct outcome.
  // -------------------------------------------------------------------------

  it('revokes secret-read approvals across a restart, with an audit row naming each one', async () => {
    const first = firstBoot();
    await first.service.grantSecretReadApproval(campaignId, dm, 'get_npc', 42, 'the hidden broker');
    await first.service.grantSecretReadApproval(campaignId, dm, 'get_quest', 7);

    // Persisted the moment they were granted — not at some later turn boundary.
    const raw = rawRow();
    expect(String(raw?.secret_read_approvals)).toContain('get_npc');
    expect(String(raw?.secret_read_approvals)).toContain('get_quest');

    const restarted = boot();
    const session = restarted.service.getSession(campaignId);
    // NOT restored. A grant to read one hidden entity was made to a room the DM could see; the
    // server cannot re-verify that room after a restart, so the safe direction is to drop it.
    expect(Object.keys(session.secretReadApprovals ?? {})).toHaveLength(0);

    // ...but LOUDLY. One audit row per grant, naming the exact tool and entity — "two approvals
    // were revoked" is not an answer to "which secret was the AI allowed to read".
    const revoked = restarted.audit.log.mock.calls
      .map((c) => c[0] as { action: string; detail: string })
      .filter((a) => a.action === 'ai-dm.driver.secret.revoked_on_restart');
    expect(revoked).toHaveLength(2);
    expect(revoked.map((a) => a.detail).join(' ')).toContain('get_npc#42');
    expect(revoked.map((a) => a.detail).join(' ')).toContain('get_quest#7');

    const reset = restarted.stream.emit.mock.calls
      .map((c) => c[0] as { type: string; approvalsRevoked?: number })
      .find((e) => e.type === 'session.reset');
    expect(reset?.approvalsRevoked).toBe(2);

    // The reset frame carries COUNTS ONLY. The #557 `secret-approval` frame names the entity and
    // the driver SSE controller forwards it to every member unprojected, so broadcasting one per
    // revoked approval would hand the whole table the ids of the hidden entities the DM had
    // approved — a burst amplification of an existing leak.
    expect(
      restarted.stream.emit.mock.calls
        .map((c) => (c[0] as { type: string }).type)
        .filter((t) => t === 'secret-approval'),
    ).toHaveLength(0);
    expect(JSON.stringify(reset)).not.toContain('42');

    // The row is cleared, so a second restart says nothing. Clearing the source data IS the
    // suppression here — `announced_recovery` tracks a steady shape and cannot express "an
    // event already happened".
    expect(rawRow()?.secret_read_approvals).toBeNull();
    const third = boot();
    third.service.getSession(campaignId);
    expect(
      third.audit.log.mock.calls
        .map((c) => (c[0] as { action: string }).action)
        .filter((a) => a === 'ai-dm.driver.secret.revoked_on_restart'),
    ).toHaveLength(0);
  });

  it('does not report a CONSUMED approval as revoked by the restart', async () => {
    const first = firstBoot();
    await first.service.grantSecretReadApproval(campaignId, dm, 'get_npc', 42);
    await first.service.revokeSecretReadApproval(campaignId, dm, 'get_npc', 42);
    // Spent or withdrawn authority is not authority the restart took away; announcing it would
    // be a false alarm about access that no longer existed.
    expect(rawRow()?.secret_read_approvals).toBeNull();

    const restarted = boot();
    restarted.service.getSession(campaignId);
    expect(
      restarted.audit.log.mock.calls
        .map((c) => (c[0] as { action: string }).action)
        .filter((a) => a === 'ai-dm.driver.secret.revoked_on_restart'),
    ).toHaveLength(0);
  });

  it('discards queued tool confirmations across a restart with an audit row each', () => {
    const first = firstBoot();
    const session = first.service.getSession(campaignId);
    // A confirm-policy tool call is an IRREVERSIBLE live-play write parked on a human's answer.
    session.pendingToolConfirmations = {
      'apply_damage:call_1': {
        id: 'confirm-1',
        tool: 'apply_damage',
        args: { combatantId: 3, amount: 12 },
        toolCallId: 'call_1',
        profile: 'live',
        policy: 'confirm',
        requestedAt: '2026-07-26T00:00:00.000Z',
        actor: `ai-dm-seat:${campaignId}`,
        triggeredBy: 'player-1',
        turnNumber: 4,
      },
    };
    first.service.setPaused(campaignId, true); // any lever persists the session

    const restarted = boot();
    // Not restored: the DM never approved it, and a write nobody approved must not survive into
    // a session where the turn that asked for it no longer exists.
    expect(restarted.service.getSession(campaignId).pendingToolConfirmations).toEqual({});

    const discarded = restarted.audit.log.mock.calls
      .map((c) => c[0] as { action: string; detail: string })
      .filter((a) => a.action === 'ai-dm.driver.confirmation.discarded_on_restart');
    expect(discarded).toHaveLength(1);
    expect(discarded[0].detail).toContain('apply_damage');
    expect(discarded[0].detail).toContain('never executed');

    const reset = restarted.stream.emit.mock.calls
      .map((c) => c[0] as { type: string; confirmationsDiscarded?: number })
      .find((e) => e.type === 'session.reset');
    expect(reset?.confirmationsDiscarded).toBe(1);
    expect(rawRow()?.pending_tool_confirmations).toBeNull();
  });

  it('#1451: restart-discarding a collaborative action confirmation releases its temporary chain retention', () => {
    const first = firstBoot();
    const session = first.service.getSession(campaignId);
    session.pendingToolConfirmations = {
      'apply_action:call-1': {
        id: 'confirm-action-1',
        tool: 'apply_action',
        args: { encounterId: 7, chainId: 'chain-restart-release' },
        toolCallId: 'call-1',
        profile: 'live',
        policy: 'confirm',
        requestedAt: '2026-07-26T00:00:00.000Z',
        actor: `ai-dm-seat:${campaignId}`,
        triggeredBy: 'player-1',
        turnNumber: 4,
        retainedActionChain: { encounterId: 7, chainId: 'chain-restart-release' },
      },
    };
    first.service.setPaused(campaignId, true);

    const restarted = boot();
    restarted.service.getSession(campaignId);
    expect(restarted.actionResolver.releasePendingChainForConfirmation).toHaveBeenCalledWith(7, 'chain-restart-release');
  });

  it('gives a lapsed vote the stream signal it never had', async () => {
    const first = firstBoot();
    await first.service.openVote(campaignId, player, 'override', 'player');
    const live = first.service.getSession(campaignId).vote!;
    open!.sqlite
      .prepare('UPDATE ai_driver_control_state SET vote = ? WHERE campaign_id = ?')
      .run(JSON.stringify({ ...live, expiresAt: '2020-01-01T00:00:00.000Z' }), campaignId);

    const restarted = boot();
    restarted.service.getSession(campaignId);

    // #559 already failed the vote correctly; nobody was told. Hydration skips `open_vote` for
    // an already-resolved vote, so `settled` was null and the recovery notice never fired — the
    // state was right and the table watched a decision quietly stop existing.
    const voteFrames = restarted.stream.emit.mock.calls
      .map((c) => c[0] as { type: string; action?: string; outcome?: string })
      .filter((e) => e.type === 'vote' && e.action === 'expired');
    expect(voteFrames).toHaveLength(1);
    expect(voteFrames[0].outcome).toBe('failed');
    expect(
      restarted.audit.log.mock.calls
        .map((c) => (c[0] as { action: string }).action)
        .filter((a) => a === 'ai-dm.driver.vote.expired_on_restart'),
    ).toHaveLength(1);
  });

  it('announces a lapsed vote even on a seat whose shape was already announced', async () => {
    const first = firstBoot();
    first.service.setPaused(campaignId, true);
    await first.service.openVote(campaignId, player, 'override', 'player');
    const live = first.service.getSession(campaignId).vote!;
    open!.sqlite
      .prepare('UPDATE ai_driver_control_state SET vote = ?, announced_recovery = ? WHERE campaign_id = ?')
      .run(JSON.stringify({ ...live, expiresAt: '2020-01-01T00:00:00.000Z' }), 'paused', campaignId);

    const restarted = boot();
    restarted.service.getSession(campaignId);

    // THE CASE THAT MOTIVATES SPLITTING RestartReconciliation FROM ControlStateRecovery. The
    // seat came back `paused`, a steady shape already announced, so the #559 notice is correctly
    // suppressed. Folding the expiry into that same mechanism would suppress it too.
    expect(
      restarted.audit.log.mock.calls
        .map((c) => (c[0] as { action: string }).action)
        .filter((a) => a === 'ai-dm.driver.control_state.recovered'),
    ).toHaveLength(0);
    expect(
      restarted.stream.emit.mock.calls
        .map((c) => c[0] as { type: string; action?: string })
        .filter((e) => e.type === 'vote' && e.action === 'expired'),
    ).toHaveLength(1);
  });

  it('says nothing at all when a restart destroyed nothing', () => {
    const first = firstBoot();
    first.service.setPaused(campaignId, true);
    const restarted = boot();
    restarted.service.getSession(campaignId);
    // The reset notice has to stay rare enough to mean something. A seat with no outstanding
    // grants and no lapsed vote produces no session.reset frame at all.
    expect(
      restarted.stream.emit.mock.calls
        .map((c) => (c[0] as { type: string }).type)
        .filter((t) => t === 'session.reset'),
    ).toHaveLength(0);
  });

  it('a malformed persisted grant map is dropped rather than announced', () => {
    firstBoot();
    open!.sqlite
      .prepare('UPDATE ai_driver_control_state SET secret_read_approvals = ? WHERE campaign_id = ?')
      .run('{"broken": {"tool": 12, "entityId": "nope"}}', campaignId);
    const restarted = boot();
    expect(() => restarted.service.getSession(campaignId)).not.toThrow();
    // An audit line describing a grant we cannot actually read is worse than no line: it would
    // tell a DM the AI had access to something the row does not really say.
    expect(
      restarted.audit.log.mock.calls
        .map((c) => (c[0] as { action: string }).action)
        .filter((a) => a === 'ai-dm.driver.secret.revoked_on_restart'),
    ).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // #1043 — the session lifecycle phase across a restart.
  // -------------------------------------------------------------------------

  it('defaults to `active` and persists a settled phase across a restart', () => {
    const first = firstBoot();
    expect(first.service.getSession(campaignId).phase).toBe('active');
    expect(rawRow()).toBeUndefined();

    first.service.setPaused(campaignId, true);
    // `active` is the pre-#1043 behaviour, so an upgraded database full of live campaigns comes
    // back indistinguishable from before rather than in a phase nobody put it in.
    expect(rawRow()).toMatchObject({ phase: 'active' });

    const session = first.service.getSession(campaignId);
    session.phase = 'ended';
    first.service.setPaused(campaignId, false);
    expect(rawRow()).toMatchObject({ phase: 'ended' });

    // `ended` is a settled phase: it survives, because a session someone deliberately closed
    // must not quietly reopen because the server was redeployed.
    const restarted = boot();
    expect(restarted.service.getSession(campaignId).phase).toBe('ended');
  });

  it('reconciles an interrupted `wrap_up` to `active` and says so out loud', () => {
    const first = firstBoot();
    const session = first.service.getSession(campaignId);
    session.phase = 'wrap_up';
    first.service.setPaused(campaignId, true);
    expect(rawRow()).toMatchObject({ phase: 'wrap_up' });

    const restarted = boot();
    // A transient phase on disk means, by construction, that its turn never returned — the turn
    // lived in process memory and its narration is gone. Coming back still `wrap_up` would
    // promise a closing summary nothing is going to produce.
    expect(restarted.service.getSession(campaignId).phase).toBe('active');

    // ...and NOT silently. A DM who pressed Wrap Up before a deploy must not have to work out
    // for themselves that the summary is never arriving.
    const audited = restarted.audit.log.mock.calls
      .map((c) => c[0] as { action: string; detail: string })
      .filter((a) => a.action === 'ai-dm.driver.session.phase_interrupted');
    expect(audited).toHaveLength(1);
    expect(audited[0].detail).toContain('wrap_up');
    expect(restarted.notifications.notifyCampaign).toHaveBeenCalled();

    // The reconciled phase reaches disk, which is the only thing stopping the notice repeating
    // on every subsequent boot.
    expect(rawRow()).toMatchObject({ phase: 'active' });
    const third = boot();
    third.service.getSession(campaignId);
    expect(
      third.audit.log.mock.calls
        .map((c) => (c[0] as { action: string }).action)
        .filter((a) => a === 'ai-dm.driver.session.phase_interrupted'),
    ).toHaveLength(0);
  });

  it('announces an interrupted phase even on a seat whose shape was already announced', () => {
    const first = firstBoot();
    const session = first.service.getSession(campaignId);
    session.phase = 'greeting';
    first.service.setPaused(campaignId, true);
    open!.sqlite
      .prepare('UPDATE ai_driver_control_state SET announced_recovery = ? WHERE campaign_id = ?')
      .run('paused', campaignId);

    const restarted = boot();
    restarted.service.getSession(campaignId);

    // WHY THE PHASE NOTICE IS NOT A ControlStateRecovery. The seat came back `paused` — a steady
    // shape already announced — so #559's recovery notice is correctly suppressed. Routing the
    // phase through that same mechanism would suppress it too, and on a seat that came back
    // clean it would never fire at all (`settled === null`).
    expect(
      restarted.audit.log.mock.calls
        .map((c) => (c[0] as { action: string }).action)
        .filter((a) => a === 'ai-dm.driver.control_state.recovered'),
    ).toHaveLength(0);
    expect(
      restarted.audit.log.mock.calls
        .map((c) => (c[0] as { action: string }).action)
        .filter((a) => a === 'ai-dm.driver.session.phase_interrupted'),
    ).toHaveLength(1);
  });

  it('says nothing about the phase when a restart interrupted none', () => {
    const first = firstBoot();
    first.service.setPaused(campaignId, true);
    const restarted = boot();
    restarted.service.getSession(campaignId);
    expect(
      restarted.audit.log.mock.calls
        .map((c) => (c[0] as { action: string }).action)
        .filter((a) => a === 'ai-dm.driver.session.phase_interrupted'),
    ).toHaveLength(0);
  });

  it('an unknown persisted phase falls back to `active` rather than being carried forward', () => {
    firstBoot();
    open!.sqlite.prepare('UPDATE ai_driver_control_state SET phase = ? WHERE campaign_id = ?').run('bogus', campaignId);
    const restarted = boot();
    // Same reasoning as #559's other hydration allowlists: an unrecognised value must resolve to
    // the safe default, not be trusted into the session where nothing knows what it means.
    expect(restarted.service.getSession(campaignId).phase).toBe('active');
  });

  // -------------------------------------------------------------------------
  // #1051 — collaborative handoff across a restart.
  // -------------------------------------------------------------------------

  it('restores collaborative handoff after a restart', () => {
    const first = firstBoot();
    first.service.setCollaborative(campaignId, true);
    expect(first.service.getSession(campaignId).state).toBe('collaborative');
    expect(rawRow()).toMatchObject({ collaborative: 1 });

    const restarted = boot();
    const s = restarted.service.getSession(campaignId);
    // A deploy must not hand the AI back the authority to change the board on its own. This is
    // the same class of silent downgrade as a takeover being revoked by a restart (#1042) —
    // authority quietly widening because a process died.
    expect(s.state).toBe('collaborative');
    expect(s.collaborative).toBe(true);
  });

  it('a PAUSED collaborative seat comes back paused, and resumes back into the mode', () => {
    const first = firstBoot();
    first.service.setCollaborative(campaignId, true);
    first.service.setPaused(campaignId, true);
    expect(rawRow()).toMatchObject({ status: 'paused', collaborative: 1 });

    const restarted = boot();
    // The hydration reconciliation used to key on `state === 'running'` only. With a third
    // non-frozen ladder value in play, a paused collaborative seat fell through every branch and
    // came back `status: 'idle'` — silently un-paused, which is the one thing restart handling
    // must never do. Guarding this here because the bug is invisible from the mode's own tests.
    expect(restarted.service.getSession(campaignId).status).toBe('paused');
    expect(restarted.service.getSession(campaignId).state).toBe('paused');

    restarted.service.setPaused(campaignId, false);
    expect(restarted.service.getSession(campaignId).state).toBe('collaborative');
  });

  it('keeps the mode under a human takeover and hands the seat back into it', async () => {
    const first = firstBoot();
    first.service.setCollaborative(campaignId, true);
    await first.service.grantTakeover(campaignId, dm, undefined, 'take it from here', 'dm');
    expect(first.service.getSession(campaignId).state).toBe('human_control');

    const restarted = boot();
    // The urgent condition owns the display slot; the mode persists underneath.
    expect(restarted.service.getSession(campaignId).state).toBe('human_control');
    expect(restarted.service.getSession(campaignId).collaborative).toBe(true);

    await restarted.service.handback(campaignId, dm, 'done', 'dm');
    expect(restarted.service.getSession(campaignId).state).toBe('collaborative');
  });

  it('an unset column reads as mode-off', () => {
    const first = firstBoot();
    first.service.setPaused(campaignId, true);
    expect(rawRow()).toMatchObject({ collaborative: 0 });
    const restarted = boot();
    expect(restarted.service.getSession(campaignId).collaborative).toBe(false);
  });

  it('a persistence failure never propagates out of a control lever', () => {
    const first = firstBoot();
    open!.sqlite.exec('DROP TABLE ai_driver_control_state');
    // Durability is best-effort: losing the write must not fail the pause the DM just asked for.
    expect(() => first.service.setPaused(campaignId, true)).not.toThrow();
    expect(first.service.getSession(campaignId).state).toBe('paused');
  });

  // #1495 — the autonomous seat's aftermath economy-grant budget must survive a restart mid-
  // window, or a restart-to-refill becomes a trivial cap bypass (the exact defect reported).
  describe('aftermath economy-grant budget persistence (#1495)', () => {
    /** Force a persistControlState write through a PUBLIC lever (setPaused), matching every
     * other test in this file — persistControlState always writes whatever is currently on the
     * session object, so mutating aftermathGrantWindow first and pausing second is a faithful,
     * privileged-method-free way to get it onto disk. */
    function persistWindow(h: Harness, window: {
      encounterId: number;
      endedAt: string;
      treasuryGranted: number;
      inventoryQtyGranted: number;
    }) {
      const session = h.service.getSession(campaignId);
      session.aftermathGrantWindow = window;
      h.service.setPaused(campaignId, true);
    }

    it('survives a restart mid-window: the exact totals round-trip, not reset to undefined', () => {
      const first = firstBoot();
      const window = { encounterId: 42, endedAt: '2026-07-26T00:10:00.000Z', treasuryGranted: 400, inventoryQtyGranted: 25 };
      persistWindow(first, window);

      expect(rawRow()?.aftermath_grant_window).toEqual(JSON.stringify(window));

      // "Restart": close the handle, reopen the same file, build a brand-new service instance —
      // the exact simulated-restart shape every other test in this file uses.
      const restarted = boot();
      const restoredSession = restarted.service.getSession(campaignId);
      // Deterministic, unconditional assertion (test-quality rule: no early return / conditional
      // skip here) — this is the P1 bug: before #1495's persistence fix, this field was entirely
      // absent from persistControlState/loadPersistedControlState, so it silently came back
      // `undefined` on every restart no matter what was written, and the very next economy grant
      // reopened a full, unearned budget.
      expect(restoredSession.aftermathGrantWindow).toEqual(window);
    });

    it('a malformed persisted window is dropped (fails closed to no tracked window, never to a wrong one)', () => {
      const first = firstBoot();
      persistWindow(first, { encounterId: 1, endedAt: '2026-01-01T00:00:00.000Z', treasuryGranted: 0, inventoryQtyGranted: 0 });
      // Corrupt the column directly, bypassing the service — simulates a hand-edited DB or a
      // future incompatible shape.
      const db = new Database(dbFilePath(dataDir));
      try {
        db
          .prepare('UPDATE ai_driver_control_state SET aftermath_grant_window = ? WHERE campaign_id = ?')
          .run(JSON.stringify({ encounterId: 'not-a-number', endedAt: 42 }), campaignId);
      } finally {
        db.close();
      }
      const restored = boot().service.getSession(campaignId);
      expect(restored.aftermathGrantWindow).toBeNull();
    });

    it('member-facing session payload never includes the aftermath grant window or the other internal guard fields', () => {
      // Regression for the Codex :624 finding: a TypeScript `Omit` only narrows the STATIC type,
      // it does not remove a runtime object key. Assert on the SERIALIZED object (JSON round-
      // trip, exactly what an HTTP client receives), not on the TypeScript type, or this test
      // would pass even if toPublicAiDmSessionState's destructuring silently dropped a field
      // again — which is precisely how the bug shipped the first time.
      const first = firstBoot();
      persistWindow(first, { encounterId: 1, endedAt: '2026-01-01T00:00:00.000Z', treasuryGranted: 50, inventoryQtyGranted: 3 });
      const session = first.service.getSession(campaignId);
      // Seed every private guard field with a truthy value so a destructuring omission for ANY
      // of them would show up as an unwanted key below, not just the three #1495 added.
      session.secretReadApprovals = { 'get_npc:1': { tool: 'get_npc', entityId: 1, grantedBy: '9', grantedAt: '2026-01-01T00:00:00.000Z', note: null, consumed: false } };
      session.driverGeneratedMapIds = [7];
      session.driverAuthoredEncounterIds = [8];
      session.generateMapCallsThisTurn = 1;
      session.confirmToolAttemptsThisTurn = 1;
      session.policyViolationsThisTurn = 1;
      session.pendingToolConfirmations = {
        'adjust_treasury:tc1': {
          id: 'confirm-1', tool: 'adjust_treasury', args: { delta: { gp: 10 } }, toolCallId: 'tc1',
          profile: 'live', policy: 'confirm', requestedAt: '2026-01-01T00:00:00.000Z', actor: 'ai-dm-seat:1',
          triggeredBy: '1', turnNumber: 1,
        },
      };

      const publicSession = toPublicAiDmSessionState(session);
      const serialized = JSON.parse(JSON.stringify(publicSession)) as Record<string, unknown>;
      const forbiddenKeys = [
        'aftermathGrantWindow',
        'secretReadApprovals',
        'driverGeneratedMapIds',
        'driverAuthoredEncounterIds',
        'generateMapCallsThisTurn',
        'confirmToolAttemptsThisTurn',
        'policyViolationsThisTurn',
        'pendingToolConfirmations',
        'detached',
      ];
      for (const key of forbiddenKeys) {
        expect(Object.prototype.hasOwnProperty.call(serialized, key)).toBe(false);
      }
      // And the projection is not simply empty — real member-visible fields are still there.
      expect(serialized.campaignId).toBe(campaignId);
    });

    it('#1495: a confirmation discarded during hydration on restart releases its queue-time reservation', () => {
      // Regression for the Codex :5761 finding (over-charging half): pendingToolConfirmations is
      // discarded WHOLESALE on restart (#1042 — a queued confirmation is a grant of authority the
      // server can no longer verify), but the ECONOMY RESERVATION it made at queue time already
      // landed in the persisted window before this restart and IS restored. Without releasing it,
      // discarded loot that never executed would keep consuming the campaign's allowance.
      const first = firstBoot();
      const session = first.service.getSession(campaignId);
      session.aftermathGrantWindow = { encounterId: 1, endedAt: '2026-01-01T00:00:00.000Z', treasuryGranted: 0, inventoryQtyGranted: 50 };
      // Reserve 30 more for a confirmation that is about to be "discarded" by a restart before a
      // DM ever resolves it.
      noteDriverEconomyGrant(session, 'add_inventory_item', { name: 'Trinket', qty: 30 });
      expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(80);
      session.pendingToolConfirmations = {
        'add_inventory_item:call-1': {
          id: 'confirm-1',
          tool: 'add_inventory_item',
          args: { name: 'Trinket', qty: 30 },
          toolCallId: 'call-1',
          profile: 'live',
          policy: 'confirm',
          requestedAt: '2026-01-01T00:00:00.000Z',
          actor: 'ai-dm-seat:1',
          triggeredBy: '1',
          turnNumber: 1,
          aftermathGrantWindow: { encounterId: 1, endedAt: '2026-01-01T00:00:00.000Z' },
        },
      };
      first.service.setPaused(campaignId, true); // forces the CURRENT session (window=80, 1 pending) to disk

      // "Restart": close the handle, reopen the same file, build a brand-new service instance.
      const restored = boot().service.getSession(campaignId);
      // The confirmation itself is gone (discarded per #1042, never restored)...
      expect(restored.pendingToolConfirmations).toEqual({});
      // ...and its 30-qty reservation was released from the restored window: back to 50, not
      // left at 80 where it would keep consuming the allowance until another encounter ends.
      expect(restored.aftermathGrantWindow?.inventoryQtyGranted).toBe(50);
    });

    it('#1495: an evicted confirmation (past the 20-entry pending-queue cap) releases its reservation', () => {
      // Regression for the Codex :5761 finding (over-charging half, eviction side): queueing
      // charges the window immediately, but the queue itself is capped at
      // MAX_PENDING_TOOL_CONFIRMATIONS — the oldest entry is evicted once a 21st arrives. An
      // evicted confirmation never executes either, so its reservation must release the same as
      // an explicit reject.
      const first = firstBoot();
      const session = first.service.getSession(campaignId);
      session.aftermathGrantWindow = { encounterId: 1, endedAt: '2026-01-01T00:00:00.000Z', treasuryGranted: 0, inventoryQtyGranted: 0 };

      // `queueToolConfirmation` is private and reservation happens at its call site
      // (executeToolCalls), not inside it — there is no public surface for "queue N confirm-
      // policy economy calls without running N real AI turns" (each turn queues at most
      // DRIVER_CONFIRM_TOOL_ATTEMPTS_PER_TURN=3), so this reaches into both directly. Fake timers
      // give each call a strictly increasing `requestedAt` (queueToolConfirmation's own eviction
      // order key), so which entry is "oldest" is deterministic rather than depending on how fast
      // this loop happens to run.
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
        for (let i = 0; i < MAX_PENDING_TOOL_CONFIRMATIONS + 1; i++) {
          const args = { name: 'Trinket', qty: 10 };
          noteDriverEconomyGrant(session, 'add_inventory_item', args);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (first.service as any).queueToolConfirmation(
            session,
            { id: `call-${i}`, name: 'add_inventory_item' },
            args,
            'live',
            'confirm',
            'ai-dm-seat:1',
            '1',
            undefined,
            { encounterId: 1, endedAt: '2026-01-01T00:00:00.000Z' },
          );
          jest.setSystemTime(new Date(Date.now() + 1));
        }
      } finally {
        jest.useRealTimers();
      }

      // Exactly MAX_PENDING_TOOL_CONFIRMATIONS remain: the oldest (call-0) was evicted.
      const remaining = Object.values(session.pendingToolConfirmations ?? {});
      expect(remaining).toHaveLength(MAX_PENDING_TOOL_CONFIRMATIONS);
      expect(remaining.some((c) => c.toolCallId === 'call-0')).toBe(false);

      // The evicted confirmation's reservation was released: only the REMAINING 20 grants'
      // worth (200) still counts against the window, not all 21 (210) that were ever queued.
      expect(session.aftermathGrantWindow?.inventoryQtyGranted).toBe(MAX_PENDING_TOOL_CONFIRMATIONS * 10);
    });

    it('#1495: a throwing window lookup during approval leaves the confirmation recoverable and its reservation intact (Codex :6632)', async () => {
      // Regression for the ordering bug the :6632 finding reported: approval used to delete +
      // persist the pending confirmation BEFORE the async encounter read that verifies its
      // window is still current. If that read rejected (a transient DB failure is enough), the
      // throw propagated past the point where the confirmation could ever be recovered — gone
      // from the map/disk, its reservation still fully charged, with no pending confirmation
      // left for hydration to release it against. The fix reorders the read to run FIRST, while
      // the confirmation is still safely in the map.
      //
      // This harness's `makeService()` deliberately leaves `encounters` (Ctor[9]) undefined —
      // `resolveSessionProfile`'s `this.encounters.listForCampaign(...)` therefore throws
      // exactly the way a real DB failure would, with no extra stubbing needed to prove it.
      const first = firstBoot();
      const session = first.service.getSession(campaignId);
      session.aftermathGrantWindow = { encounterId: 1, endedAt: '2026-01-01T00:00:00.000Z', treasuryGranted: 0, inventoryQtyGranted: 50 };
      noteDriverEconomyGrant(session, 'add_inventory_item', { name: 'Trinket', qty: 30 });
      expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(80);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (first.service as any).queueToolConfirmation(
        session,
        { id: 'call-1', name: 'add_inventory_item' },
        { name: 'Trinket', qty: 30 },
        'live',
        'confirm',
        'ai-dm-seat:1',
        '1',
        undefined,
        { encounterId: 1, endedAt: '2026-01-01T00:00:00.000Z' },
      );
      const queued = Object.values(session.pendingToolConfirmations ?? {});
      expect(queued).toHaveLength(1);
      const confirmationId = queued[0].id;

      // Deterministic, unconditional assertion (test-quality rule): the approval call MUST
      // reject, every time — no early return or conditional skip around it.
      await expect(first.service.resolveToolConfirmation(campaignId, dm, confirmationId, 'approve', 'dm')).rejects.toThrow();

      // The confirmation is still exactly where it was — recoverable, not silently gone.
      const stillPending = Object.values(session.pendingToolConfirmations ?? {});
      expect(stillPending).toHaveLength(1);
      expect(stillPending[0].id).toBe(confirmationId);
      // Its reservation is untouched: neither released (which would under-protect a later
      // legitimate grant this window still has room for) nor double-counted. Still exactly 80.
      expect(session.aftermathGrantWindow.inventoryQtyGranted).toBe(80);
    });
  });
});
