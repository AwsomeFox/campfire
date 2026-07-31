import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { MembersService } from '../../src/modules/membership/members.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { UsersService } from '../../src/modules/users/users.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('MembersService unit tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let membersService: MembersService;
  let usersService: UsersService;
  let db: DrizzleDb;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin User',
    serverRole: 'admin',
  };

  let campaignId: number;
  let user1Id: number;
  let user2Id: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-members-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const notifications = new NotificationsService(db);
    const events = new CampaignEventsService();
    membersService = new MembersService(db, audit, notifications, events);
    usersService = new UsersService(db, audit);

    const u1 = await usersService.create({ username: 'dm_user', displayName: 'DM', password: 'pw' });
    const u2 = await usersService.create({ username: 'player_user', displayName: 'Player', password: 'pw' });
    user1Id = u1.id;
    user2Id = u2.id;

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

  it('adds, gets, updates, and removes campaign members', async () => {
    const m1 = await membersService.create(
      campaignId,
      {
        userId: user1Id,
        role: 'dm',
      },
      adminActor,
    );
    expect(m1.role).toBe('dm');

    const m2 = await membersService.create(
      campaignId,
      {
        userId: user2Id,
        role: 'player',
      },
      adminActor,
    );
    expect(m2.role).toBe('player');

    const members = await membersService.listForCampaign(campaignId);
    expect(members.length).toBe(2);

    const fetched = await membersService.getRowOrThrow(campaignId, m2.id);
    expect(fetched.role).toBe('player');

    const updated = await membersService.update(
      campaignId,
      m2.id,
      {
        role: 'viewer',
      },
      adminActor,
    );
    expect(updated.role).toBe('viewer');

    await membersService.remove(campaignId, m2.id, adminActor);
    const afterRemove = await membersService.listForCampaign(campaignId);
    expect(afterRemove.length).toBe(1);
  });

  it('adds creator as DM', async () => {
    await membersService.addCreatorAsDm(campaignId, user1Id);
    const members = await membersService.listForCampaign(campaignId);
    expect(members.length).toBe(1);
    expect(members[0].role).toBe('dm');
  });

  it('manages AI consent preferences for members', async () => {
    await membersService.create(
      campaignId,
      {
        userId: user1Id,
        role: 'dm',
      },
      adminActor,
    );

    const user1Actor: RequestUser = {
      id: String(user1Id),
      name: 'DM',
      serverRole: 'user',
    };

    const updated = await membersService.updateOwnAiConsent(
      campaignId,
      {
        aiExternalUseConsent: true,
      },
      user1Actor,
    );
    expect(updated.aiExternalUseConsent).toBe(true);
  });

  it('grants and revokes guest DM access', async () => {
    await membersService.create(
      campaignId,
      {
        userId: user2Id,
        role: 'player',
      },
      adminActor,
    );

    const futureIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const grant = await membersService.createGuestDmGrant(
      campaignId,
      {
        granteeUserId: user2Id,
        expiresAt: futureIso,
      },
      adminActor,
    );
    expect(grant.granteeUserId).toBe(user2Id);

    const grants = await membersService.listGuestDmGrants(campaignId);
    expect(grants.length).toBe(1);

    await membersService.revokeGuestDmGrant(campaignId, grant.id, adminActor);
    const afterRevoke = await membersService.listGuestDmGrants(campaignId);
    expect(afterRevoke.length).toBe(1);
    expect(afterRevoke[0].revokedAt).not.toBeNull();
  });
});
