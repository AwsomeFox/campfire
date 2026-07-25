import { BadRequestException } from '@nestjs/common';
import { openDatabase } from '../../src/db/db.module';
import { characters, combatants, encounters, encounterEvents, campaigns } from '../../src/db/schema';
import { CharactersService } from '../../src/modules/characters/characters.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { Dnd5eAdapter, Pf2eAdapter, resourceVocabularyForAdapter } from '@campfire/schema';
import { makeTempDataDir } from './fixtures';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';

describe('inline spell slots & character resources (issue #422)', () => {
  let dataDir: string;
  let db: any;
  let charactersService: any;
  let encountersService: any;

  beforeEach(() => {
    dataDir = makeTempDataDir();
    const dbModule = openDatabase(dataDir);
    db = dbModule.orm;

    const audit = new AuditService(db);
    const events = new CampaignEventsService();
    const revisions = new RevisionsService(db);
    const rolls = new RollsService(db);
    const fsDeletion = new FsDeletionService(db, audit);
    const attachments = new AttachmentsService(db, audit, fsDeletion);

    charactersService = new CharactersService(db, audit, revisions, events, rolls);
    encountersService = new EncountersService(db, audit, events, rolls, revisions, attachments);
  });

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('resolves adapter resource vocabulary and custom character resources', () => {
    const dndVocab = resourceVocabularyForAdapter(Dnd5eAdapter);
    expect(dndVocab.map((r) => r.key)).toContain('rage');
    expect(dndVocab.map((r) => r.key)).toContain('hitDice');

    const pf2eVocab = resourceVocabularyForAdapter(Pf2eAdapter);
    expect(pf2eVocab.map((r) => r.key)).toContain('focusPoints');

    const customChar = {
      resources: {
        sorceryPoints: { max: 5, used: 2, name: 'Sorcery Points', recharge: 'long-rest' },
      },
    };
    const combined = resourceVocabularyForAdapter(Dnd5eAdapter, customChar);
    expect(combined.map((r) => r.key)).toContain('sorceryPoints');
  });

  it('adjusts character resources and enforces bounded used [0, max]', async () => {
    const user = { id: 1, username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Resource Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Ezren',
        ownerUserId: '1',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();

    // Adjust custom resource
    const updated1 = await charactersService.adjustResource(
      c.id,
      { key: 'focusPoints', delta: 1, max: 3, name: 'Focus Points', recharge: 'refocus' },
      user,
      'player',
    );
    expect(updated1.resources['focusPoints'].used).toBe(1);
    expect(updated1.resources['focusPoints'].max).toBe(3);

    // Overspending throws BadRequestException
    await expect(
      charactersService.adjustResource(c.id, { key: 'focusPoints', delta: 5 }, user, 'player'),
    ).rejects.toThrow(BadRequestException);

    // Over-restoring below 0 throws BadRequestException
    await expect(
      charactersService.adjustResource(c.id, { key: 'focusPoints', delta: -5 }, user, 'player'),
    ).rejects.toThrow(BadRequestException);
  });

  it('executes short rest, long rest, and refocus cadences', async () => {
    const user = { id: 1, username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Rest Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Valeros',
        ownerUserId: '1',
        spellSlots: JSON.stringify({ '1': { max: 4, used: 3 } }),
        resources: JSON.stringify({
          rage: { max: 3, used: 2, name: 'Rage', recharge: 'long-rest' },
          secondWind: { max: 1, used: 1, name: 'Second Wind', recharge: 'short-rest' },
          focusPoints: { max: 2, used: 2, name: 'Focus Points', recharge: 'refocus' },
        }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();

    // Refocus resets only refocus resources
    const afterRefocus = await charactersService.restCharacter(c.id, 'refocus', user, 'player');
    expect(afterRefocus.resources['focusPoints'].used).toBe(0);
    expect(afterRefocus.resources['rage'].used).toBe(2);

    // Short rest resets short-rest and refocus
    const afterShort = await charactersService.restCharacter(c.id, 'short-rest', user, 'player');
    expect(afterShort.resources['secondWind'].used).toBe(0);
    expect(afterShort.resources['rage'].used).toBe(2);

    // Long rest resets all slots and resources
    const afterLong = await charactersService.restCharacter(c.id, 'long-rest', user, 'player');
    expect(afterLong.spellSlots['1'].used).toBe(0);
    expect(afterLong.resources['rage'].used).toBe(0);
  });

  it('adjusts combatant inline resources during encounter and logs event', async () => {
    const user = { id: 1, username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Combat Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Seelah',
        ownerUserId: '1',
        spellSlots: JSON.stringify({ '1': { max: 2, used: 0 } }),
        resources: JSON.stringify({ layOnHands: { max: 3, used: 0, name: 'Lay on Hands', recharge: 'long-rest' } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();

    const [enc] = db
      .insert(encounters)
      .values({
        campaignId: camp.id,
        name: 'Goblin Ambush',
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();

    const [comb] = db
      .insert(combatants)
      .values({
        encounterId: enc.id,
        kind: 'character',
        characterId: c.id,
        name: 'Seelah',
        sortOrder: 1,
      })
      .returning()
      .all();

    // Inline adjust spell slot
    await encountersService.adjustCombatantResource(enc.id, comb.id, { spellLevel: 1, delta: 1 }, user, 'dm');
    const cAfter1 = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(cAfter1.spellSlots)['1'].used).toBe(1);

    // Inline adjust custom resource
    await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'layOnHands', delta: 1 }, user, 'dm');
    const cAfter2 = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(cAfter2.resources)['layOnHands'].used).toBe(1);

    // Verify encounter events recorded resource_changed
    const events = db.select().from(encounterEvents).where(eq(encounterEvents.encounterId, enc.id)).all();
    expect(events.some((e: any) => e.type === 'resource_changed')).toBe(true);
  });
});
