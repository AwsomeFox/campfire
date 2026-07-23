import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { ConflictException } from '@nestjs/common';
import { openDatabase } from '../../src/db/db.module';
import { auditLog, campaigns, characters, combatants, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { CharactersService } from '../../src/modules/characters/characters.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #466 — reopening then re-ending must not silently overwrite newer sheet HP.
 *
 * Flow under test:
 *   1. Fight ends → combatant HP written to sheet + CAS token stamped
 *   2. Sheet heals / "rests" while the encounter is ended
 *   3. Reopen without decisions → 409 with conflicts
 *   4. Reopen with pull_sheet → combatant catches up; re-end keeps healed HP
 *   5. Alternate path: keep_combatant → re-end restores the combat snapshot
 *   6. A second encounter + rest between ends does not clobber the first's sheet
 */
describe('encounter reopen HP sync (issue #466, service layer)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    const revisions = new RevisionsService(orm, audit);
    const encountersService = new EncountersService(orm, audit, events, rolls, revisions);
    const charactersService = new CharactersService(orm, audit, revisions, events);
    return { orm, encountersService, charactersService, audit };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };

  async function seedFight(hpCurrent = 8, hpMax = 30) {
    dataDir = makeTempDataDir();
    const { orm, encountersService, charactersService } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm.insert(campaigns).values({ name: 'HP Sync', createdAt: ts, updatedAt: ts }).returning().all();
    const [character] = orm
      .insert(characters)
      .values({
        campaignId: campaign.id,
        name: 'Aria',
        hpCurrent,
        hpMax,
        hpTemp: 0,
        deathState: 'none',
        deathSaveSuccesses: 0,
        deathSaveFailures: 0,
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
        hpCurrent,
        hpMax,
        hpTemp: 0,
        deathState: 'none',
        deathSaveSuccesses: 0,
        deathSaveFailures: 0,
        sheetSyncedUpdatedAt: ts,
        sortOrder: 0,
      })
      .returning()
      .all();
    return {
      orm,
      encountersService,
      charactersService,
      campaignId: campaign.id,
      encounterId: encounter.id,
      characterId: character.id,
      combatantId: combatant.id,
    };
  }

  it('surfaces conflicts on GET after sheet heal, refuses bare reopen, pull_sheet preserves heal on re-end', async () => {
    const ctx = await seedFight(8);
    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');

    // Intervening "rest": heal on the sheet while the encounter is ended.
    await ctx.charactersService.patchHp(ctx.characterId, { set: 30 }, dmUser, 'dm');

    const ended = await ctx.encountersService.getWithCombatantsOrThrow(ctx.encounterId, 'dm');
    expect(ended.hpSyncConflicts?.length).toBe(1);
    expect(ended.hpSyncConflicts![0].combatant.hpCurrent).toBe(8);
    expect(ended.hpSyncConflicts![0].sheet.hpCurrent).toBe(30);

    await expect(ctx.encountersService.reopen(ctx.encounterId, dmUser, 'dm', {})).rejects.toBeInstanceOf(
      ConflictException,
    );

    const reopened = await ctx.encountersService.reopen(ctx.encounterId, dmUser, 'dm', {
      hpResync: [{ combatantId: ctx.combatantId, direction: 'pull_sheet' }],
    });
    expect(reopened.status).toBe('running');
    const pulled = reopened.combatants.find((c) => c.id === ctx.combatantId)!;
    expect(pulled.hpCurrent).toBe(30);

    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');
    const sheet = await ctx.charactersService.getOrThrow(ctx.characterId, 'dm');
    expect(sheet.hpCurrent).toBe(30);

    const reopenAudits = await ctx.orm.select().from(auditLog).where(eq(auditLog.action, 'encounter.reopen'));
    expect(reopenAudits.some((a) => (a.detail ?? '').includes('pull_sheet'))).toBe(true);
  });

  it('keep_combatant then re-end restores the combat snapshot over intervening heal', async () => {
    const ctx = await seedFight(4);
    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');
    await ctx.charactersService.patchHp(ctx.characterId, { set: 28 }, dmUser, 'dm');

    await ctx.encountersService.reopen(ctx.encounterId, dmUser, 'dm', {
      hpResync: [{ combatantId: ctx.combatantId, direction: 'keep_combatant' }],
    });
    const running = await ctx.encountersService.getWithCombatantsOrThrow(ctx.encounterId, 'dm');
    expect(running.combatants.find((c) => c.id === ctx.combatantId)!.hpCurrent).toBe(4);

    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');
    const sheet = await ctx.charactersService.getOrThrow(ctx.characterId, 'dm');
    expect(sheet.hpCurrent).toBe(4);
  });

  it('a second encounter + rest does not let a later re-end of fight A clobber the rest', async () => {
    const ctx = await seedFight(10);
    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');

    // Second fight runs and ends while A is ended.
    const ts = new Date().toISOString();
    const [fightB] = ctx.orm
      .insert(encounters)
      .values({
        campaignId: ctx.campaignId,
        name: 'Fight B',
        status: 'running',
        round: 1,
        turnIndex: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    ctx.orm.update(campaigns).set({ activeEncounterId: fightB.id }).where(eq(campaigns.id, ctx.campaignId)).run();
    const sheetNow = await ctx.charactersService.getOrThrow(ctx.characterId, 'dm');
    const [bCombatant] = ctx.orm
      .insert(combatants)
      .values({
        encounterId: fightB.id,
        kind: 'character',
        characterId: ctx.characterId,
        name: 'Aria',
        initiative: 10,
        hpCurrent: sheetNow.hpCurrent,
        hpMax: sheetNow.hpMax,
        hpTemp: 0,
        deathState: 'none',
        deathSaveSuccesses: 0,
        deathSaveFailures: 0,
        sheetSyncedUpdatedAt: sheetNow.updatedAt,
        sortOrder: 0,
      })
      .returning()
      .all();
    // Damage in B, end B, then rest on the sheet.
    await ctx.encountersService.updateCombatant(fightB.id, bCombatant.id, { hpDelta: -3 }, dmUser, 'dm');
    await ctx.encountersService.end(fightB.id, dmUser, 'dm');
    await ctx.charactersService.patchHp(ctx.characterId, { set: 30 }, dmUser, 'dm');

    // Reopen A with pull_sheet so combat A adopts the rested HP; re-ending A must keep 30.
    await ctx.encountersService.reopen(ctx.encounterId, dmUser, 'dm', {
      hpResync: [{ combatantId: ctx.combatantId, direction: 'pull_sheet' }],
    });
    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');
    const finalSheet = await ctx.charactersService.getOrThrow(ctx.characterId, 'dm');
    expect(finalSheet.hpCurrent).toBe(30);
  });
});
