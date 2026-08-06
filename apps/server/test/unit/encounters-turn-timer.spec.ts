/**
 * Turn timer (issue #1935) — server-stamped turn start.
 *
 * The whole point of a server stamp is that two clients can never disagree about when
 * the current turn began, and a client joining mid-turn sees the true elapsed time
 * rather than 0:00. These specs assert directly on the persisted/returned
 * `turnStartedAt` value at the service layer — never on rendered UI — for every turn
 * transition: start, next-turn (including an idempotent replay, which must NOT
 * restamp), undo (a documented fresh restart, not a restore of the pre-advance time),
 * end (clears it), and reopen (a fresh stamp for the resumed fight).
 *
 * A frozen-then-advanced fake clock (mirroring
 * test/integration/encounter-condition-concurrency.spec.ts) makes each transition's
 * stamp unambiguously distinguishable from the previous one, rather than relying on
 * real wall-clock jitter between fast in-process calls.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('EncountersService — turn timer stamping (issue #1935)', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let encountersService: EncountersService;

  const dmActor: RequestUser = {
    id: '1',
    name: 'DM',
    serverRole: 'user',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-turn-timer-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const events = new CampaignEventsService();
    // Double-side typed against the real methods EncountersService actually calls on
    // `this.rolls` (record/recordInTransaction/emitDiceRolled/redactRollForRole) — the
    // annotation, not an assertion, so a missing/misspelled method fails right here
    // (AGENTS.md test-double convention; issue #1935 review). None of these turn-lifecycle
    // flows roll dice, so every method is an inert stub.
    const rollsDouble: Pick<RollsService, 'record' | 'recordInTransaction' | 'emitDiceRolled' | 'redactRollForRole'> = {
      record: jest.fn().mockResolvedValue({ id: 1 }),
      recordInTransaction: jest.fn().mockReturnValue({ id: 1 }),
      emitDiceRolled: jest.fn(),
      redactRollForRole: jest.fn().mockResolvedValue(null),
    };
    const rolls = rollsDouble as unknown as RollsService;
    const moderation = {
      quarantineNoteIfWatched: jest.fn(),
      snapshotCommentIfWatched: jest.fn(),
    } as unknown as ModerationService;
    const revisions = new RevisionsService(db, moderation);
    const attachmentsService = { assertCommitted: jest.fn() } as unknown as AttachmentsService;
    const campaignLibrary = {} as unknown as CampaignLibraryService;

    encountersService = new EncountersService(
      db,
      audit,
      events,
      rolls,
      revisions,
      attachmentsService,
      campaignLibrary,
      { notifyCampaign: jest.fn().mockResolvedValue(undefined), notifyUser: jest.fn().mockResolvedValue(undefined) } as any,
      null as any,
    );

    const [camp] = await db
      .insert(campaigns)
      .values({
        name: 'Turn Timer Test Campaign',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();
    campaignId = camp.id;
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Prepares a two-combatant encounter with initiative rolled, ready to /start. */
  async function makeReadyEncounter(name: string) {
    const enc = await encountersService.create(campaignId, { name }, dmActor, 'dm');
    await encountersService.addCombatant(enc.id, { name: 'Alpha', kind: 'monster', initMod: 4, hpMax: 10 }, dmActor, 'dm');
    await encountersService.addCombatant(enc.id, { name: 'Beta', kind: 'monster', initMod: 2, hpMax: 10 }, dmActor, 'dm');
    await encountersService.rollInitiative(enc.id, dmActor, 'dm');
    return enc.id;
  }

  it('start() stamps a fresh turnStartedAt (not null)', async () => {
    const encounterId = await makeReadyEncounter('Start Stamp');
    const before = await encountersService.getWithCombatantsOrThrow(encounterId, 'dm');
    expect(before.turnStartedAt).toBeNull();

    const started = await encountersService.start(encounterId, dmActor, 'dm');
    expect(started.status).toBe('running');
    expect(started.turnStartedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(started.turnStartedAt as string))).toBe(false);
  });

  it('nextTurn() restamps turnStartedAt to a later value, in the same serialized transition', async () => {
    jest.useFakeTimers({ advanceTimers: false });
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const encounterId = await makeReadyEncounter('Next Turn Restamp');
      const started = await encountersService.start(encounterId, dmActor, 'dm');
      const startStamp = started.turnStartedAt as string;
      expect(startStamp).toBe('2026-01-01T00:00:00.000Z');

      jest.setSystemTime(new Date('2026-01-01T00:03:40.000Z'));
      const advanced = await encountersService.nextTurn(encounterId, {}, dmActor, 'dm');
      expect(advanced.turnStartedAt).not.toBe(startStamp);
      expect(Date.parse(advanced.turnStartedAt as string)).toBeGreaterThan(Date.parse(startStamp));
      expect(advanced.turnStartedAt).toBe('2026-01-01T00:03:40.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('an idempotent replay of nextTurn (same idempotencyKey) does NOT restamp a second time', async () => {
    jest.useFakeTimers({ advanceTimers: false });
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const encounterId = await makeReadyEncounter('Idempotent Replay');
      await encountersService.start(encounterId, dmActor, 'dm');

      jest.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      const first = await encountersService.nextTurn(encounterId, { idempotencyKey: 'turn-timer-replay-key' }, dmActor, 'dm');
      expect(first.turnStartedAt).toBe('2026-01-01T00:01:00.000Z');

      // The clock moves on, but a REPLAY of the identical intent must return the
      // ORIGINAL committed turnStartedAt, not a fresh one — a retried request (lost
      // response, client resend) must never look like a second turn advance.
      jest.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
      const replay = await encountersService.nextTurn(encounterId, { idempotencyKey: 'turn-timer-replay-key' }, dmActor, 'dm');
      expect(replay.turnStartedAt).toBe(first.turnStartedAt);
    } finally {
      jest.useRealTimers();
    }
  });

  it('undoTurn() restamps a FRESH turnStartedAt — a documented restart, not a restore of the pre-advance time', async () => {
    jest.useFakeTimers({ advanceTimers: false });
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const encounterId = await makeReadyEncounter('Undo Restamp');
      const started = await encountersService.start(encounterId, dmActor, 'dm');
      const startStamp = started.turnStartedAt as string;

      jest.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));
      const advanced = await encountersService.nextTurn(encounterId, {}, dmActor, 'dm');
      const advancedStamp = advanced.turnStartedAt as string;
      expect(advancedStamp).not.toBe(startStamp);

      jest.setSystemTime(new Date('2026-01-01T00:04:30.000Z'));
      const undone = await encountersService.undoTurn(encounterId, dmActor, 'dm');
      // Fresh "now", not a restore of either prior stamp.
      expect(undone.turnStartedAt).toBe('2026-01-01T00:04:30.000Z');
      expect(undone.turnStartedAt).not.toBe(startStamp);
      expect(undone.turnStartedAt).not.toBe(advancedStamp);
    } finally {
      jest.useRealTimers();
    }
  });

  it('end() nulls turnStartedAt — no client should keep a chip ticking once the fight is over', async () => {
    const encounterId = await makeReadyEncounter('End Clears Stamp');
    const started = await encountersService.start(encounterId, dmActor, 'dm');
    expect(started.turnStartedAt).not.toBeNull();

    const ended = await encountersService.end(encounterId, dmActor, 'dm');
    expect(ended.status).toBe('ended');
    expect(ended.turnStartedAt).toBeNull();
  });

  it('reopen() stamps a fresh turnStartedAt for the resumed fight', async () => {
    jest.useFakeTimers({ advanceTimers: false });
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const encounterId = await makeReadyEncounter('Reopen Restamp');
      await encountersService.start(encounterId, dmActor, 'dm');
      const ended = await encountersService.end(encounterId, dmActor, 'dm');
      expect(ended.turnStartedAt).toBeNull();

      jest.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
      const reopened = await encountersService.reopen(encounterId, dmActor, 'dm');
      expect(reopened.status).toBe('running');
      expect(reopened.turnStartedAt).toBe('2026-01-01T01:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('turnTimerSeconds defaults to 0 (off) and DM PATCH sets it; turnStartedAt is untouched by that PATCH', async () => {
    const encounterId = await makeReadyEncounter('Timer Preset');
    const created = await encountersService.getWithCombatantsOrThrow(encounterId, 'dm');
    expect(created.turnTimerSeconds).toBe(0);

    const started = await encountersService.start(encounterId, dmActor, 'dm');
    const stampBeforePatch = started.turnStartedAt;

    const patched = await encountersService.updateEncounter(encounterId, { turnTimerSeconds: 90 }, dmActor, 'dm');
    expect(patched.turnTimerSeconds).toBe(90);
    expect(patched.turnStartedAt).toBe(stampBeforePatch);
  });

  // Issue #1935 review (Devin, round 2): removeCombatant is not NAMED like a turn-advance
  // method, but removing the CURRENT combatant performs a genuine turn transition —
  // advanceEncounterTurn runs, turnVersion bumps, a new combatant's turn starts, and
  // encounter.turn_changed fires. That transition must restamp turnStartedAt exactly like
  // start/nextTurn/undoTurn do, or the new turn's elapsed chip keeps counting the REMOVED
  // combatant's time (and can show a fresh turn as already over a DM-set limit).
  describe('removeCombatant / undoRemoveCombatant — turn timer (issue #1935 review)', () => {
    it('removing the CURRENT combatant restamps turnStartedAt to a fresh value', async () => {
      jest.useFakeTimers({ advanceTimers: false });
      try {
        jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const encounterId = await makeReadyEncounter('Remove Current Restamp');
        const started = await encountersService.start(encounterId, dmActor, 'dm');
        const startStamp = started.turnStartedAt as string;
        expect(startStamp).toBe('2026-01-01T00:00:00.000Z');
        const currentId = started.currentCombatantId!;

        jest.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
        await encountersService.removeCombatant(encounterId, currentId, dmActor, 'dm');

        const after = await encountersService.getWithCombatantsOrThrow(encounterId, 'dm');
        // Assert on the persisted/returned payload only — never on rendered UI.
        expect(after.turnStartedAt).not.toBe(startStamp);
        expect(after.turnStartedAt).toBe('2026-01-01T00:05:00.000Z');
        expect(after.currentCombatantId).not.toBe(currentId);
      } finally {
        jest.useRealTimers();
      }
    });

    it('removing a combatant who is NOT current does not touch turnStartedAt', async () => {
      jest.useFakeTimers({ advanceTimers: false });
      try {
        jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const encounterId = await makeReadyEncounter('Remove Bystander No Restamp');
        const started = await encountersService.start(encounterId, dmActor, 'dm');
        const startStamp = started.turnStartedAt as string;
        const currentId = started.currentCombatantId!;
        const combatants = started.combatants;
        const bystander = combatants.find((c) => c.id !== currentId)!;

        jest.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
        await encountersService.removeCombatant(encounterId, bystander.id, dmActor, 'dm');

        const after = await encountersService.getWithCombatantsOrThrow(encounterId, 'dm');
        expect(after.currentCombatantId).toBe(currentId);
        expect(after.turnStartedAt).toBe(startStamp);
      } finally {
        jest.useRealTimers();
      }
    });

    it('undoRemoveCombatant restores the ORIGINAL pre-removal turnStartedAt — not a fresh stamp', async () => {
      // Decision (see the code comment at the undo restore site): this undo is a
      // short-lived "erase my mistaken removal" capability, not a deliberate gameplay
      // rewind like undoTurn — every other piece of state here is restored exactly, so
      // the clock is too, rather than being given a visible fresh-restart side effect.
      jest.useFakeTimers({ advanceTimers: false });
      try {
        jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const encounterId = await makeReadyEncounter('Undo Remove Restores Stamp');
        const started = await encountersService.start(encounterId, dmActor, 'dm');
        const originalStamp = started.turnStartedAt as string;
        const currentId = started.currentCombatantId!;

        jest.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
        const removal = await encountersService.removeCombatant(encounterId, currentId, dmActor, 'dm');
        const afterRemoval = await encountersService.getWithCombatantsOrThrow(encounterId, 'dm');
        expect(afterRemoval.turnStartedAt).toBe('2026-01-01T00:05:00.000Z');

        jest.setSystemTime(new Date('2026-01-01T00:05:07.000Z'));
        await encountersService.undoRemoveCombatant(encounterId, removal.undoToken, dmActor, 'dm');

        const afterUndo = await encountersService.getWithCombatantsOrThrow(encounterId, 'dm');
        expect(afterUndo.currentCombatantId).toBe(currentId);
        // Restored to the ORIGINAL stamp — neither the removal's stamp nor a fresh
        // undo-time stamp.
        expect(afterUndo.turnStartedAt).toBe(originalStamp);
        expect(afterUndo.turnStartedAt).not.toBe('2026-01-01T00:05:00.000Z');
        expect(afterUndo.turnStartedAt).not.toBe('2026-01-01T00:05:07.000Z');
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
