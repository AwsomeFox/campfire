import fs from 'node:fs';
import { eq } from 'drizzle-orm';
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
    const campaignLibrary = new CampaignLibraryService(orm, audit);
    notifications = {
      notifyCampaign: jest.fn().mockResolvedValue(undefined),
      notifyUser: jest.fn().mockResolvedValue(undefined),
    };
    const service = new EncountersService(orm, audit, events, rolls, revisions, attachments, campaignLibrary, notifications as unknown as NotificationsService);
    return { orm, service, events };
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

  /**
   * Issue #1902 rework, round 19 (codex P2) — `adjustCombatantResource` (a spell-slot or
   * resource spend on a linked combatant) genuinely writes the character sheet in the
   * same commit, so the `encounter.updated` frame it emits is tagged `sheetMirrored: true`
   * — the client uses this to invalidate the campaign-character cache ONLY when a sheet
   * actually changed, not on every ordinary encounter update (most of which, like a
   * combat-log roll, touch no sheet at all and would otherwise trigger a wasted refetch
   * of the whole campaign character list on every busy-fight action).
   */
  it('#1902 rework: adjustCombatantResource tags its encounter.updated frame with sheetMirrored', async () => {
    dataDir = makeTempDataDir();
    const { orm, service, events } = build();

    const now = new Date().toISOString();
    const campaign = orm.insert(campaigns).values({ name: 'Sheet Mirror Flag', createdAt: now, updatedAt: now }).returning().get()!;
    const character = orm
      .insert(characters)
      .values({ campaignId: campaign.id, ownerUserId: 'player-1', name: 'Caster', spellSlots: JSON.stringify({ '1': { max: 4, used: 0 } }), createdAt: now, updatedAt: now })
      .returning()
      .get()!;
    const encounter = orm.insert(encounters).values({ campaignId: campaign.id, name: 'Fight', status: 'running', round: 1, turnIndex: 0, createdAt: now, updatedAt: now }).returning().get()!;
    const combatant = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: character.id, name: 'Caster', initiative: 20, initMod: 0, hpCurrent: 10, hpMax: 10, conditions: '[]', sortOrder: 0, tokenX: 0, tokenY: 0 })
      .returning()
      .get()!;
    const dm = { id: 'dm-1', name: 'DM', serverRole: 'user' as const, devRole: 'dm' as const };

    const seen: Array<{ type: string; sheetMirrored?: boolean }> = [];
    const sub = events.streamFor(campaign.id).subscribe((e) => seen.push(e as { type: string; sheetMirrored?: boolean }));
    try {
      await service.adjustCombatantResource(encounter.id, combatant.id, { spellLevel: 1, delta: 1 }, dm, 'dm');
    } finally {
      sub.unsubscribe();
    }

    const mirrored = seen.find((e) => e.type === 'encounter.updated');
    expect(mirrored?.sheetMirrored).toBe(true);
  });

  /**
   * Issue #1902 rework, round 21 (codex P2) — `updateCombatant` (the general combatant
   * PATCH — HP/condition/death-state) ALSO mirrors onto a linked character sheet
   * whenever `mirrorSheet` is true (see that method's own doc comment), through the
   * SHARED `emitEncounterEvent` helper this test file's OTHER `sheetMirrored` test
   * doesn't exercise (`adjustCombatantResource` emits directly). Missed in round 19's
   * initial sweep; a reviewer caught it.
   */
  it('#1902 rework (round 21): updateCombatant tags its encounter.updated frame with sheetMirrored when it mirrors the linked sheet', async () => {
    dataDir = makeTempDataDir();
    const { orm, service, events } = build();

    const now = new Date().toISOString();
    const campaign = orm.insert(campaigns).values({ name: 'Combatant Mirror Flag', createdAt: now, updatedAt: now }).returning().get()!;
    const character = orm
      .insert(characters)
      .values({ campaignId: campaign.id, ownerUserId: 'player-1', name: 'Fighter', hpCurrent: 10, hpMax: 10, createdAt: now, updatedAt: now })
      .returning()
      .get()!;
    const encounter = orm.insert(encounters).values({ campaignId: campaign.id, name: 'Fight', status: 'running', round: 1, turnIndex: 0, createdAt: now, updatedAt: now }).returning().get()!;
    const combatant = orm
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: character.id, name: 'Fighter', initiative: 20, initMod: 0, hpCurrent: 10, hpMax: 10, conditions: '[]', sortOrder: 0, tokenX: 0, tokenY: 0 })
      .returning()
      .get()!;
    const dm = { id: 'dm-1', name: 'DM', serverRole: 'user' as const, devRole: 'dm' as const };

    const seen: Array<{ type: string; sheetMirrored?: boolean }> = [];
    const sub = events.streamFor(campaign.id).subscribe((e) => seen.push(e as { type: string; sheetMirrored?: boolean }));
    try {
      // hpDelta touches `recomputeHp`, satisfying `shouldMirrorSheet` for this
      // character-linked combatant.
      await service.updateCombatant(encounter.id, combatant.id, { hpDelta: -3 }, dm, 'dm');
    } finally {
      sub.unsubscribe();
    }

    const mirrored = seen.find((e) => e.type === 'encounter.updated');
    expect(mirrored?.sheetMirrored).toBe(true);

    const [sheetAfter] = orm.select().from(characters).where(eq(characters.id, character.id)).all();
    expect(sheetAfter.hpCurrent).toBe(7);
  });
});
