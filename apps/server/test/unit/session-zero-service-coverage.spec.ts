import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { SessionZeroService } from '../../src/modules/session-zero/session-zero.service';
import { SessionZeroConsentService } from '../../src/modules/session-zero/session-zero-consent.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('SessionZero and Consent Services unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let sessionZeroService: SessionZeroService;
  let consentService: SessionZeroConsentService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-sz-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const moderation = {} as unknown as ModerationService;
    const revisions = new RevisionsService(db, moderation);
    const notifications = {
      notifyCampaign: jest.fn().mockResolvedValue(undefined),
      memberRoles: jest.fn().mockResolvedValue(new Map()),
    } as unknown as NotificationsService;

    sessionZeroService = new SessionZeroService(db, audit, revisions);
    consentService = new SessionZeroConsentService(db, audit, notifications);

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

  it('manages session zero draft and consent publishing / acknowledgments', async () => {
    const charter = await sessionZeroService.get(campaignId);
    expect(charter.campaignId).toBe(campaignId);

    const updated = await sessionZeroService.update(
      campaignId,
      {
        lines: ['spiders'],
        veils: ['guts'],
        houseRules: 'No meta-gaming',
      },
      adminActor,
      'dm',
    );
    expect(updated.lines).toContain('spiders');

    const published = await consentService.publish(campaignId, { changeSummary: 'V1 charter' }, adminActor);
    expect(published.version).toBe(1);

    const versions = await consentService.listVersions(campaignId);
    expect(versions.length).toBe(1);

    const effective = await consentService.effectiveCharter(campaignId);
    expect(effective).toBeDefined();

    const ack = await consentService.acknowledge(campaignId, { versionId: 1, state: 'acknowledged', note: 'OK' }, adminActor);
    expect(ack.version).toBe(1);

    const status = await consentService.consentStatus(campaignId, adminActor);
    expect(status).toBeDefined();

    const preview = await consentService.previewForInvite(campaignId);
    expect(preview).toBeDefined();

    const bounds = await consentService.listBoundarySubmissions(campaignId, adminActor, true);
    expect(Array.isArray(bounds)).toBe(true);

    const guardians = await consentService.listGuardianConsents(campaignId);
    expect(Array.isArray(guardians)).toBe(true);
  });
});
