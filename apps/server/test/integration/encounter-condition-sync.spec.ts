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
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { CharactersService } from '../../src/modules/characters/characters.service';
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
    const revisions = new RevisionsService(orm);
    const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit));
    const encountersService = new EncountersService(orm, audit, events, rolls, revisions, attachments);
    const charactersService = new CharactersService(orm, audit, revisions, events);
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
});
