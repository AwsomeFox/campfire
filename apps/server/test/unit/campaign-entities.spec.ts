import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CharactersService } from '../../src/modules/characters/characters.service';
import { NotesService } from '../../src/modules/notes/notes.service';
import { QuestsService } from '../../src/modules/quests/quests.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { CampaignAccessService } from '../../src/modules/membership/campaign-access.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('Campaign Entities (Characters, Notes, Quests, Inventory) unit tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let charactersService: CharactersService;
  let notesService: NotesService;
  let questsService: QuestsService;
  let inventoryService: InventoryService;

  const dmActor: RequestUser = {
    id: '1',
    name: 'DM',
    serverRole: 'user',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-entities-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const events = new CampaignEventsService();
    const notifications = new NotificationsService(db);
    const moderation = {
      quarantineNoteIfWatched: jest.fn(),
      snapshotCommentIfWatched: jest.fn(),
      snapshotNoteIfWatched: jest.fn(),
      assertUserCanPost: jest.fn(),
      assertNotMuted: jest.fn().mockResolvedValue(undefined),
    } as unknown as ModerationService;
    const revisions = new RevisionsService(db, moderation);
    const rolls = { recordRoll: jest.fn() } as unknown as RollsService;
    const access = { assertMember: jest.fn() } as unknown as CampaignAccessService;

    charactersService = new CharactersService(db, audit, revisions, events, rolls, access);
    notesService = new NotesService(db, audit, notifications, revisions, moderation);
    questsService = new QuestsService(db, audit, notifications, revisions);
    inventoryService = new InventoryService(db, audit, events);

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

  describe('CharactersService', () => {
    it('creates, lists, updates, and deletes characters', async () => {
      const char = await charactersService.create(
        campaignId,
        {
          name: 'Hero Thorin',
          className: 'Fighter',
          level: 5,
        },
        dmActor,
        'dm',
      );
      expect(char.name).toBe('Hero Thorin');

      const list = await charactersService.listForCampaign(campaignId, dmActor, 'dm');
      expect(list.length).toBe(1);
      expect(list[0].name).toBe('Hero Thorin');

      const fetched = await charactersService.getOrThrow(char.id, dmActor, 'dm');
      expect(fetched.id).toBe(char.id);

      const updated = await charactersService.update(
        char.id,
        {
          name: 'King Thorin',
          level: 6,
        },
        dmActor,
        'dm',
      );
      expect(updated.name).toBe('King Thorin');
      expect(updated.level).toBe(6);

      await charactersService.remove(char.id, dmActor, 'dm');
      const afterRemove = await charactersService.listForCampaign(campaignId, dmActor, 'dm');
      expect(afterRemove.length).toBe(0);
    });
  });

  describe('NotesService', () => {
    it('creates, lists, updates, and deletes notes', async () => {
      const note = await notesService.create(
        campaignId,
        {
          visibility: 'dm_shared',
          body: 'X marks the spot behind the waterfall.',
        },
        dmActor,
        'dm',
      );
      expect(note.body).toBe('X marks the spot behind the waterfall.');

      const list = await notesService.listForCampaign(campaignId, dmActor, 'dm');
      expect(list.items.length).toBe(1);

      const fetched = await notesService.getOrThrow(note.id, dmActor, 'dm');
      expect(fetched.body).toBe('X marks the spot behind the waterfall.');

      const updated = await notesService.update(
        note.id,
        {
          body: 'The cave was trapped!',
        },
        dmActor,
        'dm',
      );
      expect(updated.body).toBe('The cave was trapped!');

      await notesService.remove(note.id, dmActor, 'dm');
      const afterRemove = await notesService.listForCampaign(campaignId, dmActor, 'dm');
      expect(afterRemove.items.length).toBe(0);
    });
  });

  describe('QuestsService', () => {
    it('creates, lists, updates, and deletes quests', async () => {
      const quest = await questsService.create(
        campaignId,
        {
          title: 'Find the Lost Crown',
          body: 'Recover the ancient crown from goblin cave.',
          status: 'active',
        },
        dmActor,
        'dm',
      );
      expect(quest.title).toBe('Find the Lost Crown');

      const list = await questsService.listForCampaign(campaignId, 'dm');
      expect(list.length).toBe(1);

      const fetched = await questsService.getOrThrow(quest.id, 'dm');
      expect(fetched.title).toBe('Find the Lost Crown');

      const updated = await questsService.update(
        quest.id,
        {
          status: 'completed',
        },
        dmActor,
        'dm',
      );
      expect(updated.status).toBe('completed');

      await questsService.remove(quest.id, dmActor, 'dm');
      const afterRemove = await questsService.listForCampaign(campaignId, 'dm');
      expect(afterRemove.length).toBe(0);
    });
  });

  describe('InventoryService', () => {
    it('creates, lists, updates, and deletes inventory items & manages treasury', async () => {
      const item = await inventoryService.create(
        campaignId,
        {
          name: 'Healing Potion',
          qty: 3,
          notes: 'Restores 2d4+2 HP',
        },
        dmActor,
        'dm',
      );
      expect(item.name).toBe('Healing Potion');

      const list = await inventoryService.listForCampaign(campaignId, dmActor, 'dm');
      expect(list.length).toBe(1);

      const updated = await inventoryService.update(
        item.id,
        {
          qtyDelta: -1,
          idempotencyKey: 'idemp-123',
        },
        dmActor,
        'dm',
      );
      expect(updated.qty).toBe(2);

      const treasury = await inventoryService.getTreasury(campaignId);
      expect(treasury).toBeDefined();

      const patchedTreasury = await inventoryService.patchTreasury(
        campaignId,
        {
          delta: {
            gp: 150,
            sp: 20,
          },
        },
        dmActor,
        'dm',
      );
      expect(patchedTreasury.gp).toBe(150);

      await inventoryService.remove(item.id, dmActor, 'dm');
      const afterRemove = await inventoryService.listForCampaign(campaignId, dmActor, 'dm');
      expect(afterRemove.length).toBe(0);
    });
  });
});
