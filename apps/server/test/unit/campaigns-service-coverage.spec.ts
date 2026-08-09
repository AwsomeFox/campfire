import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignsService } from '../../src/modules/campaigns/campaigns.service';
import { CampaignGovernanceDeniedError, CampaignGovernanceService } from '../../src/modules/campaigns/campaign-governance.service';
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
import { campaigns as campaignsTable, rulePacks } from '../../src/db/schema';
import { count, eq } from 'drizzle-orm';
import type { RequestUser } from '../../src/common/user.types';

describe('CampaignsService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let campaignsService: CampaignsService;
  let usersService: UsersService;
  let audit: AuditService;
  let dummyGovernance: Pick<
    CampaignGovernanceService,
    'resolveContext' | 'enforceTx' | 'assertPolicyAllowed' | 'getOwnerUserId' | 'enforceActiveLimitTx'
  >;

  let creatorUserId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-campaigns-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    audit = new AuditService(db);
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
      // Issue #851: create()/clone() now insert the dm membership row INSIDE their
      // own atomic governance transaction via addCreatorAsDmTx (not the async
      // addCreatorAsDm above) — see CampaignsService.create/clone.
      addCreatorAsDmTx: jest.fn(),
      listRosterForCampaign: jest.fn().mockResolvedValue([]),
    } as unknown as MembersService;
    // Issue #851 — shared-instance governance double. `bypass: true` mirrors the
    // real service's dev-auth carve-out: this test suite's synthetic RequestUsers
    // (see below) are exercising CampaignsService's OWN logic, not governance
    // enforcement (that has its own dedicated spec), so the policy/limit gate is a
    // no-op here — every create()/clone() call in this file behaves exactly as it
    // did before #851 introduced the constructor dependency.
    dummyGovernance = {
      resolveContext: jest.fn().mockResolvedValue({
        bypass: true,
        policy: 'everyone',
        isServerAdmin: false,
        canCreateCampaigns: true,
        userId: null,
        limits: { activePerUser: null, totalPerUser: null, activeServerWide: null, totalServerWide: null },
        defaultStorageQuotaBytes: null,
      }),
      enforceTx: jest.fn(),
      assertPolicyAllowed: jest.fn(),
      // Issue #2016 — the reactivation ceiling. Same `bypass` rationale as above: this
      // suite exercises CampaignsService's own logic, and the real enforcement has its
      // own spec (campaign-governance.spec.ts). `getOwnerUserId` must still return a
      // value rather than being absent, because update()/restore() call it before
      // enforceActiveLimitTx on every reactivation.
      getOwnerUserId: jest.fn().mockReturnValue(null),
      enforceActiveLimitTx: jest.fn(),
    };
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
      dummyGovernance as unknown as CampaignGovernanceService,
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

  it('revalidates enabled pack rows inside create and update transactions', async () => {
    const creatorActor: RequestUser = {
      id: String(creatorUserId),
      name: 'Creator',
      serverRole: 'user',
    };
    const ts = new Date().toISOString();
    const [base] = await db
      .insert(rulePacks)
      .values({
        slug: 'transaction-base',
        name: 'Transaction Base',
        version: '1',
        license: 'CC0',
        sourceUrl: '',
        kind: 'base',
        installedAt: ts,
        entryCount: 0,
      })
      .returning();
    const insertSupplement = () =>
      db
        .insert(rulePacks)
        .values({
          slug: 'transaction-supplement',
          name: 'Transaction Supplement',
          version: '1',
          license: 'CC0',
          sourceUrl: '',
          kind: 'supplement' as const,
          installedAt: ts,
          entryCount: 0,
        })
        .returning()
        .get();
    let supplement = insertSupplement();

    (dummyGovernance.resolveContext as jest.Mock).mockImplementationOnce(async () => {
      // Simulate uninstall after the async pack preflight but before create() reserves
      // the writer slot for its governance+insert transaction.
      db.delete(rulePacks).where(eq(rulePacks.id, supplement.id)).run();
      return {
        bypass: true,
        policy: 'everyone',
        isServerAdmin: false,
        canCreateCampaigns: true,
        userId: null,
        limits: { activePerUser: null, totalPerUser: null, activeServerWide: null, totalServerWide: null },
        defaultStorageQuotaBytes: null,
      };
    });
    await expect(
      campaignsService.create(
        { name: 'Raced Create', ruleSystem: base.slug, enabledPackSlugs: [supplement.slug] },
        creatorActor,
      ),
    ).rejects.toThrow(BadRequestException);

    supplement = insertSupplement();
    const target = await campaignsService.create(
      { name: 'Raced Update', ruleSystem: base.slug },
      creatorActor,
    );
    // The injected DB is a forwarding proxy, so stage the interleaving on the live ORM:
    // remove the pack immediately before update() enters its first write transaction.
    const orm = (holder as unknown as { orm: DrizzleDb }).orm;
    const original = Object.getOwnPropertyDescriptor(orm, 'transaction');
    const realTransaction = orm.transaction.bind(orm);
    let staged = false;
    (orm as unknown as { transaction: unknown }).transaction = (fn: never) => {
      if (!staged) {
        staged = true;
        db.delete(rulePacks).where(eq(rulePacks.id, supplement.id)).run();
      }
      return realTransaction(fn);
    };
    try {
      await expect(
        campaignsService.update(target.id, { enabledPackSlugs: [supplement.slug] }, creatorActor),
      ).rejects.toThrow(BadRequestException);
    } finally {
      if (original) Object.defineProperty(orm, 'transaction', original);
      else delete (orm as unknown as { transaction?: unknown }).transaction;
    }
    expect((await campaignsService.getOrThrow(target.id)).enabledPackSlugs).toEqual([]);

    const [otherBase] = await db
      .insert(rulePacks)
      .values({
        slug: 'transaction-other-base',
        name: 'Transaction Other Base',
        version: '1',
        license: 'CC0',
        sourceUrl: '',
        kind: 'base',
        installedAt: ts,
        entryCount: 0,
      })
      .returning();
    const [extension] = await db
      .insert(rulePacks)
      .values({
        slug: 'transaction-extension',
        name: 'Transaction Extension',
        version: '1',
        license: 'CC0',
        sourceUrl: '',
        kind: 'extension',
        extendsPackSlug: base.slug,
        installedAt: ts,
        entryCount: 0,
      })
      .returning();

    const primaryRaceOriginal = Object.getOwnPropertyDescriptor(orm, 'transaction');
    const primaryRaceTransaction = orm.transaction.bind(orm);
    let primarySwitched = false;
    (orm as unknown as { transaction: unknown }).transaction = (fn: never) => {
      if (!primarySwitched) {
        primarySwitched = true;
        // Simulate a concurrent PATCH switching A -> B after this request validated E
        // against A, but before its enabled-pack write transaction begins.
        db.update(campaignsTable).set({ ruleSystem: otherBase.slug }).where(eq(campaignsTable.id, target.id)).run();
      }
      return primaryRaceTransaction(fn);
    };
    try {
      await expect(
        campaignsService.update(target.id, { enabledPackSlugs: [extension.slug] }, creatorActor),
      ).rejects.toThrow(BadRequestException);
    } finally {
      if (primaryRaceOriginal) Object.defineProperty(orm, 'transaction', primaryRaceOriginal);
      else delete (orm as unknown as { transaction?: unknown }).transaction;
    }
    expect(await campaignsService.getOrThrow(target.id)).toMatchObject({
      ruleSystem: otherBase.slug,
      enabledPackSlugs: [],
    });
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

  // Issue #851 — CampaignsService's WIRING to CampaignGovernanceService: the
  // authoritative policy/limit logic itself is covered exhaustively in
  // campaign-governance.spec.ts against a real CampaignGovernanceService; here we
  // only prove create()/clone() call it correctly — atomically, with audit-on-deny
  // and rollback, and that the resolved default quota lands on the inserted row.
  describe('shared-instance governance wiring (issue #851)', () => {
    const creatorActor: RequestUser = { id: '', name: 'Creator', serverRole: 'user' };

    beforeEach(() => {
      (creatorActor as { id: string }).id = String(creatorUserId);
    });

    async function campaignRowCount(): Promise<number> {
      const [row] = await db.select({ n: count() }).from(campaignsTable);
      return Number(row?.n ?? 0);
    }

    it('denies create() when enforceTx throws, audits campaign.create.denied, and inserts no row', async () => {
      (dummyGovernance.enforceTx as jest.Mock).mockImplementation(() => {
        throw new CampaignGovernanceDeniedError('limit_active_per_user', 'no more for you');
      });
      const auditSpy = jest.spyOn(audit, 'log');

      await expect(
        campaignsService.create({ name: 'Blocked Campaign' }, creatorActor),
      ).rejects.toThrow(CampaignGovernanceDeniedError);

      expect(await campaignRowCount()).toBe(0);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'campaign.create.denied', detail: expect.stringContaining('limit_active_per_user') }),
      );
    });

    // Review: the three denial audits hard-coded actorRole:'dm'. Limits are deliberately
    // NOT admin-exempt (enforceTx's doc), so an admin refused by a ceiling is reachable —
    // and 'dm' erases exactly the distinction an incident reviewer needs. The assertions
    // below discriminate: an admin must log 'admin', and a viewer-scoped PAT held BY that
    // same admin must still log 'dm', because adminEnabled=false caps the power the role
    // is meant to record. A `user.serverRole === 'admin'` shortcut would fail the second.
    it('records the denied actor\'s real role, not a hard-coded dm', async () => {
      (dummyGovernance.enforceTx as jest.Mock).mockImplementation(() => {
        throw new CampaignGovernanceDeniedError('limit_active_per_user', 'no more for you');
      });
      const auditSpy = jest.spyOn(audit, 'log');

      const adminActor: RequestUser = { id: String(creatorUserId), name: 'Admin', serverRole: 'admin' };
      await expect(campaignsService.create({ name: 'Blocked By Ceiling' }, adminActor)).rejects.toThrow(
        CampaignGovernanceDeniedError,
      );
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'campaign.create.denied', actorRole: 'admin' }),
      );

      auditSpy.mockClear();
      const cappedPatActor: RequestUser = {
        id: String(creatorUserId),
        name: 'Admin',
        serverRole: 'admin',
        tokenContext: { name: 'viewer-pat', scope: 'viewer', adminEnabled: false },
      } as RequestUser;
      await expect(campaignsService.create({ name: 'Blocked By Ceiling 2' }, cappedPatActor)).rejects.toThrow(
        CampaignGovernanceDeniedError,
      );
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'campaign.create.denied', actorRole: 'dm' }),
      );

      expect(await campaignRowCount()).toBe(0);
    });

    // Review: enforceTx runs inside the insert transaction, which for an archive import is
    // reached only after the whole zip is decompressed and staged to disk — so a caller the
    // POLICY forbids could force that work on every attempt just to be handed a 403.
    //
    // The buffer below is deliberately not a zip at all. If the policy check runs first, the
    // caller sees the governance denial; if it runs after JSZip.loadAsync, they see "not a
    // valid zip archive" instead. The error identity is therefore a direct proof of ordering,
    // with no need to time or instrument the decompression itself.
    it('refuses a policy-forbidden archive import before the zip is ever opened', async () => {
      (dummyGovernance.assertPolicyAllowed as jest.Mock).mockImplementation(() => {
        throw new CampaignGovernanceDeniedError('policy_admins_only', 'admins only');
      });

      await expect(
        campaignsService.importArchive(Buffer.from('this is not a zip'), creatorActor),
      ).rejects.toThrow(CampaignGovernanceDeniedError);
      expect(await campaignRowCount()).toBe(0);
    });

    it('opens the archive normally when the policy allows the caller', async () => {
      // The other half of the same branch: assertPolicyAllowed is a no-op by default, so this
      // must get PAST the policy gate and fail on the archive itself. Without it, a check that
      // rejected everyone would still pass the test above.
      await expect(
        campaignsService.importArchive(Buffer.from('this is not a zip'), creatorActor),
      ).rejects.toThrow(/not a valid zip/i);
    });

    it('applies the resolved default storage quota to a newly created campaign', async () => {
      (dummyGovernance.resolveContext as jest.Mock).mockResolvedValue({
        bypass: false,
        policy: 'everyone',
        isServerAdmin: false,
        canCreateCampaigns: true,
        userId: creatorUserId,
        limits: { activePerUser: null, totalPerUser: null, activeServerWide: null, totalServerWide: null },
        defaultStorageQuotaBytes: 123456,
      });

      const created = await campaignsService.create({ name: 'Quota Campaign' }, creatorActor);
      expect(created.storageQuotaBytes).toBe(123456);
    });

    it('denies clone() when enforceTx throws, audits the denial, and inserts no new row', async () => {
      const source = await campaignsService.create({ name: 'Clone Source' }, creatorActor);
      const before = await campaignRowCount();

      (dummyGovernance.enforceTx as jest.Mock).mockImplementation(() => {
        throw new CampaignGovernanceDeniedError('limit_total_per_user', 'no more for you');
      });
      const auditSpy = jest.spyOn(audit, 'log');

      await expect(
        campaignsService.clone(source.id, { name: 'Blocked Clone', mode: 'full' }, creatorActor),
      ).rejects.toThrow(CampaignGovernanceDeniedError);

      expect(await campaignRowCount()).toBe(before);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'campaign.create.denied', detail: expect.stringContaining('limit_total_per_user') }),
      );
    });

    it('applies the resolved default storage quota to a clone (not the source campaign quota)', async () => {
      const source = await campaignsService.create({ name: 'Quota Clone Source' }, creatorActor);
      (dummyGovernance.resolveContext as jest.Mock).mockResolvedValue({
        bypass: false,
        policy: 'everyone',
        isServerAdmin: false,
        canCreateCampaigns: true,
        userId: creatorUserId,
        limits: { activePerUser: null, totalPerUser: null, activeServerWide: null, totalServerWide: null },
        defaultStorageQuotaBytes: 555000,
      });

      const cloned = await campaignsService.clone(source.id, { name: 'Quota Clone', mode: 'full' }, creatorActor);
      expect(cloned.storageQuotaBytes).toBe(555000);
      // The source itself was created before the quota override took effect (null default).
      const refetchedSource = await campaignsService.getOrThrow(source.id);
      expect(refetchedSource.storageQuotaBytes).toBeNull();
    });
  });
});
