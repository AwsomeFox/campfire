import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { openDatabase, dbFilePath } from '../../src/db/db.module';
import * as schema from '../../src/db/schema';
import { campaigns, characters, combatants, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import * as idempotency from '../../src/modules/encounters/encounter-idempotency';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #2032: a genuine `EncounterOpRaceMarker` race requires TWO SEPARATE
 * better-sqlite3 connections against the SAME database file. `updateCombatant`,
 * `adjustCombatantResource`, `rollCombatantInitiative`, and `rollDeathSave` each
 * open their own `db.transaction()` whose FIRST statement is
 * `findPriorEncounterOp`'s bounded-retention DELETE — this immediately promotes
 * the connection to SQLite's single writer role for the rest of that
 * transaction. Concretely, that rules out the two techniques that look tempting
 * first:
 *
 *  - A raw two-connection interleave (one connection pauses after its own
 *    reads, the other tries to write) does not reach a clean primary-key
 *    conflict: WAL's snapshot isolation makes the paused connection's own
 *    later write throw `SQLITE_BUSY_SNAPSHOT` instead, and if the pause is
 *    positioned BEFORE that connection's own early lookup, the lookup then
 *    simply finds the other connection's already-committed row and takes the
 *    ordinary REPLAY branch — never reaching the race path either way.
 *  - Seeding the "winner" row on the SAME connection/transaction as the
 *    "loser" (e.g. from a spy called mid-transaction) DOES throw a real
 *    `EncounterOpRaceMarker` on the loser's own insert — but that seeded row
 *    was never committed on its own; it rolls back together with the rest of
 *    the loser's doomed transaction. The loser's own subsequent
 *    `readEncounterOpAfterRace` then finds nothing and reports
 *    `IDEMPOTENCY_KEY_REUSE` instead — exactly the dead end #2032 documents.
 *
 * The working shape combines both requirements: a truly SEPARATE connection
 * (`openSecondConnection`) so the winner's write is durable and survives the
 * loser's rollback, plus a narrow, restorable mock of the shared
 * `findPriorEncounterOp` export (so the loser's own early lookup(s) report a
 * miss even though the winner's row already exists) so the loser's REAL,
 * unmocked write logic proceeds into its REAL `recordEncounterOp` call, which
 * then hits a REAL primary-key conflict against the winner's REAL, durable
 * row. `runAsRaceLoser` below also wraps the real `recordEncounterOp` (without
 * replacing its behavior) so every test can assert the marker was actually
 * thrown internally, not just that the final answer happens to look right.
 */

const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };

function buildService(orm: any): { service: EncountersService; rolls: RollsService } {
  const audit = new AuditService(orm);
  const events = new CampaignEventsService();
  const rolls = new RollsService(orm);
  const revisions = new RevisionsService(orm, new ModerationService(orm, audit));
  const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit), new AttachmentDerivativesService(orm));
  const campaignLibrary = new CampaignLibraryService(orm, audit, events);
  // AGENTS.md: annotate the double against `Pick<RealService, 'methodsActuallyUsed'>` rather
  // than casting blindly — an annotation is checked for missing/misspelled members, whereas an
  // assertion (and `as any` especially) checks nothing. `EncountersService` declares this
  // dependency as the concrete class, so the final cast is unavoidable; the annotation above it
  // is what does the work. Note the known limit of the double-side-only variant: it will NOT
  // catch production code starting to call a THIRD notifications method, since the Pick list
  // isn't forced to grow. That would need consumer-side narrowing, which is out of scope here.
  const notifications: Pick<NotificationsService, 'notifyCampaign' | 'notifyUser'> = {
    notifyCampaign: jest.fn().mockResolvedValue(undefined),
    notifyUser: jest.fn().mockResolvedValue(undefined),
  };
  const service = new EncountersService(
    orm,
    audit,
    events,
    rolls,
    revisions,
    attachments,
    campaignLibrary,
    notifications as unknown as NotificationsService,
  );
  return { service, rolls };
}

