import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { auditLog, campaigns, characters, combatants, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
// Issue #604: AttachmentsService now delegates responsive derivative generation.
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { CharactersService } from '../../src/modules/characters/characters.service';
import { CampaignAccessService } from '../../src/modules/membership/campaign-access.service';
import { RoleResolver } from '../../src/modules/membership/role-resolver.service';
import type { ConditionInstance } from '@campfire/schema';
import { fromJsonText } from '../../src/common/json';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #486 — character-sheet and combatant conditions must stay synchronized.
 *
 * Merge semantics (overlap window):
 *   - create/add seeds combatant conditions from the sheet
 *   - sheet patchConditions overwrites the live combatant's conditions array
 *   - tracker updateCombatant add/removeConditions overwrites the sheet array
 *   - last cross-surface write wins as a whole array (no 3-way merge)
 *   - /end writes combatant conditions back onto the sheet with HP
 *
 * Service-layer against real SQLite (same shape as death-temp-hp reconcile).
 */
describe('encounter condition sync (issue #486, service layer)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    // Issue #601: RevisionsService fires the moderation pre-mutation evidence hook
    // on restore, so it takes a real ModerationService. Deliberately not optional —
    // an absent hook would silently stop capturing abuse evidence.
    const revisions = new RevisionsService(orm, new ModerationService(orm, audit));
    const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit), new AttachmentDerivativesService(orm));
    const campaignLibrary = new CampaignLibraryService(orm, audit);
    const encountersService = new EncountersService(orm, audit, events, rolls, revisions, attachments, campaignLibrary, { notifyCampaign: jest.fn().mockResolvedValue(undefined), notifyUser: jest.fn().mockResolvedValue(undefined) } as any);
    const access = new CampaignAccessService(orm, new RoleResolver(orm));
    const charactersService = new CharactersService(orm, audit, revisions, events, rolls, access);
    return { orm, encountersService, charactersService };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };

  function seedRunningFight(opts?: { sheetConditions?: string[] }) {
    dataDir = makeTempDataDir();
    const { orm, encountersService, charactersService } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm.insert(campaigns).values({ name: 'Cond Sync', createdAt: ts, updatedAt: ts }).returning().all();
    const [character] = orm
      .insert(characters)
      .values({
        campaignId: campaign.id,
        name: 'Aria',
        hpCurrent: 20,
        hpMax: 20,
        conditions: JSON.stringify(opts?.sheetConditions ?? []),
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({
        campaignId: campaign.id,
        name: 'Ambush',
        status: 'running',
        round: 1,
        turnIndex: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    orm.update(campaigns).set({ activeEncounterId: encounter.id }).where(eq(campaigns.id, campaign.id)).run();
    const [combatant] = orm
      .insert(combatants)
      .values({
        encounterId: encounter.id,
        kind: 'character',
        characterId: character.id,
        name: 'Aria',
        initiative: 12,
        initMod: 2,
        hpCurrent: 20,
        hpMax: 20,
        conditions: JSON.stringify(opts?.sheetConditions ?? []),
        sheetSyncedUpdatedAt: ts,
        sortOrder: 0,
      })
      .returning()
      .all();
    return { orm, encountersService, charactersService, campaignId: campaign.id, encounterId: encounter.id, characterId: character.id, combatantId: combatant.id };
  }

  function readConditions(orm: ReturnType<typeof build>['orm'], table: 'character' | 'combatant', id: number): string[] {
    if (table === 'character') {
      const [row] = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all();
      return fromJsonText<string[]>(row.conditions, []);
    }
    const [row] = orm.select().from(combatants).where(eq(combatants.id, id)).limit(1).all();
    return fromJsonText<string[]>(row.conditions, []);
  }

  /** Structured instance names on a combatant, which must never disagree with `conditions`. */
  function readInstanceNames(orm: ReturnType<typeof build>['orm'], combatantId: number): string[] {
    const [row] = orm.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all();
    return fromJsonText<Array<{ name: string }>>(row.conditionInstances, []).map((i) => i.name).sort();
  }

  it('create() seeds combatant conditions from the sheet', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm.insert(campaigns).values({ name: 'Seed', createdAt: ts, updatedAt: ts }).returning().all();
    orm
      .insert(characters)
      .values({
        campaignId: campaign.id,
        name: 'Poisoned PC',
        hpCurrent: 12,
        hpMax: 12,
        conditions: JSON.stringify(['poisoned']),
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const encounter = await encountersService.create(campaign.id, { name: 'New Fight' }, dmUser, 'dm');
    const pc = encounter.combatants.find((c) => c.kind === 'character');
    expect(pc).toBeDefined();
    expect(pc!.conditions).toContain('poisoned');
  });

  it('sheet patchConditions appears on the live combatant', async () => {
    const ctx = seedRunningFight();
    await ctx.charactersService.patchConditions(ctx.characterId, { add: ['poisoned'] }, dmUser, 'dm');
    expect(readConditions(ctx.orm, 'combatant', ctx.combatantId)).toContain('poisoned');
    expect(readConditions(ctx.orm, 'character', ctx.characterId)).toContain('poisoned');
  });

  it.each([
    {
      name: 'HP',
      sync: (service: CharactersService, characterId: number, campaignId: number) =>
        (service as unknown as {
          syncActiveCombatants: (id: number, hpCurrent: number, hpMax?: number, opts?: { campaignId?: number }) => Promise<void>;
        }).syncActiveCombatants(characterId, 13, undefined, { campaignId }),
    },
    {
      name: 'conditions',
      sync: (service: CharactersService, characterId: number, campaignId: number) =>
        (service as unknown as {
          syncActiveCombatantConditions: (id: number, conditions: string, opts?: { campaignId?: number }) => Promise<void>;
        }).syncActiveCombatantConditions(characterId, JSON.stringify(['poisoned']), { campaignId }),
    },
  ])('does not bump the encounter revision when concurrent removal wins the $name mirror race', async ({ sync }) => {
    const ctx = seedRunningFight();
    const originalTransaction = ctx.orm.transaction.bind(ctx.orm);
    let removedBeforeMirror = false;
    const transactionSpy = jest.spyOn(ctx.orm, 'transaction').mockImplementation((callback) => {
      // The mirror's roster query has already selected this combatant. Delete it just
      // before the mirror transaction, which models a concurrent remove committing in
      // that gap. Its UPDATE must affect zero rows and leave the undo revision alone.
      if (!removedBeforeMirror) {
        removedBeforeMirror = true;
        ctx.orm.delete(combatants).where(eq(combatants.id, ctx.combatantId)).run();
      }
      return originalTransaction(callback);
    });
    try {
      await sync(ctx.charactersService, ctx.characterId, ctx.campaignId);
    } finally {
      transactionSpy.mockRestore();
    }

    expect(removedBeforeMirror).toBe(true);
    const [encounter] = ctx.orm.select().from(encounters).where(eq(encounters.id, ctx.encounterId)).limit(1).all();
    expect(encounter.combatantStateVersion).toBe(0);
  });

  it('does not expose a sheet combatant write without its undo revision', async () => {
    const ctx = seedRunningFight();
    const [removedTurn] = ctx.orm.insert(combatants).values({
      encounterId: ctx.encounterId,
      kind: 'monster',
      name: 'Removed turn',
      initiative: 20,
      initMod: 0,
      hpCurrent: 10,
      hpMax: 10,
      conditions: '[]',
      sortOrder: 1,
    }).returning().all();
    ctx.orm.update(encounters)
      .set({ currentCombatantId: removedTurn.id, turnIndex: 0, combatantStateVersion: 0 })
      .where(eq(encounters.id, ctx.encounterId))
      .run();
    const removal = await ctx.encountersService.removeCombatant(ctx.encounterId, removedTurn.id, dmUser, 'dm');

    // The old implementation yielded after this linked combatant update and before it
    // bumped combatantStateVersion. A queued undo then saw the removal's old revision and
    // exactly rewound the pointer to the removed turn. The transaction makes that state
    // unobservable: the undo either runs before the mirror or reconciles after its revision.
    let patchSettled = false;
    let undo: Promise<unknown> | undefined;
    const interleaveUndo = () => {
      const [linked] = ctx.orm.select({ hpCurrent: combatants.hpCurrent })
        .from(combatants)
        .where(eq(combatants.id, ctx.combatantId))
        .limit(1)
        .all();
      if (!undo && linked?.hpCurrent === 13) {
        undo = ctx.encountersService.undoRemoveCombatant(ctx.encounterId, removal.undoToken, dmUser, 'dm');
      } else if (!patchSettled) {
        queueMicrotask(interleaveUndo);
      }
    };
    const patch = ctx.charactersService.patchHp(ctx.characterId, { set: 13 }, dmUser, 'dm')
      .finally(() => { patchSettled = true; });
    queueMicrotask(interleaveUndo);
    await patch;
    // With the fixed transaction the queued interleaver sees either no combatant write,
    // or its already-incremented revision. It still represents the competing undo action.
    undo ??= ctx.encountersService.undoRemoveCombatant(ctx.encounterId, removal.undoToken, dmUser, 'dm');
    await undo;

    const [encounter] = ctx.orm.select().from(encounters).where(eq(encounters.id, ctx.encounterId)).limit(1).all();
    expect(encounter.currentCombatantId).toBe(ctx.combatantId);
    expect(encounter.combatantStateVersion).toBeGreaterThan(1);
    // The narrower transaction leaves the character write's established audit behavior intact.
    const hpAudits = ctx.orm.select().from(auditLog)
      .where(eq(auditLog.action, 'character.hp'))
      .all()
      .filter((audit) => audit.entityId === ctx.characterId);
    expect(hpAudits).toEqual([expect.objectContaining({ actor: dmUser.id, campaignId: ctx.campaignId })]);
  });

  it('does not expose a live combatant addition without its undo revision', async () => {
    const ctx = seedRunningFight();
    const [removedTurn] = ctx.orm.insert(combatants).values({
      encounterId: ctx.encounterId,
      kind: 'monster',
      name: 'Removed turn',
      initiative: 20,
      initMod: 0,
      hpCurrent: 10,
      hpMax: 10,
      conditions: '[]',
      sortOrder: 1,
    }).returning().all();
    ctx.orm.update(encounters)
      .set({ currentCombatantId: removedTurn.id, turnIndex: 0, combatantStateVersion: 0 })
      .where(eq(encounters.id, ctx.encounterId))
      .run();
    const removal = await ctx.encountersService.removeCombatant(ctx.encounterId, removedTurn.id, dmUser, 'dm');

    // Before the fix the INSERT committed, then addCombatant yielded to re-read the roster
    // before bumping combatantStateVersion. Let Undo run at that same interleaving point.
    let addSettled = false;
    let undo: Promise<unknown> | undefined;
    const interleaveUndo = () => {
      const hasAddition = ctx.orm.select({ id: combatants.id })
        .from(combatants)
        .where(eq(combatants.encounterId, ctx.encounterId))
        .all()
        .some((combatant) => combatant.id !== ctx.combatantId);
      if (!undo && hasAddition) {
        undo = ctx.encountersService.undoRemoveCombatant(ctx.encounterId, removal.undoToken, dmUser, 'dm');
      } else if (!addSettled) {
        queueMicrotask(interleaveUndo);
      }
    };
    const addition = ctx.encountersService.addCombatant(
      ctx.encounterId,
      { kind: 'monster', name: 'Later arrival', hpMax: 6 },
      dmUser,
      'dm',
    ).finally(() => { addSettled = true; });
    queueMicrotask(interleaveUndo);
    const added = await addition;
    undo ??= ctx.encountersService.undoRemoveCombatant(ctx.encounterId, removal.undoToken, dmUser, 'dm');
    await undo;

    const [encounter] = ctx.orm.select().from(encounters).where(eq(encounters.id, ctx.encounterId)).limit(1).all();
    expect(encounter.currentCombatantId).toBe(ctx.combatantId);
    expect(ctx.orm.select().from(auditLog).where(eq(auditLog.entityId, added.id)).all())
      .toEqual([expect.objectContaining({ action: 'encounter.combatant.add', actor: dmUser.id })]);
  });

  it('tracker addConditions survives /end onto the sheet', async () => {
    const ctx = seedRunningFight();
    await ctx.encountersService.updateCombatant(
      ctx.encounterId,
      ctx.combatantId,
      { addConditions: ['prone'] },
      dmUser,
      'dm',
    );
    // Live mirror should already have written the sheet.
    expect(readConditions(ctx.orm, 'character', ctx.characterId)).toContain('prone');

    // Clear sheet conditions while keeping combatant (simulate a race where only
    // the combatant holds the final state), then /end must write them back.
    ctx.orm
      .update(characters)
      .set({ conditions: '[]', updatedAt: new Date().toISOString() })
      .where(eq(characters.id, ctx.characterId))
      .run();
    // Align CAS token so /end's HP sync guard allows the write-back.
    const [sheet] = ctx.orm.select().from(characters).where(eq(characters.id, ctx.characterId)).limit(1).all();
    ctx.orm
      .update(combatants)
      .set({
        conditions: JSON.stringify(['prone']),
        sheetSyncedUpdatedAt: sheet.updatedAt,
        hpCurrent: sheet.hpCurrent,
        hpTemp: sheet.hpTemp,
        deathState: sheet.deathState,
        deathSaveSuccesses: sheet.deathSaveSuccesses,
        deathSaveFailures: sheet.deathSaveFailures,
      })
      .where(eq(combatants.id, ctx.combatantId))
      .run();

    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');
    expect(readConditions(ctx.orm, 'character', ctx.characterId)).toContain('prone');
  });

  it('tracker condition write mirrors to the sheet mid-fight', async () => {
    const ctx = seedRunningFight({ sheetConditions: ['frightened'] });
    await ctx.encountersService.updateCombatant(
      ctx.encounterId,
      ctx.combatantId,
      { addConditions: ['poisoned'], removeConditions: ['frightened'] },
      dmUser,
      'dm',
    );
    const sheet = readConditions(ctx.orm, 'character', ctx.characterId);
    const tracker = readConditions(ctx.orm, 'combatant', ctx.combatantId);
    expect(sheet).toEqual(expect.arrayContaining(['poisoned']));
    expect(sheet).not.toContain('frightened');
    expect(tracker).toEqual(sheet);
  });

  /**
   * The combatant carries the SAME conditions twice: the legacy `conditions` string array
   * and the structured `conditionInstances` blob added by #423. Writers that set only the
   * former leave the latter stale, and `parseConditionInstances` UNIONS rather than
   * reconciles — it adds legacy names missing from instances, but never drops instances
   * missing from the legacy array. A removal therefore survives in the structured copy and
   * is re-derived back into visibility by the next write that touches conditions.
   */
  describe('conditions and conditionInstances must not diverge', () => {
    /** Sheet has 'poisoned'; a tracker edit materialises it as a structured instance. */
    async function materialisedThenClearedOnSheet() {
      const ctx = seedRunningFight({ sheetConditions: ['poisoned'] });
      await ctx.encountersService.updateCombatant(
        ctx.encounterId,
        ctx.combatantId,
        { addConditions: ['prone'] },
        dmUser,
        'dm',
      );
      expect(readInstanceNames(ctx.orm, ctx.combatantId)).toEqual(['poisoned', 'prone']);

      // The sheet clears 'poisoned'. syncActiveCombatantConditions writes `conditions` only.
      await ctx.charactersService.patchConditions(ctx.characterId, { remove: ['poisoned'] }, dmUser, 'dm');
      // The removal LOOKS applied at this point — both surfaces agree.
      expect(readConditions(ctx.orm, 'combatant', ctx.combatantId)).not.toContain('poisoned');
      expect(readConditions(ctx.orm, 'character', ctx.characterId)).not.toContain('poisoned');
      return ctx;
    }

    // The symptom a DM actually sees: a condition they removed comes back by itself.
    it('does not resurrect a sheet-removed condition on the next tracker write', async () => {
      const ctx = await materialisedThenClearedOnSheet();

      // An unrelated condition edit re-derives `conditions` from the stale instances.
      await ctx.encountersService.updateCombatant(
        ctx.encounterId,
        ctx.combatantId,
        { addConditions: ['blinded'] },
        dmUser,
        'dm',
      );

      expect(readConditions(ctx.orm, 'combatant', ctx.combatantId)).not.toContain('poisoned');
      expect(readConditions(ctx.orm, 'character', ctx.characterId)).not.toContain('poisoned');
    });

    // The cause: the structured copy still holds what the legacy array dropped.
    it('reconciles conditionInstances when a sheet-side removal lands', async () => {
      const ctx = await materialisedThenClearedOnSheet();
      expect(readInstanceNames(ctx.orm, ctx.combatantId)).toEqual(['prone']);
    });
  });

  /**
   * Issue #1047 — the sheet<->combat boundary.
   *
   * The sheet stores the same ConditionInstance shape as a combatant, but rounds do not
   * elapse outside an encounter, so the round/turn-scoped fields are nulled on the way to
   * the sheet and adopted as "indefinite" on the way back in. This is where the next
   * desync would live, so it is asserted in both directions.
   */
  describe('sheet <-> combat condition boundary (#1047)', () => {
    function readSheetInstances(orm: ReturnType<typeof build>['orm'], characterId: number) {
      const [row] = orm.select().from(characters).where(eq(characters.id, characterId)).limit(1).all();
      return fromJsonText<ConditionInstance[]>(row.conditionInstances, []);
    }

    function readCombatantInstances(orm: ReturnType<typeof build>['orm'], combatantId: number) {
      const [row] = orm.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all();
      return fromJsonText<ConditionInstance[]>(row.conditionInstances, []);
    }

    /**
     * Issue #1643 — adjustConditionLevel must push the new stacks onto the live tracker.
     * Name-only sync would preserve an existing Exhaustion's old stacks (or invent stacks: 1
     * for a brand-new name), so the tracker and sheet would disagree until the next
     * combatant write mirrored the stale level back onto the sheet.
     */
    it('adjustConditionLevel syncs Exhaustion stacks onto the live combatant', async () => {
      const ctx = seedRunningFight();
      // Pre-seed the tracker with Exhaustion at stacks: 1 (as a presence-only add would).
      await ctx.charactersService.patchConditions(ctx.characterId, { add: ['Exhaustion'] }, dmUser, 'dm');
      expect(readCombatantInstances(ctx.orm, ctx.combatantId).find((i) => i.name === 'Exhaustion')).toMatchObject({
        stacks: 1,
      });

      // Absolute set to 3 — must land on the combatant, not leave stacks: 1 behind.
      await ctx.charactersService.adjustConditionLevel(
        ctx.characterId,
        { name: 'Exhaustion', level: 3 },
        dmUser,
        'dm',
      );
      expect(readSheetInstances(ctx.orm, ctx.characterId).find((i) => i.name === 'Exhaustion')).toMatchObject({
        stacks: 3,
      });
      expect(readCombatantInstances(ctx.orm, ctx.combatantId).find((i) => i.name === 'Exhaustion')).toMatchObject({
        stacks: 3,
      });

      // Relative +1 on a fresh character with no prior Exhaustion must create stacks: 1, not
      // leave the tracker empty while the sheet has it (or invent the wrong level).
      await ctx.charactersService.adjustConditionLevel(
        ctx.characterId,
        { name: 'Exhaustion', level: 0 },
        dmUser,
        'dm',
      );
      await ctx.charactersService.adjustConditionLevel(
        ctx.characterId,
        { name: 'Exhaustion', delta: 2 },
        dmUser,
        'dm',
      );
      expect(readCombatantInstances(ctx.orm, ctx.combatantId).find((i) => i.name === 'Exhaustion')).toMatchObject({
        stacks: 2,
      });
    });

    it('strips round-scoped fields when a condition travels to the sheet on /end', async () => {
      const ctx = seedRunningFight();
      // A condition with a live round counter and a repeat save, as combat produces.
      await ctx.encountersService.updateCombatant(
        ctx.encounterId,
        ctx.combatantId,
        {
          addConditionInstance: {
            id: 'inst_poison', name: 'poisoned', ruleEntryId: null, source: 'Giant Spider',
            sourceCombatantId: 4242, durationRounds: 3, roundsRemaining: 2, timing: 'end-of-turn',
            saveTiming: 'end-of-turn', saveDc: 13, saveAbility: 'con', isConcentration: false,
            stacks: 1, notes: 'bite', custom: false,
          },
        },
        dmUser,
        'dm',
      );

      await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');

      const [sheet] = readSheetInstances(ctx.orm, ctx.characterId).filter((i) => i.name === 'poisoned');
      expect(sheet).toBeDefined();
      // Kept: the duration-independent facts.
      expect(sheet.source).toBe('Giant Spider');
      expect(sheet.notes).toBe('bite');
      expect(sheet.stacks).toBe(1);
      // Stripped: everything that only means something inside a round loop.
      expect(sheet.durationRounds).toBeNull();
      expect(sheet.roundsRemaining).toBeNull();
      expect(sheet.timing).toBe('none');
      expect(sheet.saveTiming).toBe('none');
      expect(sheet.saveDc).toBeNull();
      expect(sheet.saveAbility).toBeNull();
      expect(sheet.sourceCombatantId).toBeNull();
      // The condition itself survives — a mid-countdown effect is not silently dropped.
      expect(readConditions(ctx.orm, 'character', ctx.characterId)).toContain('poisoned');
    });

    it('carries sheet metadata into a new encounter as an indefinite condition', async () => {
      const ctx = seedRunningFight();
      await ctx.charactersService.patchConditions(ctx.characterId, { add: ['cursed'] }, dmUser, 'dm');
      // Give the sheet instance metadata a bare string cannot express.
      const sheetInstances = readSheetInstances(ctx.orm, ctx.characterId).map((i) =>
        i.name === 'cursed' ? { ...i, source: 'Hag bargain', stacks: 3, notes: 'family debt' } : i,
      );
      ctx.orm
        .update(characters)
        .set({ conditionInstances: JSON.stringify(sheetInstances) })
        .where(eq(characters.id, ctx.characterId))
        .run();

      const next = await ctx.encountersService.create(ctx.campaignId, { name: 'Round two' }, dmUser, 'dm');
      const pc = next.combatants.find((c) => c.characterId === ctx.characterId);
      expect(pc).toBeDefined();
      const [carried] = fromJsonText<ConditionInstance[]>(
        ctx.orm.select().from(combatants).where(eq(combatants.id, pc!.id)).limit(1).all()[0].conditionInstances,
        [],
      ).filter((i) => i.name === 'cursed');

      expect(carried).toBeDefined();
      expect(carried.source).toBe('Hag bargain');
      expect(carried.notes).toBe('family debt');
      // stacks survives the boundary — this is what lets exhaustion be an instance, not a column (#1073).
      expect(carried.stacks).toBe(3);
      // Adopted as indefinite: you did not walk in with a round timer already running.
      expect(carried.roundsRemaining).toBeNull();
      expect(carried.timing).toBe('none');
    });
  });

  /**
   * Issue #1670 — exhaustion (or any adapter-declared leveled condition) must not diverge
   * between the sheet and a linked combatant. Two gaps, both closed here:
   *
   *   A. The combatant condition-instance write path (updateCombatant / update_combatant)
   *      had no reference to the adapter's leveled-condition track at all, so a DM could
   *      push `stacks` past what characters.service.ts's adjustConditionLevel would ever
   *      allow on the sheet — and the sheet's own controls are bounded to [0, track.max],
   *      so there was no way back down from the sheet once that happened.
   *   B. restParty's long-rest decrement wrote the sheet's new `stacks` but mirrored the
   *      linked combatant by NAME ONLY (syncActiveCombatantConditions with no
   *      conditionInstancesJson) — the combat tracker kept the pre-rest level until
   *      something else rewrote it.
   *
   * Both fixes reuse `leveledConditionTrackFor` — the SAME lookup adjustConditionLevel
   * already consults — rather than a second cap or a second sync path, per the issue's
   * explicit ask: one shared rule, not two more call sites each enforcing a copy.
   */
  describe('leveled-condition parity between sheet and combatant (#1670)', () => {
    function readSheetInstances(orm: ReturnType<typeof build>['orm'], characterId: number) {
      const [row] = orm.select().from(characters).where(eq(characters.id, characterId)).limit(1).all();
      return fromJsonText<ConditionInstance[]>(row.conditionInstances, []);
    }

    function readCombatantInstances(orm: ReturnType<typeof build>['orm'], combatantId: number) {
      const [row] = orm.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all();
      return fromJsonText<ConditionInstance[]>(row.conditionInstances, []);
    }

    const fullInstance = (over: Partial<ConditionInstance>): ConditionInstance => ({
      id: 'inst_1',
      name: 'Exhaustion',
      ruleEntryId: null,
      source: null,
      sourceCombatantId: null,
      durationRounds: null,
      roundsRemaining: null,
      timing: 'none',
      saveTiming: 'none',
      saveDc: null,
      saveAbility: null,
      isConcentration: false,
      stacks: 1,
      notes: '',
      custom: false,
      ...over,
    });

    // Half A.
    it('updateCombatant rejects Exhaustion past the adapter cap, the same way adjustConditionLevel rejects it on the sheet', async () => {
      const ctx = seedRunningFight();
      await expect(
        ctx.encountersService.updateCombatant(
          ctx.encounterId,
          ctx.combatantId,
          { addConditionInstance: fullInstance({ id: 'inst_over', stacks: 9 }) },
          dmUser,
          'dm',
        ),
      ).rejects.toMatchObject({ status: 400 });
      // Rejected, so nothing was written — the combatant still has no Exhaustion instance.
      expect(readCombatantInstances(ctx.orm, ctx.combatantId).find((i) => i.name === 'Exhaustion')).toBeUndefined();

      // The cap itself (6) is accepted — this is a ceiling, not an accidental exclusion of the max.
      await ctx.encountersService.updateCombatant(
        ctx.encounterId,
        ctx.combatantId,
        { addConditionInstance: fullInstance({ id: 'inst_at_cap', stacks: 6 }) },
        dmUser,
        'dm',
      );
      expect(readCombatantInstances(ctx.orm, ctx.combatantId).find((i) => i.name === 'Exhaustion')).toMatchObject({ stacks: 6 });

      // A bulk `conditionInstances` replace is the same write path and must be checked too.
      await expect(
        ctx.encountersService.updateCombatant(
          ctx.encounterId,
          ctx.combatantId,
          { conditionInstances: [fullInstance({ id: 'inst_bulk_over', stacks: 7 })] },
          dmUser,
          'dm',
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    // Half A's negative case: a system with no leveled-condition track (PF2e) is unaffected —
    // an arbitrary stacks value on ANY name is accepted, matching adjustConditionLevel's own
    // PF2e behaviour (every /conditions/level call 400s there for an unrelated reason — no
    // track exists to name — while plain condition-instance writes are untouched).
    it('a system with no leveled-condition track (PF2e) accepts any stacks value on the combatant', async () => {
      const ctx = seedRunningFight();
      ctx.orm.update(campaigns).set({ ruleSystem: 'pf2e' }).where(eq(campaigns.id, ctx.campaignId)).run();

      await ctx.encountersService.updateCombatant(
        ctx.encounterId,
        ctx.combatantId,
        { addConditionInstance: fullInstance({ id: 'inst_pf2e', name: 'Exhaustion', stacks: 99 }) },
        dmUser,
        'dm',
      );
      expect(readCombatantInstances(ctx.orm, ctx.combatantId).find((i) => i.name === 'Exhaustion')).toMatchObject({ stacks: 99 });
    });

    // Half B.
    it('a long rest mid-encounter reconciles the linked combatant’s Exhaustion level, not just its presence', async () => {
      const ctx = seedRunningFight();
      await ctx.charactersService.adjustConditionLevel(ctx.characterId, { name: 'Exhaustion', level: 5 }, dmUser, 'dm');
      expect(readCombatantInstances(ctx.orm, ctx.combatantId).find((i) => i.name === 'Exhaustion')).toMatchObject({ stacks: 5 });

      await ctx.charactersService.restParty(ctx.campaignId, 'long', [ctx.characterId], {}, dmUser, 'dm');

      // The sheet decremented by one level (#1641) …
      expect(readSheetInstances(ctx.orm, ctx.characterId).find((i) => i.name === 'Exhaustion')).toMatchObject({ stacks: 4 });
      // … and the combatant must agree, not still read the pre-rest level.
      expect(readCombatantInstances(ctx.orm, ctx.combatantId).find((i) => i.name === 'Exhaustion')).toMatchObject({ stacks: 4 });
    });

    it('a long rest that fully clears Exhaustion removes it from the linked combatant too', async () => {
      const ctx = seedRunningFight();
      await ctx.charactersService.adjustConditionLevel(ctx.characterId, { name: 'Exhaustion', level: 1 }, dmUser, 'dm');
      expect(readCombatantInstances(ctx.orm, ctx.combatantId).find((i) => i.name === 'Exhaustion')).toMatchObject({ stacks: 1 });

      await ctx.charactersService.restParty(ctx.campaignId, 'long', [ctx.characterId], {}, dmUser, 'dm');

      expect(readSheetInstances(ctx.orm, ctx.characterId).find((i) => i.name === 'Exhaustion')).toBeUndefined();
      expect(readCombatantInstances(ctx.orm, ctx.combatantId).find((i) => i.name === 'Exhaustion')).toBeUndefined();
    });
  });
});
