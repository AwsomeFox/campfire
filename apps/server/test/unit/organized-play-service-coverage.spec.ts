import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { OrganizedPlayService } from '../../src/modules/sessions/organized-play.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { RoleResolver } from '../../src/modules/membership/role-resolver.service';
import type { RequestUser } from '../../src/common/user.types';

describe('OrganizedPlayService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let organizedPlayService: OrganizedPlayService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-orgplay-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const events = { emit: jest.fn() } as unknown as CampaignEventsService;
    const notifications = { queueAdminNotification: jest.fn() } as unknown as NotificationsService;
    const roles = { resolveEffectiveRole: jest.fn().mockResolvedValue('admin') } as unknown as RoleResolver;

    organizedPlayService = new OrganizedPlayService(
      db,
      audit,
      events,
      notifications,
      roles,
    );
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('manages venues, rooms, and schedule templates', async () => {
    const venuesBefore = await organizedPlayService.listVenues();
    expect(venuesBefore.length).toBe(0);

    const venue = await organizedPlayService.createVenue(
      {
        name: 'Game Hall Alpha',
        address: '123 Main St',
        timezone: 'UTC',
      },
      adminActor,
    );
    expect(venue.name).toBe('Game Hall Alpha');

    const venuesAfter = await organizedPlayService.listVenues();
    expect(venuesAfter.length).toBe(1);

    const room = await organizedPlayService.createRoom(
      venue.id,
      {
        name: 'Room 101',
        capacity: 6,
      },
      adminActor,
    );
    expect(room.name).toBe('Room 101');

    const template = await organizedPlayService.createTemplate(
      {
        name: 'Weekly Campaign Slot',
        timezone: 'UTC',
        slots: [
          {
            weekday: 1,
            startTime: '18:00',
            durationMinutes: 180,
            capacity: 6,
            roomId: null,
            assignedDmUserId: '1',
            title: 'Weekly Game',
          },
        ],
      },
      adminActor,
    );
    expect(template.name).toBe('Weekly Campaign Slot');

    const templates = await organizedPlayService.listTemplates();
    expect(templates.length).toBe(1);
  });
});
