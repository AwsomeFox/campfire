import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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

  it('blocks reclassifying a referenced base pack and ignores optional supplement compatibility on uninstall', async () => {
    const [base] = await db
      .insert(rulePacks)
      .values({
        slug: 'core-rules',
        name: 'Core Rules',
        version: '1',
        license: 'CC0',
        sourceUrl: '',
        kind: 'base',
        installedAt: nowIso(),
        entryCount: 0,
      })
      .returning();
    await db.update(campaigns).set({ ruleSystem: base.slug }).where(eq(campaigns.id, campaignId));

    const reclassification = {
      source: 'upload' as const,
      pack: {
        slug: base.slug,
        name: base.name,
        license: 'CC0',
        kind: 'supplement' as const,
      },
      entries: [{ slug: 'entry', name: 'Entry', type: 'other' as const }],
    };
    await expect(rulesService.enqueueUploadInstall(reclassification, adminActor)).rejects.toThrow(ConflictException);

    await db.update(campaigns).set({ ruleSystem: '' }).where(eq(campaigns.id, campaignId));
    const [extension] = await db
      .insert(rulePacks)
      .values({
        slug: 'core-extension',
        name: 'Core Extension',
        version: '1',
        license: 'CC0',
        sourceUrl: '',
        kind: 'extension',
        extendsPackSlug: base.slug,
        installedAt: nowIso(),
        entryCount: 0,
      })
      .returning();
    await expect(rulesService.enqueueUploadInstall(reclassification, adminActor)).rejects.toThrow(ConflictException);

    await db.delete(rulePacks).where(eq(rulePacks.id, extension.id));
    const [supplement] = await db
      .insert(rulePacks)
      .values({
        slug: 'compatible-supplement',
        name: 'Compatible Supplement',
        version: '1',
        license: 'CC0',
        sourceUrl: '',
        kind: 'supplement',
        extendsPackSlug: base.slug,
        installedAt: nowIso(),
        entryCount: 0,
      })
      .returning();

    await rulesService.uninstall(base.id, adminActor);
    expect(await rulesService.getPackBySlug(base.slug)).toBeUndefined();
    expect((await rulesService.getPackOrThrow(supplement.id)).extendsPackSlug).toBe(base.slug);
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

  it('handles campaign-scoped getEntryOrThrow and search including homebrew and archived exclusion', async () => {
    const [pack] = await db
      .insert(rulePacks)
      .values({
        slug: 'open5e-srd',
        name: 'Open5e SRD',
        version: '1.0.0',
        license: 'OGL',
        sourceUrl: 'https://example.com',
        installedAt: nowIso(),
        entryCount: 1,
      })
      .returning();

    const [globalEntry] = await db
      .insert(ruleEntries)
      .values({
        packId: pack.id,
        slug: 'goblin',
        name: 'Goblin',
        type: 'monster',
        summary: 'Small humanoid monster.',
        body: 'Nimble escape.',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning();

    const homebrewEntry = await rulesService.createCampaignHomebrew(
      campaignId,
      {
        slug: 'shadow-goblin',
        name: 'Shadow Goblin',
        type: 'monster',
        summary: 'Homebrew shadow monster.',
        body: 'Shadow step.',
      },
      adminActor,
    );

    // 1. Member can get global entry with campaignId
    const resolvedGlobal = await rulesService.getEntryOrThrow(globalEntry.id, campaignId, adminActor);
    expect(resolvedGlobal.id).toBe(globalEntry.id);

    // 2. Member can get homebrew entry with campaignId
    const resolvedHomebrew = await rulesService.getEntryOrThrow(homebrewEntry.id, campaignId, adminActor);
    expect(resolvedHomebrew.id).toBe(homebrewEntry.id);

    // 3. Getting homebrew without campaignId throws 404
    await expect(rulesService.getEntryOrThrow(homebrewEntry.id)).rejects.toThrow('not found');

    // 4. Getting homebrew scoped to a DIFFERENT campaignId (999, not the entry's real
    // campaignId) throws NotFoundException specifically — the SQL scope excludes the row
    // rather than falling through to some other error, so the id's existence never leaks
    // outside its own campaign. `access` is mocked to always grant 'dm' above, so this
    // isolates the scope condition itself; real non-member rejection (a genuine second
    // campaign the caller isn't in) is covered by the e2e test in homebrew.e2e-spec.ts,
    // which uses real per-campaign membership rather than this mock.
    await expect(rulesService.getEntryOrThrow(homebrewEntry.id, 999, adminActor)).rejects.toThrow(NotFoundException);

    // 5. Member search with campaignId returns both global and homebrew
    const scopedSearch = await rulesService.search(
      { q: 'Goblin', campaignId },
      10,
      adminActor,
    );
    const names = scopedSearch.items.map((i) => i.name);
    expect(names).toContain('Goblin');
    expect(names).toContain('Shadow Goblin');

    // 6. Search without campaignId returns only global
    const globalSearch = await rulesService.search({ q: 'Goblin' });
    const globalNames = globalSearch.items.map((i) => i.name);
    expect(globalNames).toContain('Goblin');
    expect(globalNames).not.toContain('Shadow Goblin');

    // 7. A `pack` filter alongside campaignId must not exclude homebrew: homebrew rows
    // live under a separate internal pack (never the requested pack's id), and the web
    // add-combatant picker always sends both once a campaign has a rule system configured
    // (issue #1898 review) — the pack filter must narrow only the global half of the scope.
    const packScopedSearch = await rulesService.search(
      { q: 'Goblin', pack: pack.slug, campaignId },
      10,
      adminActor,
    );
    const packScopedNames = packScopedSearch.items.map((i) => i.name);
    expect(packScopedNames).toContain('Goblin');
    expect(packScopedNames).toContain('Shadow Goblin');

    // An explicit homebrew-only search never depends on a fabricated global pack slug:
    // even with matching global content installed, only this campaign's live rows qualify.
    const homebrewOnlySearch = await rulesService.search(
      { q: 'Goblin', campaignId, homebrewOnly: true },
      10,
      adminActor,
    );
    expect(homebrewOnlySearch.items.map((item) => item.name)).toEqual(['Shadow Goblin']);

    // 8. Archived homebrew is excluded from scoped search
    await rulesService.archiveCampaignHomebrew(campaignId, homebrewEntry.id, adminActor);
    const postArchiveSearch = await rulesService.search(
      { q: 'Goblin', campaignId },
      10,
      adminActor,
    );
    const postArchiveNames = postArchiveSearch.items.map((i) => i.name);
    expect(postArchiveNames).toContain('Goblin');
    expect(postArchiveNames).not.toContain('Shadow Goblin');

    // 9. A `pack` slug naming a rule system with no matching INSTALLED pack must not
    // drop the campaign's own (still-live, not archived) homebrew too (issue #1898
    // review): campaign.ruleSystem is free-text, never validated against installed
    // packs, and the picker always forwards it. Re-create a live homebrew entry since
    // step 8 archived the prior one.
    await rulesService.createCampaignHomebrew(
      campaignId,
      { slug: 'still-live-goblin', name: 'Still Live Goblin', type: 'monster', summary: '', body: '' },
      adminActor,
    );
    const missingPackSearch = await rulesService.search(
      { q: 'Goblin', pack: 'no-such-installed-pack-slug', campaignId },
      10,
      adminActor,
    );
    const missingPackNames = missingPackSearch.items.map((i) => i.name);
    expect(missingPackNames).toContain('Still Live Goblin');
    expect(missingPackNames).not.toContain('Goblin'); // the global entry belongs to a REAL pack, not the missing one
    expect(missingPackNames).not.toContain('Shadow Goblin'); // archived — stays excluded regardless

    // Regression: without campaignId, a missing pack still short-circuits to fully empty
    // (unchanged behavior for the plain global search).
    const missingPackGlobalSearch = await rulesService.search({ q: 'Goblin', pack: 'no-such-installed-pack-slug' });
    expect(missingPackGlobalSearch.items).toHaveLength(0);
  });
});
