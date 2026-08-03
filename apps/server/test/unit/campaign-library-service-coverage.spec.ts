import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns, characters, inventoryItems } from '../../src/db/schema';
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
});
