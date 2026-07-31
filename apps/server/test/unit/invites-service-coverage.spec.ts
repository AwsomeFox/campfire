import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { SessionZeroConsentService } from '../../src/modules/session-zero/session-zero-consent.service';
import { InvitesService } from '../../src/modules/membership/invites.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('InvitesService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let invitesService: InvitesService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-invites-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const auth = {} as unknown as AuthService;
    const settings = new SettingsService(db);
    const notifications = { queueNotification: jest.fn() } as unknown as NotificationsService;
    const consent = new SessionZeroConsentService(db, audit, notifications);

    invitesService = new InvitesService(db, audit, auth, settings, consent);

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

  it('creates, previews, lists, and revokes campaign invites', async () => {
    const invite = await invitesService.create(
      campaignId,
      {
        role: 'player',
        expiresInDays: 7,
      },
      adminActor,
    );
    expect(invite.code).toBeDefined();

    const list = await invitesService.listForCampaign(campaignId);
    expect(list.length).toBe(1);

    const preview = await invitesService.preview(invite.code);
    expect(preview.campaignName).toBe('Test Campaign');

    await invitesService.revoke(campaignId, invite.id, adminActor);
    const listAfter = await invitesService.listForCampaign(campaignId);
    expect(listAfter.length).toBe(0);
  });
});
