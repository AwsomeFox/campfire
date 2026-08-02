import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignsService } from '../../src/modules/campaigns/campaigns.service';
import { QuestsService } from '../../src/modules/quests/quests.service';
import { NpcsService } from '../../src/modules/npcs/npcs.service';
import { LocationsService } from '../../src/modules/locations/locations.service';
import { CharactersService } from '../../src/modules/characters/characters.service';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { SchedulingService } from '../../src/modules/sessions/scheduling.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { TimelineService } from '../../src/modules/timeline/timeline.service';
import { CommentsService } from '../../src/modules/comments/comments.service';
import { RoleResolver } from '../../src/modules/membership/role-resolver.service';
import { MembersService } from '../../src/modules/membership/members.service';
import { InvitesService } from '../../src/modules/membership/invites.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { AiDmService } from '../../src/modules/ai-dm/ai-dm.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { UsersService } from '../../src/modules/users/users.service';
import type { RequestUser } from '../../src/common/user.types';

describe('CampaignsService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let campaignsService: CampaignsService;
  let usersService: UsersService;

  let creatorUserId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-campaigns-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    usersService = new UsersService(db, audit);

    const user = await usersService.create({ username: 'creator', displayName: 'Creator', password: 'pw' });
    creatorUserId = user.id;

    const dummyQuests = { listForCampaignWithObjectives: jest.fn().mockResolvedValue([]) } as unknown as QuestsService;
    const dummyNpcs = { listForCampaign: jest.fn().mockResolvedValue([]) } as unknown as NpcsService;
    const dummyLocations = { listForCampaign: jest.fn().mockResolvedValue([]) } as unknown as LocationsService;
    const dummyCharacters = {
      listForCampaign: jest.fn().mockResolvedValue([]),
      partyRosterForCampaign: jest.fn().mockResolvedValue([]),
    } as unknown as CharactersService;
    const dummySessions = {
      listForCampaign: jest.fn().mockResolvedValue([]),
      recomputeSessionStatsInTx: jest.fn(),
    } as unknown as SessionsService;
    const dummyScheduling = {
      nextSession: jest.fn().mockResolvedValue(null),
      currentAndNextForCampaign: jest.fn().mockResolvedValue({ current: null, next: null }),
    } as unknown as SchedulingService;
    const dummyEncounters = { digestForCampaign: jest.fn().mockResolvedValue([]) } as unknown as EncountersService;
    const dummyInventory = {
      getTreasury: jest.fn().mockResolvedValue({ cp: 0, sp: 0, ep: 0, gp: 0, pp: 0, updatedAt: '' }),
      countForCampaign: jest.fn().mockResolvedValue(0),
    } as unknown as InventoryService;
    const dummyTimeline = {
      listEventsForCampaign: jest.fn().mockResolvedValue([]),
      listEvents: jest.fn().mockResolvedValue([]),
    } as unknown as TimelineService;
    const dummyComments = { countForCampaign: jest.fn().mockResolvedValue(0) } as unknown as CommentsService;
    const dummyRoleResolver = {
      resolveEffectiveRole: jest.fn().mockResolvedValue('dm'),
      accessibleCampaignIds: jest.fn().mockResolvedValue('all'),
    } as unknown as RoleResolver;
    const dummyMembers = {
      addCreatorAsDm: jest.fn().mockResolvedValue(undefined),
      listRosterForCampaign: jest.fn().mockResolvedValue([]),
    } as unknown as MembersService;
    const dummyInvites = {
      suspendForCampaign: jest.fn().mockResolvedValue(undefined),
    } as unknown as InvitesService;
    const dummyFsDeletion = {
      purgeCampaignDir: jest.fn().mockResolvedValue({ status: 'purged' }),
      auditRequested: jest.fn().mockResolvedValue(undefined),
      auditMetadataComplete: jest.fn().mockResolvedValue(undefined),
      reserveUploadPaths: jest.fn().mockResolvedValue({ commit: jest.fn().mockResolvedValue(undefined) }),
      completeReservedUploadPaths: jest.fn().mockResolvedValue({ status: 'purged' }),
    } as unknown as FsDeletionService;
    const dummyEvents = {
      emitCampaignUpdated: jest.fn(),
      emitCampaignDeleted: jest.fn(),
      emit: jest.fn(),
    } as unknown as CampaignEventsService;
    const dummyAiDm = { syncProactiveWatcher: jest.fn(), isExperimentalEnabled: jest.fn().mockResolvedValue(true) } as unknown as AiDmService;
    const dummyNotifications = {
      queueCampaignLifecycleNotification: jest.fn(),
      notifyCampaign: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationsService;

    campaignsService = new CampaignsService(
      db,
      audit,
      dummyQuests,
      dummyNpcs,
      dummyLocations,
      dummyCharacters,
      dummySessions,
      dummyScheduling,
      dummyEncounters,
      dummyInventory,
      dummyTimeline,
      dummyComments,
      dummyRoleResolver,
      dummyMembers,
      dummyInvites,
      dummyFsDeletion,
      dummyEvents,
      dummyAiDm,
      dummyNotifications,
    );
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates, lists, updates, trashes, restores, and purges campaigns', async () => {
    const creatorActor: RequestUser = {
      id: String(creatorUserId),
      name: 'Creator',
      serverRole: 'user',
    };

    const created = await campaignsService.create(
      {
        name: 'The Lost Kingdom',
        description: 'An epic fantasy adventure.',
      },
      creatorActor,
    );
    expect(created.name).toBe('The Lost Kingdom');

    const devActor: RequestUser = {
      id: 'dev:admin',
      name: 'Dev Admin',
      serverRole: 'admin',
    };

    const list = await campaignsService.listForUser(devActor);
    expect(list.length).toBe(1);

    const fetched = await campaignsService.getOrThrow(created.id);
    expect(fetched.id).toBe(created.id);

    const trashedEntities = await campaignsService.listTrashedEntities(created.id);
    expect(Array.isArray(trashedEntities)).toBe(true);

    const summ = await campaignsService.summary(created.id, devActor, 'dm');
    expect(summ.campaign.name).toBe('The Lost Kingdom');

    const updated = await campaignsService.update(
      created.id,
      {
        name: 'The Restored Kingdom',
      },
      creatorActor,
    );
    expect(updated.name).toBe('The Restored Kingdom');

    const paused = await campaignsService.update(
      created.id,
      { status: 'paused' },
      creatorActor,
    );
    expect(paused.status).toBe('paused');

    const active = await campaignsService.update(
      created.id,
      { status: 'active' },
      creatorActor,
    );
    expect(active.status).toBe('active');

    await campaignsService.remove(created.id, creatorActor);
    const trashedList = await campaignsService.listTrashedForUser(devActor);
    expect(trashedList.length).toBe(1);

    const restored = await campaignsService.restore(created.id, creatorActor);
    expect(restored.deletedAt).toBeNull();

    await campaignsService.remove(created.id, creatorActor);
    await campaignsService.purge(created.id, creatorActor, { confirm: 'PURGE' });
  });

  it('previews and executes campaign cloning', async () => {
    const creatorActor: RequestUser = {
      id: String(creatorUserId),
      name: 'Creator',
      serverRole: 'user',
    };

    const created = await campaignsService.create(
      {
        name: 'Original Campaign',
      },
      creatorActor,
    );

    const fullPreview = await campaignsService.clonePreview(created.id, 'full', creatorActor);
    expect(fullPreview.mode).toBe('full');

    const tmplPreview = await campaignsService.clonePreview(created.id, 'template', creatorActor);
    expect(tmplPreview.mode).toBe('template');

    const clonedFull = await campaignsService.clone(
      created.id,
      { name: 'Cloned Full Campaign', mode: 'full' },
      creatorActor,
    );
    expect(clonedFull.name).toBe('Cloned Full Campaign');

    const clonedTmpl = await campaignsService.clone(
      created.id,
      { name: 'Cloned Template Campaign', mode: 'template' },
      creatorActor,
    );
    expect(clonedTmpl.name).toBe('Cloned Template Campaign');
  });
});
