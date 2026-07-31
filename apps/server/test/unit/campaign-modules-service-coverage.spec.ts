import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignModulesService } from '../../src/modules/campaign-modules/campaign-modules.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('CampaignModulesService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let modulesService: CampaignModulesService;

  const dmActor: RequestUser = {
    id: '1',
    name: 'DM',
    serverRole: 'user',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-modules-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);

    modulesService = new CampaignModulesService(db, audit);

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

  it('lists installed modules and installs module package', async () => {
    const listBefore = await modulesService.list(campaignId);
    expect(listBefore.length).toBe(0);

    const installed = await modulesService.install(
      campaignId,
      {
        package: {
          manifest: {
            formatVersion: 1,
            moduleId: 'module-uuid-1',
            name: 'The Dark Dungeon',
            description: 'A dangerous dungeon.',
            version: '1.0.0',
            authors: [{ name: 'Author', url: '', email: '' }],
            license: 'MIT',
            sourceUrl: 'https://example.com',
            publishedAt: nowIso(),
            compatibility: { campfire: '>=0.1.0', ruleSystems: [] },
            dependencies: [],
            kind: 'campaign-module-manifest',
            app: 'campfire',
            artifacts: [],
          },
          artifacts: [],
        },
      },
      dmActor,
      'dm',
    );
    expect(installed.moduleId).toBe('module-uuid-1');

    const listAfter = await modulesService.list(campaignId);
    expect(listAfter.length).toBe(1);

    const fetched = await modulesService.get(campaignId, installed.id);
    expect(fetched.id).toBe(installed.id);

    const snapshots = await modulesService.snapshots(campaignId, installed.id);
    expect(Array.isArray(snapshots)).toBe(true);

    const overlays = await modulesService.overlays(campaignId, installed.id);
    expect(Array.isArray(overlays)).toBe(true);

    const detached = await modulesService.detach(campaignId, installed.id, dmActor, 'dm');
    expect(detached.lineage.detached).toBe(true);

    const match = await modulesService.campaignsWithModule('module-uuid-1');
    expect(match.length).toBe(1);
  });
});
