import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { RulesService } from '../../src/modules/rules/rules.service';
import { CampaignAccessService } from '../../src/modules/membership/campaign-access.service';
import type { RequestUser } from '../../src/common/user.types';
import { campaigns, ruleEntries, rulePacks } from '../../src/db/schema';
import { nowIso } from '../../src/common/time';

describe('RulesService unit coverage tests', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let rulesService: RulesService;

  const adminActor: RequestUser = {
    id: '1',
    name: 'Admin User',
    serverRole: 'admin',
  };

  let campaignId: number;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-rules-unit-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const access = {
      assertMember: jest.fn(),
      requireRole: jest.fn().mockResolvedValue('dm'),
      requireMember: jest.fn().mockResolvedValue('dm'),
    } as unknown as CampaignAccessService;

    rulesService = new RulesService(db, holder.ftsAvailable, audit, access);

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

  it('lists installed rule packs and gets by slug or id', async () => {
    rulesService.onModuleInit();

    const packs = await rulesService.listPacks();
    expect(Array.isArray(packs)).toBe(true);

    const [pack] = await db
      .insert(rulePacks)
      .values({
        slug: 'test-pack',
        name: 'Test Rule Pack',
        version: '1.0.0',
        license: 'OGL',
        sourceUrl: 'https://example.com',
        installedAt: nowIso(),
        entryCount: 1,
      })
      .returning();

    const packsAfter = await rulesService.listPacks();
    expect(packsAfter.length).toBeGreaterThan(0);

    const fetchedPack = await rulesService.getPackOrThrow(pack.id);
    expect(fetchedPack.name).toBe('Test Rule Pack');

    const bySlug = await rulesService.getPackBySlug('test-pack');
    expect(bySlug?.id).toBe(pack.id);

    await rulesService.uninstall(pack.id, adminActor);
  });

  it('creates, updates, duplicates, and archives campaign homebrew entries', async () => {
    const entry = await rulesService.createCampaignHomebrew(
      campaignId,
      {
        slug: 'ring-of-power',
        name: 'Ring of Power',
        type: 'item',
        summary: 'A powerful magic ring.',
        body: 'Grants +2 to all rolls.',
      },
      adminActor,
    );
    expect(entry.name).toBe('Ring of Power');

    const listHomebrew = await rulesService.listCampaignHomebrew(campaignId, adminActor);
    expect(listHomebrew.length).toBe(1);

    const fetched = await rulesService.getCampaignHomebrew(campaignId, entry.id, adminActor);
    expect(fetched.name).toBe('Ring of Power');

    const updated = await rulesService.updateCampaignHomebrew(
      campaignId,
      entry.id,
      {
        name: 'Ring of Supreme Power',
        summary: 'An even more powerful ring.',
      },
      adminActor,
    );
    expect(updated.name).toBe('Ring of Supreme Power');

    const revs = await rulesService.homebrewRevisions(campaignId, entry.id, adminActor);
    expect(Array.isArray(revs)).toBe(true);

    const previewImp = await rulesService.previewHomebrewImport(
      campaignId,
      {
        entries: [
          {
            slug: 'wand-of-fire',
            name: 'Wand of Fire',
            type: 'item',
            summary: 'Shoots fireballs.',
          },
        ],
      },
      adminActor,
    );
    expect(previewImp).toBeDefined();

    const dup = await rulesService.duplicateCampaignHomebrew(campaignId, entry.id, adminActor);
    expect(dup.id).not.toBe(entry.id);

    const archived = await rulesService.archiveCampaignHomebrew(campaignId, entry.id, adminActor);
    expect(archived.id).toBe(entry.id);
  });

  it('performs rule searches and facets', async () => {
    const [pack] = await db
      .insert(rulePacks)
      .values({
        slug: 'core-spells',
        name: 'Core Spells',
        version: '1.0.0',
        license: 'OGL',
        sourceUrl: 'https://example.com',
        installedAt: nowIso(),
        entryCount: 1,
      })
      .returning();

    const [e] = await db
      .insert(ruleEntries)
      .values({
        packId: pack.id,
        slug: 'fireball-spell',
        name: 'Fireball Spell',
        type: 'spell',
        summary: 'Deals 8d6 fire damage.',
        body: 'A bright streak flashes from your pointing finger.',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();

    const fetchedEntry = await rulesService.getEntryOrThrow(e.id);
    expect(fetchedEntry.id).toBe(e.id);

    const searchResult = await rulesService.search({
      q: 'Fireball',
      limit: 10,
    });
    expect(searchResult.items.length).toBeGreaterThanOrEqual(1);
    expect(searchResult.items[0].name).toBe('Fireball Spell');
  });
});
