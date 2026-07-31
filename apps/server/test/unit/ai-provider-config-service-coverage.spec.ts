import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { AiProviderConfigService } from '../../src/modules/ai-provider-config/ai-provider-config.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('AiProviderConfigService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let configService: AiProviderConfigService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-aiconfig-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);

    configService = new AiProviderConfigService(db, audit);

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

  it('manages server and campaign AI provider configurations', async () => {
    const serverView = await configService.getServerView();
    expect(serverView).toBeNull();

    const updatedServer = await configService.putServer(
      { providerType: 'openai', model: 'gpt-4o' },
      adminActor,
    );
    expect(updatedServer.providerType).toBe('openai');

    const campaignView = await configService.getCampaignView(campaignId);
    expect(campaignView).toBeNull();

    const updatedCampaign = await configService.putCampaign(
      campaignId,
      { providerType: 'openai', model: 'gpt-4o-mini' },
      adminActor,
    );
    expect(updatedCampaign.providerType).toBe('openai');

    const effectiveView = await configService.getEffectiveView(campaignId);
    expect(effectiveView?.model).toBe('gpt-4o-mini');

    await configService.deleteCampaign(campaignId, adminActor);
    await configService.deleteServer(adminActor);
  });
});
