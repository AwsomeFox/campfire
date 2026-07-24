import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, characters, combatants, encounters, npcs } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { ConflictException } from '@nestjs/common';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #749, service-layer: two concurrent `addCombatant` calls for the SAME
 * character (or NPC) must resolve to exactly one success and one 409 carrying
 * the winning combatant's id — never two rows, never a raw 500.
 *
 * better-sqlite3 is synchronous, so under a live HTTP server two requests tend
 * to serialize at the Nest handler boundary rather than interleave at the
 * drizzle `await` boundaries inside the service. The race IS reachable in
 * production (multiple Node handles, the AI-DM driver + a human DM, the create()
 * auto-add racing an explicit add), but reproducing it deterministically in a
 * test requires driving the SERVICE directly and parking both callers at a
 * shared gate so they run their SELECT-then-INSERT probes together. This spec
 * does exactly that — mirroring the barrier pattern in db-concurrency.e2e-spec's
 * `synchronizeLazyCreateProbe`.
 *
 * Against the pre-fix code (no partial unique indexes, 409 only from the
 * SELECT-then-INSERT probe), both callers pass the probe (both observe no
 * existing row) and BOTH INSERT succeeds — leaving two combatant rows for one
 * identity, which then track HP independently and fork the initiative order.
 * The fix adds partial UNIQUE indexes (idx_combatants_encounter_character /
 * idx_combatants_encounter_npc) that turn the loser's INSERT into a caught
 * SQLITE_CONSTRAINT_UNIQUE, which the service maps to a deterministic 409 with
 * the winning combatant id (re-read after the failed INSERT).
 *
 * No Nest bootstrap: a real SQLite file + the services constructed by hand, so
 * it lives beside the other real-SQLite integration specs (mirrors
 * encounter-condition-concurrency.spec.ts's shape).
 */
describe('encounter combatant identity concurrency (real SQLite, service layer)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Build the EncountersService against a fresh temp SQLite DB. */
  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    const revisions = new RevisionsService(orm);
    const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit));
    const encountersService = new EncountersService(orm, audit, events, rolls, revisions, attachments);
    return { orm, encountersService };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };

  /** Seed a campaign + encounter, returning the ids. The encounter is in 'preparing' so addCombatant is allowed. */
  function seedEncounter(orm: ReturnType<typeof build>['orm']): { campaignId: number; encounterId: number } {
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Identity Race', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({
        campaignId: campaign.id,
        name: 'Identity Fight',
        status: 'preparing',
        round: 1,
        turnIndex: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    return { campaignId: campaign.id, encounterId: encounter.id };
  }

  /** Seed a campaign + encounter + one character row, returning both ids. */
  function seedCharacter(orm: ReturnType<typeof build>['orm']): {
    campaignId: number;
    encounterId: number;
    characterId: number;
  } {
    const { campaignId, encounterId } = seedEncounter(orm);
    const ts = new Date().toISOString();
    const [character] = orm
      .insert(characters)
      .values({
        campaignId,
        name: 'Racing PC',
        hpCurrent: 12,
        hpMax: 12,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    return { campaignId, encounterId, characterId: character.id };
  }

  /** Seed a campaign + encounter + one NPC row, returning both ids. */
  function seedNpc(orm: ReturnType<typeof build>['orm']): {
    campaignId: number;
    encounterId: number;
    npcId: number;
  } {
    const { campaignId, encounterId } = seedEncounter(orm);
    const ts = new Date().toISOString();
    const [npc] = orm
      .insert(npcs)
      .values({ campaignId, name: 'Racing NPC', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    return { campaignId, encounterId, npcId: npc.id };
  }

  /**
   * Park two `addCombatant` callers at the top of the method (getRowOrThrow is
   * the first `await` in addCombatant, before the duplicate probe) until both
   * have arrived, then release them together so both run the SELECT-then-INSERT
   * probe against an empty table and collide at the INSERT. Mirrors the
   * `synchronizeLazyCreateProbe` barrier in db-concurrency.e2e-spec.ts.
   *
   * The spy runs the real lookup first (so it 404s correctly for a missing
   * encounter), then counts arrivals; on the second arrival it releases the
   * gate and both callers resume together. Armed-once so a later legitimate
   * call (e.g. an assertion read) isn't parked.
   */
  function synchronizeAddCombatantStart(service: EncountersService, encounterId: number) {
    const original = service.getRowOrThrow.bind(service);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    let armed = true;

    const spy = jest.spyOn(service, 'getRowOrThrow').mockImplementation(async (id: number) => {
      const row = await original(id);
      if (id !== encounterId || !armed) return row;
      arrivals += 1;
      if (arrivals === 2) {
        // Both callers have passed the entry probe — release both, then race
        // the duplicate-probe SELECTs and the INSERTs.
        armed = false;
        release();
      }
      await gate;
      return row;
    });
    return spy;
  }

  /** Count combatant rows for an encounter straight from the table. */
  function countCombatants(orm: ReturnType<typeof build>['orm'], encounterId: number): number {
    return orm.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all().length;
  }

  /** Pluck the single persisted identity combatant (characterId or npcId set). */
  function identityCombatant(
    orm: ReturnType<typeof build>['orm'],
    encounterId: number,
  ): { id: number; characterId: number | null; npcId: number | null } | undefined {
    return orm
      .select({
        id: combatants.id,
        characterId: combatants.characterId,
        npcId: combatants.npcId,
      })
      .from(combatants)
      .where(eq(combatants.encounterId, encounterId))
      .all()
      .find((c) => c.characterId !== null || c.npcId !== null);
  }

  type AddInput = Parameters<EncountersService['addCombatant']>[1];
  type AddResult = Awaited<ReturnType<EncountersService['addCombatant']>>;

  /**
   * Run two concurrent addCombatant calls for the same identity and bucket the
   * outcomes. Returns { successes, conflicts, other } where successes are the
   * returned Combatant rows, conflicts are the caught ConflictExceptions, and
   * other is anything else (a 500-shaped throw — the pre-fix failure mode).
   */
  async function raceAddCombatant(
    service: EncountersService,
    encounterId: number,
    inputs: AddInput[],
  ): Promise<{ successes: AddResult[]; conflicts: ConflictException[]; other: unknown[] }> {
    const outcomes = await Promise.allSettled(inputs.map((input) => service.addCombatant(encounterId, input, dmUser, 'dm')));
    const successes: AddResult[] = [];
    const conflicts: ConflictException[] = [];
    const other: unknown[] = [];
    for (const o of outcomes) {
      if (o.status === 'fulfilled') {
        successes.push(o.value);
      } else {
        const err = o.reason;
        if (err instanceof ConflictException) {
          conflicts.push(err);
        } else {
          other.push(err);
        }
      }
    }
    return { successes, conflicts, other };
  }

  it('two concurrent addCombatant calls for the same character resolve to 1 success + 1 carrying the winner id (#749)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const { encounterId, characterId } = seedCharacter(orm);

    const spy = synchronizeAddCombatantStart(encountersService, encounterId);
    let outcomes: Awaited<ReturnType<typeof raceAddCombatant>>;
    try {
      outcomes = await raceAddCombatant(encountersService, encounterId, [
        { kind: 'character', characterId },
        { kind: 'character', characterId },
      ]);
    } finally {
      spy.mockRestore();
    }

    // Exactly one success, exactly one conflict, no raw 500.
    expect(outcomes.successes).toHaveLength(1);
    expect(outcomes.conflicts).toHaveLength(1);
    expect(outcomes.other).toHaveLength(0);

    // The conflict's body carries the WINNING combatant's id — the loser can
    // treat the duplicate as an idempotent re-add by adopting that id.
    const winnerId = outcomes.successes[0].id;
    const conflict = outcomes.conflicts[0];
    const body = conflict.getResponse() as { code?: string; combatantId?: number; message?: string };
    expect(body.code).toBe('COMBATANT_IDENTITY_CONFLICT');
    expect(body.combatantId).toBe(winnerId);
    expect(body.message).toContain(`Character ${characterId}`);

    // The persisted table holds exactly ONE row for this identity — no fork.
    expect(countCombatants(orm, encounterId)).toBe(1);
    const persisted = identityCombatant(orm, encounterId);
    expect(persisted?.id).toBe(winnerId);
    expect(persisted?.characterId).toBe(characterId);
  });

  it('two concurrent addCombatant calls for the same NPC resolve to 1 success + 1 carrying the winner id (#749)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const { encounterId, npcId } = seedNpc(orm);

    const spy = synchronizeAddCombatantStart(encountersService, encounterId);
    let outcomes: Awaited<ReturnType<typeof raceAddCombatant>>;
    try {
      outcomes = await raceAddCombatant(encountersService, encounterId, [
        { kind: 'npc', npcId, hpMax: 10 },
        { kind: 'npc', npcId, hpMax: 10 },
      ]);
    } finally {
      spy.mockRestore();
    }

    expect(outcomes.successes).toHaveLength(1);
    expect(outcomes.conflicts).toHaveLength(1);
    expect(outcomes.other).toHaveLength(0);

    const winnerId = outcomes.successes[0].id;
    const conflict = outcomes.conflicts[0];
    const body = conflict.getResponse() as { code?: string; combatantId?: number; message?: string };
    expect(body.code).toBe('COMBATANT_IDENTITY_CONFLICT');
    expect(body.combatantId).toBe(winnerId);
    expect(body.message).toContain(`NPC ${npcId}`);

    expect(countCombatants(orm, encounterId)).toBe(1);
    const persisted = identityCombatant(orm, encounterId);
    expect(persisted?.id).toBe(winnerId);
    expect(persisted?.npcId).toBe(npcId);
  });

  it('a timeout retry (caller re-sends the same character add after a crash) is idempotent — 1 row, 409 carries the original id (#749)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const { encounterId, characterId } = seedCharacter(orm);

    // First add succeeds (the "original" request landed but the caller never
    // saw the response, e.g. a network drop after commit).
    const original = await encountersService.addCombatant(
      encounterId,
      { kind: 'character', characterId },
      dmUser,
      'dm',
    );
    expect(original.characterId).toBe(characterId);

    // The retry arrives AFTER the original committed — the duplicate probe now
    // catches it via the SELECT (the more common path), and the 409 must carry
    // the original's id so the retry knows it already succeeded.
    let caught: ConflictException | undefined;
    try {
      await encountersService.addCombatant(encounterId, { kind: 'character', characterId }, dmUser, 'dm');
    } catch (err) {
      if (err instanceof ConflictException) caught = err as ConflictException;
      else throw err;
    }
    expect(caught).toBeDefined();
    const body = caught!.getResponse() as { code?: string; combatantId?: number };
    expect(body.code).toBe('COMBATANT_IDENTITY_CONFLICT');
    expect(body.combatantId).toBe(original.id);

    // Still exactly one row — the retry did not duplicate.
    expect(countCombatants(orm, encounterId)).toBe(1);
  });

  it('two concurrent addCombatant calls for DIFFERENT monsters both succeed (partial index does not over-constrain) (#749)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const { encounterId } = seedEncounter(orm);

    // Two distinct monsters (both kind='monster', both identity-less) added
    // concurrently. The partial unique indexes scope to non-NULL character_id/
    // npc_id, so these must NOT collide — both should land. This guards against
    // a regression where the index was accidentally non-partial.
    const spy = synchronizeAddCombatantStart(encountersService, encounterId);
    let outcomes: Awaited<ReturnType<typeof raceAddCombatant>>;
    try {
      outcomes = await raceAddCombatant(encountersService, encounterId, [
        { kind: 'monster', name: 'Goblin A', hpMax: 7 },
        { kind: 'monster', name: 'Goblin B', hpMax: 7 },
      ]);
    } finally {
      spy.mockRestore();
    }

    expect(outcomes.successes).toHaveLength(2);
    expect(outcomes.conflicts).toHaveLength(0);
    expect(outcomes.other).toHaveLength(0);
    expect(countCombatants(orm, encounterId)).toBe(2);
  });

  it('rolling initiative does not deadlock or drop combatants after a raced identity add (#749)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const { encounterId, characterId } = seedCharacter(orm);

    // Two concurrent adds of the same character: one wins, one 409s. The winner
    // owns the single audit entry + the single identity row. After the race
    // settles, rolling initiative over the encounter must succeed and observe
    // exactly one combatant for that identity — no orphaned/hidden second row
    // created by the loser before the constraint fired.
    const spy = synchronizeAddCombatantStart(encountersService, encounterId);
    try {
      await raceAddCombatant(encountersService, encounterId, [
        { kind: 'character', characterId },
        { kind: 'character', characterId },
      ]);
    } finally {
      spy.mockRestore();
    }

    expect(countCombatants(orm, encounterId)).toBe(1);

    // Flip the encounter to running and roll initiative — this re-reads and
    // re-sorts every combatant. If the race had left a second row (pre-fix bug),
    // both would sort in and the character would appear twice in the order.
    const ts = new Date().toISOString();
    orm
      .update(encounters)
      .set({ status: 'running', updatedAt: ts })
      .where(eq(encounters.id, encounterId))
      .run();
    const rolled = await encountersService.rollInitiative(encounterId, dmUser, 'dm');

    const forCharacter = rolled.combatants.filter((c) => c.characterId === characterId);
    expect(forCharacter).toHaveLength(1);
    // Initiative was assigned by the roll.
    expect(forCharacter[0].initiative).not.toBeNull();
  });
});
