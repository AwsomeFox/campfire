import fs from 'node:fs';
import { describe, expect, it, jest, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import { openDatabase, type DrizzleDb } from '../../src/db/db.module';
import { campaigns } from '../../src/db/schema';
import { AiDriverService } from '../../src/modules/ai-driver/ai-driver.service';
import { AiDmTranscriptService } from '../../src/modules/ai-driver/ai-driver-transcript.service';
import type { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { TableSafetyService } from '../../src/modules/safety/table-safety.service';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #599 — a safety hold survives a restart, and the AI seat comes back frozen.
 *
 * A REAL-SQLITE spec for the same reason #559's is: the guarantee is that state written by one
 * process is honoured by the next, so the "restart" here closes the handle, reopens the same
 * data dir, and builds brand-new services over the reopened connection. The failure this exists
 * to catch is the worst one available — a deploy in the middle of a stopped session quietly
 * un-pausing the table.
 */

type DriverCtor = ConstructorParameters<typeof AiDriverService>;

function makeSafety(orm: DrizzleDb): TableSafetyService {
  const audit = { log: jest.fn(async () => undefined) };
  const events = { emit: jest.fn() };
  const notifications: Pick<NotificationsService, 'notifyCampaign' | 'notifyCampaignIncludingActor'> = {
    notifyCampaign: jest.fn(async () => undefined),
    notifyCampaignIncludingActor: jest.fn(async () => undefined),
  };
  return new TableSafetyService(
    orm,
    audit as unknown as ConstructorParameters<typeof TableSafetyService>[1],
    events as unknown as ConstructorParameters<typeof TableSafetyService>[2],
    notifications as unknown as ConstructorParameters<typeof TableSafetyService>[3],
  );
}

/**
 * Only the collaborators the control-state / safety paths touch are stubbed. The parameter list
 * is positional on purpose, mirroring ai-driver-control-state-persistence.spec.ts: `safety` is
 * the LAST parameter (after #559's optional `db`), which is precisely why appending it there
 * rather than inserting it mid-list left every existing positional construction valid.
 */
function makeDriver(orm: DrizzleDb, safety: TableSafetyService): AiDriverService {
  const aiDm = { registerDriverSessionTeardown: jest.fn(), isExperimentalEnabled: jest.fn(() => Promise.resolve(true)) };
  const audit = { log: jest.fn(async () => undefined) };
  const stream = { emit: jest.fn() };
  const notifications = {
    memberRoles: jest.fn(async () => new Map<number, string>([[1, 'player']])),
    notifyCampaign: jest.fn(async () => undefined),
  };
  return new AiDriverService(
    aiDm as unknown as DriverCtor[0],
    undefined as unknown as DriverCtor[1],
    audit as unknown as DriverCtor[2],
    stream as unknown as DriverCtor[3],
    notifications as unknown as DriverCtor[4],
    undefined as unknown as DriverCtor[5],
    undefined as unknown as DriverCtor[6],
    undefined as unknown as DriverCtor[7],
    undefined as unknown as DriverCtor[8],
    undefined as unknown as DriverCtor[9],
    undefined as unknown as DriverCtor[10],
    undefined as unknown as DriverCtor[11],
    new AiDmTranscriptService(orm, stream as unknown as ConstructorParameters<typeof AiDmTranscriptService>[1]) as DriverCtor[12],
    { correctionsForPrompt: async () => [] } as unknown as DriverCtor[13],
    orm as DriverCtor[14],
    safety as DriverCtor[15],
  );
}

describe('table safety hold survives a restart (#599, real SQLite)', () => {
  let dataDir: string;
  let open: { sqlite: Database.Database; orm: DrizzleDb } | null = null;
  const campaignId = 1;

  const boot = () => {
    open = openDatabase(dataDir);
    return open;
  };
  const restart = () => {
    open?.sqlite.close();
    open = null;
    return boot();
  };

  afterEach(() => {
    open?.sqlite.close();
    open = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('a held table comes back held, with the AI seat frozen', async () => {
    dataDir = makeTempDataDir();
    const first = boot();
    first.orm
      .insert(campaigns)
      .values({ id: campaignId, name: 'Held', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
      .run();

    const safety = makeSafety(first.orm);
    const driver = makeDriver(first.orm, safety);
    await safety.activate(campaignId, null);

    // The freeze reached the live session through the registered hook.
    expect(driver.getSession(campaignId).state).toBe('paused');
    expect(safety.isHeld(campaignId)).toBe(true);

    // --- restart ---------------------------------------------------------------
    const second = restart();
    const safety2 = makeSafety(second.orm);
    const driver2 = makeDriver(second.orm, safety2);

    expect(safety2.isHeld(campaignId)).toBe(true);
    const session = driver2.getSession(campaignId);
    expect(session.state).toBe('paused');
    expect(session.status).toBe('paused');
  });

  it('freezes a seat whose stored ladder state says running — the hold outranks the row', async () => {
    dataDir = makeTempDataDir();
    const first = boot();
    first.orm
      .insert(campaigns)
      .values({ id: campaignId, name: 'Torn', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
      .run();

    // Simulate the crash window the durable hold exists to cover: the hold row is written, but
    // the process dies before the freeze hook reaches the driver's control state, so the stored
    // ladder state still says `running`. Written with NO driver attached, exactly like that.
    const safety = makeSafety(first.orm);
    const driverBefore = makeDriver(first.orm, makeSafety(first.orm));
    driverBefore.getSession(campaignId); // persists a `running` control-state row
    await safety.activate(campaignId, null);
    first.sqlite
      .prepare(`UPDATE ai_driver_control_state SET status = 'idle', state = 'running' WHERE campaign_id = ?`)
      .run(campaignId);

    const second = restart();
    const safety2 = makeSafety(second.orm);
    const driver2 = makeDriver(second.orm, safety2);
    const session = driver2.getSession(campaignId);
    // Hydration re-derives the freeze from the hold rather than trusting the stale row.
    expect(session.state).toBe('paused');
    expect(session.status).toBe('paused');
  });

  it('a released hold does not re-freeze the seat on the next restart', async () => {
    dataDir = makeTempDataDir();
    const first = boot();
    first.orm
      .insert(campaigns)
      .values({ id: campaignId, name: 'Cleared', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
      .run();

    const safety = makeSafety(first.orm);
    const driver = makeDriver(first.orm, safety);
    await safety.activate(campaignId, null);
    await safety.release(campaignId, 'The DM', 'resume', null);
    // Release does not auto-resume; the facilitator does it explicitly, and now can.
    driver.setPaused(campaignId, false);

    const second = restart();
    const safety2 = makeSafety(second.orm);
    const driver2 = makeDriver(second.orm, safety2);
    expect(safety2.isHeld(campaignId)).toBe(false);
    expect(driver2.getSession(campaignId).state).not.toBe('paused');
  });

  it('activation never throws, even when the same campaign is held twice concurrently', async () => {
    dataDir = makeTempDataDir();
    const first = boot();
    first.orm
      .insert(campaigns)
      .values({ id: campaignId, name: 'Race', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
      .run();

    const safety = makeSafety(first.orm);
    // Both resolve. There is no compare-and-set to lose and no state machine to reject, which
    // is the entire point: pausing twice is harmless, and any guarantee that could make a pause
    // fail is worth less than the pause.
    const [a, b] = await Promise.all([safety.activate(campaignId, { id: '1', name: 'Ana' }), safety.activate(campaignId, null)]);
    expect(a.active).toBe(true);
    expect(b.active).toBe(true);
    expect(safety.getHold(campaignId)).toMatchObject({ activationCount: 1, activatedByName: 'Ana', anonymous: false });
  });
});
