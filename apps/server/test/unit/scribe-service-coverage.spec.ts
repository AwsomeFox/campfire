import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { NotesService } from '../../src/modules/notes/notes.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { ProposalRecordsService } from '../../src/modules/proposals/proposal-records.service';
import { AiProviderConfigService } from '../../src/modules/ai-provider-config/ai-provider-config.service';
import { AiDmService } from '../../src/modules/ai-dm/ai-dm.service';
import { SupportPreferencesService } from '../../src/modules/session-zero/support-preferences.service';
import { ScribeService } from '../../src/modules/scribe/scribe.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('ScribeService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let scribeService: ScribeService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-scribe-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const settings = new SettingsService(db);
    const notes = {} as unknown as NotesService;
    const encounters = {} as unknown as EncountersService;
    const rolls = {} as unknown as RollsService;
    const proposalRecords = {} as unknown as ProposalRecordsService;
    const providerConfig = new AiProviderConfigService(db, audit);
    const aiDm = {} as unknown as AiDmService;
    const supportPreferences = new SupportPreferencesService(db, audit);
    const fallbackProvider = {} as any;

    scribeService = new ScribeService(
      db,
      audit,
      settings,
      notes,
      encounters,
      rolls,
      proposalRecords,
      providerConfig,
      aiDm,
      supportPreferences,
      fallbackProvider,
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

  it('manages scribe configs and jobs', async () => {
    scribeService.onApplicationBootstrap();

    const config = await scribeService.getConfig(campaignId);
    expect(config).toBeDefined();

    const updated = await scribeService.putConfig(
      campaignId,
      { postSession: true, cron: false, budgetPerRun: 100 },
      adminActor,
    );
    expect(updated.postSession).toBe(true);

    const jobs = await scribeService.listJobs(campaignId);
    expect(Array.isArray(jobs)).toBe(true);
  });
});
