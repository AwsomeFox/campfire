import fs from 'node:fs';
import { desc, eq } from 'drizzle-orm';
import { ActionResolveRequest, ActionSpec, ConditionInstance } from '@campfire/schema';
import { openDatabase } from '../../src/db/db.module';
import { auditLog, campaigns, characters, combatants, encounterEvents, encounters, inventoryItems, ruleEntries, rulePacks } from '../../src/db/schema';
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
import { ActionResolverService } from '../../src/modules/encounters/action-resolver.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';
import * as dice from '../../src/common/dice';

/**
 * Issue #413 — current-turn workspace + player End-turn, at the service layer against a real
 * SQLite file (mirrors encounter-condition-concurrency.spec.ts). Covers the safety-critical
 * requirements: ownership + current-turn authorization, serialized advancement with a
 * double-advance guard, the DM-only-advancement + DM-confirmation campaign settings, the
 * delay/ready turn-order tools, and undo.
 */
describe('encounter turn workspace (real SQLite, service layer)', () => {
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
    const campaignLibrary = new CampaignLibraryService(orm, audit, events);
    const actions = new ActionResolverService(orm, events, audit);
    // Issue #1901: wire ActionResolverService in (the last, optional constructor param) so
    // suggestedActionsForCombatant's character branch merges equipped-item actions the same
    // way listUsableActions/resolveSpec do. Harmless for every OTHER test in this file — with
    // no equipped items the merge is a no-op, identical to the pre-#1901 sheet-only list.
    const service = new EncountersService(
      orm,
      audit,
      events,
      rolls,
      revisions,
      attachments,
      campaignLibrary,
      { notifyCampaign: jest.fn().mockResolvedValue(undefined), notifyUser: jest.fn().mockResolvedValue(undefined) } as any,
      undefined, // safety
      undefined, // charactersService
      undefined, // inventoryService
      undefined, // questsService
      undefined, // storylinesService
      undefined, // timelineService
      undefined, // campaignsService
      actions,
    );
    return { orm, service, actions, events };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };
  const player1: RequestUser = { id: 'user-1', name: 'Alice', serverRole: 'user', devRole: 'player' };
  const player2: RequestUser = { id: 'user-2', name: 'Bob', serverRole: 'user', devRole: 'player' };

  /**
   * Seed a running encounter with two character combatants owned by player1 (c1, top of
   * initiative and the current actor) and player2 (c2). Returns the ids + the campaign.
   */
  function seed(
    orm: ReturnType<typeof build>['orm'],
    opts: { dmControlsTurns?: boolean; requireDmTurnConfirmation?: boolean } = {},
  ): { campaignId: number; encounterId: number; c1: number; c2: number } {
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({
        name: 'Turn Test',
        dmControlsTurns: opts.dmControlsTurns ?? false,
        requireDmTurnConfirmation: opts.requireDmTurnConfirmation ?? false,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [char1] = orm
      .insert(characters)
      .values({ campaignId: campaign.id, ownerUserId: player1.id, name: 'Alice PC', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [char2] = orm
      .insert(characters)
      .values({ campaignId: campaign.id, ownerUserId: player2.id, name: 'Bob PC', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({ campaignId: campaign.id, name: 'Fight', status: 'running', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [c1] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: char1.id, name: 'Alice PC', initiative: 20, hpCurrent: 20, hpMax: 20, sortOrder: 0 })
      .returning()
      .all();
    const [c2] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: char2.id, name: 'Bob PC', initiative: 10, hpCurrent: 18, hpMax: 18, sortOrder: 1 })
      .returning()
      .all();
    orm.update(encounters).set({ currentCombatantId: c1.id }).where(eq(encounters.id, encounter.id)).run();
    return { campaignId: campaign.id, encounterId: encounter.id, c1: c1.id, c2: c2.id };
  }

  function currentId(orm: ReturnType<typeof build>['orm'], encounterId: number): number | null {
    const [row] = orm.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
    return row.currentCombatantId;
  }

  function currentRound(orm: ReturnType<typeof build>['orm'], encounterId: number): number {
    const [row] = orm.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
    return row.round;
  }

  it('the current combatant owner may end their own turn; it advances to the next actor', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);

    const result = await service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, player1, 'player');
    expect(result.currentCombatantId).toBe(c2);
    expect(currentId(orm, encounterId)).toBe(c2);
  });

  it('a player may NOT end another player’s active turn (ownership authorization)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm);

    // player2 owns c2, but c1 (player1) currently has the turn.
    await expect(service.endTurn(encounterId, {}, player2, 'player')).rejects.toThrow(/your own/i);
    expect(currentId(orm, encounterId)).toBe(c1); // no advance
  });

  it('dmControlsTurns forbids a player ending their own turn', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm, { dmControlsTurns: true });

    await expect(service.endTurn(encounterId, {}, player1, 'player')).rejects.toThrow(/DM-only/i);
    expect(currentId(orm, encounterId)).toBe(c1);
    // the DM can still advance.
    const result = await service.endTurn(encounterId, {}, dmUser, 'dm');
    expect(result.currentCombatantId).not.toBe(c1);
  });

  it('serializes advancement and prevents double-advance (two concurrent end-turns)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);

    // Both callers try to end c1's turn concurrently, each guarding on expected=c1.
    const results = await Promise.allSettled([
      service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm'),
      service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // Exactly one advances; the other 409s on the double-advance guard.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The turn advanced exactly once — to c2, not skipped past it.
    expect(currentId(orm, encounterId)).toBe(c2);
  });

  it('requireDmTurnConfirmation stages a player end-turn until the DM confirms', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm, { requireDmTurnConfirmation: true });

    // player1 ending their own turn is staged (no advance), surfaced as a 409-style conflict.
    await expect(service.endTurn(encounterId, {}, player1, 'player')).rejects.toThrow(/confirm/i);
    expect(currentId(orm, encounterId)).toBe(c1);
    // The DM confirms → advances.
    const result = await service.endTurn(encounterId, {}, dmUser, 'dm');
    expect(result.currentCombatantId).toBe(c2);
  });

  it('undo steps the turn pointer back to the previous combatant', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);

    await service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm');
    expect(currentId(orm, encounterId)).toBe(c2);
    const undone = await service.undoTurn(encounterId, dmUser, 'dm');
    expect(undone.currentCombatantId).toBe(c1);
    expect(currentId(orm, encounterId)).toBe(c1);
  });

  it('emits a turn edge for the restored combatant', async () => {
    dataDir = makeTempDataDir();
    const { orm, service, events } = build();
    const { campaignId, encounterId, c1, c2 } = seed(orm);
    const frames: Array<{
      type: string;
      currentCombatantId?: number | null;
      round?: number;
      combatantKind?: string | null;
      turnReverted?: true;
    }> = [];
    const subscription = events.streamFor(campaignId).subscribe((event) => frames.push(event));

    await service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm');
    frames.length = 0;
    await service.undoTurn(encounterId, dmUser, 'dm');
    subscription.unsubscribe();

    expect(frames).toEqual([
      expect.objectContaining({ type: 'encounter.updated', encounterId }),
      expect.objectContaining({
        type: 'encounter.turn_changed',
        encounterId,
        currentCombatantId: c1,
        round: 1,
        combatantKind: 'character',
        turnReverted: true,
      }),
    ]);
    expect(c2).not.toBe(c1);
  });

  it('emits turn edges when removing and restoring the active combatant', async () => {
    dataDir = makeTempDataDir();
    const { orm, service, events } = build();
    const { campaignId, encounterId, c1, c2 } = seed(orm);
    const frames: Array<{
      type: string;
      currentCombatantId?: number | null;
      round?: number;
      turnIndex?: number;
      combatantKind?: string | null;
      turnReverted?: true;
    }> = [];
    const subscription = events.streamFor(campaignId).subscribe((event) => frames.push(event));

    const removal = await service.removeCombatant(encounterId, c1, dmUser, 'dm');

    expect(frames).toEqual([
      expect.objectContaining({ type: 'encounter.updated', encounterId }),
      expect.objectContaining({
        type: 'encounter.turn_changed',
        encounterId,
        currentCombatantId: c2,
        round: 1,
        turnIndex: 0,
        combatantKind: 'character',
      }),
    ]);

    frames.length = 0;
    await service.undoRemoveCombatant(encounterId, removal.undoToken, dmUser, 'dm');
    subscription.unsubscribe();

    expect(frames).toEqual([
      expect.objectContaining({ type: 'encounter.updated', encounterId }),
      expect.objectContaining({
        type: 'encounter.turn_changed',
        encounterId,
        currentCombatantId: c1,
        round: 1,
        turnIndex: 0,
        combatantKind: 'character',
        turnReverted: true,
      }),
    ]);
  });

  it('undo resets the restored combatant’s per-turn action economy', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);

    await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'action', moveFt: 30 }, dmUser, 'dm');
    await service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm');
    expect(currentId(orm, encounterId)).toBe(c2);
    await service.undoTurn(encounterId, dmUser, 'dm');
    const [c1row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
    const turnState = JSON.parse(c1row.turnState ?? '{}');
    expect(turnState.used).toEqual({});
    expect(turnState.movementUsedFt).toBe(0);
  });

  describe('undo restores ticked condition and effect state (issue #1445)', () => {
    function conditionsFrom(row: { conditionInstances: string | null; conditions: string | null }): string[] {
      const instances = JSON.parse(row.conditionInstances ?? '[]');
      const names = new Set<string>();
      for (const c of instances) {
        if (typeof c.name === 'string' && c.name.trim().length > 0) names.add(c.name.trim());
      }
      return [...names].sort();
    }

    it('restores an end-of-turn condition that would expire, preserving roundsRemaining and metadata', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);

      const instance = {
        id: 'poisoned-1',
        name: 'Poisoned',
        source: 'goblin blade',
        sourceCombatantId: c2,
        ruleEntryId: null,
        saveDc: 12,
        saveAbility: 'CON',
        isConcentration: false,
        stacks: 2,
        notes: 'ends on save',
        durationRounds: 1,
        roundsRemaining: 1,
        timing: 'end-of-turn',
      };
      orm
        .update(combatants)
        .set({
          conditionInstances: JSON.stringify([instance]),
          conditions: JSON.stringify(['Poisoned']),
        })
        .where(eq(combatants.id, c1))
        .run();

      await service.nextTurn(encounterId, {}, dmUser, 'dm');
      expect(currentId(orm, encounterId)).toBe(c2);

      const [c1rowAfterAdvance] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      expect(JSON.parse(c1rowAfterAdvance.conditionInstances ?? '[]')).toHaveLength(0);

      await service.undoTurn(encounterId, dmUser, 'dm');
      expect(currentId(orm, encounterId)).toBe(c1);

      const [c1row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      const restored = JSON.parse(c1row.conditionInstances ?? '[]');
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject(instance);
      expect(conditionsFrom(c1row)).toEqual(['Poisoned']);
      expect(JSON.parse(c1row.conditions ?? '[]')).toEqual(['Poisoned']);

      const events = orm
        .select()
        .from(encounterEvents)
        .where(eq(encounterEvents.encounterId, encounterId))
        .orderBy(encounterEvents.id)
        .all();
      const restoredEvent = events.find((e) => e.detail === 'condition restored: Poisoned');
      expect(restoredEvent).toBeDefined();
      expect(restoredEvent?.actorId).toBe(c1);
    });

    it('keeps roundsRemaining unchanged across repeated next/undo cycles', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);

      orm
        .update(combatants)
        .set({
          conditionInstances: JSON.stringify([
            { id: 'bless', name: 'Bless', roundsRemaining: 4, timing: 'end-of-turn', isConcentration: false },
          ]),
          conditions: JSON.stringify(['Bless']),
        })
        .where(eq(combatants.id, c1))
        .run();

      for (let i = 0; i < 3; i++) {
        await service.nextTurn(encounterId, {}, dmUser, 'dm');
        expect(currentId(orm, encounterId)).toBe(c2);
        await service.undoTurn(encounterId, dmUser, 'dm');
        expect(currentId(orm, encounterId)).toBe(c1);
      }

      const [c1row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      const restored = JSON.parse(c1row.conditionInstances ?? '[]');
      expect(restored).toHaveLength(1);
      expect(restored[0].roundsRemaining).toBe(4);
      expect(conditionsFrom(c1row)).toEqual(['Bless']);
      expect(JSON.parse(c1row.conditions ?? '[]')).toEqual(['Bless']);
    });

    it('restores an active effect that would expire, preserving roundsRemaining', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      const effect = {
        id: 'faerie-fire',
        name: 'Faerie Fire',
        kind: 'buff',
        timing: 'none',
        roundsRemaining: 1,
        saveAbility: null,
        saveDc: null,
        notes: '',
      };
      orm
        .update(combatants)
        .set({ activeEffects: JSON.stringify([effect]) })
        .where(eq(combatants.id, c1))
        .run();

      await service.nextTurn(encounterId, {}, dmUser, 'dm');
      const [c1rowAfterAdvance] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      expect(JSON.parse(c1rowAfterAdvance.activeEffects ?? '[]')).toHaveLength(0);

      await service.undoTurn(encounterId, dmUser, 'dm');
      const [c1row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      const restored = JSON.parse(c1row.activeEffects ?? '[]');
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject(effect);

      const events = orm
        .select()
        .from(encounterEvents)
        .where(eq(encounterEvents.encounterId, encounterId))
        .orderBy(encounterEvents.id)
        .all();
      expect(events.some((e) => e.detail === 'effect restored: Faerie Fire')).toBe(true);
    });

    it('keeps active effect roundsRemaining unchanged across repeated next/undo cycles', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      orm
        .update(combatants)
        .set({
          activeEffects: JSON.stringify([
            { id: 'haste', name: 'Haste', kind: 'buff', timing: 'none', roundsRemaining: 4 },
          ]),
        })
        .where(eq(combatants.id, c1))
        .run();

      for (let i = 0; i < 3; i++) {
        await service.nextTurn(encounterId, {}, dmUser, 'dm');
        await service.undoTurn(encounterId, dmUser, 'dm');
      }

      const [c1row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      const restored = JSON.parse(c1row.activeEffects ?? '[]');
      expect(restored).toHaveLength(1);
      expect(restored[0].roundsRemaining).toBe(4);
    });

    it('restores a start-of-turn condition on the incoming combatant, including concentration links', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);

      orm
        .update(combatants)
        .set({ turnState: JSON.stringify({ concentration: 'Hold Person' }) })
        .where(eq(combatants.id, c1))
        .run();
      orm
        .update(combatants)
        .set({
          conditionInstances: JSON.stringify([
            {
              id: 'hold-person',
              name: 'Hold Person',
              isConcentration: true,
              sourceCombatantId: c1,
              roundsRemaining: 1,
              timing: 'start-of-turn',
            },
          ]),
          conditions: JSON.stringify(['Hold Person']),
        })
        .where(eq(combatants.id, c2))
        .run();

      await service.nextTurn(encounterId, {}, dmUser, 'dm');
      const [c2rowAfterAdvance] = orm.select().from(combatants).where(eq(combatants.id, c2)).limit(1).all();
      expect(JSON.parse(c2rowAfterAdvance.conditionInstances ?? '[]')).toHaveLength(0);

      await service.undoTurn(encounterId, dmUser, 'dm');
      const [c2row] = orm.select().from(combatants).where(eq(combatants.id, c2)).limit(1).all();
      const restored = JSON.parse(c2row.conditionInstances ?? '[]');
      expect(restored).toHaveLength(1);
      expect(restored[0].roundsRemaining).toBe(1);
      expect(restored[0].isConcentration).toBe(true);
      expect(restored[0].sourceCombatantId).toBe(c1);
      expect(conditionsFrom(c2row)).toEqual(['Hold Person']);
      expect(JSON.parse(c2row.conditions ?? '[]')).toEqual(['Hold Person']);

      const [c1row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      expect(JSON.parse(c1row.turnState ?? '{}').concentration).toBe('Hold Person');
    });

    it('skips restoration safely when a snapshot combatant was removed between advance and undo', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);

      orm
        .update(combatants)
        .set({
          conditionInstances: JSON.stringify([
            { id: 'slow', name: 'Slow', roundsRemaining: 2, timing: 'end-of-turn' },
          ]),
          conditions: JSON.stringify(['Slow']),
        })
        .where(eq(combatants.id, c1))
        .run();

      await service.nextTurn(encounterId, {}, dmUser, 'dm');
      await service.removeCombatant(encounterId, c2, dmUser, 'dm');

      const undone = await service.undoTurn(encounterId, dmUser, 'dm');
      expect(undone.currentCombatantId).toBe(c1);

      const [c1row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      const restored = JSON.parse(c1row.conditionInstances ?? '[]');
      expect(restored).toHaveLength(1);
      expect(restored[0].roundsRemaining).toBe(2);
      expect(JSON.parse(c1row.conditions ?? '[]')).toEqual(['Slow']);
    });

    it('supports multiple consecutive undos by consuming the snapshot each time (issue #1445)', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);

      function conditionRounds(row: { conditionInstances: string | null }, id: string): number | undefined {
        return JSON.parse(row.conditionInstances ?? '[]').find((c: any) => c.id === id)?.roundsRemaining;
      }
      function effectRounds(row: { activeEffects: string | null }, id: string): number | undefined {
        return JSON.parse(row.activeEffects ?? '[]').find((e: any) => e.id === id)?.roundsRemaining;
      }

      const c1Condition = {
        id: 'c1-cond',
        name: 'C1 Cond',
        roundsRemaining: 2,
        timing: 'end-of-turn',
        isConcentration: false,
      };
      const c1Effect = {
        id: 'c1-eff',
        name: 'C1 Eff',
        kind: 'other',
        timing: 'none',
        roundsRemaining: 2,
      };
      const c2Condition = {
        id: 'c2-cond',
        name: 'C2 Cond',
        roundsRemaining: 2,
        timing: 'end-of-turn',
        isConcentration: false,
      };
      const c2Effect = {
        id: 'c2-eff',
        name: 'C2 Eff',
        kind: 'other',
        timing: 'none',
        roundsRemaining: 2,
      };
      orm
        .update(combatants)
        .set({
          conditionInstances: JSON.stringify([c1Condition]),
          conditions: JSON.stringify(['C1 Cond']),
          activeEffects: JSON.stringify([c1Effect]),
        })
        .where(eq(combatants.id, c1))
        .run();
      orm
        .update(combatants)
        .set({
          conditionInstances: JSON.stringify([c2Condition]),
          conditions: JSON.stringify(['C2 Cond']),
          activeEffects: JSON.stringify([c2Effect]),
        })
        .where(eq(combatants.id, c2))
        .run();

      await service.nextTurn(encounterId, {}, dmUser, 'dm');
      expect(currentId(orm, encounterId)).toBe(c2);
      const [c1rowAfterFirst] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      expect(conditionRounds(c1rowAfterFirst, 'c1-cond')).toBe(1);
      expect(effectRounds(c1rowAfterFirst, 'c1-eff')).toBe(1);

      await service.nextTurn(encounterId, {}, dmUser, 'dm');
      expect(currentId(orm, encounterId)).toBe(c1);
      expect(currentRound(orm, encounterId)).toBe(2);
      const [c2rowAfterSecond] = orm.select().from(combatants).where(eq(combatants.id, c2)).limit(1).all();
      expect(conditionRounds(c2rowAfterSecond, 'c2-cond')).toBe(1);
      expect(effectRounds(c2rowAfterSecond, 'c2-eff')).toBe(1);

      const first = await service.undoTurn(encounterId, dmUser, 'dm');
      expect(first.currentCombatantId).toBe(c2);
      expect(first.round).toBe(1);
      const [c2rowAfterFirstUndo] = orm.select().from(combatants).where(eq(combatants.id, c2)).limit(1).all();
      expect(conditionRounds(c2rowAfterFirstUndo, 'c2-cond')).toBe(2);
      expect(effectRounds(c2rowAfterFirstUndo, 'c2-eff')).toBe(2);
      const [c1rowAfterFirstUndo] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      expect(conditionRounds(c1rowAfterFirstUndo, 'c1-cond')).toBe(1);
      expect(effectRounds(c1rowAfterFirstUndo, 'c1-eff')).toBe(1);

      const second = await service.undoTurn(encounterId, dmUser, 'dm');
      expect(second.currentCombatantId).toBe(c1);
      expect(second.round).toBe(1);
      const [c1rowAfterSecondUndo] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      expect(conditionRounds(c1rowAfterSecondUndo, 'c1-cond')).toBe(2);
      expect(effectRounds(c1rowAfterSecondUndo, 'c1-eff')).toBe(2);
      const [c2rowAfterSecondUndo] = orm.select().from(combatants).where(eq(combatants.id, c2)).limit(1).all();
      expect(conditionRounds(c2rowAfterSecondUndo, 'c2-cond')).toBe(2);
      expect(effectRounds(c2rowAfterSecondUndo, 'c2-eff')).toBe(2);
    });

    it('preserves conditions and effects added during the turn while restoring ticked state (issue #1445)', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);

      const startCondition = {
        id: 'c2-start',
        name: 'C2 Start',
        roundsRemaining: 1,
        timing: 'start-of-turn',
      };
      const preEffect = {
        id: 'c2-effect',
        name: 'C2 Effect',
        kind: 'other',
        timing: 'none',
        roundsRemaining: 2,
      };
      orm
        .update(combatants)
        .set({
          conditionInstances: JSON.stringify([startCondition]),
          conditions: JSON.stringify(['C2 Start']),
          activeEffects: JSON.stringify([preEffect]),
        })
        .where(eq(combatants.id, c2))
        .run();

      await service.nextTurn(encounterId, {}, dmUser, 'dm');
      expect(currentId(orm, encounterId)).toBe(c2);

      // Add a condition and effect during c2's turn.
      await service.updateCombatant(
        encounterId,
        c2,
        {
          addConditionInstance: ConditionInstance.parse({
            id: 'added-cond',
            name: 'Added Cond',
            roundsRemaining: 3,
            timing: 'none',
          }),
        },
        dmUser,
        'dm',
      );
      const [c2rowBeforeUndo] = orm.select().from(combatants).where(eq(combatants.id, c2)).limit(1).all();
      const beforeEffects = JSON.parse(c2rowBeforeUndo.activeEffects ?? '[]');
      const addedEffect = {
        id: 'added-effect',
        name: 'Added Effect',
        kind: 'buff',
        timing: 'none',
        roundsRemaining: 5,
      };
      orm
        .update(combatants)
        .set({ activeEffects: JSON.stringify([...beforeEffects, addedEffect]) })
        .where(eq(combatants.id, c2))
        .run();

      await service.undoTurn(encounterId, dmUser, 'dm');
      expect(currentId(orm, encounterId)).toBe(c1);

      const [c2row] = orm.select().from(combatants).where(eq(combatants.id, c2)).limit(1).all();
      const conditionNames = conditionsFrom(c2row);
      expect(conditionNames).toContain('C2 Start');
      expect(conditionNames).toContain('Added Cond');

      const effects = JSON.parse(c2row.activeEffects ?? '[]');
      expect(effects).toHaveLength(2);
      expect(effects.find((e: any) => e.id === 'added-effect')).toMatchObject(addedEffect);
      expect(effects.find((e: any) => e.id === 'c2-effect')).toMatchObject(preEffect);
    });

    it('does not revert post-advance edits or resurrect removed conditions/effects (issue #1445)', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      const condA = {
        id: 'cond-a',
        name: 'Cond A',
        roundsRemaining: 2,
        timing: 'end-of-turn',
        isConcentration: false,
        stacks: 1,
        notes: '',
        custom: false,
      };
      const condB = {
        id: 'cond-b',
        name: 'Cond B',
        roundsRemaining: 2,
        timing: 'end-of-turn',
        isConcentration: false,
        stacks: 1,
        notes: '',
        custom: false,
      };
      const effX = {
        id: 'eff-x',
        name: 'Eff X',
        kind: 'other',
        timing: 'none',
        roundsRemaining: 2,
        saveAbility: null,
        saveDc: null,
        notes: '',
      };
      const effY = {
        id: 'eff-y',
        name: 'Eff Y',
        kind: 'other',
        timing: 'none',
        roundsRemaining: 2,
        saveAbility: null,
        saveDc: null,
        notes: '',
      };
      orm
        .update(combatants)
        .set({
          conditionInstances: JSON.stringify([condA, condB]),
          conditions: JSON.stringify(['Cond A', 'Cond B']),
          activeEffects: JSON.stringify([effX, effY]),
        })
        .where(eq(combatants.id, c1))
        .run();

      await service.nextTurn(encounterId, {}, dmUser, 'dm');

      const [c1rowAfter] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      const afterConds = JSON.parse(c1rowAfter.conditionInstances ?? '[]');
      const afterEffs = JSON.parse(c1rowAfter.activeEffects ?? '[]');

      // Edit cond-a's stacks/notes but leave its post-tick roundsRemaining at 1.
      const editedCondA = afterConds.find((c: any) => c.id === 'cond-a');
      editedCondA.stacks = 3;
      editedCondA.notes = 'kept edit';
      // Remove cond-b after the tick.
      const remainingConds = [editedCondA];

      // Edit eff-x's roundsRemaining to a custom value; remove eff-y.
      const editedEffX = afterEffs.find((e: any) => e.id === 'eff-x');
      editedEffX.roundsRemaining = 5;
      const remainingEffs = [editedEffX];

      orm
        .update(combatants)
        .set({
          conditionInstances: JSON.stringify(remainingConds),
          conditions: JSON.stringify(['Cond A']),
          activeEffects: JSON.stringify(remainingEffs),
        })
        .where(eq(combatants.id, c1))
        .run();

      await service.undoTurn(encounterId, dmUser, 'dm');

      const [c1row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      const restoredConds = JSON.parse(c1row.conditionInstances ?? '[]');
      const restoredEffs = JSON.parse(c1row.activeEffects ?? '[]');

      const a = restoredConds.find((c: any) => c.id === 'cond-a');
      expect(a).toBeDefined();
      expect(a.roundsRemaining).toBe(2);
      expect(a.stacks).toBe(3);
      expect(a.notes).toBe('kept edit');

      expect(restoredConds.find((c: any) => c.id === 'cond-b')).toBeUndefined();

      const x = restoredEffs.find((e: any) => e.id === 'eff-x');
      expect(x).toBeDefined();
      expect(x.roundsRemaining).toBe(5);

      expect(restoredEffs.find((e: any) => e.id === 'eff-y')).toBeUndefined();
    });

    it('restores both end-of-turn and start-of-turn conditions when the same combatant ends and begins the turn', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);

      await service.removeCombatant(encounterId, c2, dmUser, 'dm');

      const endCondition = {
        id: 'lone-end',
        name: 'Lone End',
        source: 'trap',
        sourceCombatantId: null,
        ruleEntryId: null,
        saveDc: null,
        saveAbility: null,
        isConcentration: false,
        stacks: 1,
        notes: '',
        durationRounds: 2,
        roundsRemaining: 2,
        timing: 'end-of-turn',
      };
      const startCondition = {
        id: 'lone-start',
        name: 'Lone Start',
        source: 'trap',
        sourceCombatantId: null,
        ruleEntryId: null,
        saveDc: null,
        saveAbility: null,
        isConcentration: false,
        stacks: 1,
        notes: '',
        durationRounds: 1,
        roundsRemaining: 1,
        timing: 'start-of-turn',
      };
      orm
        .update(combatants)
        .set({
          conditionInstances: JSON.stringify([endCondition, startCondition]),
          conditions: JSON.stringify(['Lone End', 'Lone Start']),
        })
        .where(eq(combatants.id, c1))
        .run();

      await service.nextTurn(encounterId, {}, dmUser, 'dm');
      const [rowAfterAdvance] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      const afterAdvance = JSON.parse(rowAfterAdvance.conditionInstances ?? '[]');
      expect(afterAdvance).toHaveLength(1);
      expect(afterAdvance[0]).toMatchObject({ id: 'lone-end', roundsRemaining: 1 });
      expect(conditionsFrom(rowAfterAdvance)).toEqual(['Lone End']);

      await service.undoTurn(encounterId, dmUser, 'dm');
      const [row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      const restored = JSON.parse(row.conditionInstances ?? '[]');
      expect(restored).toHaveLength(2);
      expect(restored.find((c: any) => c.id === 'lone-end')).toMatchObject(endCondition);
      expect(restored.find((c: any) => c.id === 'lone-start')).toMatchObject(startCondition);
      expect(conditionsFrom(row)).toEqual(['Lone End', 'Lone Start']);
      expect(JSON.parse(row.conditions ?? '[]')).toEqual(['Lone End', 'Lone Start']);
      expect(currentId(orm, encounterId)).toBe(c1);
    });
  });

  it('advancing resets the incoming combatant’s per-turn action economy', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);

    // c2 has spent its action + movement in a prior round.
    await service.updateCombatantTurnState(encounterId, c2, { useSlot: 'action', moveFt: 30 }, dmUser, 'dm');
    // Advance so c2's turn begins — its per-turn slice must reset.
    await service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm');
    const [c2row] = orm.select().from(combatants).where(eq(combatants.id, c2)).limit(1).all();
    const turnState = JSON.parse(c2row.turnState ?? '{}');
    expect(turnState.used).toEqual({});
    expect(turnState.movementUsedFt).toBe(0);
  });

  it('removing the active combatant starts the selected successor’s turn lifecycle', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    const [c3] = orm
      .insert(combatants)
      .values({ encounterId, kind: 'monster', name: 'Eligible successor', initiative: 5, hpCurrent: 8, hpMax: 8, sortOrder: 2 })
      .returning()
      .all();
    // The next ordered actor is down, so removal skips it and starts c3 instead.
    orm.update(combatants).set({ deathState: 'dead' }).where(eq(combatants.id, c2)).run();
    await service.updateCombatantTurnState(encounterId, c3.id, { useSlot: 'action', moveFt: 30 }, dmUser, 'dm');
    const startTick = {
      id: 'remove_start_tick', name: 'hexed', ruleEntryId: null, source: null, sourceCombatantId: null,
      durationRounds: 2, roundsRemaining: 2, timing: 'start-of-turn', saveTiming: 'none', saveDc: null,
      saveAbility: null, isConcentration: false, stacks: 1, notes: '', custom: false,
    };
    orm.update(combatants)
      .set({ conditions: JSON.stringify(['hexed']), conditionInstances: JSON.stringify([startTick]) })
      .where(eq(combatants.id, c3.id))
      .run();

    const removal = await service.removeCombatant(encounterId, c1, dmUser, 'dm');

    expect(currentId(orm, encounterId)).toBe(c3.id);
    const [successor] = orm.select().from(combatants).where(eq(combatants.id, c3.id)).limit(1).all();
    expect(JSON.parse(successor.turnState ?? '{}')).toMatchObject({ used: {}, movementUsedFt: 0 });
    expect(JSON.parse(successor.conditionInstances ?? '[]')).toEqual([expect.objectContaining({ id: 'remove_start_tick', roundsRemaining: 1 })]);

    await service.undoRemoveCombatant(encounterId, removal.undoToken, dmUser, 'dm');
    const [rewoundSuccessor] = orm.select().from(combatants).where(eq(combatants.id, c3.id)).limit(1).all();
    expect(JSON.parse(rewoundSuccessor.turnState ?? '{}')).toMatchObject({ used: { action: 1 }, movementUsedFt: 30 });
    expect(JSON.parse(rewoundSuccessor.conditionInstances ?? '[]')).toEqual([expect.objectContaining({ id: 'remove_start_tick', roundsRemaining: 2 })]);
  });

  it('removing the last active combatant resets legendary usage for the new round', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    const ts = new Date().toISOString();
    const [pack] = orm.insert(rulePacks)
      .values({ slug: 'removal-round-legendary', name: 'Removal round legendary', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 1 })
      .returning()
      .all();
    const [entry] = orm.insert(ruleEntries)
      .values({
        packId: pack.id, slug: 'removal-round-drake', name: 'Removal round drake', type: 'monster', summary: '', body: '',
        dataJson: JSON.stringify({ legendary_actions: [{ name: 'Tail attack' }] }), createdAt: ts, updatedAt: ts,
      })
      .returning()
      .all();
    const [otherBoss] = orm.insert(combatants)
      .values({ encounterId, kind: 'monster', name: 'Inactive legendary', initiative: 5, hpCurrent: 8, hpMax: 8, sortOrder: 2, ruleEntryId: entry.id, deathState: 'dead', turnState: JSON.stringify({ used: { legendary: 3 } }) })
      .returning()
      .all();
    orm.update(combatants).set({ ruleEntryId: entry.id, turnState: JSON.stringify({ used: { legendary: 3 } }) }).where(eq(combatants.id, c1)).run();

    await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'action', moveFt: 30 }, dmUser, 'dm');
    await service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm');
    const removal = await service.removeCombatant(encounterId, c2, dmUser, 'dm');

    const [newRoundBoss] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
    expect(JSON.parse(newRoundBoss.turnState ?? '{}').used.legendary ?? 0).toBe(0);
    expect(JSON.parse(newRoundBoss.turnState ?? '{}')).toMatchObject({ used: {}, movementUsedFt: 0 });
    const [newRoundOtherBoss] = orm.select().from(combatants).where(eq(combatants.id, otherBoss.id)).limit(1).all();
    expect(JSON.parse(newRoundOtherBoss.turnState ?? '{}').used.legendary ?? 0).toBe(0);

    await service.undoRemoveCombatant(encounterId, removal.undoToken, dmUser, 'dm');
    const [rewoundOtherBoss] = orm.select().from(combatants).where(eq(combatants.id, otherBoss.id)).limit(1).all();
    expect(JSON.parse(rewoundOtherBoss.turnState ?? '{}').used.legendary).toBe(3);
  });

  it('removing a lair resume target chooses the next eligible combatant', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    const [downed] = orm.insert(combatants)
      .values({ encounterId, kind: 'monster', name: 'Downed fallback', initiative: 5, hpCurrent: 0, hpMax: 8, sortOrder: 2, deathState: 'dead' })
      .returning()
      .all();
    const [eligible] = orm.insert(combatants)
      .values({ encounterId, kind: 'monster', name: 'Eligible fallback', initiative: 1, hpCurrent: 8, hpMax: 8, sortOrder: 3 })
      .returning()
      .all();
    orm.update(encounters)
      .set({ turnPhase: 'lair', currentCombatantId: null, lairResumeCombatantId: c2 })
      .where(eq(encounters.id, encounterId))
      .run();

    await service.removeCombatant(encounterId, c2, dmUser, 'dm');

    const [afterRemoval] = orm.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
    expect(afterRemoval).toMatchObject({ turnPhase: 'lair', currentCombatantId: null, lairResumeCombatantId: eligible.id });
    expect(afterRemoval.lairResumeCombatantId).not.toBe(downed.id);
    expect(afterRemoval.lairResumeCombatantId).not.toBe(c1);
  });

  it('removing a lair resume target exits the lair phase when no actor is eligible', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    orm.update(combatants).set({ hpCurrent: 0, deathState: 'dead' }).where(eq(combatants.id, c1)).run();
    orm.update(encounters)
      .set({ turnPhase: 'lair', currentCombatantId: null, lairResumeCombatantId: c2 })
      .where(eq(encounters.id, encounterId))
      .run();

    await service.removeCombatant(encounterId, c2, dmUser, 'dm');

    const [afterRemoval] = orm.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
    expect(afterRemoval).toMatchObject({ turnPhase: 'combatant', currentCombatantId: null, lairResumeCombatantId: null });
  });

  it('removing the final lair resume target shifts without round wrap', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    orm.update(encounters)
      .set({ turnPhase: 'lair', currentCombatantId: null, lairResumeCombatantId: c2 })
      .where(eq(encounters.id, encounterId))
      .run();

    await service.removeCombatant(encounterId, c2, dmUser, 'dm');

    const [afterRemoval] = orm.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
    expect(afterRemoval).toMatchObject({ round: 1, turnPhase: 'lair', currentCombatantId: null, lairResumeCombatantId: c1 });
  });

  it('undoing an active removal restores the combatant phase after entering a lair slot', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    const ts = new Date().toISOString();
    const [pack] = orm.insert(rulePacks)
      .values({ slug: 'lair-turn-test', name: 'Lair turn test', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 1 })
      .returning()
      .all();
    const [lairEntry] = orm.insert(ruleEntries)
      .values({
        packId: pack.id, slug: 'lair-turn-monster', name: 'Lair turn monster', type: 'monster', summary: '', body: '',
        dataJson: JSON.stringify({ lairActions: [{ name: 'Shifting walls' }] }), createdAt: ts, updatedAt: ts,
      })
      .returning()
      .all();
    orm.update(combatants).set({ ruleEntryId: lairEntry.id }).where(eq(combatants.id, c1)).run();

    const removal = await service.removeCombatant(encounterId, c1, dmUser, 'dm');
    const [afterRemoval] = orm.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
    expect(afterRemoval).toMatchObject({ turnPhase: 'lair', currentCombatantId: null, lairResumeCombatantId: c2 });

    await service.undoRemoveCombatant(encounterId, removal.undoToken, dmUser, 'dm');
    const [afterUndo] = orm.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
    expect(afterUndo).toMatchObject({ turnPhase: 'combatant', currentCombatantId: c1, lairResumeCombatantId: null });
  });

  it('removing the final initiative-20 actor carries a lair-entry round wrap', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    const ts = new Date().toISOString();
    const [pack] = orm.insert(rulePacks)
      .values({ slug: 'lair-wrap-test', name: 'Lair wrap test', version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 1 })
      .returning()
      .all();
    const [lairEntry] = orm.insert(ruleEntries)
      .values({
        packId: pack.id, slug: 'lair-wrap-monster', name: 'Lair wrap monster', type: 'monster', summary: '', body: '',
        dataJson: JSON.stringify({ lairActions: [{ name: 'Crumbling floor' }] }), createdAt: ts, updatedAt: ts,
      })
      .returning()
      .all();
    orm.update(combatants).set({ initiative: 21, ruleEntryId: lairEntry.id }).where(eq(combatants.id, c1)).run();
    orm.update(combatants).set({ initiative: 20 }).where(eq(combatants.id, c2)).run();
    orm.update(encounters).set({ currentCombatantId: c2 }).where(eq(encounters.id, encounterId)).run();

    await service.removeCombatant(encounterId, c2, dmUser, 'dm');

    const [afterRemoval] = orm.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
    expect(afterRemoval).toMatchObject({ round: 2, turnPhase: 'lair', currentCombatantId: null, lairResumeCombatantId: c1 });
  });

  it('delay / ready flags persist and are player-authorized on their own combatant', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm);

    const delayed = await service.updateCombatantTurnState(encounterId, c1, { delaying: true }, player1, 'player');
    expect(delayed.turnState.delaying).toBe(true);
    const readied = await service.updateCombatantTurnState(encounterId, c1, { readied: 'Fire when the door opens' }, player1, 'player');
    expect(readied.turnState.readied).toBe('Fire when the door opens');

    // player2 cannot touch player1's combatant turn state.
    await expect(
      service.updateCombatantTurnState(encounterId, c1, { delaying: false }, player2, 'player'),
    ).rejects.toThrow(/your own/i);
  });

  it('turn workspace shows the owner their action economy + your-turn flag, and hides detail from others', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm);

    const owner = await service.getTurnWorkspace(encounterId, player1, 'player');
    expect(owner.isYourTurn).toBe(true);
    expect(owner.canEndTurn).toBe(true);
    expect(owner.current?.combatantId).toBe(c1);
    // Default (empty) ruleSystem resolves to the 5e adapter — action economy is present.
    expect(owner.actionEconomy.map((s) => s.key)).toEqual(['action', 'bonus', 'reaction', 'movement']);

    // A different player sees identity + round but no detailed workspace (secrecy).
    const other = await service.getTurnWorkspace(encounterId, player2, 'player');
    expect(other.isYourTurn).toBe(false);
    expect(other.current?.combatantId).toBe(c1);
    expect(other.actionEconomy).toHaveLength(0);
  });

  describe('movement speed resolution (issue #1910)', () => {
    /** Resolves the movement slot's reported max from a fetched turn workspace. */
    function movementMax(workspace: { actionEconomy: Array<{ kind: string; max: number }> }): number | undefined {
      return workspace.actionEconomy.find((s) => s.kind === 'movement')?.max;
    }

    it('a null-speed character (nothing set anywhere) shows the adapter default (30 for 5e)', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId } = seed(orm);

      const workspace = await service.getTurnWorkspace(encounterId, player1, 'player');
      expect(movementMax(workspace)).toBe(30);
      expect(workspace.movement?.maxFt).toBe(30);
    });

    it('a combatant add-time speed snapshot resolves the movement max (a dwarf at 25)', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);
      orm.update(combatants).set({ speed: 25 }).where(eq(combatants.id, c1)).run();

      const workspace = await service.getTurnWorkspace(encounterId, player1, 'player');
      expect(movementMax(workspace)).toBe(25);
      expect(workspace.movement?.maxFt).toBe(25);
    });

    // Issue #1910 review (Devin, PR #1980, round 4): a combatant with `speed: null`
    // does NOT fall through to the linked character's live speed — that would be
    // ambiguous between "this row predates the speed column" and "the character
    // genuinely had null speed at add time" (Character.speed defaults to null, so
    // the second case is every character until someone sets a value), and a live
    // fallback resolves both identically, reintroducing the retroactive-change bug
    // the snapshot exists to prevent. The adapter default is the only safe
    // resolution for a null snapshot, matching pre-#1910 behavior (every combatant
    // reported the hardcoded adapter constant) — see the sibling test below that
    // proves this for the realistic "genuinely null at add time" case specifically.
    it('a combatant with a null snapshot (whether legacy or genuinely unset) resolves to the adapter default, never the character live speed', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);
      const [c1row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      orm.update(characters).set({ speed: 35 }).where(eq(characters.id, c1row.characterId!)).run();
      // combatant.speed stays null — indistinguishable from a genuinely-unset add.

      const workspace = await service.getTurnWorkspace(encounterId, player1, 'player');
      expect(movementMax(workspace)).toBe(30);
    });

    it('a mid-fight sheet edit does not retroactively change a running encounter movement budget', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);
      const [c1row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      orm.update(combatants).set({ speed: 25 }).where(eq(combatants.id, c1)).run();

      // The DM edits the sheet mid-encounter to 40 (e.g. a Haste spell on the sheet, not
      // through the combat tracker) — the combatant's frozen snapshot must still win.
      orm.update(characters).set({ speed: 40 }).where(eq(characters.id, c1row.characterId!)).run();

      const workspace = await service.getTurnWorkspace(encounterId, player1, 'player');
      expect(movementMax(workspace)).toBe(25);
    });

    // Devin review on PR #1980: the two BULK party auto-add paths (create()'s party
    // INSERT and the generator's) build their combatant rows explicitly and must also
    // stamp `speed`, not just the single-combatant addCombatant() path exercised above —
    // otherwise every real, auto-added PC (the common case; addCombatant is only for a
    // mid-fight late join) would resolve through the character's LIVE speed on every
    // read, silently breaking the frozen-snapshot invariant for essentially all fights.
    it('an auto-added party member (via the real create() path, not a hand-stamped combatant) keeps a frozen movement max across a mid-fight sheet edit', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const ts = new Date().toISOString();
      const [campaign] = orm.insert(campaigns).values({ name: 'Auto Add Campaign', createdAt: ts, updatedAt: ts }).returning().all();
      const [character] = orm
        .insert(characters)
        .values({ campaignId: campaign.id, ownerUserId: player1.id, name: 'Auto PC', speed: 25, createdAt: ts, updatedAt: ts })
        .returning()
        .all();

      // The real party auto-add path — no manual combatant INSERT, no hand-stamped speed.
      // hidden:false — encounters are private-by-default (#754), and player1 needs to
      // read the turn workspace below.
      const created = await service.create(campaign.id, { name: 'Ambush', hidden: false }, dmUser, 'dm');
      expect(created.combatants).toHaveLength(1);
      const combatantId = created.combatants[0].id;
      orm.update(encounters).set({ status: 'running', currentCombatantId: combatantId }).where(eq(encounters.id, created.id)).run();

      const before = await service.getTurnWorkspace(created.id, player1, 'player');
      expect(movementMax(before)).toBe(25);

      // The DM edits the sheet mid-encounter (e.g. a Haste spell) — the auto-added
      // combatant's frozen snapshot must still win, exactly like the manually-added case.
      orm.update(characters).set({ speed: 40 }).where(eq(characters.id, character.id)).run();

      const after = await service.getTurnWorkspace(created.id, player1, 'player');
      expect(movementMax(after)).toBe(25);
    });

    // Devin review on PR #1980 (round 4): the sibling test above proves the
    // invariant for a character that ALREADY had a real speed at add time (25).
    // The overwhelmingly common case is the opposite — Character.speed defaults
    // to null, so most PCs are added with NO speed set at all. That combatant's
    // snapshot is also null, indistinguishable at the DB level from a legacy
    // pre-#1910 row, and — before this fix — getTurnWorkspace's fallback-to-live-
    // character-speed treated both cases the same way, so filling in the sheet
    // mid-fight (the realistic sequence: a DM realizes they forgot to set speed
    // and adds it once combat has already started) silently changed the running
    // encounter's movement budget, reproducing the exact bug the snapshot exists
    // to prevent. This is the sequence that must stay frozen.
    it('a character with NO speed set at add time (the common case) does not retroactively pick up a mid-fight sheet edit', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const ts = new Date().toISOString();
      const [campaign] = orm.insert(campaigns).values({ name: 'Null Speed Campaign', createdAt: ts, updatedAt: ts }).returning().all();
      const [character] = orm
        .insert(characters)
        // speed omitted entirely -> the schema default, null. This is the ordinary
        // shape of a freshly-created character, not a contrived edge case.
        .values({ campaignId: campaign.id, ownerUserId: player1.id, name: 'Blank Slate PC', createdAt: ts, updatedAt: ts })
        .returning()
        .all();

      const created = await service.create(campaign.id, { name: 'Ambush', hidden: false }, dmUser, 'dm');
      expect(created.combatants).toHaveLength(1);
      const combatantId = created.combatants[0].id;
      orm.update(encounters).set({ status: 'running', currentCombatantId: combatantId }).where(eq(encounters.id, created.id)).run();

      const before = await service.getTurnWorkspace(created.id, player1, 'player');
      expect(movementMax(before)).toBe(30); // adapter default — speed was never set

      // The DM fills in the sheet mid-encounter — the frozen (null) snapshot must
      // NOT pick this up.
      orm.update(characters).set({ speed: 40 }).where(eq(characters.id, character.id)).run();

      const after = await service.getTurnWorkspace(created.id, player1, 'player');
      expect(movementMax(after)).toBe(30); // still the adapter default, NOT 40
    });
  });

  describe('spellbook data — spells/spellSlots on the turn workspace (issue #1900)', () => {
    /** Gives c1's linked character a cantrip, a leveled spell, a non-spell action, and slots. */
    function seedSpellbookCharacter(orm: ReturnType<typeof build>['orm'], c1: number): void {
      const [c1row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      const characterId = c1row.characterId!;
      const actions = [
        {
          name: 'Fire Bolt',
          kind: 'cantrip',
          notes: '',
          spec: { uses: { spellLevel: 0, concentration: false }, cost: { slot: 'action' } },
        },
        {
          name: 'Fireball',
          kind: 'spell',
          notes: '',
          spec: { uses: { spellLevel: 3, concentration: false }, cost: { slot: 'action' } },
        },
        {
          name: 'Shortsword Slash',
          kind: 'action',
          notes: '',
          spec: { uses: { spellLevel: 0, concentration: false }, cost: { slot: 'action' } },
        },
      ];
      orm
        .update(characters)
        .set({
          actions: JSON.stringify(actions),
          spellSlots: JSON.stringify({ '3': { max: 2, used: 1 } }),
        })
        .where(eq(characters.id, characterId))
        .run();
    }

    it('the owner sees real spellSlots + derived spells (cantrip and leveled, not the plain action)', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);
      seedSpellbookCharacter(orm, c1);

      const owner = await service.getTurnWorkspace(encounterId, player1, 'player');
      expect(owner.spellSlots).toEqual({ '3': { max: 2, used: 1 } });
      expect(owner.spells.map((s) => s.name).sort()).toEqual(['Fire Bolt', 'Fireball']);
      const fireball = owner.spells.find((s) => s.name === 'Fireball')!;
      expect(fireball).toMatchObject({ level: 3, castingSlot: 'action', concentration: false });
      const fireBolt = owner.spells.find((s) => s.name === 'Fire Bolt')!;
      expect(fireBolt.level).toBe(0);
      // The plain (non-spell) action never appears in `spells` — no invented spell data.
      expect(owner.spells.some((s) => s.name === 'Shortsword Slash')).toBe(false);
    });

    it('a non-owner player receives neither spells nor spellSlots for another PC (secrecy)', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);
      seedSpellbookCharacter(orm, c1);

      const other = await service.getTurnWorkspace(encounterId, player2, 'player');
      expect(other.spellSlots).toBeNull();
      expect(other.spells).toEqual([]);
    });

    it('the DM sees the current character actor\'s spells/spellSlots same as the owner', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);
      seedSpellbookCharacter(orm, c1);

      const dm = await service.getTurnWorkspace(encounterId, dmUser, 'dm');
      expect(dm.spellSlots).toEqual({ '3': { max: 2, used: 1 } });
      expect(dm.spells.map((s) => s.name).sort()).toEqual(['Fire Bolt', 'Fireball']);
    });

    it('a monster/NPC actor never carries spellSlots or spells (character-only feature)', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);
      const [monster] = orm
        .insert(combatants)
        .values({ encounterId, kind: 'monster', name: 'Wolf', initiative: 15, hpCurrent: 11, hpMax: 11, sortOrder: 2 })
        .returning()
        .all();
      // initiative 15 sits between c1 (20) and c2 (10) — one advance from c1 makes it current.
      const advanced = await service.endTurn(encounterId, { expectedCurrentCombatantId: c1 }, dmUser, 'dm');
      expect(advanced.currentCombatantId).toBe(monster.id);

      const dm = await service.getTurnWorkspace(encounterId, dmUser, 'dm');
      expect(dm.current?.combatantId).toBe(monster.id);
      expect(dm.spellSlots).toBeNull();
      expect(dm.spells).toEqual([]);
    });
  });

  it('13th Age auto-added PCs get DEX + level initiative breakdowns', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Archmage', ruleSystem: 'archmage', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    await orm
      .insert(characters)
      .values({
        campaignId: campaign.id,
        ownerUserId: player1.id,
        name: 'Iconic Rogue',
        level: 5,
        stats: JSON.stringify({ DEX: 14 }),
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const created = await service.create(campaign.id, { name: 'Ambush' }, dmUser, 'dm');
    expect(created.combatants).toHaveLength(1);
    expect(created.combatants[0].initMod).toBe(7);
    expect(created.combatants[0].initiativeBreakdown?.terms).toEqual([
      { label: 'DEX', value: 2 },
      { label: 'level', value: 5 },
    ]);
  });

  it('13th Age escalation advances rounds 1-8, caps at +6, supports hold/override, and undo restores round default', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId } = seedArchmageRunningEncounter(orm);

    let snapshot = await service.nextTurn(encounterId, {}, dmUser, 'dm');
    expect(snapshot.round).toBe(1);
    expect(snapshot.escalationDie).toBe(0);

    for (let round = 2; round <= 8; round++) {
      snapshot = await service.nextTurn(encounterId, {}, dmUser, 'dm');
      expect(snapshot.round).toBe(round);
      expect(snapshot.escalationDie).toBe(Math.min(round - 1, 6));
      if (round < 8) {
        snapshot = await service.nextTurn(encounterId, {}, dmUser, 'dm');
        expect(snapshot.round).toBe(round);
      }
    }

    const heldSeed = seedArchmageRunningEncounter(orm);
    await service.nextTurn(heldSeed.encounterId, {}, dmUser, 'dm');
    snapshot = await service.nextTurn(heldSeed.encounterId, {}, dmUser, 'dm');
    expect(snapshot.round).toBe(2);
    expect(snapshot.escalationDie).toBe(1);

    snapshot = await service.updateEscalationDie(heldSeed.encounterId, { held: true }, dmUser, 'dm');
    expect(snapshot.escalationDieHeld).toBe(true);
    await service.nextTurn(heldSeed.encounterId, {}, dmUser, 'dm');
    snapshot = await service.nextTurn(heldSeed.encounterId, {}, dmUser, 'dm');
    expect(snapshot.round).toBe(3);
    expect(snapshot.escalationDie).toBe(1);

    snapshot = await service.updateEscalationDie(heldSeed.encounterId, { override: 4 }, dmUser, 'dm');
    expect(snapshot.escalationDie).toBe(4);
    await service.nextTurn(heldSeed.encounterId, {}, dmUser, 'dm');
    snapshot = await service.nextTurn(heldSeed.encounterId, {}, dmUser, 'dm');
    expect(snapshot.round).toBe(4);
    expect(snapshot.escalationDie).toBe(4);

    snapshot = await service.updateEscalationDie(heldSeed.encounterId, { held: false, override: null }, dmUser, 'dm');
    expect(snapshot.escalationDie).toBe(3);
    snapshot = await service.undoTurn(heldSeed.encounterId, dmUser, 'dm');
    expect(snapshot.round).toBe(3);
    expect(snapshot.escalationDie).toBe(2);
    expect(snapshot.escalationDieHistory.length).toBeGreaterThan(0);
  });

  it('13th Age action resolution applies escalation to PCs only and Fear blocks it', () => {
    dataDir = makeTempDataDir();
    const { orm, actions } = build();
    const { encounterId, pc, monster } = seedArchmageActionEncounter(orm);
    const strike = ActionSpec.parse({
      mode: 'attack',
      attack: { bonus: '+5' },
      targets: { count: 1, allow: 'enemy' },
      outcomes: { hit: { damage: [{ flat: 1, type: 'untyped' }] } },
    });

    let resolved = actions.resolve(
      encounterId,
      { actorCombatantId: pc, spec: strike, targetIds: [monster], commit: false },
      dmUser,
      'dm',
    );
    expect(resolved.resolution.dmSummary).toContain('escalation die +3');

    orm.update(combatants).set({ conditions: JSON.stringify(['fear']) }).where(eq(combatants.id, pc)).run();
    resolved = actions.resolve(
      encounterId,
      { actorCombatantId: pc, spec: strike, targetIds: [monster], commit: false },
      dmUser,
      'dm',
    );
    expect(resolved.resolution.dmSummary).toContain('blocked by Fear');

    resolved = actions.resolve(
      encounterId,
      { actorCombatantId: monster, spec: strike, targetIds: [pc], commit: false },
      dmUser,
      'dm',
    );
    expect(resolved.resolution.dmSummary).toContain('no escalation die for monsters/NPCs');
    expect(resolved.resolution.dmSummary).not.toContain('escalation die +3');
  });

  function seedArchmageRunningEncounter(
    orm: ReturnType<typeof build>['orm'],
  ): { campaignId: number; encounterId: number; c1: number; c2: number } {
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Archmage Turns', ruleSystem: 'archmage', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({
        campaignId: campaign.id,
        name: 'Escalating Fight',
        status: 'running',
        round: 1,
        escalationDie: 0,
        turnIndex: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [c1] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', name: 'PC One', initiative: 20, hpCurrent: 20, hpMax: 20, sortOrder: 0 })
      .returning()
      .all();
    const [c2] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', name: 'PC Two', initiative: 10, hpCurrent: 20, hpMax: 20, sortOrder: 1 })
      .returning()
      .all();
    orm.update(encounters).set({ currentCombatantId: c1.id }).where(eq(encounters.id, encounter.id)).run();
    return { campaignId: campaign.id, encounterId: encounter.id, c1: c1.id, c2: c2.id };
  }

  function seedArchmageActionEncounter(
    orm: ReturnType<typeof build>['orm'],
  ): { campaignId: number; encounterId: number; pc: number; monster: number } {
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Archmage Actions', ruleSystem: 'archmage', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [pack] = orm
      .insert(rulePacks)
      .values({ slug: `archmage-test-${campaign.id}`, name: 'Archmage Test', installedAt: ts })
      .returning()
      .all();
    const [entry] = orm
      .insert(ruleEntries)
      .values({
        packId: pack.id,
        slug: `monster-${campaign.id}`,
        name: 'Test Monster',
        type: 'monster',
        dataJson: JSON.stringify({ ac: 16, hp: 30, initiative: 4 }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [character] = orm
      .insert(characters)
      .values({
        campaignId: campaign.id,
        ownerUserId: player1.id,
        name: 'Hero',
        ac: 15,
        stats: JSON.stringify({ STR: 18, DEX: 14 }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({
        campaignId: campaign.id,
        name: 'Action Fight',
        status: 'running',
        round: 4,
        escalationDie: 3,
        turnIndex: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [pc] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: character.id, name: 'Hero', initiative: 20, hpCurrent: 25, hpMax: 25, sortOrder: 0 })
      .returning()
      .all();
    const [monster] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'monster', name: 'Test Monster', initiative: 10, initMod: 4, hpCurrent: 30, hpMax: 30, ruleEntryId: entry.id, sortOrder: 1 })
      .returning()
      .all();
    orm.update(encounters).set({ currentCombatantId: pc.id }).where(eq(encounters.id, encounter.id)).run();
    return { campaignId: campaign.id, encounterId: encounter.id, pc: pc.id, monster: monster.id };
  }

  it('persists player-applied structured-action checks in the DM encounter state (issue #606)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service, actions } = build();
    const { encounterId, c1, c2 } = seed(orm);
    orm
      .update(combatants)
      .set({
        conditionInstances: JSON.stringify([
          { id: 'focus', name: 'Focus', isConcentration: true, sourceCombatantId: c2 },
        ]),
      })
      .where(eq(combatants.id, c1))
      .run();

    const strike = ActionSpec.parse({
      mode: 'save',
      save: { ability: 'DEX', dc: { kind: 'fixed', dc: 21 } },
      targets: { count: 1, allow: 'any' },
      outcomes: { failure: { damage: [{ flat: 12, type: 'untyped' }] } },
    });
    actions.resolve(
      encounterId,
      { actorCombatantId: c1, spec: strike, targetIds: [c2], commit: true },
      player1,
      'player',
    );

    const dmView = await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id);
    const damaged = dmView.combatants.find((combatant) => combatant.id === c2)!;
    expect(damaged.turnState.pendingConcentrationChecks).toEqual([
      expect.objectContaining({ damage: 12, dc: 10 }),
    ]);
  });

  it('authorizes and resolves the persisted queue atomically (issue #606)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    orm
      .update(combatants)
      .set({ conditionInstances: JSON.stringify([{ id: 'bless', name: 'Bless', isConcentration: true, sourceCombatantId: c1 }]) })
      .where(eq(combatants.id, c2))
      .run();

    await service.updateCombatant(encounterId, c1, { hpDelta: -4, idempotencyKey: 'concentration-replay' }, dmUser, 'dm');
    await service.updateCombatant(encounterId, c1, { hpDelta: -4, idempotencyKey: 'concentration-replay' }, dmUser, 'dm');
    let state = (await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id)).combatants
      .find((combatant) => combatant.id === c1)!.turnState;
    expect(state.pendingConcentrationChecks).toHaveLength(1);
    await service.updateCombatant(encounterId, c1, { hpDelta: -12 }, dmUser, 'dm');
    state = (await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id)).combatants
      .find((combatant) => combatant.id === c1)!.turnState;
    expect(state.pendingConcentrationChecks).toHaveLength(2);
    expect(state.pendingConcentrationChecks.map(({ damage, dc }) => ({ damage, dc }))).toEqual([
      { damage: 4, dc: 10 },
      { damage: 12, dc: 10 },
    ]);
    expect((await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id)).combatants.find((combatant) => combatant.id === c1)?.hpCurrent).toBe(4);

    await expect(
      service.updateCombatantTurnState(
        encounterId,
        c1,
        { resolveConcentrationCheck: { id: state.pendingConcentrationChecks[0].id, outcome: 'pass' } },
        player2,
        'player',
      ),
    ).rejects.toThrow(/own character/i);

    const passedCheckId = state.pendingConcentrationChecks[0].id;
    await service.updateCombatantTurnState(
      encounterId,
      c1,
      { resolveConcentrationCheck: { id: passedCheckId, outcome: 'pass' } },
      player1,
      'player',
    );
    state = (await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id)).combatants
      .find((combatant) => combatant.id === c1)!.turnState;
    expect(state.pendingConcentrationChecks).toHaveLength(1);
    await expect(
      service.updateCombatantTurnState(
        encounterId,
        c1,
        { resolveConcentrationCheck: { id: passedCheckId, outcome: 'pass' } },
        player1,
        'player',
      ),
    ).rejects.toThrow(/no longer first/i);

    await service.updateCombatantTurnState(
      encounterId,
      c1,
      { resolveConcentrationCheck: { id: state.pendingConcentrationChecks[0].id, outcome: 'fail' } },
      player1,
      'player',
    );
    state = (await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id)).combatants
      .find((combatant) => combatant.id === c1)!.turnState;
    expect(state.pendingConcentrationChecks).toEqual([]);
    expect(state.concentration).toBeNull();
    const [target] = orm.select().from(combatants).where(eq(combatants.id, c2)).all();
    expect(target.conditionInstances).toBe('[]');
  });

  it('drops stale checks only when concentration is explicitly replaced (issue #606)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm);
    orm
      .update(combatants)
      .set({ turnState: JSON.stringify({ concentration: 'Bless' }) })
      .where(eq(combatants.id, c1))
      .run();
    await service.updateCombatant(encounterId, c1, { hpDelta: -8 }, dmUser, 'dm');

    let updated = await service.updateCombatantTurnState(
      encounterId,
      c1,
      { concentration: 'Bless' },
      player1,
      'player',
    );
    expect(updated.turnState.pendingConcentrationChecks).toHaveLength(1);

    updated = await service.updateCombatantTurnState(
      encounterId,
      c1,
      { concentration: 'Haste' },
      player1,
      'player',
    );
    expect(updated.turnState.concentration).toBe('Haste');
    expect(updated.turnState.pendingConcentrationChecks).toEqual([]);
  });

  it('queues only post-mitigation direct typed damage (issue #606)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm);
    const ts = new Date().toISOString();
    const [pack] = orm
      .insert(rulePacks)
      .values({ slug: 'concentration-defences', name: 'Concentration Defences', installedAt: ts })
      .returning()
      .all();
    const [entry] = orm
      .insert(ruleEntries)
      .values({
        packId: pack.id,
        slug: 'resistant-caster',
        name: 'Resistant Caster',
        type: 'monster',
        dataJson: JSON.stringify({ damage_resistances: ['fire'] }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    orm
      .update(combatants)
      .set({
        hpCurrent: 100,
        hpMax: 100,
        ruleEntryId: entry.id,
        turnState: JSON.stringify({ concentration: 'Wall of Fire' }),
      })
      .where(eq(combatants.id, c1))
      .run();

    let updated = await service.updateCombatant(
      encounterId,
      c1,
      { hpDelta: -42, damageType: 'fire' },
      dmUser,
      'dm',
    );
    expect(updated.hpCurrent).toBe(79);
    expect(updated.turnState.pendingConcentrationChecks).toEqual([
      expect.objectContaining({ damage: 21, dc: 10 }),
    ]);

    orm
      .update(ruleEntries)
      .set({ dataJson: JSON.stringify({ damage_immunities: ['fire'] }) })
      .where(eq(ruleEntries.id, entry.id))
      .run();
    updated = await service.updateCombatant(
      encounterId,
      c1,
      { hpDelta: -20, damageType: 'fire' },
      dmUser,
      'dm',
    );
    expect(updated.hpCurrent).toBe(79);
    expect(updated.turnState.pendingConcentrationChecks).toHaveLength(1);
  });

  it('does not apply 5e concentration checks in a non-5e campaign (issue #606)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1, c2 } = seed(orm);
    const encounter = orm.select().from(encounters).where(eq(encounters.id, encounterId)).get()!;
    orm.update(campaigns).set({ ruleSystem: 'pf2e' }).where(eq(campaigns.id, encounter.campaignId)).run();
    orm.update(combatants).set({ conditionInstances: JSON.stringify([{ id: 'focus', name: 'Focus', isConcentration: true, sourceCombatantId: c1 }]) }).where(eq(combatants.id, c2)).run();
    const updated = await service.updateCombatant(encounterId, c1, { hpDelta: -8 }, dmUser, 'dm');
    expect(updated.turnState.pendingConcentrationChecks).toEqual([]);
  });

  it('redacts monster pending concentration checks from non-DM encounter reads (issue #606 / #43)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, c1 } = seed(orm);
    const [monster] = orm
      .insert(combatants)
      .values({
        encounterId,
        kind: 'monster',
        name: 'Concentrating Drake',
        initiative: 5,
        hpCurrent: 40,
        hpMax: 40,
        sortOrder: 2,
        turnState: JSON.stringify({ concentration: 'Hold Person' }),
      })
      .returning()
      .all();

    await service.updateCombatant(encounterId, monster.id, { hpDelta: -21 }, dmUser, 'dm');

    const dmView = await service.getWithCombatantsOrThrow(encounterId, 'dm', dmUser.id);
    expect(dmView.combatants.find((combatant) => combatant.id === monster.id)?.turnState.pendingConcentrationChecks).toEqual([
      expect.objectContaining({ damage: 21, dc: 10 }),
    ]);

    const playerView = await service.getWithCombatantsOrThrow(encounterId, 'player', player1.id);
    const playerMonster = playerView.combatants.find((combatant) => combatant.id === monster.id)!;
    expect(playerMonster.hpCurrent).toBeNull();
    expect(playerMonster.turnState.pendingConcentrationChecks).toEqual([]);

    // Character combatant checks remain visible to non-DM viewers (shared table knowledge).
    orm
      .update(combatants)
      .set({ turnState: JSON.stringify({ concentration: 'Bless' }) })
      .where(eq(combatants.id, c1))
      .run();
    await service.updateCombatant(encounterId, c1, { hpDelta: -8 }, dmUser, 'dm');
    const playerPc = (await service.getWithCombatantsOrThrow(encounterId, 'player', player1.id)).combatants.find(
      (combatant) => combatant.id === c1,
    )!;
    expect(playerPc.turnState.pendingConcentrationChecks).toEqual([
      expect.objectContaining({ damage: 8, dc: 10 }),
    ]);
  });

  /**
   * Issue #1674 — `updateCombatantTurnState` bounded ONLY the legendary slot; every other slot
   * (action, bonus, reaction, movement, PF2e's `actions`) incremented/absolute-set with no
   * check against the adapter's action-economy model, reachable directly via the turn-workspace
   * endpoint. Convention (#1570/#1571, extended by #1637): spends error, restores clamp.
   */
  describe('action-economy slot bounds (issue #1674)', () => {
    async function expectRejected(promise: Promise<unknown>): Promise<{ code?: string; slot?: string; remaining?: number; max?: number }> {
      let threw: unknown;
      try {
        await promise;
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeDefined();
      const body = (threw as { getResponse?: () => unknown }).getResponse?.();
      return body as { code?: string; slot?: string; remaining?: number; max?: number };
    }

    it('useSlot rejects a 5e action once the action slot is already spent — 400 with code/slot/remaining/max', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'action' }, dmUser, 'dm');
      const body = await expectRejected(service.updateCombatantTurnState(encounterId, c1, { useSlot: 'action' }, dmUser, 'dm'));
      expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'action', remaining: 0, max: 1 });

      // Nothing was overwritten past the legal value.
      const [row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      expect(JSON.parse(row.turnState ?? '{}').used.action).toBe(1);
    });

    it('useSlot rejects a 5e bonus action and reaction past their max of 1 each', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'bonus' }, dmUser, 'dm');
      const bonusBody = await expectRejected(service.updateCombatantTurnState(encounterId, c1, { useSlot: 'bonus' }, dmUser, 'dm'));
      expect(bonusBody).toMatchObject({ code: 'action_economy_exhausted', slot: 'bonus', remaining: 0, max: 1 });

      await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'reaction' }, dmUser, 'dm');
      const reactionBody = await expectRejected(service.updateCombatantTurnState(encounterId, c1, { useSlot: 'reaction' }, dmUser, 'dm'));
      expect(reactionBody).toMatchObject({ code: 'action_economy_exhausted', slot: 'reaction', remaining: 0, max: 1 });
    });

    it("setSlotUsed rejects an absolute overshoot just as easily as useSlot's increment", async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      const body = await expectRejected(
        service.updateCombatantTurnState(encounterId, c1, { setSlotUsed: { key: 'action', used: 2 } }, dmUser, 'dm'),
      );
      expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'action', remaining: 1, max: 1 });

      const [row] = orm.select().from(combatants).where(eq(combatants.id, c1)).limit(1).all();
      expect(JSON.parse(row.turnState ?? '{}').used?.action ?? 0).toBe(0);
    });

    it('moveFt tracks movement past the adapter default, while a negative correction still floors at 0', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      const moved = await service.updateCombatantTurnState(encounterId, c1, { moveFt: 45 }, dmUser, 'dm');
      expect(moved.turnState.movementUsedFt).toBe(45);

      // A decrement (correcting overcounted movement) is never rejected — floors at 0.
      const corrected = await service.updateCombatantTurnState(encounterId, c1, { moveFt: -100 }, dmUser, 'dm');
      expect(corrected.turnState.movementUsedFt).toBe(0);
    });

    it('releaseSlot keeps flooring at 0 rather than erroring on over-release', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);

      const released = await service.updateCombatantTurnState(encounterId, c1, { releaseSlot: 'action' }, dmUser, 'dm');
      expect(released.turnState.used.action ?? 0).toBe(0);
      const releasedAgain = await service.updateCombatantTurnState(encounterId, c1, { releaseSlot: 'action' }, dmUser, 'dm');
      expect(releasedAgain.turnState.used.action ?? 0).toBe(0);
    });

    it('legendary-action spend is still bounded by the monster statblock: none declared means none spendable', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId } = seed(orm);
      const ts = new Date().toISOString();
      const [pack] = orm.insert(rulePacks).values({ slug: 'plain-monster', name: 'Plain Monster', installedAt: ts }).returning().all();
      const [entry] = orm
        .insert(ruleEntries)
        .values({
          packId: pack.id,
          slug: 'no-legendary-drake',
          name: 'No-Legendary Drake',
          type: 'monster',
          dataJson: JSON.stringify({ armor_class: 15, hit_points: 60 }),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();
      const [monster] = orm
        .insert(combatants)
        .values({ encounterId, kind: 'monster', name: 'Drake', initiative: 1, hpCurrent: 60, hpMax: 60, sortOrder: 3, ruleEntryId: entry.id })
        .returning()
        .all();

      const body = await expectRejected(service.updateCombatantTurnState(encounterId, monster.id, { useSlot: 'legendary' }, dmUser, 'dm'));
      expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'legendary', remaining: 0, max: 0 });
    });

    it('legendary-action spend is bounded at 3 for a monster whose statblock declares legendary actions, and rejected on the 4th', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId } = seed(orm);
      const ts = new Date().toISOString();
      const [pack] = orm.insert(rulePacks).values({ slug: 'legendary-monster', name: 'Legendary Monster', installedAt: ts }).returning().all();
      const [entry] = orm
        .insert(ruleEntries)
        .values({
          packId: pack.id,
          slug: 'legendary-drake',
          name: 'Legendary Drake',
          type: 'monster',
          dataJson: JSON.stringify({
            armor_class: 18,
            hit_points: 120,
            legendary_actions: [{ name: 'Tail Attack', desc: 'The drake makes a tail attack.' }],
          }),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();
      const [monster] = orm
        .insert(combatants)
        .values({ encounterId, kind: 'monster', name: 'Ancient Drake', initiative: 1, hpCurrent: 120, hpMax: 120, sortOrder: 3, ruleEntryId: entry.id })
        .returning()
        .all();

      await service.updateCombatantTurnState(encounterId, monster.id, { useSlot: 'legendary' }, dmUser, 'dm');
      await service.updateCombatantTurnState(encounterId, monster.id, { useSlot: 'legendary' }, dmUser, 'dm');
      await service.updateCombatantTurnState(encounterId, monster.id, { useSlot: 'legendary' }, dmUser, 'dm');
      const body = await expectRejected(service.updateCombatantTurnState(encounterId, monster.id, { useSlot: 'legendary' }, dmUser, 'dm'));
      expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'legendary', remaining: 0, max: 3 });

      const [row] = orm.select().from(combatants).where(eq(combatants.id, monster.id)).limit(1).all();
      expect(JSON.parse(row.turnState ?? '{}').used.legendary).toBe(3);
    });

    it("PF2e is bounded by ITS action economy (3 actions, no bonus/movement slot) — not 5e's numbers", async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1 } = seed(orm);
      const encounter = orm.select().from(encounters).where(eq(encounters.id, encounterId)).get()!;
      orm.update(campaigns).set({ ruleSystem: 'pf2e' }).where(eq(campaigns.id, encounter.campaignId)).run();

      // Three PF2e actions are all spendable — 5e would have capped a single "action" at 1.
      await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'actions' }, dmUser, 'dm');
      await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'actions' }, dmUser, 'dm');
      const third = await service.updateCombatantTurnState(encounterId, c1, { useSlot: 'actions' }, dmUser, 'dm');
      expect(third.turnState.used.actions).toBe(3);

      const body = await expectRejected(service.updateCombatantTurnState(encounterId, c1, { useSlot: 'actions' }, dmUser, 'dm'));
      expect(body).toMatchObject({ code: 'action_economy_exhausted', slot: 'actions', remaining: 0, max: 3 });
    });
  });

  describe('concentration break (issue #1452)', () => {
    const holdPersonInstance = (sourceCombatantId: number) =>
      JSON.stringify([{ id: 'paralyzed', name: 'Paralyzed', isConcentration: true, sourceCombatantId, stacks: 1 }]);

    function setupConcentration(orm: ReturnType<typeof build>['orm'], encounterId: number, c1: number, c2: number, c3?: number) {
      orm
        .update(combatants)
        .set({ turnState: JSON.stringify({ concentration: 'Hold Person' }) })
        .where(eq(combatants.id, c1))
        .run();
      orm
        .update(combatants)
        .set({ conditionInstances: holdPersonInstance(c1), conditions: JSON.stringify(['Paralyzed']) })
        .where(eq(combatants.id, c2))
        .run();
      if (c3 != null) {
        orm
          .update(combatants)
          .set({ conditionInstances: holdPersonInstance(c1), conditions: JSON.stringify(['Paralyzed']) })
          .where(eq(combatants.id, c3))
          .run();
      }
    }

    it('caster drops to 0 HP removes the sustained condition from every target, clears concentration, and logs it', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);
      setupConcentration(orm, encounterId, c1, c2);
      orm.update(combatants).set({ hpCurrent: 10, hpMax: 10 }).where(eq(combatants.id, c1)).run();

      await service.updateCombatant(encounterId, c1, { hpDelta: -10 }, dmUser, 'dm');

      const [target] = orm.select().from(combatants).where(eq(combatants.id, c2)).all();
      const [caster] = orm.select().from(combatants).where(eq(combatants.id, c1)).all();
      expect(JSON.parse(target.conditionInstances ?? '[]')).toEqual([]);
      expect(JSON.parse(caster.turnState ?? '{}').concentration).toBeNull();
      const log = orm.select().from(encounterEvents).where(eq(encounterEvents.encounterId, encounterId)).all();
      expect(log.some((e) => e.type === 'condition' && e.targetId === c2 && e.detail.includes('concentration broken'))).toBe(true);
    });

    it('caster killed outright removes the sustained condition', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);
      setupConcentration(orm, encounterId, c1, c2);
      orm.update(combatants).set({ hpCurrent: 10, hpMax: 10 }).where(eq(combatants.id, c1)).run();

      await service.updateCombatant(encounterId, c1, { hpDelta: -30 }, dmUser, 'dm');

      const [target] = orm.select().from(combatants).where(eq(combatants.id, c2)).all();
      const [caster] = orm.select().from(combatants).where(eq(combatants.id, c1)).all();
      expect(caster.deathState).toBe('dead');
      expect(JSON.parse(target.conditionInstances ?? '[]')).toEqual([]);
      expect(JSON.parse(caster.turnState ?? '{}').concentration).toBeNull();
    });

    it('removing the caster from the encounter breaks concentration on all targets', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);
      setupConcentration(orm, encounterId, c1, c2);

      await service.removeCombatant(encounterId, c1, dmUser, 'dm');

      const [target] = orm.select().from(combatants).where(eq(combatants.id, c2)).all();
      expect(JSON.parse(target.conditionInstances ?? '[]')).toEqual([]);
      const log = orm.select().from(encounterEvents).where(eq(encounterEvents.encounterId, encounterId)).all();
      expect(log.some((e) => e.type === 'condition' && e.targetId === c2 && e.detail.includes('concentration broken'))).toBe(true);
    });

    it('replacing concentration via turn workspace drops the previous effect and keeps the new one', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);
      setupConcentration(orm, encounterId, c1, c2);

      const updated = await service.updateCombatantTurnState(
        encounterId,
        c1,
        { concentration: 'Haste' },
        player1,
        'player',
      );
      expect(updated.turnState.concentration).toBe('Haste');
      const [target] = orm.select().from(combatants).where(eq(combatants.id, c2)).all();
      expect(JSON.parse(target.conditionInstances ?? '[]')).toEqual([]);
    });

    it('healing a broken caster back above 0 does not restore the broken concentration', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);
      setupConcentration(orm, encounterId, c1, c2);
      orm.update(combatants).set({ hpCurrent: 10, hpMax: 10 }).where(eq(combatants.id, c1)).run();

      await service.updateCombatant(encounterId, c1, { hpDelta: -10 }, dmUser, 'dm');
      const revived = await service.updateCombatant(encounterId, c1, { hpDelta: 5 }, dmUser, 'dm');

      expect(revived.hpCurrent).toBe(5);
      expect(revived.turnState.concentration).toBeNull();
      const [target] = orm.select().from(combatants).where(eq(combatants.id, c2)).all();
      expect(JSON.parse(target.conditionInstances ?? '[]')).toEqual([]);
    });

    it('multi-target concentration clears every target, not just the first', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, c2 } = seed(orm);
      const [c3] = orm
        .insert(combatants)
        .values({
          encounterId,
          kind: 'monster',
          name: 'Ogre 2',
          initiative: 5,
          hpCurrent: 30,
          hpMax: 30,
          sortOrder: 2,
        })
        .returning()
        .all();
      setupConcentration(orm, encounterId, c1, c2, c3.id);
      orm.update(combatants).set({ hpCurrent: 10, hpMax: 10 }).where(eq(combatants.id, c1)).run();

      await service.updateCombatant(encounterId, c1, { hpDelta: -10 }, dmUser, 'dm');

      const [target1] = orm.select().from(combatants).where(eq(combatants.id, c2)).all();
      const [target2] = orm.select().from(combatants).where(eq(combatants.id, c3.id)).all();
      expect(JSON.parse(target1.conditionInstances ?? '[]')).toEqual([]);
      expect(JSON.parse(target2.conditionInstances ?? '[]')).toEqual([]);
    });
  });

  // Issue #1901: /turn's suggestedActions for a character actor merge equipped-item actions
  // AFTER sheet actions, through ActionResolverService's shared characterUsableActionRows —
  // the exact same merge listUsableActions/resolveSpec use — so actionIndex N on this payload
  // is the same action as index N on those.
  describe('/turn suggestedActions include equipped-item actions (issue #1901)', () => {
    const greatsword = {
      name: 'Greatsword',
      kind: 'melee',
      toHit: '+7',
      damage: '2d6+4 slashing',
      notes: '',
      spec: {
        mode: 'attack',
        // Deliberately omits `attack.bonus` — a character.actions row written straight to
        // SQLite (bypassing the CharacterUpsertRequest/CharacterAction validation layer
        // that would otherwise default it to '') is exactly the "malformed source" this
        // function's doc comment already promises to be defensive about. This regresses
        // the rework-round bug where suggestedActionsForCombatant passed `spec` to
        // isResolvableSpec via a bare passthrough instead of `ActionSpec.safeParse`,
        // crashing `.trim()` on the missing field instead of defaulting it like
        // resolveSpec already does (issue #1901 rework).
        attack: { ability: 'STR', proficient: true },
        cost: { slot: 'action', count: 1 },
        targets: { count: 1, allow: 'enemy' },
        outcomes: { hit: { damage: [{ formula: '2d6', flat: 4, type: 'slashing' }] } },
      },
    };
    const dagger = {
      name: 'Dagger',
      kind: 'melee',
      toHit: '+5',
      damage: '1d4+2 piercing',
      notes: '',
      spec: {
        mode: 'attack',
        attack: { ability: 'DEX', proficient: true },
        cost: { slot: 'action', count: 1 },
        targets: { count: 1, allow: 'enemy' },
        outcomes: { hit: { damage: [{ formula: '1d4', flat: 2, type: 'piercing' }] } },
      },
    };

    it("appends the equipped item's action after sheet actions, tagged with its item name via equippedItemName, and agrees with listUsableActions on the index", async () => {
      dataDir = makeTempDataDir();
      const { orm, service, actions } = build();
      const { campaignId, encounterId, c1 } = seed(orm);
      const [charRow] = orm.select({ characterId: combatants.characterId }).from(combatants).where(eq(combatants.id, c1)).all();
      const characterId = charRow.characterId!;
      orm.update(characters).set({ actions: JSON.stringify([greatsword]) }).where(eq(characters.id, characterId)).run();
      const ts = new Date().toISOString();
      orm
        .insert(inventoryItems)
        .values({
          campaignId,
          ownerType: 'character',
          characterId,
          name: 'Rusty Dagger',
          qty: 1,
          equipped: true,
          equipSlot: 'off-hand',
          equippedAction: JSON.stringify(dagger),
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const workspace = await service.getTurnWorkspace(encounterId, player1, 'player');
      expect(workspace.suggestedActions).toHaveLength(2);
      expect(workspace.suggestedActions[0].name).toBe('Greatsword');
      expect(workspace.suggestedActions[0].actionIndex).toBe(0);
      const equippedRow = workspace.suggestedActions[1];
      expect(equippedRow.name).toBe('Dagger');
      expect(equippedRow.actionIndex).toBe(1);
      // Issue #1901 review (devin-ai-integration): `source` must stay the action-economy/kind
      // hint the web turn workspace buckets tabs and detects spells from — never a display
      // label — so it reads the dagger's own `kind` ('melee'), exactly like a sheet action
      // would. The equipping item's name is carried separately.
      expect(equippedRow.source).toBe('melee');
      expect(equippedRow.equippedItemName).toBe('Rusty Dagger');

      // Same actor, same index space: listUsableActions index 1 must be the SAME action.
      const usable = actions.listUsableActions(encounterId, c1, player1, 'player');
      expect(usable[1].name).toBe('Dagger');
      expect(usable[1].index).toBe(equippedRow.actionIndex);
    });

    // Issue #1901 review (devin-ai-integration): before this fix, `source` was
    // `equipped: <item name>` for every equipped-item row, so a gear-granted bonus action or
    // reaction — one with no `spec.cost.slot` to fall back on, e.g. a passive trinket's
    // triggered ability — could only be bucketed via TurnWorkspace's `source` comparison,
    // which no longer matched 'bonus'/'reaction' once overwritten with the item label. It
    // fell into "Other / Limited Use" instead of the tab the player expects it in.
    it('a gear-granted bonus action keeps its kind as source, not the equipping item label, so the turn workspace can bucket it correctly', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { campaignId, encounterId, c1 } = seed(orm);
      const [charRow] = orm.select({ characterId: combatants.characterId }).from(combatants).where(eq(combatants.id, c1)).all();
      const characterId = charRow.characterId!;
      orm.update(characters).set({ actions: JSON.stringify([]) }).where(eq(characters.id, characterId)).run();
      const ts = new Date().toISOString();
      const trinketAction = {
        name: 'Flurry Strike',
        kind: 'bonus',
        toHit: '+3',
        damage: '1d4 force',
        notes: 'A quick follow-up strike.',
        spec: {
          mode: 'attack',
          attack: { ability: 'DEX', proficient: true },
          // Deliberately NO cost.slot of 'bonus' — TurnWorkspace's bucketing must not
          // depend on spec.cost.slot alone; `source` itself has to carry the kind.
          cost: { slot: '', count: 1 },
          targets: { count: 1, allow: 'enemy' },
          outcomes: { hit: { damage: [{ formula: '1d4', type: 'force' }] } },
        },
      };
      orm
        .insert(inventoryItems)
        .values({
          campaignId,
          ownerType: 'character',
          characterId,
          name: 'Spell Focus Trinket',
          qty: 1,
          equipped: true,
          equipSlot: 'trinket',
          equippedAction: JSON.stringify(trinketAction),
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const workspace = await service.getTurnWorkspace(encounterId, player1, 'player');
      expect(workspace.suggestedActions).toHaveLength(1);
      const row = workspace.suggestedActions[0];
      expect(row.source).toBe('bonus');
      expect(row.equippedItemName).toBe('Spell Focus Trinket');
      // The item's name contains "spell" — confirms `source` (what the web fallback
      // spell-list filter checks) is NOT contaminated with the item label.
      expect(row.source.toLowerCase()).not.toContain('spell');
    });

    // Issue #1901 review (chatgpt-codex-connector P2): `InventoryItem.name` permits up to 200
    // characters, so `equippedItemName` must accept the same range — a narrower schema limit
    // here would make an otherwise-valid item name fail this exported `TurnSuggestedAction`
    // response shape.
    it('an equipped item name up to the inventory contract\'s 200-character limit survives the /turn payload', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { campaignId, encounterId, c1 } = seed(orm);
      const [charRow] = orm.select({ characterId: combatants.characterId }).from(combatants).where(eq(combatants.id, c1)).all();
      const characterId = charRow.characterId!;
      orm.update(characters).set({ actions: JSON.stringify([]) }).where(eq(characters.id, characterId)).run();
      const longName = 'A'.repeat(200);
      const ts = new Date().toISOString();
      orm
        .insert(inventoryItems)
        .values({
          campaignId,
          ownerType: 'character',
          characterId,
          name: longName,
          qty: 1,
          equipped: true,
          equipSlot: 'off-hand',
          equippedAction: JSON.stringify(dagger),
          createdAt: ts,
          updatedAt: ts,
        })
        .run();

      const workspace = await service.getTurnWorkspace(encounterId, player1, 'player');
      expect(workspace.suggestedActions).toHaveLength(1);
      expect(workspace.suggestedActions[0].equippedItemName).toBe(longName);
    });

    it('unequipping removes the item action from suggestedActions', async () => {
      dataDir = makeTempDataDir();
      const { orm, service } = build();
      const { encounterId, c1, campaignId } = seed(orm);
      const [charRow] = orm.select({ characterId: combatants.characterId }).from(combatants).where(eq(combatants.id, c1)).all();
      const characterId = charRow.characterId!;
      const ts = new Date().toISOString();
      const [item] = orm
        .insert(inventoryItems)
        .values({
          campaignId,
          ownerType: 'character',
          characterId,
          name: 'Rusty Dagger',
          qty: 1,
          equipped: true,
          equipSlot: 'off-hand',
          equippedAction: JSON.stringify(dagger),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();

      expect((await service.getTurnWorkspace(encounterId, player1, 'player')).suggestedActions).toHaveLength(1);

      orm.update(inventoryItems).set({ equipped: false, equipSlot: null }).where(eq(inventoryItems.id, item.id)).run();

      expect((await service.getTurnWorkspace(encounterId, player1, 'player')).suggestedActions).toHaveLength(0);
    });
  });
});

/**
 * Issue #1921 — limited-use/recharge monster abilities: the turn-tick recharge roll (both
 * outcomes), undo-turn restoring pre-tick recharge state, X/day pools never auto-clearing
 * mid-encounter, and the DM force-toggle override (+ player 403 / audit row).
 */
describe('recharge action turn tick (real SQLite, service layer, issue #1921)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    const revisions = new RevisionsService(orm, new ModerationService(orm, audit));
    const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit), new AttachmentDerivativesService(orm));
    const campaignLibrary = new CampaignLibraryService(orm, audit, events);
    const actions = new ActionResolverService(orm, events, audit);
    const service = new EncountersService(
      orm,
      audit,
      events,
      rolls,
      revisions,
      attachments,
      campaignLibrary,
      { notifyCampaign: jest.fn().mockResolvedValue(undefined), notifyUser: jest.fn().mockResolvedValue(undefined) } as any,
      undefined, // safety
      undefined, // charactersService
      undefined, // inventoryService
      undefined, // questsService
      undefined, // storylinesService
      undefined, // timelineService
      undefined, // campaignsService
      actions,
    );
    return { orm, service, actions };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };
  const player1: RequestUser = { id: 'user-1', name: 'Alice', serverRole: 'user', devRole: 'player' };

  const breathWeaponStatblock = {
    ac: 18,
    abilityScores: { STR: 22, DEX: 10, CON: 18, INT: 10, WIS: 12, CHA: 14 },
    actions: [
      {
        name: 'Breath Weapon',
        kind: 'action',
        spec: {
          mode: 'attack',
          attack: { bonus: '+9' },
          cost: { slot: '', count: 0 },
          uses: { recharge: 'recharge-5-6' },
          targets: { count: 0, allow: 'enemy' },
          outcomes: {},
        },
      },
    ],
  };

  /** Alice (top of initiative, current turn) → Drake (monster, recharge action) → nobody else. */
  function seedAliceThenDrake(orm: ReturnType<typeof build>['orm']) {
    const ts = new Date().toISOString();
    const [campaign] = orm.insert(campaigns).values({ name: 'Recharge Test', createdAt: ts, updatedAt: ts }).returning().all();
    const [char1] = orm
      .insert(characters)
      .values({ campaignId: campaign.id, ownerUserId: player1.id, name: 'Alice PC', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({ campaignId: campaign.id, name: 'Fight', status: 'running', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [c1] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: char1.id, name: 'Alice PC', initiative: 20, hpCurrent: 20, hpMax: 20, sortOrder: 0 })
      .returning()
      .all();
    const [drake] = orm
      .insert(combatants)
      .values({
        encounterId: encounter.id,
        kind: 'monster',
        name: 'Recharge Drake',
        initiative: 10,
        hpCurrent: 80,
        hpMax: 80,
        sortOrder: 1,
        statblockJson: JSON.stringify(breathWeaponStatblock),
      })
      .returning()
      .all();
    orm.update(encounters).set({ currentCombatantId: c1.id }).where(eq(encounters.id, encounter.id)).run();
    return { campaignId: campaign.id, encounterId: encounter.id, c1: c1.id, drake: drake.id };
  }

  function latestEvent(orm: ReturnType<typeof build>['orm'], encounterId: number) {
    return orm
      .select()
      .from(encounterEvents)
      .where(eq(encounterEvents.encounterId, encounterId))
      .orderBy(desc(encounterEvents.id))
      .limit(1)
      .all()[0];
  }

  function spendBreathWeapon(actions: ActionResolverService, encounterId: number, drake: number) {
    const applied = actions.resolve(
      encounterId,
      ActionResolveRequest.parse({ actorCombatantId: drake, actionIndex: 0, targetIds: [], commit: true }),
      dmUser,
      'dm',
    );
    expect(applied.applied).toBe(true);
    return applied;
  }

  it('rolls exactly one d6 for a spent recharge action at turn start, recharging on a hit and logging the outcome', async () => {
    dataDir = makeTempDataDir();
    const { orm, service, actions } = build();
    const { encounterId, drake } = seedAliceThenDrake(orm);

    // Alice's turn → the drake's turn: nothing spent yet, no roll should happen.
    const rollSpy = jest.spyOn(dice, 'rollDice');
    await service.nextTurn(encounterId, {}, dmUser, 'dm');
    expect(rollSpy).not.toHaveBeenCalledWith('1d6');
    rollSpy.mockClear();

    spendBreathWeapon(actions, encounterId, drake);
    const spentRow = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!;
    const usesKey = Object.keys(JSON.parse(spentRow.actionUses ?? '{}'))[0];
    expect(JSON.parse(spentRow.actionUses ?? '{}')[usesKey].spent).toBe(1);

    // Drake's turn → Alice's turn (round 2) → the drake's turn again: THIS is where recharge rolls.
    await service.nextTurn(encounterId, {}, dmUser, 'dm'); // -> Alice, round 2
    rollSpy.mockReturnValue({ total: 6, rolls: [6] } as ReturnType<typeof dice.rollDice>);
    await service.nextTurn(encounterId, {}, dmUser, 'dm'); // -> Drake, round 2: recharge roll fires

    expect(rollSpy).toHaveBeenCalledWith('1d6');
    const rechargedRow = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!;
    expect(JSON.parse(rechargedRow.actionUses ?? '{}')[usesKey].spent).toBe(0);

    const event = latestEvent(orm, encounterId);
    expect(event.type).toBe('resource_changed');
    expect(event.actorId).toBe(drake);
    expect(event.detail).toContain('Breath Weapon recharges');
    expect(event.detail).toContain('rolled 6');

    // Usable again.
    spendBreathWeapon(actions, encounterId, drake);
  });

  it('leaves a spent recharge action spent on a miss, and logs the miss', async () => {
    dataDir = makeTempDataDir();
    const { orm, service, actions } = build();
    const { encounterId, drake } = seedAliceThenDrake(orm);

    await service.nextTurn(encounterId, {}, dmUser, 'dm'); // -> Drake, round 1
    spendBreathWeapon(actions, encounterId, drake);
    const usesKey = Object.keys(JSON.parse(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.actionUses ?? '{}'))[0];

    const rollSpy = jest.spyOn(dice, 'rollDice').mockReturnValue({ total: 2, rolls: [2] } as ReturnType<typeof dice.rollDice>);
    await service.nextTurn(encounterId, {}, dmUser, 'dm'); // -> Alice, round 2
    await service.nextTurn(encounterId, {}, dmUser, 'dm'); // -> Drake, round 2: recharge roll fires, misses

    expect(rollSpy).toHaveBeenCalledWith('1d6');
    const row = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!;
    expect(JSON.parse(row.actionUses ?? '{}')[usesKey].spent).toBe(1);

    const event = latestEvent(orm, encounterId);
    expect(event.type).toBe('resource_changed');
    expect(event.detail).toContain('Breath Weapon stays spent');
    expect(event.detail).toContain('rolled 2');

    // Still exhausted — a second apply attempt is refused.
    expect(() =>
      actions.resolve(
        encounterId,
        ActionResolveRequest.parse({ actorCombatantId: drake, actionIndex: 0, targetIds: [], commit: true }),
        dmUser,
        'dm',
      ),
    ).toThrow(/uses remaining/i);
  });

  it('undoTurn restores the pre-tick spent state after a recharge roll cleared it', async () => {
    dataDir = makeTempDataDir();
    const { orm, service, actions } = build();
    const { encounterId, drake } = seedAliceThenDrake(orm);

    await service.nextTurn(encounterId, {}, dmUser, 'dm'); // -> Drake, round 1
    spendBreathWeapon(actions, encounterId, drake);
    const usesKey = Object.keys(JSON.parse(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.actionUses ?? '{}'))[0];

    const rollSpy = jest.spyOn(dice, 'rollDice').mockReturnValue({ total: 6, rolls: [6] } as ReturnType<typeof dice.rollDice>);
    await service.nextTurn(encounterId, {}, dmUser, 'dm'); // -> Alice, round 2
    await service.nextTurn(encounterId, {}, dmUser, 'dm'); // -> Drake, round 2: recharges
    rollSpy.mockRestore();

    expect(JSON.parse(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.actionUses ?? '{}')[usesKey].spent).toBe(0);

    await service.undoTurn(encounterId, dmUser, 'dm');

    const row = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!;
    expect(JSON.parse(row.actionUses ?? '{}')[usesKey].spent).toBe(1);
    const event = latestEvent(orm, encounterId);
    expect(event.detail).toContain('Breath Weapon recharge undone');
  });

  it('an X/day pool never auto-recharges mid-encounter, even across several turn advances', async () => {
    dataDir = makeTempDataDir();
    const { orm, service, actions } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm.insert(campaigns).values({ name: 'Per-day Test', createdAt: ts, updatedAt: ts }).returning().all();
    const [char1] = orm.insert(characters).values({ campaignId: campaign.id, ownerUserId: player1.id, name: 'Alice PC', createdAt: ts, updatedAt: ts }).returning().all();
    const [encounter] = orm.insert(encounters).values({ campaignId: campaign.id, name: 'Fight', status: 'running', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts }).returning().all();
    const [c1] = orm.insert(combatants).values({ encounterId: encounter.id, kind: 'character', characterId: char1.id, name: 'Alice PC', initiative: 20, hpCurrent: 20, hpMax: 20, sortOrder: 0 }).returning().all();
    const [mage] = orm
      .insert(combatants)
      .values({
        encounterId: encounter.id,
        kind: 'monster',
        name: 'Once-a-day Mage',
        initiative: 10,
        hpCurrent: 40,
        hpMax: 40,
        sortOrder: 1,
        statblockJson: JSON.stringify({
          ac: 14,
          abilityScores: { STR: 10, DEX: 12, CON: 12, INT: 18, WIS: 12, CHA: 14 },
          actions: [
            {
              name: 'Fireball',
              kind: 'action',
              spec: {
                mode: 'attack',
                attack: { bonus: '+6' },
                cost: { slot: '', count: 0 },
                uses: { max: 1 },
                targets: { count: 0, allow: 'enemy' },
                outcomes: {},
              },
            },
          ],
        }),
      })
      .returning()
      .all();
    orm.update(encounters).set({ currentCombatantId: c1.id }).where(eq(encounters.id, encounter.id)).run();

    const applied = actions.resolve(
      encounter.id,
      ActionResolveRequest.parse({ actorCombatantId: mage.id, actionIndex: 0, targetIds: [], commit: true }),
      dmUser,
      'dm',
    );
    expect(applied.applied).toBe(true);
    const usesKey = Object.keys(JSON.parse(orm.select().from(combatants).where(eq(combatants.id, mage.id)).get()!.actionUses ?? '{}'))[0];

    const rollSpy = jest.spyOn(dice, 'rollDice');
    // Cycle several full rounds — an X/day pool must stay spent no matter how many turn
    // starts the mage sees (it is encounter-scoped, not per-turn or per-round).
    for (let i = 0; i < 6; i++) {
      await service.nextTurn(encounter.id, {}, dmUser, 'dm');
    }
    expect(rollSpy).not.toHaveBeenCalledWith('1d6');

    const row = orm.select().from(combatants).where(eq(combatants.id, mage.id)).get()!;
    expect(JSON.parse(row.actionUses ?? '{}')[usesKey].spent).toBe(1);
  });

  it('DM force-toggle sets an action’s spend state directly, clamped to [0, max], and is audit-logged', async () => {
    dataDir = makeTempDataDir();
    const { orm, service, actions } = build();
    const { campaignId, encounterId, drake } = seedAliceThenDrake(orm);
    spendBreathWeapon(actions, encounterId, drake);
    const usesKey = Object.keys(JSON.parse(orm.select().from(combatants).where(eq(combatants.id, drake)).get()!.actionUses ?? '{}'))[0];

    const updated = await service.updateCombatant(
      encounterId,
      drake,
      { actionUses: { actionIndex: 0, spent: 0 }, idempotencyKey: 'force-recharge-1' } as any,
      dmUser,
      'dm',
    );
    expect(updated).toBeDefined();
    const row = orm.select().from(combatants).where(eq(combatants.id, drake)).get()!;
    expect(JSON.parse(row.actionUses ?? '{}')[usesKey].spent).toBe(0);

    const auditRows = orm
      .select()
      .from(auditLog)
      .where(eq(auditLog.campaignId, campaignId))
      .all();
    expect(auditRows.some((r) => r.action === 'encounter.combatant.update' && r.entityId === drake)).toBe(true);

    const event = latestEvent(orm, encounterId);
    expect(event.type).toBe('resource_changed');
    expect(event.detail).toContain('Breath Weapon uses set by DM');
  });

  it('a player may not force-toggle an action’s spend state, even on their OWN character combatant (403)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    // c1 is player1's OWN character combatant — ownership alone would otherwise let player1
    // edit it (e.g. hpDelta/conditions), so this specifically exercises the actionUses
    // absolute-rule gate, not just the "not my combatant" fallback a monster target would
    // also trip.
    const { encounterId, c1 } = seedAliceThenDrake(orm);

    let threw: unknown;
    try {
      await service.updateCombatant(
        encounterId,
        c1,
        { actionUses: { actionIndex: 0, spent: 0 }, idempotencyKey: 'player-force-1' } as any,
        player1,
        'player',
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    const body = (threw as { getResponse?: () => unknown }).getResponse?.();
    expect(body).toMatchObject({ code: 'COMBATANT_FIELD_DM_ONLY' });
  });
});
