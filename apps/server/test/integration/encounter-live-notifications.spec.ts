import fs from 'node:fs';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, characters, combatants, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import type { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { makeTempDataDir } from './fixtures';

describe('encounter live play notifications', () => {
  let dataDir: string;
  let notifications: Pick<NotificationsService, 'notifyCampaign' | 'notifyUser'>;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    const revisions = new RevisionsService(orm, new ModerationService(orm, audit));
    const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit), new AttachmentDerivativesService(orm));
    const campaignLibrary = new CampaignLibraryService(orm, audit, events);
    notifications = {
      notifyCampaign: jest.fn().mockResolvedValue(undefined),
      notifyUser: jest.fn().mockResolvedValue(undefined),
    };
    const service = new EncountersService(orm, audit, events, rolls, revisions, attachments, campaignLibrary, notifications as unknown as NotificationsService);
    return { orm, service };
  }

  it('notifies campaign when encounter starts and ends, and users on their turn', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    
    const now = new Date().toISOString();
    const campaign = orm.insert(campaigns).values({ name: 'Live Play', createdAt: now, updatedAt: now }).returning().get()!;
    const character = orm.insert(characters).values({ campaignId: campaign.id, ownerUserId: 'player-1', name: 'Hero', createdAt: now, updatedAt: now }).returning().get()!;
    
    const encounter = orm.insert(encounters).values({ campaignId: campaign.id, name: 'Boss Fight', status: 'preparing', round: 1, turnIndex: 0, createdAt: now, updatedAt: now }).returning().get()!;
    
    // Add combatant
    orm.insert(combatants).values({ encounterId: encounter.id, kind: 'character', characterId: character.id, name: 'Hero', initiative: 20, initMod: 0, hpCurrent: 10, hpMax: 10, conditions: '[]', sortOrder: 0, tokenX: 0, tokenY: 0 }).run();

    const dm = { id: 'dm-1', name: 'DM', serverRole: 'user' as const, devRole: 'dm' as const };

    // Start encounter
    await service.start(encounter.id, dm, 'dm');
    
    expect(notifications.notifyCampaign).toHaveBeenCalledWith(campaign.id, dm, expect.objectContaining({ type: 'encounter_started' }));
    
    // The turn notification is fired asynchronously inside `start()` (promise is caught but not awaited)
    // Wait a tick for the microtask queue to process
    await new Promise((resolve) => setImmediate(resolve));
    
    expect(notifications.notifyUser).toHaveBeenCalledWith('player-1', campaign.id, dm, expect.objectContaining({ type: 'encounter_turn' }));

    // End encounter
    await service.end(encounter.id, dm, 'dm');
    
    expect(notifications.notifyCampaign).toHaveBeenCalledWith(campaign.id, dm, expect.objectContaining({ type: 'encounter_ended' }));
  });
});