/** Open a genuinely separate better-sqlite3 connection against the SAME file. */
function openSecondConnection(dataDir: string) {
  const sqlite = new Database(dbFilePath(dataDir));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const orm = drizzle(sqlite, { schema });
  return { sqlite, orm };
}

/**
 * Run `fn` (the "loser" invocation) with the first `missCount` calls to
 * `findPriorEncounterOp` forced to report "nothing found" -- covering every
 * early-lookup check a target method makes BEFORE its own write transaction
 * (so the loser's real write logic proceeds even though a winner's claim
 * already exists on a separate, already-committed connection) -- and every
 * call AFTER that budget delegated to the REAL implementation. That second
 * part matters: `rollCombatantInitiative`'s and `rollDeathSave`'s own
 * post-exception RECOVERY paths call `findPriorEncounterOp` again (by a
 * different name -- `findPrior()` / `replayCommittedDeathSave()` -- but the
 * same underlying export) to fetch the winner's now-committed row. A blanket,
 * unconditional mock would defeat that recovery too, masking the real
 * `EncounterOpRaceMarker` behind a DIFFERENT, unrelated failure
 * (`DEATH_SAVE_RESULT_UNAVAILABLE` / a raw escaped race-marker Error) instead
 * of exercising it.
 *
 * `recordEncounterOp` itself is left real (never mocked) but wrapped so the
 * test can assert the marker was genuinely thrown by REAL SQLite, not skipped.
 */
async function runAsRaceLoser<T>(
  fn: () => Promise<T>,
  missCount = 2,
): Promise<{ result?: T; error?: unknown; raceMarkerThrown: boolean }> {
  const realFind = idempotency.findPriorEncounterOp;
  const realRecord = idempotency.recordEncounterOp;
  let remainingMisses = missCount;
  let raceMarkerThrown = false;
  const findSpy = jest
    .spyOn(idempotency, 'findPriorEncounterOp')
    .mockImplementation((...args: Parameters<typeof realFind>) => {
      if (remainingMisses > 0) {
        remainingMisses -= 1;
        return null;
      }
      return realFind(...args);
    });
  const recordSpy = jest
    .spyOn(idempotency, 'recordEncounterOp')
    .mockImplementation((...args: Parameters<typeof realRecord>) => {
      try {
        return realRecord(...args);
      } catch (err) {
        if (err instanceof idempotency.EncounterOpRaceMarker) raceMarkerThrown = true;
        throw err;
      }
    });
  try {
    const result = await fn();
    return { result, raceMarkerThrown };
  } catch (error) {
    return { error, raceMarkerThrown };
  } finally {
    findSpy.mockRestore();
    recordSpy.mockRestore();
  }
}

