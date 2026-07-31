import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { AdminCatalogService } from '../../src/modules/admin-catalog/admin-catalog.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('AdminCatalogService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let catalogService: AdminCatalogService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-catalog-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const events = { emit: jest.fn() } as unknown as CampaignEventsService;
    const notifications = { queueAdminNotification: jest.fn() } as unknown as NotificationsService;
    const settings = new SettingsService(db);

    catalogService = new AdminCatalogService(
      db,
      audit,
      events,
      notifications,
      settings,
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

  it('manages privacy policy and reads catalog entries', async () => {
    const initialPolicy = await catalogService.getPrivacyPolicy();
    expect(initialPolicy.source).toBe('default');

    const updatedPolicy = await catalogService.updatePrivacyPolicy(
      { names: 'redacted' },
      { actor: '1', actorRole: 'admin' },
    );
    expect(updatedPolicy.names).toBe('redacted');

    const page = await catalogService.listCatalog(adminActor, {});
    expect(page.items.length).toBeGreaterThan(0);

    const entry = await catalogService.getCatalogEntry(adminActor, campaignId);
    expect(entry.id).toBe(campaignId);

    const privacySet = await catalogService.setCampaignPrivacy(
      campaignId,
      'redacted',
      adminActor,
    );
    expect(privacySet.catalogPrivacy).toBe('redacted');
  });
});
