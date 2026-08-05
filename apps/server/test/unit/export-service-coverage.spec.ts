import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignsService } from '../../src/modules/campaigns/campaigns.service';
import { QuestsService } from '../../src/modules/quests/quests.service';
import { NpcsService } from '../../src/modules/npcs/npcs.service';
import { LocationsService } from '../../src/modules/locations/locations.service';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { SchedulingService } from '../../src/modules/sessions/scheduling.service';
import { CharactersService } from '../../src/modules/characters/characters.service';
import { NotesService } from '../../src/modules/notes/notes.service';
import { CommentsService } from '../../src/modules/comments/comments.service';
import { MembersService } from '../../src/modules/membership/members.service';
import { ProposalsService } from '../../src/modules/proposals/proposals.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { FactionsService } from '../../src/modules/factions/factions.service';
import { StorylinesService } from '../../src/modules/storylines/storylines.service';
import { TimelineService } from '../../src/modules/timeline/timeline.service';
import { SessionZeroService } from '../../src/modules/session-zero/session-zero.service';
import { SupportPreferencesService } from '../../src/modules/session-zero/support-preferences.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { ExportService } from '../../src/modules/export/export.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('ExportService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let exportService: ExportService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;
  // Issue #1904 review finding: hoisted so a test can assert what role buildMemberExport
  // actually threads through to RollsService.listForCampaign — an omitted role there reads
  // as unredacted DM access, the exact gap that let a player's own member export carry the
  // full unredacted dice log.
  let rollsListForCampaignMock: jest.Mock;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-export-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const quests = { listForCampaignWithObjectives: jest.fn().mockResolvedValue([]) } as unknown as QuestsService;
    const npcs = { listForCampaign: jest.fn().mockResolvedValue([]) } as unknown as NpcsService;
    const locations = { listForCampaign: jest.fn().mockResolvedValue([]) } as unknown as LocationsService;
    const sessions = {
      listRecapsForCampaign: jest.fn().mockResolvedValue([]),
      listAttendanceForCampaign: jest.fn().mockResolvedValue([]),
    } as unknown as SessionsService;
    const scheduling = {
      listForCampaign: jest.fn().mockResolvedValue([]),
      listForExport: jest.fn().mockResolvedValue([]),
    } as unknown as SchedulingService;
    const characters = { listForExport: jest.fn().mockResolvedValue([]) } as unknown as CharactersService;
    const notes = {
      listForCampaign: jest.fn().mockResolvedValue({ items: [] }),
      listAllForCampaign: jest.fn().mockResolvedValue([]),
    } as unknown as NotesService;
    const comments = { listForCampaign: jest.fn().mockResolvedValue([]) } as unknown as CommentsService;
    const members = {
      listRosterForCampaign: jest.fn().mockResolvedValue([]),
      listForCampaign: jest.fn().mockResolvedValue([]),
    } as unknown as MembersService;
    const proposals = { listForCampaign: jest.fn().mockResolvedValue([]) } as unknown as ProposalsService;
    const encounters = { listForCampaign: jest.fn().mockResolvedValue([]) } as unknown as EncountersService;
    const attachments = {
      listForCampaign: jest.fn().mockResolvedValue([]),
      listRowsForCampaign: jest.fn().mockResolvedValue([]),
    } as unknown as AttachmentsService;
    const factions = { listForCampaign: jest.fn().mockResolvedValue([]) } as unknown as FactionsService;
    const storylines = { listArcsWithBeats: jest.fn().mockResolvedValue([]) } as unknown as StorylinesService;
    const timeline = {
      listEvents: jest.fn().mockResolvedValue([]),
      getCalendar: jest.fn().mockResolvedValue(null),
    } as unknown as TimelineService;
    const sessionZero = {
      getCharter: jest.fn().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue(null),
      listConsent: jest.fn().mockResolvedValue([]),
      listRatings: jest.fn().mockResolvedValue([]),
    } as unknown as SessionZeroService;
    const supportPreferences = {
      getPreferences: jest.fn().mockResolvedValue(null),
      getOwn: jest.fn().mockResolvedValue(null),
    } as unknown as SupportPreferencesService;
    const inventory = {
      listItemsForCampaign: jest.fn().mockResolvedValue([]),
      listForCampaign: jest.fn().mockResolvedValue([]),
      getTreasury: jest.fn().mockResolvedValue(null),
    } as unknown as InventoryService;
    const revisions = { listForCampaign: jest.fn().mockResolvedValue([]) } as unknown as RevisionsService;
    rollsListForCampaignMock = jest.fn().mockResolvedValue([]);
    const rolls: Pick<RollsService, 'listForCampaign'> = {
      listForCampaign: rollsListForCampaignMock as unknown as RollsService['listForCampaign'],
    };
    const library = { listForCampaign: jest.fn().mockResolvedValue([]) } as unknown as CampaignLibraryService;
    const campaignService = { getOrThrow: jest.fn().mockResolvedValue({ id: 1, name: 'Test Campaign' }) } as unknown as CampaignsService;

    exportService = new ExportService(
      db,
      campaignService,
      quests,
      npcs,
      locations,
      sessions,
      scheduling,
      characters,
      notes,
      comments,
      members,
      audit,
      proposals,
      encounters,
      attachments,
      factions,
      storylines,
      timeline,
      sessionZero,
      supportPreferences,
      inventory,
      revisions,
      rolls as unknown as RollsService,
      library,
    );

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

  it('builds full campaign export payload and member exports', async () => {
    const exp = await exportService.buildExport(campaignId, adminActor);
    expect(exp).toBeDefined();

    const memberExp = await exportService.buildMemberExport(campaignId, adminActor, 'dm');
    expect(memberExp).toBeDefined();
  });

  // Issue #1904 review finding: buildMemberExport's whole contract is "never show a caller
  // more than the live API already would" (see its own doc comment), which only holds if
  // every composed read is threaded through the caller's ACTUAL role. rolls.listForCampaign
  // was called with no role at all — an omitted role reads as unredacted DM access
  // (RollsService.listForCampaign's own doc comment: "omit it... only for DM-facing
  // returns") — so a player's own member export carried the full unredacted dice log
  // (hidden-encounter rolls, unmasked hidden-NPC names/ids) the live GET
  // /campaigns/:id/rolls would have redacted for that same player.
  it('threads the caller role through to RollsService.listForCampaign, not an implicit DM view (#1904)', async () => {
    await exportService.buildMemberExport(campaignId, adminActor, 'player');
    expect(rollsListForCampaignMock).toHaveBeenCalledWith(campaignId, expect.any(Number), 'player');

    rollsListForCampaignMock.mockClear();
    await exportService.buildMemberExport(campaignId, adminActor, 'viewer');
    expect(rollsListForCampaignMock).toHaveBeenCalledWith(campaignId, expect.any(Number), 'viewer');

    // The full-campaign DM export is legitimately unredacted — explicit role='dm', not an
    // omission that happens to behave the same way today.
    rollsListForCampaignMock.mockClear();
    await exportService.buildExport(campaignId, adminActor);
    expect(rollsListForCampaignMock).toHaveBeenCalledWith(campaignId, expect.any(Number), 'dm');
  });
});
