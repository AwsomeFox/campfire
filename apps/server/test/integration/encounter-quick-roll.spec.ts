import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, characters, combatants, encounterEvents, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

describe('encounter quick-roll (real SQLite, service layer)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    const revisions = new RevisionsService(orm, new ModerationService(orm, audit));
    const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit), new AttachmentDerivativesService(orm));
    const campaignLibrary = new CampaignLibraryService(orm, audit);
    const notifications = { notifyCampaign: jest.fn().mockResolvedValue(undefined), notifyUser: jest.fn().mockResolvedValue(undefined) } as any;
    const service = new EncountersService(orm, audit, events, rolls, revisions, attachments, campaignLibrary, notifications);
    return { orm, service, rolls };
  }

  const player1: RequestUser = { id: 'user-1', name: 'Alice', serverRole: 'user', devRole: 'player' };

  function seed(orm: ReturnType<typeof build>['orm']) {
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Quick Roll Campaign', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [char1] = orm
      .insert(characters)
      .values({ campaignId: campaign.id, ownerUserId: player1.id, name: 'Valerie', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({ campaignId: campaign.id, name: 'Skirmish', status: 'running', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [c1] = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: char1.id, name: 'Valerie', initiative: 15, hpCurrent: 30, hpMax: 30 })
      .returning()
      .all();
    return { campaignId: campaign.id, encounterId: encounter.id, combatantId: c1.id };
  }

  it('quick-rolls to-hit (+7) and records to BOTH campaign dice_rolls and encounter_events', async () => {
    dataDir = makeTempDataDir();
    const { orm, service, rolls } = build();
    const { campaignId, encounterId, combatantId } = seed(orm);

    const res = await service.quickRoll(
      encounterId,
      {
        combatantId,
        actorName: 'Valerie',
        actionName: 'Longsword',
        kind: 'to-hit',
        expr: '+7',
        mode: 'flat',
      },
      player1,
      'player',
    );

    expect(res.total).toBeGreaterThanOrEqual(8);
    expect(res.total).toBeLessThanOrEqual(27);
    expect(res.breakdown).toContain('1d20');

    // Check dice_rolls table
    const campaignRolls = await rolls.listForCampaign(campaignId);
    expect(campaignRolls.length).toBeGreaterThanOrEqual(1);
    expect(campaignRolls[0].actor).toBe('Valerie');
    expect(campaignRolls[0].label).toContain('Valerie · Longsword (to-hit)');

    // Check encounter_events table
    const events = orm
      .select()
      .from(encounterEvents)
      .where(eq(encounterEvents.encounterId, encounterId))
      .all();
    expect(events.length).toBe(1);
    expect(events[0].actor).toBe('Valerie');
    expect(events[0].actorId).toBe(combatantId);
    expect(events[0].type).toBe('roll');
    expect(events[0].detail).toContain('Longsword (to-hit)');
  });

  it('quick-rolls damage (1d8+4 slashing) and records damage type icon', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const { encounterId, combatantId } = seed(orm);

    const res = await service.quickRoll(
      encounterId,
      {
        combatantId,
        actorName: 'Valerie',
        actionName: 'Longsword',
        kind: 'damage',
        expr: '1d8+4 slashing',
        mode: 'flat',
      },
      player1,
      'player',
    );

    expect(res.total).toBeGreaterThanOrEqual(5);
    expect(res.total).toBeLessThanOrEqual(12);

    const events = orm
      .select()
      .from(encounterEvents)
      .where(eq(encounterEvents.encounterId, encounterId))
      .all();
    expect(events.length).toBe(1);
    expect(events[0].detail).toContain('⚔️');
    expect(events[0].detail).toContain('Longsword (damage)');
  });
});
