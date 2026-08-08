import fs from 'node:fs';
import { openDatabase } from '../../src/db/db.module';
import { campaignLibraryMonsters, campaigns, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
// Issue #604: AttachmentsService now delegates responsive derivative generation.
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import type { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { BadRequestException } from '@nestjs/common';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #2080 — a homebrew monster's HP must survive save-to-library -> re-add.
 *
 * Before this fix, `CombatantStatblock` had no HP field at all: save-to-library
 * posted the statblock without the DM-typed Max HP, and re-adding from the
 * library fell back to a hardcoded `10` (AddCombatantPanel.tsx's `resolvedHp`).
 * The fix adds a nullable `CombatantStatblock.hp` template field and has
 * `EncountersService.addCombatant` seed a library add's `hpMax` from it when the
 * caller doesn't supply one explicitly — this is the layer that owns the
 * invariant for REST, MCP, and the web UI alike (all three funnel through this
 * one service method).
 *
 * Service-layer against real SQLite (same shape as the other encounter
 * integration specs in this directory).
 */
describe('encounter library monster HP (issue #2080, service layer)', () => {
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
    const campaignLibrary = new CampaignLibraryService(orm, audit, events);
    // Copilot review on PR #2086: type the double against the methods this service
    // actually calls (Pick<...>, checked as an annotation, not a bare assertion — see
    // AGENTS.md's "double-side only" convention), then cast only at the constructor
    // boundary, instead of a blind `as any` that skips shape-checking entirely.
    const notifications: Pick<NotificationsService, 'notifyCampaign' | 'notifyUser'> = {
      notifyCampaign: jest.fn().mockResolvedValue(undefined),
      notifyUser: jest.fn().mockResolvedValue(undefined),
    };
    const encountersService = new EncountersService(
      orm,
      audit,
      events,
      rolls,
      revisions,
      attachments,
      campaignLibrary,
      notifications as unknown as NotificationsService,
    );
    return { orm, encountersService, campaignLibrary };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };

  /** Seed a campaign + encounter, returning the ids. The encounter is in 'preparing' so addCombatant is allowed. */
  function seedEncounter(orm: ReturnType<typeof build>['orm']): { campaignId: number; encounterId: number } {
    const ts = new Date().toISOString();
    const [campaign] = orm.insert(campaigns).values({ name: 'HP Library Test', createdAt: ts, updatedAt: ts }).returning().all();
    const [encounter] = orm
      .insert(encounters)
      .values({ campaignId: campaign.id, name: 'HP Library Fight', status: 'preparing', round: 1, turnIndex: 0, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    return { campaignId: campaign.id, encounterId: encounter.id };
  }

  beforeEach(() => {
    dataDir = makeTempDataDir();
  });

  it('round-trips a homebrew statblock’s HP through save -> library -> re-add, at the value the DM typed', async () => {
    const { orm, encountersService, campaignLibrary } = build();
    const { campaignId, encounterId } = seedEncounter(orm);

    // Save-to-library: the DM typed 60 as this brute's Max HP.
    const saved = await campaignLibrary.create(
      campaignId,
      {
        name: 'Bonecrusher',
        statblock: {
          ac: 15,
          hp: 60,
          abilityScores: { STR: 18, DEX: 10, CON: 16, INT: 6, WIS: 8, CHA: 6 },
          actions: [],
          resources: {},
          spellSlots: {},
          traits: [],
          notes: '',
        },
      },
      dmUser,
      'dm',
    );
    expect(saved.statblock.hp).toBe(60);

    // Re-add from the library WITHOUT an explicit hpMax — exactly what the web UI's
    // Library tab now sends (see AddCombatantPanel.addFromLibrary).
    const combatant = await encountersService.addCombatant(
      encounterId,
      { kind: 'monster', name: saved.name, libraryMonsterId: saved.id },
      dmUser,
      'dm',
    );

    expect(combatant.hpMax).toBe(60);
    expect(combatant.hpCurrent).toBe(60);
  });

  it('an explicit caller-supplied hpMax overrides the library statblock’s stored HP', async () => {
    const { orm, encountersService, campaignLibrary } = build();
    const { campaignId, encounterId } = seedEncounter(orm);

    const saved = await campaignLibrary.create(
      campaignId,
      { name: 'Bonecrusher', statblock: { ac: 15, hp: 60, abilityScores: {}, actions: [], resources: {}, spellSlots: {}, traits: [], notes: '' } },
      dmUser,
      'dm',
    );

    const combatant = await encountersService.addCombatant(
      encounterId,
      { kind: 'monster', name: saved.name, libraryMonsterId: saved.id, hpMax: 90 },
      dmUser,
      'dm',
    );

    expect(combatant.hpMax).toBe(90);
  });

  it('a library entry saved before this field existed (no "hp" key at all) still loads, and still adds when the caller supplies hpMax', async () => {
    const { orm, encountersService, campaignLibrary } = build();
    const { campaignId, encounterId } = seedEncounter(orm);

    // Simulate a pre-#2080 row: insert directly, bypassing CombatantStatblock.parse,
    // with a statblockJson that has no "hp" key whatsoever — the actual on-disk shape
    // every campaign-library row had before this change shipped.
    const ts = new Date().toISOString();
    const legacyStatblockJson = JSON.stringify({
      ac: 12,
      abilityScores: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
      actions: [],
      resources: {},
      spellSlots: {},
      traits: [],
      notes: '',
    });
    const [legacyRow] = orm
      .insert(campaignLibraryMonsters)
      .values({ campaignId, name: 'Ancient Goblin', statblockJson: legacyStatblockJson, sourceRuleEntryId: null, createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    // Still loads: Zod parses the legacy JSON without an "hp" key via `.default(null)`,
    // not a validation error.
    const loaded = await campaignLibrary.getOrThrow(legacyRow.id, campaignId);
    expect(loaded.statblock.hp).toBeNull();
    const list = await campaignLibrary.listForCampaign(campaignId);
    expect(list.find((m) => m.id === legacyRow.id)?.statblock.hp).toBeNull();

    // Still adds: the caller supplies hpMax explicitly (as every REST/MCP caller
    // already had to before this fix — this entry has no stored HP to seed from).
    const combatant = await encountersService.addCombatant(
      encounterId,
      { kind: 'monster', name: loaded.name, libraryMonsterId: legacyRow.id, hpMax: 7 },
      dmUser,
      'dm',
    );
    expect(combatant.hpMax).toBe(7);
  });

  it('a library entry with no stored HP and no caller-supplied hpMax is rejected explicitly, never silently defaulted', async () => {
    const { orm, encountersService, campaignLibrary } = build();
    const { campaignId, encounterId } = seedEncounter(orm);

    const saved = await campaignLibrary.create(
      campaignId,
      { name: 'Unstated Ooze', statblock: { ac: 8, hp: null, abilityScores: {}, actions: [], resources: {}, spellSlots: {}, traits: [], notes: '' } },
      dmUser,
      'dm',
    );
    expect(saved.statblock.hp).toBeNull();

    await expect(
      encountersService.addCombatant(encounterId, { kind: 'monster', name: saved.name, libraryMonsterId: saved.id }, dmUser, 'dm'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      encountersService.addCombatant(encounterId, { kind: 'monster', name: saved.name, libraryMonsterId: saved.id }, dmUser, 'dm'),
    ).rejects.toThrow(/provide "hpMax" explicitly/);
  });
});
