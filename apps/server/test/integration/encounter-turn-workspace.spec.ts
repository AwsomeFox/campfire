import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, characters, combatants, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

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
    const revisions = new RevisionsService(orm);
    const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit));
    const campaignLibrary = new CampaignLibraryService(orm, audit);
    const service = new EncountersService(orm, audit, events, rolls, revisions, attachments, campaignLibrary);
    return { orm, service };
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
});