describe('encounter idempotency: genuine two-connection race (issue #2032)', () => {
  let dataDir: string;
  const openHandles: Array<{ close: () => void }> = [];

  afterEach(() => {
    // Close every connection BEFORE removing the directory. better-sqlite3 holds native
    // Statement objects tied to the Node environment; leaving handles open leaks file
    // descriptors across the suite and makes teardown OS-dependent (Windows refuses to
    // unlink an open DB). Closing is also what keeps the WAL/-shm sidecars from outliving
    // the test (issue #2032 review).
    for (const handle of openHandles.splice(0)) {
      try {
        handle.close();
      } catch {
        /* already closed — teardown must stay best-effort */
      }
    }
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function seed() {
    dataDir = makeTempDataDir();
    const { sqlite: sqliteA, orm: ormA } = openDatabase(dataDir);
    openHandles.push(sqliteA);
    const ts = new Date().toISOString();
    const [camp] = ormA.insert(campaigns).values({ name: 'Race', createdAt: ts, updatedAt: ts }).returning().all();
    const [enc] = ormA
      .insert(encounters)
      .values({ campaignId: camp.id, name: 'Fight', status: 'running', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const { sqlite: sqliteB, orm: ormB } = openSecondConnection(dataDir);
    openHandles.push(sqliteB);
    return { ormA, ormB, campaignId: camp.id, encounterId: enc.id };
  }

  describe('updateCombatant', () => {
    it('a race loser replays the winner\'s HP, and the DB reflects exactly ONE hpDelta (not a double-apply)', async () => {
      const { ormA, ormB, encounterId } = seed();
      const [combatant] = ormA
        .insert(combatants)
        .values({ encounterId, kind: 'monster', name: 'Goblin', hpCurrent: 10, hpMax: 10 })
        .returning()
        .all();

      const { service: serviceA } = buildService(ormA);
      const { service: serviceB } = buildService(ormB);

      const winner = await serviceB.updateCombatant(
        encounterId,
        combatant.id,
        { hpDelta: -3, idempotencyKey: 'race-key-1' },
        dmUser,
        'dm',
      );
      expect(winner.hpCurrent).toBe(7);

      const { result, error, raceMarkerThrown } = await runAsRaceLoser(() =>
        serviceA.updateCombatant(encounterId, combatant.id, { hpDelta: -3, idempotencyKey: 'race-key-1' }, dmUser, 'dm'),
      );

      expect(error).toBeUndefined();
      expect(raceMarkerThrown).toBe(true);
      expect(result?.hpCurrent).toBe(7); // the WINNER's result, not a second -3 applied on top

      const raw = ormA.select().from(combatants).where(eq(combatants.id, combatant.id)).all();
      expect(raw[0].hpCurrent).toBe(7); // exactly one hpDelta persisted -- the loser's rolled back
    });
  });

  describe('adjustCombatantResource', () => {
    it('a race loser replays the winner\'s resource state instead of double-spending', async () => {
      const { ormA, ormB, campaignId, encounterId } = seed();
      const ts = new Date().toISOString();
      const [character] = ormA
        .insert(characters)
        .values({
          campaignId,
          name: 'Monk',
          hpCurrent: 12,
          hpMax: 12,
          resources: JSON.stringify({ ki: { max: 5, used: 0, name: 'Ki Points' } }),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();
      const [combatant] = ormA
        .insert(combatants)
        .values({ encounterId, kind: 'character', characterId: character.id, name: 'Monk', hpCurrent: 12, hpMax: 12 })
        .returning()
        .all();

      const { service: serviceA } = buildService(ormA);
      const { service: serviceB } = buildService(ormB);

      const winner = await serviceB.adjustCombatantResource(
        encounterId,
        combatant.id,
        { key: 'ki', delta: 1, idempotencyKey: 'race-key-2' },
        dmUser,
        'dm',
      );
      expect(winner).toBeDefined();

      const { error, raceMarkerThrown } = await runAsRaceLoser(() =>
        serviceA.adjustCombatantResource(encounterId, combatant.id, { key: 'ki', delta: 1, idempotencyKey: 'race-key-2' }, dmUser, 'dm'),
      );

      expect(error).toBeUndefined();
      expect(raceMarkerThrown).toBe(true);

      const raw = ormA.select().from(characters).where(eq(characters.id, character.id)).all();
      const resources = JSON.parse(raw[0].resources) as { ki: { used: number } };
      expect(resources.ki.used).toBe(1); // exactly one spend persisted, not two
    });
  });

  describe('rollCombatantInitiative', () => {
    it('a race loser replays the winner\'s initiative roll rather than rolling and persisting a second one', async () => {
      const { ormA, ormB, encounterId } = seed();
      const [combatant] = ormA
        .insert(combatants)
        .values({ encounterId, kind: 'monster', name: 'Goblin', hpCurrent: 7, hpMax: 7 })
        .returning()
        .all();

      const { service: serviceA } = buildService(ormA);
      const { service: serviceB } = buildService(ormB);

      // Both sides pass the SAME `overwrite` value: it feeds the claim's fingerprint
      // (see rollCombatantInitiative's opClaim), so a mismatch would 409 as
      // IDEMPOTENCY_KEY_REUSE on the post-race replay lookup rather than exercising
      // the race this test targets.
      const winner = await serviceB.rollCombatantInitiative(encounterId, combatant.id, 'race-key-3', true, dmUser, 'dm');
      expect(winner.combatant.initiative).not.toBeNull();

      const { result, error, raceMarkerThrown } = await runAsRaceLoser(() =>
        serviceA.rollCombatantInitiative(encounterId, combatant.id, 'race-key-3', true, dmUser, 'dm'),
      );

      expect(error).toBeUndefined();
      expect(raceMarkerThrown).toBe(true);
      expect(result?.combatant.initiative).toBe(winner.combatant.initiative);

      const raw = ormA.select().from(combatants).where(eq(combatants.id, combatant.id)).all();
      expect(raw[0].initiative).toBe(winner.combatant.initiative);
    });
  });

  describe('rollDeathSave', () => {
    function seedDyingCharacter(ormA: any, campaignId: number, encounterId: number) {
      const ts = new Date().toISOString();
      const [character] = ormA
        .insert(characters)
        .values({ campaignId, name: 'Hero', hpCurrent: 0, hpMax: 10, deathState: 'dying', createdAt: ts, updatedAt: ts })
        .returning()
        .all();
      const [combatant] = ormA
        .insert(combatants)
        .values({
          encounterId,
          kind: 'character',
          characterId: character.id,
          name: 'Hero',
          hpCurrent: 0,
          hpMax: 10,
          deathState: 'dying',
        })
        .returning()
        .all();
      return { character, combatant };
    }

    it('a race loser replays the winner\'s combatant AND roll -- never its own discarded die (defect 1)', async () => {
      const { ormA, ormB, campaignId, encounterId } = seed();
      const { combatant } = seedDyingCharacter(ormA, campaignId, encounterId);

      const { service: serviceA } = buildService(ormA);
      const { service: serviceB } = buildService(ormB);

      // Deterministic, distinguishable dice: the WINNER (B) rolls a 15 (a plain
      // success -- 10-19 -- that leaves the combatant still `dying`, since it
      // takes 3 successes to stabilize; a natural 20 would instead revive it and
      // break the loser's OWN "only a dying character" precondition below). The
      // LOSER (A) rolls a 5 (a failure, clearly distinguishable). If the
      // discarded-die defect regresses, the loser's response carries a 5 instead
      // of replaying the winner's 15.
      jest.spyOn(serviceB as any, 'rollDeathSaveD20').mockReturnValue({ total: 15, expr: '1d20', rolls: [15] });
      jest.spyOn(serviceA as any, 'rollDeathSaveD20').mockReturnValue({ total: 5, expr: '1d20', rolls: [5] });

      const winner = await serviceB.rollDeathSave(encounterId, combatant.id, 'race-key-4', dmUser, 'dm');
      expect(winner.roll.total).toBe(15);

      const { result, error, raceMarkerThrown } = await runAsRaceLoser(() =>
        serviceA.rollDeathSave(encounterId, combatant.id, 'race-key-4', dmUser, 'dm'),
      );

      expect(error).toBeUndefined();
      expect(raceMarkerThrown).toBe(true);
      expect(result?.roll.total).toBe(15); // the WINNER's die, never the loser's discarded 5
      expect(result?.combatant.id).toBe(winner.combatant.id);
    });

    it('a race loser does not re-emit dice.rolled for a die it did not actually persist (defect 3)', async () => {
      const { ormA, ormB, campaignId, encounterId } = seed();
      const { combatant } = seedDyingCharacter(ormA, campaignId, encounterId);

      const { service: serviceA, rolls: rollsA } = buildService(ormA);
      const { service: serviceB, rolls: rollsB } = buildService(ormB);

      jest.spyOn(serviceB as any, 'rollDeathSaveD20').mockReturnValue({ total: 15, expr: '1d20', rolls: [15] });
      jest.spyOn(serviceA as any, 'rollDeathSaveD20').mockReturnValue({ total: 5, expr: '1d20', rolls: [5] });
      const emitA = jest.spyOn(rollsA, 'emitDiceRolled');
      const emitB = jest.spyOn(rollsB, 'emitDiceRolled');

      await serviceB.rollDeathSave(encounterId, combatant.id, 'race-key-5', dmUser, 'dm');
      expect(emitB).toHaveBeenCalledTimes(1);
      expect(emitB.mock.calls[0][0]).toMatchObject({ total: 15 });

      const { error, raceMarkerThrown } = await runAsRaceLoser(() =>
        serviceA.rollDeathSave(encounterId, combatant.id, 'race-key-5', dmUser, 'dm'),
      );

      expect(error).toBeUndefined();
      expect(raceMarkerThrown).toBe(true);
      // The loser must NOT emit anything -- the winner already broadcast this die.
      // A regression re-emits the loser's own discarded 2, or re-emits the
      // winner's 15 a second time; either way the shared dice tray sees the
      // SAME death save twice for what was really one roll.
      expect(emitA).not.toHaveBeenCalled();
    });
  });
});

describe('encounter idempotency: resolveReplay guards a throwing caller-supplied parser (issue #2032, defect 2)', () => {
  let dataDir: string;
  const openHandles: Array<{ close: () => void }> = [];

  afterEach(() => {
    // Close every connection BEFORE removing the directory. better-sqlite3 holds native
    // Statement objects tied to the Node environment; leaving handles open leaks file
    // descriptors across the suite and makes teardown OS-dependent (Windows refuses to
    // unlink an open DB). Closing is also what keeps the WAL/-shm sidecars from outliving
    // the test (issue #2032 review).
    for (const handle of openHandles.splice(0)) {
      try {
        handle.close();
      } catch {
        /* already closed — teardown must stay best-effort */
      }
    }
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('a null stored body plus a naive replayCombatant falls back to a fresh read instead of throwing a raw TypeError', async () => {
    dataDir = makeTempDataDir();
    const { sqlite: sqliteA, orm: ormA } = openDatabase(dataDir);
    openHandles.push(sqliteA);
    const ts = new Date().toISOString();
    const [camp] = ormA.insert(campaigns).values({ name: 'Race', createdAt: ts, updatedAt: ts }).returning().all();
    const [enc] = ormA
      .insert(encounters)
      .values({ campaignId: camp.id, name: 'Fight', status: 'running', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [combatant] = ormA
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'monster', name: 'Goblin', hpCurrent: 10, hpMax: 10 })
      .returning()
      .all();

    const { sqlite: sqliteB, orm: ormB } = openSecondConnection(dataDir);
    openHandles.push(sqliteB);
    const { service: serviceA } = buildService(ormA);
    const { service: serviceB } = buildService(ormB);

    // The WINNER commits with operationResponse forced to null -- reproducing the
    // real "claim committed, backfill has not happened yet" window (see
    // backfillEncounterOpResponse's doc comment) that turn-advance-style callers
    // hit in production.
    await serviceB.updateCombatant(
      enc.id,
      combatant.id,
      { hpDelta: -1, idempotencyKey: 'race-key-6' },
      dmUser,
      'dm',
      { operationResponse: () => null },
    );

    // A naive caller-supplied parser -- exactly the shape a caller storing a
    // structured (non-Combatant) response might reasonably write, dereferencing
    // its expected field WITHOUT an optional-chain guard. This throws a plain
    // TypeError when handed `null`.
    const naiveReplayCombatant = (response: unknown): any => (response as any).combatant;

    const { result, error, raceMarkerThrown } = await runAsRaceLoser(() =>
      serviceA.updateCombatant(
        enc.id,
        combatant.id,
        { hpDelta: -1, idempotencyKey: 'race-key-6' },
        dmUser,
        'dm',
        { operationResponse: () => null, replayCombatant: naiveReplayCombatant },
      ),
    );

    expect(raceMarkerThrown).toBe(true);
    // The naive parser's TypeError must be swallowed by resolveReplay's own try,
    // falling back to a fresh role-filtered read of the (really committed)
    // combatant -- never surfacing as an unhandled TypeError/500.
    expect(error).toBeUndefined();
    expect(result?.id).toBe(combatant.id);
    expect(result?.hpCurrent).toBe(9); // the winner's committed HP, read fresh
  });
});
