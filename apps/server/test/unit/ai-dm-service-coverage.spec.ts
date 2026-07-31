import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { AiDmService } from '../../src/modules/ai-dm/ai-dm.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { AiProviderConfigService } from '../../src/modules/ai-provider-config/ai-provider-config.service';
import { SessionZeroService } from '../../src/modules/session-zero/session-zero.service';
import { SupportPreferencesService } from '../../src/modules/session-zero/support-preferences.service';
import { AiPricingService } from '../../src/modules/ai-pricing/ai-pricing.service';
import type { AiDmProvider } from '../../src/modules/ai-dm/ai-dm.provider';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('AiDmService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let aiDmService: AiDmService;

  const dmActor: RequestUser = {
    id: '1',
    name: 'DM',
    serverRole: 'user',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-aidm-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const settings = new SettingsService(db);
    await settings.setJson('experimentalAiDm', true);

    const providerConfig = {
      getConfig: jest.fn().mockResolvedValue({ mode: 'mock' }),
      getEffectiveView: jest.fn().mockResolvedValue({ mode: 'mock', provider: 'mock' }),
    } as unknown as AiProviderConfigService;
    const sessionZero = {
      getForCampaign: jest.fn().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue({ lines: [], veils: [], safetyTools: [], houseRules: '', toneAndExpectations: '', topicRatings: [] }),
    } as unknown as SessionZeroService;
    const supportPreferences = {
      getForCampaign: jest.fn().mockResolvedValue(null),
      aiConsentCounts: jest.fn().mockResolvedValue({ agreed: 1, declined: 0, total: 1 }),
    } as unknown as SupportPreferencesService;
    const pricing = { getPricing: jest.fn().mockResolvedValue({ promptUsdPer100k: 0.1, completionUsdPer100k: 0.2 }) } as unknown as AiPricingService;
    const provider = { name: 'mock', generateTurn: jest.fn() } as unknown as AiDmProvider;

    aiDmService = new AiDmService(
      db,
      audit,
      settings,
      providerConfig,
      sessionZero,
      supportPreferences,
      pricing,
      provider,
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

  it('manages AI DM seat configuration, defaults, and readiness', async () => {
    await aiDmService.onApplicationBootstrap();

    const defaults = await aiDmService.getSeatDefaults();
    expect(defaults).toBeDefined();

    const seat = await aiDmService.getSeat(campaignId);
    expect(seat.campaignId).toBe(campaignId);

    const updated = await aiDmService.configure(
      campaignId,
      { mode: 'co_dm' },
      dmActor,
    );
    expect(updated.mode).toBe('co_dm');

    const history = await aiDmService.listUsageHistory(campaignId, {});
    expect(Array.isArray(history.items)).toBe(true);

    const readiness = await aiDmService.getReadiness(campaignId, dmActor, { isAdmin: false });
    expect(readiness.campaignId).toBe(campaignId);
  });
});
