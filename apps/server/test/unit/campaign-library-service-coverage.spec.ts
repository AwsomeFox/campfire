import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import type { RequestUser } from '../../src/common/user.types';
import { combatants, campaigns, characters, encounters, inventoryItems, npcs } from '../../src/db/schema';
import { CombatantStatblock, EncounterTemplateRoster, EncounterTemplateRosterEntry } from '@campfire/schema';
import { nowIso } from '../../src/common/time';

describe('CampaignLibraryService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let libraryService: CampaignLibraryService;
  let events: CampaignEventsService;

  const dmActor: RequestUser = {
    id: '1',
    name: 'DM',
    serverRole: 'user',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-library-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    events = new CampaignEventsService();

    libraryService = new CampaignLibraryService(db, audit, events);

    const [camp] = await db
      .insert(campaigns)
      .values({
        name: 'Test Campaign',
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

  it('manages library monsters, tags, and collections', async () => {
    const monstersBefore = await libraryService.listForCampaign(campaignId);
    expect(monstersBefore.length).toBe(0);

    const monster = await libraryService.create(
      campaignId,
      {
        name: 'Dire Wolf',
        statblock: {
          ac: 14,
          abilityScores: { str: 16, dex: 14, con: 14, int: 3, wis: 12, cha: 7 },
          notes: '', resources: {}, spellSlots: {},
          actions: [],
          traits: [],
        },
      },
      dmActor,
      'dm',
    );
    expect(monster.name).toBe('Dire Wolf');

    const monstersAfter = await libraryService.listForCampaign(campaignId);
    expect(monstersAfter.length).toBe(1);

    const tag = await libraryService.createTag(
      campaignId,
      {
        name: 'Beasts',
        color: '#ff0000',
      },
      dmActor,
      'dm',
    );
    expect(tag.name).toBe('Beasts');

    const tags = await libraryService.listTags(campaignId);
    expect(tags.length).toBe(1);

    const collection = await libraryService.createCollection(
      campaignId,
      {
        name: 'Forest Encounter Pack',
      },
      dmActor,
      'dm',
    );
    expect(collection.name).toBe('Forest Encounter Pack');

    const collections = await libraryService.listCollections(campaignId);
    expect(collections.length).toBe(1);

    const searchRes = await libraryService.search(campaignId, 'dm', { q: 'Dire' });
    expect(searchRes).toBeDefined();
  });

  // Issue #1901 review (chatgpt-codex-connector P2): archiving an equipped, action-granting
  // inventory item through the bulk tool drops it out of the owning character's merged
  // usable-action list (equippedItemActionRows only reads equipped=true rows) exactly like an
  // unequip does — this must invalidate the same way InventoryService.update()'s single-item
  // PATCH already does, or an already-open encounter card / /turn query stays stale.
  it('bulk archive of an equipped action-granting item emits character.updated for the owner', async () => {
    const ts = nowIso();
    const [character] = await db.insert(characters).values({ campaignId, name: 'Bulk Archive PC', createdAt: ts, updatedAt: ts }).returning();
    const [item] = await db
      .insert(inventoryItems)
      .values({
        campaignId,
        ownerType: 'character',
        characterId: character.id,
        name: 'Wand of Sparks',
        equipped: true,
        equipSlot: 'main-hand',
        equippedAction: JSON.stringify({ name: 'Zap', kind: 'action', toHit: '+5', damage: '1d6 lightning', notes: '' }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    const emitSpy = jest.spyOn(events, 'emit');
    await libraryService.bulk(campaignId, { operation: 'archive', targets: [{ entityType: 'inventory_item', entityId: item.id }] }, dmActor, 'dm');

    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'character.updated', campaignId, characterId: character.id }));
  });

  // Same gap, the undo direction: restoring an archived character's equip state (via
  // undoBulk) can bring an item's action BACK into the merged list, which must invalidate
  // just as much as the forward archive did.
  it('undoBulk of that archive emits character.updated again when the equip state is restored', async () => {
    const ts = nowIso();
    const [character] = await db.insert(characters).values({ campaignId, name: 'Bulk Undo PC', createdAt: ts, updatedAt: ts }).returning();
    const [item] = await db
      .insert(inventoryItems)
      .values({
        campaignId,
        ownerType: 'character',
        characterId: character.id,
        name: 'Wand of Sparks',
        equipped: true,
        equipSlot: 'main-hand',
        equippedAction: JSON.stringify({ name: 'Zap', kind: 'action', toHit: '+5', damage: '1d6 lightning', notes: '' }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    const bulkResult = await libraryService.bulk(campaignId, { operation: 'archive', targets: [{ entityType: 'inventory_item', entityId: item.id }] }, dmActor, 'dm');

    const emitSpy = jest.spyOn(events, 'emit');
    await libraryService.undoBulk(campaignId, bulkResult.operationId, dmActor, 'dm');

    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'character.updated', campaignId, characterId: character.id }));
  });

  it('validates EncounterTemplateRosterEntry schema bounds and default fields', () => {
    const valid = EncounterTemplateRosterEntry.parse({
      kind: 'monster',
      name: 'Goblin',
      hpMax: 10,
    });
    expect(valid).toMatchObject({
      kind: 'monster',
      name: 'Goblin',
      statblock: null,
      hpMax: 10,
      initMod: 0,
      tokenSize: 'medium',
      sortOrder: 0,
      count: 1,
    });

    expect(() => EncounterTemplateRosterEntry.parse({ kind: 'invalid_kind', name: 'X', hpMax: 5 })).toThrow();
    expect(() => EncounterTemplateRosterEntry.parse({ kind: 'monster', name: '', hpMax: 5 })).toThrow();
    expect(() => EncounterTemplateRosterEntry.parse({ kind: 'monster', name: 'X', hpMax: -1 })).toThrow();
    expect(() => EncounterTemplateRosterEntry.parse({ kind: 'monster', name: 'X', hpMax: 5, count: 0 })).toThrow();

    const roster = EncounterTemplateRoster.parse([valid, { kind: 'npc', name: 'Guard', hpMax: 20, count: 2 }]);
    expect(roster.length).toBe(2);
  });

  it('snapshots roster composition, strips play state, and excludes PCs / linked NPCs when saving encounter templates', async () => {
    const ts = nowIso();
    const [enc] = await db.insert(encounters).values({ campaignId, name: 'Goblin Ambush', createdAt: ts, updatedAt: ts }).returning();
    const [pcChar] = await db.insert(characters).values({ campaignId, name: 'Hero PC', createdAt: ts, updatedAt: ts }).returning();
    const [npcEntity] = await db.insert(npcs).values({ campaignId, name: 'Guide NPC', createdAt: ts, updatedAt: ts }).returning();

    const gobStatblock = {
      ac: 15,
      abilityScores: { STR: 8, DEX: 14, CON: 10, INT: 10, WIS: 8, CHA: 8 },
      actions: [{ name: 'Scimitar', kind: 'melee', toHit: '+4', damage: '1d6+2 slashing', notes: '' }],
      traits: [], resources: {}, spellSlots: {}, notes: 'Sneaky',
    };

    // Add 4 Goblins with mid-fight play state
    for (let i = 1; i <= 4; i++) {
      await db.insert(combatants).values({
        encounterId: enc.id,
        kind: 'monster',
        name: `Goblin ${i}`,
        statblockJson: JSON.stringify(gobStatblock),
        hpMax: 10,
        hpCurrent: 3, // Damaged!
        initMod: 2,
        initiative: 14, // Mid-fight initiative!
        initiativeBreakdown: '1d20+2',
        initiativeGroup: 'monsters',
        hpTemp: 4,
        deathState: 'dying',
        deathSaveSuccesses: 1,
        deathSaveFailures: 2,
        conditions: '["blinded"]',
        conditionInstances: JSON.stringify([{ id: 'c1', name: 'blinded' }]),
        turnState: JSON.stringify({ movementUsed: 10 }),
        activeEffects: JSON.stringify([{ id: 'ae1', name: 'Bess' }]),
        tokenX: 25.5,
        tokenY: 40.0,
        tokenSize: 'small',
        sortOrder: i - 1,
      });
    }

    // Add 1 PC combatant
    await db.insert(combatants).values({
      encounterId: enc.id,
      kind: 'character',
      characterId: pcChar.id,
      name: pcChar.name,
      hpMax: 25,
      hpCurrent: 25,
      initMod: 1,
      initiative: 18,
      sortOrder: 4,
    });

    // Add 1 linked NPC combatant
    await db.insert(combatants).values({
      encounterId: enc.id,
      kind: 'npc',
      npcId: npcEntity.id,
      name: npcEntity.name,
      hpMax: 15,
      hpCurrent: 15,
      initMod: 0,
      initiative: 8,
      sortOrder: 5,
    });

    // Save as template
    const template = await libraryService.saveTemplate(campaignId, { entityType: 'encounter', entityId: enc.id, name: 'Ambush Template' }, dmActor, 'dm');

    const snapshot = template.snapshot as { roster?: Array<Record<string, unknown>> };
    expect(snapshot.roster).toBeDefined();
    expect(snapshot.roster).toHaveLength(1);
    expect(snapshot.roster![0]).toMatchObject({
      kind: 'monster',
      name: 'Goblin',
      count: 4,
      hpMax: 10,
      initMod: 2,
      tokenSize: 'small',
      sortOrder: 0,
      statblock: gobStatblock,
    });

    // Instantiate template
    const instantiated = await libraryService.instantiateTemplate(campaignId, template.id, { name: 'Instantiated Ambush' }, dmActor, 'dm');
    const newEncId = instantiated.entityId;

    const instantiatedCombatants = await db.select().from(combatants).where(eq(combatants.encounterId, newEncId)).orderBy(combatants.sortOrder);
    expect(instantiatedCombatants).toHaveLength(4);

    // Assert full HP, initiative null, play state cleared, no PCs/linked NPCs
    for (let i = 0; i < 4; i++) {
      const c = instantiatedCombatants[i];
      expect(c.name).toBe(`Goblin ${i + 1}`);
      expect(c.kind).toBe('monster');
      expect(c.hpMax).toBe(10);
      expect(c.hpCurrent).toBe(10); // Restored full HP!
      expect(c.hpTemp).toBe(0); // Restored 0 temp HP!
      expect(c.initiative).toBeNull(); // Initiative cleared!
      expect(c.initiativeBreakdown).toBeNull();
      expect(c.initiativeGroup).toBeNull();
      expect(c.deathState).toBe('none');
      expect(c.deathSaveSuccesses).toBe(0);
      expect(c.deathSaveFailures).toBe(0);
      expect(c.conditions).toBe('[]');
      expect(c.conditionInstances).toBeNull();
      expect(c.turnState).toBeNull();
      expect(c.activeEffects).toBeNull();
      expect(c.tokenX).toBeNull();
      expect(c.tokenY).toBeNull();
      expect(CombatantStatblock.parse(JSON.parse(c.statblockJson!))).toMatchObject(CombatantStatblock.parse(gobStatblock));
    }
  });

  it('instantiates pre-existing templates without roster backwards-compatibly', async () => {
    const ts = nowIso();
    const [enc] = await db.insert(encounters).values({ campaignId, name: 'Bare Encounter', createdAt: ts, updatedAt: ts }).returning();
    const template = await libraryService.saveTemplate(campaignId, { entityType: 'encounter', entityId: enc.id, name: 'Bare Template' }, dmActor, 'dm');

    // Instantiate bare template
    const instantiated = await libraryService.instantiateTemplate(campaignId, template.id, { name: 'Instantiated Bare' }, dmActor, 'dm');
    const newEncId = instantiated.entityId;
    const instantiatedCombatants = await db.select().from(combatants).where(eq(combatants.encounterId, newEncId));
    expect(instantiatedCombatants).toHaveLength(0);
  });
});

