import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_AI_SCRIBE_JOBS_EXPORT_LIMIT, ExportService } from '../../src/modules/export/export.service';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { aiScribeJobs, campaigns, users } from '../../src/db/schema';
import type { RequestUser } from '../../src/common/user.types';

describe('ExportService — AI scribe jobs bounding (Issue #1529)', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let holder: DbHolder;
  let db: DrizzleDb;

  const USER: RequestUser = {
    id: '1',
    name: 'Dungeon Master',
    serverRole: 'admin',
  };

  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-export-scribe-jobs-test-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function createExportService(): ExportService {
    const emptyList = async () => [];
    const auditMock = {
      listForCampaignExport: async () => ({ entries: [], meta: {} }),
      finalizeCampaignExportMeta: async () => ({ truncated: 0, cutoff: {} }),
    };

    return new ExportService(
      db,
      { getOrThrow: async () => ({ id: 1, name: 'Test Campaign' }) } as any, // campaigns
      { listForCampaignWithObjectives: emptyList } as any, // quests
      { listForCampaign: emptyList } as any, // npcs
      { listForCampaign: emptyList } as any, // locations
      { listRecapsForCampaign: emptyList, listAttendanceForCampaign: emptyList } as any, // sessions
      { listForExport: emptyList } as any, // scheduling
      { listForExport: emptyList } as any, // characters
      { listAllForCampaign: emptyList } as any, // notes
      { listForCampaign: emptyList } as any, // comments
      { listForCampaign: emptyList } as any, // members
      auditMock as any, // audit
      { listForCampaign: emptyList } as any, // proposals
      { listForCampaign: emptyList } as any, // encounters
      { listRowsForCampaign: emptyList } as any, // attachments
      { listForCampaign: emptyList } as any, // factions
      { listArcsWithBeats: emptyList } as any, // storylines
      { listEvents: emptyList, getCalendar: async () => null } as any, // timeline
      { get: async () => null } as any, // sessionZero
      { getForUser: async () => null } as any, // supportPreferences
      { listForCampaign: emptyList, getTreasury: async () => null } as any, // inventory
      { listForCampaign: emptyList } as any, // revisions
      { listForCampaign: emptyList } as any, // rolls
      { listForCampaign: emptyList } as any, // library
    );
  }

  it('bounds exported no-op AI scribe jobs to DEFAULT_AI_SCRIBE_JOBS_EXPORT_LIMIT', async () => {
    const now = new Date().toISOString();
    await db.insert(users).values({ id: 1, username: 'dm', displayName: 'DM', createdAt: now, updatedAt: now });
    await db.insert(campaigns).values({ id: 1, name: 'Test Campaign', createdAt: now, updatedAt: now });

    // Seed 100 no-op scribe job rows (status='no_material', proposalId=null)
    for (let i = 1; i <= 100; i++) {
      await db.insert(aiScribeJobs).values({
        id: i,
        campaignId: 1,
        trigger: 'cron',
        status: 'no_material',
        proposalCount: 0,
        tokensUsed: 0,
        detail: `Run ${i}`,
        createdAt: now,
      });
    }

    const service = createExportService();
    const exported = await service.buildExport(1, USER);

    // Should be capped to DEFAULT_AI_SCRIBE_JOBS_EXPORT_LIMIT (50)
    expect(exported.aiScribeJobs).toHaveLength(DEFAULT_AI_SCRIBE_JOBS_EXPORT_LIMIT);

    // Should be the 50 most recent jobs (IDs 51 to 100), sorted ascending by ID
    expect(exported.aiScribeJobs[0]!.id).toBe(51);
    expect(exported.aiScribeJobs[49]!.id).toBe(100);
    for (let i = 0; i < exported.aiScribeJobs.length - 1; i++) {
      expect(exported.aiScribeJobs[i]!.id).toBeLessThan(exported.aiScribeJobs[i + 1]!.id);
    }
  });

  it('preserves durable provenance for proposal-filing jobs even when older than recent limit', async () => {
    const now = new Date().toISOString();
    await db.insert(users).values({ id: 1, username: 'dm', displayName: 'DM', createdAt: now, updatedAt: now });
    await db.insert(campaigns).values({ id: 1, name: 'Test Campaign', createdAt: now, updatedAt: now });

    // Job #1: An old proposal-filing job with durable provenance
    await db.insert(aiScribeJobs).values({
      id: 1,
      campaignId: 1,
      trigger: 'post_session',
      status: 'succeeded',
      proposalId: 42,
      proposalCount: 1,
      tokensUsed: 500,
      generationProvenance: JSON.stringify({ model: 'gpt-4o', promptHash: 'abc123hash' }),
      createdAt: now,
    });

    // Seed 60 subsequent no-op jobs (#2 to #61)
    for (let i = 2; i <= 61; i++) {
      await db.insert(aiScribeJobs).values({
        id: i,
        campaignId: 1,
        trigger: 'cron',
        status: 'no_material',
        proposalCount: 0,
        createdAt: now,
      });
    }

    const service = createExportService();
    const exported = await service.buildExport(1, USER);

    // Should export 51 jobs: job #1 (proposal-filing) + 50 recent no-op jobs (#12..61)
    expect(exported.aiScribeJobs).toHaveLength(51);

    // Verify job #1 is preserved with full provenance intact
    const job1 = exported.aiScribeJobs.find((j) => j.id === 1);
    expect(job1).toBeDefined();
    expect(job1?.proposalId).toBe(42);
    expect(job1?.generationProvenance).toEqual({ model: 'gpt-4o', promptHash: 'abc123hash' });

    // Verify array is sorted ascending by ID
    for (let i = 0; i < exported.aiScribeJobs.length - 1; i++) {
      expect(exported.aiScribeJobs[i]!.id).toBeLessThan(exported.aiScribeJobs[i + 1]!.id);
    }
  });

  it('does not treat dry-run preview jobs (status succeeded but proposalCount 0) as proposal-filing', async () => {
    const now = new Date().toISOString();
    await db.insert(users).values({ id: 1, username: 'dm', displayName: 'DM', createdAt: now, updatedAt: now });
    await db.insert(campaigns).values({ id: 1, name: 'Test Campaign', createdAt: now, updatedAt: now });

    // Job #1: An old dry-run job with status 'succeeded' but proposalId null and proposalCount 0
    await db.insert(aiScribeJobs).values({
      id: 1,
      campaignId: 1,
      trigger: 'on_demand',
      status: 'succeeded',
      proposalId: null,
      proposalCount: 0,
      detail: 'dry-run preview (no proposal filed)',
      createdAt: now,
    });

    // Seed 60 subsequent no-op jobs (#2 to #61)
    for (let i = 2; i <= 61; i++) {
      await db.insert(aiScribeJobs).values({
        id: i,
        campaignId: 1,
        trigger: 'cron',
        status: 'no_material',
        proposalCount: 0,
        createdAt: now,
      });
    }

    const service = createExportService();
    const exported = await service.buildExport(1, USER);

    // Job #1 was an old dry-run (no proposal) and is older than the 50 most recent jobs (#12..61),
    // so it must NOT be included in the export (capped to 50 jobs total).
    expect(exported.aiScribeJobs).toHaveLength(50);
    expect(exported.aiScribeJobs.find((j) => j.id === 1)).toBeUndefined();
  });
});
