import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CharactersService } from '../../src/modules/characters/characters.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { CampaignAccessService } from '../../src/modules/membership/campaign-access.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('CharactersService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let charactersService: CharactersService;

  const dmActor: RequestUser = {
    id: '1',
    name: 'DM',
    serverRole: 'user',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-characters-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const moderation = {} as unknown as ModerationService;
    const revisions = new RevisionsService(db, moderation);
    const events = { emit: jest.fn() } as unknown as CampaignEventsService;
    const rolls = { recordRoll: jest.fn().mockResolvedValue({ id: 1 }) } as unknown as RollsService;
    const access = {
      assertMember: jest.fn().mockResolvedValue('dm'),
      requireRole: jest.fn().mockResolvedValue('dm'),
      requireMember: jest.fn().mockResolvedValue('dm'),
    } as unknown as CampaignAccessService;

    charactersService = new CharactersService(
      db,
      audit,
      revisions,
      events,
      rolls,
      access,
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

  it('manages character HP, XP, leveling, conditions, and spell slots', async () => {
    const char = await charactersService.create(
      campaignId,
      {
        name: 'Valeros',
        level: 1,
        hpMax: 20,
        hpCurrent: 20,
      },
      dmActor,
      'dm',
    );
    expect(char.name).toBe('Valeros');

    const party = await charactersService.partyRosterForCampaign(campaignId);
    expect(party.length).toBe(1);

    const exportList = await charactersService.listForExport(campaignId, 'dm');
    expect(exportList.length).toBe(1);

    const checks = await charactersService.listChecks(char.id);
    expect(Array.isArray(checks)).toBe(true);

    const reqList = await charactersService.listCheckRequests(campaignId, dmActor, 'dm');
    expect(Array.isArray(reqList)).toBe(true);

    const patchedHp = await charactersService.patchHp(
      char.id,
      { delta: -5 },
      dmActor,
      'dm',
    );
    expect(patchedHp.hpCurrent).toBe(15);

    const patchedXp = await charactersService.patchXp(
      char.id,
      { set: 500 },
      dmActor,
      'dm',
    );
    expect(patchedXp.xp).toBe(500);

    const awarded = await charactersService.awardXp(
      campaignId,
      { amount: 100, includeNonActive: false },
      dmActor,
      'dm',
    );
    expect(awarded.length).toBeGreaterThan(0);

    const slotsLeft = await charactersService.spellSlotsLeft(char.id, 1);
    expect(typeof slotsLeft).toBe('number');

    const vocab = await charactersService.listResourceVocabulary(char.id);
    expect(Array.isArray(vocab)).toBe(true);

    const rested = await charactersService.rest(char.id, 'short', dmActor, 'dm');
    expect(rested.id).toBe(char.id);

    await charactersService.remove(char.id, dmActor, 'dm');
    await charactersService.restore(char.id, dmActor, 'dm');
  });
});
